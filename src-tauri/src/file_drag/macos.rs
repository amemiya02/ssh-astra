use std::cell::RefCell;
use std::ffi::CStr;
use std::io::{ErrorKind, Write};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::ptr::NonNull;
use std::sync::Arc;

use block2::StackBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{define_class, msg_send, ClassType, MainThreadMarker, Message};
use objc2_app_kit::{
    NSDragOperation, NSDraggingContext, NSDraggingItem, NSDraggingSession, NSDraggingSource,
    NSEvent, NSEventMask, NSEventType, NSImage, NSView,
};
use objc2_app_kit::{NSFilePromiseProvider, NSFilePromiseProviderDelegate};
use objc2_foundation::{
    ns_string, NSArray, NSDictionary, NSError, NSFileCoordinator, NSFileCoordinatorWritingOptions,
    NSLocalizedDescriptionKey, NSObject, NSObjectProtocol, NSOperationQueue, NSPoint, NSRect,
    NSSize, NSString, NSURL,
};
use sshastra_core::files::{FsError, FsResult};
use tauri::WebviewWindow;

use super::{RemoteRead, Report, Source, CHUNK_SIZE};

struct MouseGesture {
    down: Retained<NSEvent>,
    dragged: Option<Retained<NSEvent>>,
}

thread_local! {
    static MONITOR: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
    static MOUSE: RefCell<Option<MouseGesture>> = const { RefCell::new(None) };
    static DRAG: RefCell<Option<Retained<DragSource>>> = const { RefCell::new(None) };
}

pub(crate) fn capture_mouse_events() {
    let mask =
        NSEventMask::LeftMouseDown | NSEventMask::LeftMouseDragged | NSEventMask::LeftMouseUp;
    let monitor = StackBlock::new(|event: NonNull<NSEvent>| {
        // AppKit owns the event for this callback and executes local monitors on its UI thread.
        let mouse = unsafe { event.as_ref() };
        MOUSE.with_borrow_mut(|gesture| match mouse.r#type() {
            NSEventType::LeftMouseDown => {
                *gesture = Some(MouseGesture {
                    down: mouse.retain(),
                    dragged: None,
                });
            }
            NSEventType::LeftMouseDragged => {
                if let Some(gesture) = gesture {
                    gesture.dragged = Some(mouse.retain());
                }
            }
            NSEventType::LeftMouseUp => *gesture = None,
            _ => {}
        });
        event.as_ptr()
    });
    // The monitor retains its copied block and always receives its own event back.
    let monitor = unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &monitor) };
    MONITOR.with_borrow_mut(|slot| *slot = monitor);
}

struct PromiseState {
    source: Arc<Source>,
    report: Arc<Report>,
}

define_class!(
    // NSObject has no subclassing requirements. Promise callbacks use only thread-safe state.
    #[unsafe(super(NSObject))]
    #[ivars = PromiseState]
    struct PromiseDelegate;

    unsafe impl NSObjectProtocol for PromiseDelegate {}

    unsafe impl NSFilePromiseProviderDelegate for PromiseDelegate {
        #[unsafe(method_id(filePromiseProvider:fileNameForType:))]
        fn promise_name(
            &self,
            _provider: &NSFilePromiseProvider,
            _file_type: &NSString,
        ) -> Retained<NSString> {
            NSString::from_str(&self.ivars().source.name)
        }

        #[unsafe(method_id(operationQueueForFilePromiseProvider:))]
        fn queue(&self, _provider: &NSFilePromiseProvider) -> Retained<NSOperationQueue> {
            NSOperationQueue::new()
        }

        #[unsafe(method(filePromiseProvider:writePromiseToURL:completionHandler:))]
        fn write_promise(
            &self,
            _provider: &NSFilePromiseProvider,
            url: &NSURL,
            complete: &block2::DynBlock<dyn Fn(*mut NSError)>,
        ) {
            let mut error = None;
            let result = coordinate_copy(url, self.ivars().source.clone(), &mut error);
            if error.is_none() {
                error = result.as_ref().err().map(promise_error);
            }
            complete.call((error.as_ref().map_or(std::ptr::null_mut(), |error| {
                Retained::as_ptr(error).cast_mut()
            }),));
            self.ivars().report.finish(result.map(|()| true));
        }
    }
);

define_class!(
    // The dragging source is only called on the AppKit thread.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = Arc<Report>]
    struct DragSource;

    unsafe impl NSObjectProtocol for DragSource {}

    unsafe impl NSDraggingSource for DragSource {
        #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
        fn allowed(&self, _session: &NSDraggingSession, context: NSDraggingContext) -> NSDragOperation {
            if context == NSDraggingContext::OutsideApplication {
                NSDragOperation::Copy
            } else {
                NSDragOperation::None
            }
        }

        #[unsafe(method(draggingSession:endedAtPoint:operation:))]
        fn ended(&self, _session: &NSDraggingSession, _point: NSPoint, operation: NSDragOperation) {
            if !operation.contains(NSDragOperation::Copy) {
                self.ivars().finish(Ok(false));
            }
            DRAG.with_borrow_mut(|active| *active = None);
        }
    }
);

