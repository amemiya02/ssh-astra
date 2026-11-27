use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::CStr;
use std::io::{ErrorKind, Write};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use block2::StackBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{
    define_class, msg_send, AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, Message,
};
use objc2_app_kit::{
    NSDragOperation, NSDraggingContext, NSDraggingItem, NSDraggingSession, NSDraggingSource,
    NSEvent, NSEventMask, NSEventType, NSImage, NSImageNameMultipleDocuments, NSView,
};
use objc2_app_kit::{NSFilePromiseProvider, NSFilePromiseProviderDelegate};
use objc2_foundation::{
    ns_string, NSArray, NSDictionary, NSError, NSFileCoordinator, NSFileCoordinatorWritingOptions,
    NSLocalizedDescriptionKey, NSObject, NSObjectProtocol, NSOperationQueue, NSPoint, NSRect,
    NSSize, NSString, NSURL,
};
use sshastra_core::files::{FsError, FsResult};
use tauri::{AppHandle, Manager, WebviewWindow};

use super::{PointerState, RemoteRead, Report, Source, CHUNK_SIZE};

thread_local! {
    static MONITOR: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
    static MOUSE_DOWN: RefCell<Option<Retained<NSEvent>>> = const { RefCell::new(None) };
    static DRAG: RefCell<Option<Retained<DragSource>>> = const { RefCell::new(None) };
    static PROMISES: RefCell<HashMap<usize, Retained<NSFilePromiseProvider>>> = RefCell::default();
}

pub(crate) fn capture_mouse_events() {
    let mask = NSEventMask::LeftMouseDown | NSEventMask::LeftMouseUp;
    let monitor = StackBlock::new(|event: NonNull<NSEvent>| {
        // AppKit owns the event for this callback and executes local monitors on its UI thread.
        let mouse = unsafe { event.as_ref() };
        MOUSE_DOWN.with_borrow_mut(|gesture| match mouse.r#type() {
            NSEventType::LeftMouseDown => *gesture = Some(mouse.retain()),
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
    queue: Retained<NSOperationQueue>,
    delivery: Option<Delivery>,
}

#[derive(Clone)]
struct Delivery {
    app: AppHandle,
    started: Arc<AtomicBool>,
}

fn promise_id(report: &Arc<Report>) -> usize {
    Arc::as_ptr(report) as usize
}

fn release_promise(id: usize) -> bool {
    PROMISES.with_borrow_mut(|pending| pending.remove(&id).is_some())
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
            #[cfg(feature = "e2e")]
            log::info!("file drag AppKit requested the promise name");
            NSString::from_str(&self.ivars().source.name)
        }

        #[unsafe(method_id(operationQueueForFilePromiseProvider:))]
        fn queue(&self, _provider: &NSFilePromiseProvider) -> Retained<NSOperationQueue> {
            #[cfg(feature = "e2e")]
            log::info!("file drag AppKit requested the promise queue");
            self.ivars().queue.clone()
        }

        #[unsafe(method(filePromiseProvider:writePromiseToURL:completionHandler:))]
        fn write_promise(
            &self,
            _provider: &NSFilePromiseProvider,
            url: &NSURL,
            complete: &block2::DynBlock<dyn Fn(*mut NSError)>,
        ) {
            #[cfg(feature = "e2e")]
            log::info!("file drag AppKit requested the file contents");
            let state = self.ivars();
            if let Some(delivery) = &state.delivery {
                delivery.started.store(true, Ordering::Release);
            }
            let mut error = None;
            let result = coordinate_copy(url, state.source.clone(), &mut error);
            if error.is_none() {
                error = result.as_ref().err().map(promise_error);
            }
            complete.call((error.as_ref().map_or(std::ptr::null_mut(), |error| {
                Retained::as_ptr(error).cast_mut()
            }),));
            #[cfg(feature = "e2e")]
            log::info!(
                "file drag AppKit finished writing success={}",
                result.is_ok()
            );
            state.report.finish(result.map(|()| true));
            if let Some(delivery) = &state.delivery {
                let id = promise_id(&state.report);
                let _ = delivery.app.run_on_main_thread(move || {
                    release_promise(id);
                });
            }
        }
    }
);

impl PromiseDelegate {
    fn new(source: Arc<Source>, report: Arc<Report>, delivery: Option<Delivery>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(PromiseState {
            source,
            report,
            delivery,
            queue: NSOperationQueue::new(),
        });
        unsafe { msg_send![super(this), init] }
    }
}

fn physical_pointer(view: &NSView) -> Option<(isize, PointerState)> {
    let window = view.window()?;
    let gesture = MOUSE_DOWN.with_borrow(|mouse| {
        let down = mouse.as_ref()?;
        (down.windowNumber() == window.windowNumber()).then(|| down.eventNumber())
    })?;
    let mouse = view.convertPoint_fromView(
        window.convertPointFromScreen(NSEvent::mouseLocation()),
        None,
    );
    let bounds = view.bounds();
    let inside = mouse.x >= bounds.min().x
        && mouse.x < bounds.max().x
        && mouse.y >= bounds.min().y
        && mouse.y < bounds.max().y;
    let state = if NSEvent::pressedMouseButtons() & 1 == 0 {
        PointerState::Released
    } else if inside {
        PointerState::Inside
    } else {
        PointerState::Outside
    };
    Some((gesture, state))
}

pub(super) async fn sample_pointer(window: &WebviewWindow) -> Option<(isize, PointerState)> {
    let (send, receive) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |webview| {
            // Tauri supplies the WKWebView pointer while this main-thread callback runs.
            let view = unsafe { webview.inner().cast::<NSView>().as_ref() };
            let _ = send.send(view.and_then(physical_pointer));
        })
        .ok()?;
    receive.await.ok().flatten()
}

struct DragState {
    delivery: Delivery,
    report: Arc<Report>,
}

define_class!(
    // The dragging source is only called on the AppKit thread.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = DragState]
    struct DragSource;

    unsafe impl NSObjectProtocol for DragSource {}

    unsafe impl NSDraggingSource for DragSource {
        #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
        fn allowed(
            &self,
            _session: &NSDraggingSession,
            context: NSDraggingContext,
        ) -> NSDragOperation {
            if context == NSDraggingContext::OutsideApplication {
                NSDragOperation::Copy
            } else {
                NSDragOperation::None
            }
        }

        #[unsafe(method(draggingSession:endedAtPoint:operation:))]
        fn ended(&self, _session: &NSDraggingSession, _point: NSPoint, operation: NSDragOperation) {
            #[cfg(feature = "e2e")]
            log::info!("file drag ended AppKit session operation={}", operation.0);
            let state = self.ivars();
            if operation.contains(NSDragOperation::Copy) {
                let Delivery { app, started } = state.delivery.clone();
                let report = state.report.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                    let _ = app.run_on_main_thread(move || {
                        if !started.load(Ordering::Acquire) && release_promise(promise_id(&report))
                        {
                            report.finish(Err(FsError::Io(
                                "The drop target did not request the file".into(),
                            )));
                        }
                    });
                });
            } else {
                release_promise(promise_id(&state.report));
                state.report.finish(Ok(false));
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
    let app = window.app_handle().clone();
    window.with_webview(move |webview| {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        // Tauri supplies the WKWebView pointer while its main-thread closure is running.
        let Some(view) = (unsafe { webview.inner().cast::<NSView>().as_ref() }) else {
            return;
        };
        if !matches!(physical_pointer(view), Some((_, PointerState::Outside)))
            || DRAG.with_borrow(Option::is_some)
        {
            return;
        }
        let Some(event) = MOUSE_DOWN.with_borrow_mut(Option::take) else {
            return;
        };
        let delivery = Delivery {
            app,
            started: Arc::new(AtomicBool::new(false)),
        };
        let delegate = PromiseDelegate::new(source, report.clone(), Some(delivery.clone()));
        let provider = NSFilePromiseProvider::initWithFileType_delegate(
            NSFilePromiseProvider::alloc(),
            ns_string!("public.data"),
            ProtocolObject::from_ref(&*delegate),
        );
        // The delegate property is weak. The provider keeps the delegate alive through delivery.
        unsafe { provider.setUserInfo(Some(delegate.as_ref())) };
        let item = NSDraggingItem::initWithPasteboardWriter(
            NSDraggingItem::alloc(),
            ProtocolObject::from_ref(&*provider),
        );
        let point = view.convertPoint_fromView(event.locationInWindow(), None);
        let frame = NSRect::new(
            NSPoint::new(point.x - 16.0, point.y - 16.0),
            NSSize::new(32.0, 32.0),
        );
        let icon = NSImage::imageNamed(unsafe { NSImageNameMultipleDocuments });
        unsafe { item.setDraggingFrame_contents(frame, icon.as_deref().map(|icon| icon.as_ref())) };
        let this = DragSource::alloc(mtm).set_ivars(DragState {
            delivery,
            report: report.clone(),
        });
        let drag_source: Retained<DragSource> = unsafe { msg_send![super(this), init] };
        DRAG.with_borrow_mut(|active| *active = Some(drag_source.clone()));
        PROMISES.with_borrow_mut(|pending| pending.insert(promise_id(&report), provider));
        let items = NSArray::from_retained_slice(&[item]);
        let source: &ProtocolObject<dyn NSDraggingSource> = ProtocolObject::from_ref(&*drag_source);
        // AppKit requires the original mouse-down event. The method can return nil
        // if AppKit cannot start the session, even though the SDK declares it nonnull.
        let session: Option<Retained<NSDraggingSession>> = unsafe {
            msg_send![view, beginDraggingSessionWithItems: &*items, event: &*event, source: source]
        };
        let Some(session) = session else {
            DRAG.with_borrow_mut(|active| *active = None);
            release_promise(promise_id(&report));
            report.finish(Err(FsError::Io(
                "AppKit could not start the file drag".into(),
            )));
            return;
        };
        #[cfg(feature = "e2e")]
        log::info!("file drag started AppKit session");
        session.setAnimatesToStartingPositionsOnCancelOrFail(false);
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

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::io::Cursor;
    use std::rc::Rc;

    use super::*;

    #[test]
    fn coordinate_a_promise_at_the_system_path_without_overwriting() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("資料.bin");
        let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str().unwrap()));
        let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let file = Arc::new(Source {
            name: "資料.bin".into(),
            length: Some(5),
            open: Box::new({
                let attempts = attempts.clone();
                move |_| {
                    attempts.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    Box::pin(async {
                        Ok(Box::new(Cursor::new(b"bytes")) as sshastra_core::files::FileReader)
                    })
                }
            }),
        });
        let (sender, mut result) = tokio::sync::oneshot::channel();
        let report = Arc::new(Report(std::sync::Mutex::new(Some(sender))));
        let delegate = PromiseDelegate::new(file, report, None);
        let delegate: &ProtocolObject<dyn NSFilePromiseProviderDelegate> =
            ProtocolObject::from_ref(&*delegate);
        let provider = NSFilePromiseProvider::initWithFileType_delegate(
            NSFilePromiseProvider::alloc(),
            ns_string!("public.data"),
            delegate,
        );
        assert_eq!(attempts.load(std::sync::atomic::Ordering::Relaxed), 0);

        let succeeded = Rc::new(Cell::new(false));
        let completion = StackBlock::new({
            let succeeded = succeeded.clone();
            move |error: *mut NSError| succeeded.set(error.is_null())
        });
        delegate.filePromiseProvider_writePromiseToURL_completionHandler(
            &provider,
            &url,
            &completion,
        );
        assert!(succeeded.get());
        assert_eq!(result.try_recv(), Ok(Ok(true)));
        assert_eq!(std::fs::read(&path).unwrap(), b"bytes");

        let failed = Rc::new(Cell::new(false));
        let completion = StackBlock::new({
            let failed = failed.clone();
            move |error: *mut NSError| failed.set(!error.is_null())
        });
        delegate.filePromiseProvider_writePromiseToURL_completionHandler(
            &provider,
            &url,
            &completion,
        );
        assert!(failed.get());
        assert_eq!(attempts.load(std::sync::atomic::Ordering::Relaxed), 1);
        assert_eq!(std::fs::read(&path).unwrap(), b"bytes");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn removes_the_staging_file_when_remote_content_is_incomplete() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("partial.bin");
        let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str().unwrap()));
        let file = Arc::new(Source {
            name: "partial.bin".into(),
            length: Some(90_000),
            open: Box::new(|_| {
                Box::pin(async {
                    Ok(Box::new(Cursor::new(vec![7_u8; 65_000]))
                        as sshastra_core::files::FileReader)
                })
            }),
        });
        assert!(coordinate_copy(&url, file, &mut None).is_err());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }
}