pub(super) fn start(
    window: WebviewWindow,
    source: Arc<Source>,
    report: Arc<Report>,
) -> tauri::Result<()> {
    window.with_webview(move |webview| {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        // Tauri supplies the WKWebView pointer while its main-thread closure is running.
        let Some(view) = (unsafe { webview.inner().cast::<NSView>().as_ref() }) else {
            return;
        };
        let Some(window) = view.window() else { return };
        let mouse = view.convertPoint_fromView(
            window.convertPointFromScreen(NSEvent::mouseLocation()),
            None,
        );
        let bounds = view.bounds();
        let inside = mouse.x >= bounds.min().x
            && mouse.x < bounds.max().x
            && mouse.y >= bounds.min().y
            && mouse.y < bounds.max().y;
        if NSEvent::pressedMouseButtons() & 1 == 0 || inside || DRAG.with_borrow(Option::is_some) {
            return;
        }
        let gesture = MOUSE.with_borrow_mut(Option::take);
        let Some(gesture) =
            gesture.filter(|gesture| gesture.down.windowNumber() == window.windowNumber())
        else {
            return;
        };
        let event = gesture.dragged.as_ref().unwrap_or(&gesture.down);
        let delegate: Retained<PromiseDelegate> = unsafe {
            msg_send![
                PromiseDelegate::alloc().set_ivars(PromiseState {
                    source,
                    report: report.clone()
                }),
                init
            ]
        };
        let provider = NSFilePromiseProvider::initWithFileType_delegate(
            NSFilePromiseProvider::alloc(),
            ns_string!("public.data"),
            ProtocolObject::from_ref(&*delegate),
        );
        // The delegate property is weak. The provider keeps the delegate alive through delivery.
        unsafe { provider.setUserInfo(Some(delegate.as_ref())) };
        let item = NSDraggingItem::initWithPasteboardWriter(
            NSDraggingItem::alloc(mtm),
            ProtocolObject::from_ref(&*provider),
        );
        let point = view.convertPoint_fromView(event.locationInWindow(), None);
        let frame = NSRect::new(
            NSPoint::new(point.x - 16.0, point.y - 16.0),
            NSSize::new(32.0, 32.0),
        );
        let icon =
            NSImage::imageWithSystemSymbolName_accessibilityDescription(ns_string!("doc"), None);
        unsafe { item.setDraggingFrame_contents(frame, icon.as_deref().map(|icon| icon.as_ref())) };
        let drag_source: Retained<DragSource> =
            unsafe { msg_send![DragSource::alloc(mtm).set_ivars(report), init] };
        DRAG.with_borrow_mut(|active| *active = Some(drag_source.clone()));
        view.beginDraggingSessionWithItems_event_source(
            &NSArray::from_retained_slice(&[item]),
            event,
            ProtocolObject::from_ref(&*drag_source),
        )
        .setAnimatesToStartingPositionsOnCancelOrFail(false);
    })
}

fn coordinate_copy(
    url: &NSURL,
    source: Arc<Source>,
    coordination_error: &mut Option<Retained<NSError>>,
) -> FsResult<()> {
    let result = RefCell::new(Err(FsError::Io(
        "The system did not provide a writable drop location".into(),
    )));
    let writer = StackBlock::new(|destination: NonNull<NSURL>| {
        // The coordinator retains its URL for the duration of this synchronous accessor.
        *result.borrow_mut() = copy_to(unsafe { destination.as_ref() }, source.clone());
    });
    NSFileCoordinator::new().coordinateWritingItemAtURL_options_error_byAccessor(
        url,
        NSFileCoordinatorWritingOptions::empty(),
        Some(coordination_error),
        &writer,
    );
    if let Some(error) = coordination_error {
        return Err(FsError::Io(error.localizedDescription().to_string()));
    }
    result.into_inner()
}

fn copy_to(url: &NSURL, source: Arc<Source>) -> FsResult<()> {
    if !url.isFileURL() {
        return Err(FsError::InvalidName);
    }
    // NSURL holds the file-system representation through this call.
    let path = unsafe { CStr::from_ptr(url.fileSystemRepresentation().as_ptr()) };
    let path = Path::new(std::ffi::OsStr::from_bytes(path.to_bytes()));
    let parent = path
        .parent()
        .filter(|_| path.is_absolute())
        .ok_or(FsError::InvalidName)?;
    let io_error = |error: std::io::Error| {
        if error.kind() == ErrorKind::AlreadyExists {
            FsError::AlreadyExists(path.display().to_string())
        } else {
            FsError::Io(error.to_string())
        }
    };
    match path.symlink_metadata() {
        Ok(_) => return Err(FsError::AlreadyExists(path.display().to_string())),
        Err(error) if error.kind() != ErrorKind::NotFound => return Err(io_error(error)),
        Err(_) => {}
    }

    let mut staged = tempfile::Builder::new()
        .prefix(".sshastra-drag-")
        .tempfile_in(parent)
        .map_err(io_error)?;
    let runtime = tauri::async_runtime::handle();
    let mut remote = RemoteRead::new(source);
    let mut position = 0;
    let mut buffer = vec![0; CHUNK_SIZE];
    loop {
        let read = runtime.block_on(remote.read_at(position, &mut buffer))?;
        if read == 0 {
            break;
        }
        staged.write_all(&buffer[..read]).map_err(io_error)?;
        position += read as u64;
    }
    staged.as_file().sync_all().map_err(io_error)?;
    staged
        .persist_noclobber(path)
        .map_err(|error| io_error(error.error))?;
    Ok(())
}

fn promise_error(error: &FsError) -> Retained<NSError> {
    let message = NSString::from_str(&error.to_string());
    // Both values have the Foundation types expected for a localized error description.
    unsafe {
        let info = NSDictionary::from_slices(&[NSLocalizedDescriptionKey], &[message.as_ref()]);
        NSError::errorWithDomain_code_userInfo(
            ns_string!("dev.sshastra.app.file-promise"),
            1,
            Some(&info),
        )
    }
}
