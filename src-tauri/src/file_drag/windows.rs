use std::cell::Cell;
use std::ffi::c_void;
use std::mem::{size_of, ManuallyDrop};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, Weak};

use sshastra_core::files::{FsError, FsResult};
use tauri::WebviewWindow;
use windows::core::{implement, Error, Interface, Ref, Result, BOOL, HRESULT};
use windows::Win32::Foundation::{
    GlobalFree, DATA_S_SAMEFORMATETC, DRAGDROP_S_CANCEL, DRAGDROP_S_DROP,
    DRAGDROP_S_USEDEFAULTCURSORS, DV_E_DVASPECT, DV_E_FORMATETC, DV_E_LINDEX, DV_E_TYMED, E_FAIL,
    E_NOTIMPL, E_OUTOFMEMORY, E_POINTER, FILETIME, HWND, OLE_E_ADVISENOTSUPPORTED, POINT, RECT,
    STG_E_READFAULT, S_FALSE, S_OK,
};
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
use windows::Win32::System::Com::Marshal::CoMarshalInterThreadInterfaceInStream;
use windows::Win32::System::Com::StructuredStorage::CoGetInterfaceAndReleaseStream;
use windows::Win32::System::Com::{
    CoInitializeEx, CoUninitialize, IAdviseSink, IBindCtx, IDataObject, IDataObject_Impl,
    IEnumFORMATETC, IEnumSTATDATA, IStream, COINIT_MULTITHREADED, DATADIR_GET, DVASPECT_CONTENT,
    FORMATETC, STGMEDIUM, STGMEDIUM_0, TYMED_HGLOBAL, TYMED_ISTREAM,
};
use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::{
    DoDragDrop, IDropSource, IDropSource_Impl, OleInitialize, OleUninitialize, ReleaseStgMedium,
    DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE,
};
use windows::Win32::System::SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
use windows::Win32::UI::Shell::{
    IDataObjectAsyncCapability, IDataObjectAsyncCapability_Impl, SHCreateStdEnumFmtEtc,
    CFSTR_FILECONTENTS, CFSTR_FILEDESCRIPTORW, CFSTR_INDRAGLOOP, CFSTR_LOGICALPERFORMEDDROPEFFECT,
    CFSTR_PASTESUCCEEDED, CFSTR_PERFORMEDDROPEFFECT, CFSTR_PREFERREDDROPEFFECT, CFSTR_TARGETCLSID,
    FD_ATTRIBUTES, FD_FILESIZE, FD_PROGRESSUI, FD_UNICODE, FD_WRITESTIME, FILEDESCRIPTORW,
    FILEGROUPDESCRIPTORW,
};
use windows::Win32::UI::WindowsAndMessaging::{GetClientRect, GetCursorPos};

use super::{Report, Source};

mod stream;
use stream::{Cursor, FileStream};

thread_local! {
    static DRAG: Cell<bool> = const { Cell::new(false) };
}

pub(super) fn start(
    window: WebviewWindow,
    source: Arc<Source>,
    report: Arc<Report>,
) -> tauri::Result<()> {
    let owner = window.clone();
    // This task is queued to the UI STA after the WebView2 IPC handler returns.
    window.run_on_main_thread(move || {
        let result = owner
            .hwnd()
            .map_err(|error| FsError::Io(error.to_string()))
            .and_then(|hwnd| run(hwnd, source, report.clone()).map_err(win_error));
        if let Err(error) = result {
            report.finish(Err(error));
        }
    })
}

fn run(hwnd: HWND, source: Arc<Source>, report: Arc<Report>) -> Result<()> {
    if DRAG.with(Cell::get) || !outside_while_pressed(hwnd)? {
        return Ok(());
    }
    // OLE drag-and-drop must run on this STA. Balance our own initialization.
    unsafe { OleInitialize(None)? };
    let _ole = OleThread;
    DRAG.with(|active| active.set(true));

    let formats = Formats::new()?;
    let (drag, finished) = Drag::new(source, report);
    let data = data_on_mta(
        DataObject {
            formats,
            drag: drag.clone(),
        },
        finished,
    )?;
    if !outside_while_pressed(hwnd)? {
        return Ok(());
    }
    let drop_source: IDropSource = DropSource { drag: drag.clone() }.into();
    let mut effect = DROPEFFECT_NONE;
    let status = unsafe { DoDragDrop(&data, &drop_source, DROPEFFECT_COPY, &mut effect) };
    drag.in_drag_loop.store(false, Ordering::Release);
    if status == DRAGDROP_S_DROP && effect.contains(DROPEFFECT_COPY) {
        if !drag.extracting.load(Ordering::Acquire) {
            // A synchronous consumer finished its Drop call. A stream already handed
            // to the consumer remains valid independently of the IDataObject.
            if drag.read_started.load(Ordering::Acquire) {
                drag.report.finish(Ok(true));
            }
        }
    } else {
        drag.stop_reading();
        status.ok()?;
        drag.report.finish(Ok(false));
    }
    Ok(())
}

struct OleThread;

impl Drop for OleThread {
    fn drop(&mut self) {
        DRAG.with(|active| active.set(false));
        unsafe { OleUninitialize() };
    }
}

fn outside_while_pressed(hwnd: HWND) -> Result<bool> {
    let mut pointer = POINT::default();
    let mut window = RECT::default();
    unsafe {
        GetCursorPos(&mut pointer)?;
        GetClientRect(hwnd, &mut window)?;
        ScreenToClient(hwnd, &mut pointer).ok()?;
        Ok(GetAsyncKeyState(VK_LBUTTON.0 as i32) < 0
            && (pointer.x < window.left
                || pointer.x >= window.right
                || pointer.y < window.top
                || pointer.y >= window.bottom))
    }
}

// Keep the object and its streams in the MTA. A receiver's synchronous Read blocks
// an RPC thread rather than SSH Astra's UI STA. The apartment remains initialized
// until the final data object, stream, and drop source release their shared state.
fn data_on_mta(data: DataObject, finished: mpsc::Receiver<()>) -> Result<IDataObject> {
    let (send, receive) = mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("file-drag-ole".into())
        .spawn(move || {
            let init = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            if init.is_err() {
                let _ = send.send(Err(init.into()));
                return;
            }
            let data: IDataObject = data.into();
            let packet = unsafe { CoMarshalInterThreadInterfaceInStream(&IDataObject::IID, &data) };
            drop(data);
            // COM's marshalled stream is the one object permitted to cross this apartment boundary.
            let packet = packet.map(|packet| Interface::into_raw(packet) as usize);
            let marshalled = packet.is_ok();
            let _ = send.send(packet);
            if marshalled {
                let _ = finished.recv();
            }
            unsafe { CoUninitialize() };
        })
        .map_err(|error| Error::new(E_FAIL, error.to_string()))?;
    let packet = receive
        .recv()
        .map_err(|error| Error::new(E_FAIL, error.to_string()))??;
    // CoGetInterfaceAndReleaseStream consumes the packet even if unmarshalling fails.
    let packet = ManuallyDrop::new(unsafe { IStream::from_raw(packet as *mut c_void) });
    unsafe { CoGetInterfaceAndReleaseStream(&*packet) }
}

fn win_error(error: Error) -> FsError {
    FsError::Io(error.to_string())
}

struct Drag {
    source: Arc<Source>,
    report: Arc<Report>,
    can_drop: AtomicBool,
    accepted: AtomicBool,
    in_drag_loop: AtomicBool,
    async_mode: AtomicBool,
    extracting: AtomicBool,
    read_started: AtomicBool,
    streams: Mutex<Vec<Weak<Mutex<Cursor>>>>,
    _lifetime: mpsc::Sender<()>,
}

impl Drag {
    fn new(source: Arc<Source>, report: Arc<Report>) -> (Arc<Self>, mpsc::Receiver<()>) {
        let (lifetime, finished) = mpsc::channel();
        let drag = Arc::new(Self {
            source,
            report,
            can_drop: AtomicBool::new(false),
            accepted: AtomicBool::new(false),
            in_drag_loop: AtomicBool::new(true),
            async_mode: AtomicBool::new(true),
            extracting: AtomicBool::new(false),
            read_started: AtomicBool::new(false),
            streams: Mutex::default(),
            _lifetime: lifetime,
        });
        (drag, finished)
    }

    fn stop_reading(&self) {
        self.accepted.store(false, Ordering::Release);
        for stream in self
            .streams
            .lock()
            .unwrap()
            .drain(..)
            .filter_map(|stream| stream.upgrade())
        {
            // Active reads release their handles when they observe the stop after the
            // current SFTP request. Avoid waiting for that request on the OLE STA.
            if let Ok(mut stream) = stream.try_lock() {
                stream.close();
            }
        }
    }

    fn failed(&self, error: FsError) -> HRESULT {
        self.stop_reading();
        self.report.finish(Err(error));
        STG_E_READFAULT
    }
}

#[implement(IDropSource)]
struct DropSource {
    drag: Arc<Drag>,
}

impl IDropSource_Impl for DropSource_Impl {
    fn QueryContinueDrag(&self, escape: BOOL, keys: MODIFIERKEYS_FLAGS) -> HRESULT {
        if escape.as_bool() {
            self.drag.stop_reading();
            return DRAGDROP_S_CANCEL;
        }
        if keys.contains(MK_LBUTTON) {
            return S_OK;
        }
        // OLE calls the target's Drop before DoDragDrop returns. Enable data reads
        // only after release over a target that advertised a copy.
        if self.drag.can_drop.load(Ordering::Acquire) {
            self.drag.accepted.store(true, Ordering::Release);
            self.drag.in_drag_loop.store(false, Ordering::Release);
            DRAGDROP_S_DROP
        } else {
            DRAGDROP_S_CANCEL
        }
    }

    fn GiveFeedback(&self, effect: DROPEFFECT) -> HRESULT {
        self.drag
            .can_drop
            .store(effect.contains(DROPEFFECT_COPY), Ordering::Release);
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}

struct Formats {
    descriptor: u16,
    contents: u16,
    in_drag_loop: u16,
    preferred_effect: u16,
    feedback: [u16; 4],
}

impl Formats {
    fn new() -> Result<Self> {
        let register = |name| {
            let id = unsafe { RegisterClipboardFormatW(name) } as u16;
            if id == 0 {
                Err(Error::from_thread())
            } else {
                Ok(id)
            }
        };
        Ok(Self {
            descriptor: register(CFSTR_FILEDESCRIPTORW)?,
            contents: register(CFSTR_FILECONTENTS)?,
            in_drag_loop: register(CFSTR_INDRAGLOOP)?,
            preferred_effect: register(CFSTR_PREFERREDDROPEFFECT)?,
            feedback: [
                register(CFSTR_PERFORMEDDROPEFFECT)?,
                register(CFSTR_LOGICALPERFORMEDDROPEFFECT)?,
                register(CFSTR_PASTESUCCEEDED)?,
                register(CFSTR_TARGETCLSID)?,
            ],
        })
    }

    fn offer(&self) -> [FORMATETC; 4] {
        let item = |cf_format, lindex, tymed| FORMATETC {
            cfFormat: cf_format,
            dwAspect: DVASPECT_CONTENT.0,
            lindex,
            tymed,
            ..Default::default()
        };
        [
            item(self.descriptor, -1, TYMED_HGLOBAL.0 as u32),
            item(self.contents, 0, TYMED_ISTREAM.0 as u32),
            item(self.in_drag_loop, -1, TYMED_HGLOBAL.0 as u32),
            item(self.preferred_effect, -1, TYMED_HGLOBAL.0 as u32),
        ]
    }

    fn query(&self, request: *const FORMATETC) -> Result<u16> {
        let request = unsafe { request.as_ref() }.ok_or_else(|| Error::from_hresult(E_POINTER))?;
        let offer = self
            .offer()
            .into_iter()
            .find(|format| format.cfFormat == request.cfFormat)
            .ok_or_else(|| Error::from_hresult(DV_E_FORMATETC))?;
        if request.dwAspect != DVASPECT_CONTENT.0 {
            return Err(DV_E_DVASPECT.into());
        }
        if request.lindex != offer.lindex {
            return Err(DV_E_LINDEX.into());
        }
        if request.tymed & offer.tymed == 0 {
            return Err(DV_E_TYMED.into());
        }
        Ok(request.cfFormat)
    }
}

#[implement(IDataObject, IDataObjectAsyncCapability)]
struct DataObject {
    formats: Formats,
    drag: Arc<Drag>,
}

impl IDataObject_Impl for DataObject_Impl {
    fn GetData(&self, format: *const FORMATETC) -> Result<STGMEDIUM> {
        let requested = self.formats.query(format)?;
        if requested == self.formats.contents {
            if self.drag.accepted.load(Ordering::Acquire) && self.drag.source.length.is_none() {
                // The target can complete an empty stream without calling Read.
                self.drag.read_started.store(true, Ordering::Release);
            }
            return Ok(STGMEDIUM {
                tymed: TYMED_ISTREAM.0 as u32,
                u: STGMEDIUM_0 {
                    pstm: ManuallyDrop::new(Some(FileStream::new(self.drag.clone(), 0).into())),
                },
                ..Default::default()
            });
        }
        if requested == self.formats.descriptor {
            return global_medium(descriptor(&self.drag.source));
        }
        if requested == self.formats.in_drag_loop {
            return global_medium(u32::from(self.drag.in_drag_loop.load(Ordering::Acquire)));
        }
        global_medium(DROPEFFECT_COPY.0)
    }

    fn GetDataHere(&self, _format: *const FORMATETC, _medium: *mut STGMEDIUM) -> Result<()> {
        Err(DV_E_TYMED.into())
    }

    fn QueryGetData(&self, format: *const FORMATETC) -> HRESULT {
        self.formats
            .query(format)
            .map_or_else(|error| error.code(), |_| S_OK)
    }

    fn GetCanonicalFormatEtc(&self, _input: *const FORMATETC, output: *mut FORMATETC) -> HRESULT {
        if output.is_null() {
            return E_POINTER;
        }
        unsafe { output.write(FORMATETC::default()) };
        DATA_S_SAMEFORMATETC
    }

    fn SetData(
        &self,
        format: *const FORMATETC,
        medium: *const STGMEDIUM,
        release: BOOL,
    ) -> Result<()> {
        let format = unsafe { format.as_ref() }.ok_or_else(|| Error::from_hresult(E_POINTER))?;
        if medium.is_null() {
            return Err(E_POINTER.into());
        }
        if !self.formats.feedback.contains(&format.cfFormat) {
            return Err(DV_E_FORMATETC.into());
        }
        // Shell feedback does not change the remote file or its permissions.
        if release.as_bool() {
            unsafe { ReleaseStgMedium(medium.cast_mut()) };
        }
        Ok(())
    }

    fn EnumFormatEtc(&self, direction: u32) -> Result<IEnumFORMATETC> {
        if direction != DATADIR_GET.0 as u32 {
            return Err(E_NOTIMPL.into());
        }
        unsafe { SHCreateStdEnumFmtEtc(&self.formats.offer()) }
    }

    fn DAdvise(&self, _: *const FORMATETC, _: u32, _: Ref<IAdviseSink>) -> Result<u32> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }

    fn DUnadvise(&self, _: u32) -> Result<()> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }

    fn EnumDAdvise(&self) -> Result<IEnumSTATDATA> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }
}

impl IDataObjectAsyncCapability_Impl for DataObject_Impl {
    fn SetAsyncMode(&self, enabled: BOOL) -> Result<()> {
        self.drag
            .async_mode
            .store(enabled.as_bool(), Ordering::Release);
        Ok(())
    }

    fn GetAsyncMode(&self) -> Result<BOOL> {
        Ok(self.drag.async_mode.load(Ordering::Acquire).into())
    }

    fn StartOperation(&self, _: Ref<IBindCtx>) -> Result<()> {
        if !self.drag.accepted.load(Ordering::Acquire) {
            return Err(E_FAIL.into());
        }
        self.drag.extracting.store(true, Ordering::Release);
        #[cfg(feature = "e2e")]
        log::info!("file drag OLE asynchronous extraction began");
        Ok(())
    }

    fn InOperation(&self) -> Result<BOOL> {
        Ok(self.drag.extracting.load(Ordering::Acquire).into())
    }

    fn EndOperation(&self, status: HRESULT, _: Ref<IBindCtx>, effect: u32) -> Result<()> {
        self.drag.extracting.store(false, Ordering::Release);
        self.drag.stop_reading();
        #[cfg(feature = "e2e")]
        log::info!("file drag OLE asynchronous extraction ended");
        let result: FsResult<bool> = status.ok().map_err(win_error).map(|()| {
            (effect == DROPEFFECT_COPY.0 || self.drag.read_started.load(Ordering::Acquire))
                && status != S_FALSE
        });
        self.drag.report.finish(result);
        Ok(())
    }
}

fn descriptor(file: &Source) -> FILEGROUPDESCRIPTORW {
    // FILEDESCRIPTORW is packed. Populate its Unicode buffer before building it.
    let mut name = [0u16; 260];
    for (slot, code_unit) in name.iter_mut().zip(file.name.encode_utf16()) {
        *slot = code_unit;
    }
    let mut flags = FD_ATTRIBUTES.0 | FD_UNICODE.0 | FD_PROGRESSUI.0;
    if file.length.is_some() {
        flags |= FD_FILESIZE.0;
    }
    let modified = file.modified.and_then(filetime);
    if modified.is_some() {
        flags |= FD_WRITESTIME.0;
    }
    let size = file.length.unwrap_or_default();
    FILEGROUPDESCRIPTORW {
        cItems: 1,
        fgd: [FILEDESCRIPTORW {
            dwFlags: flags as u32,
            dwFileAttributes: FILE_ATTRIBUTE_NORMAL.0,
            ftLastWriteTime: modified.unwrap_or_default(),
            nFileSizeHigh: (size >> 32) as u32,
            nFileSizeLow: size as u32,
            cFileName: name,
            ..Default::default()
        }],
    }
}

fn filetime(unix_seconds: u64) -> Option<FILETIME> {
    let ticks = unix_seconds
        .checked_add(11_644_473_600)?
        .checked_mul(10_000_000)?;
    Some(FILETIME {
        dwLowDateTime: ticks as u32,
        dwHighDateTime: (ticks >> 32) as u32,
    })
}

fn global_medium<T: Copy>(value: T) -> Result<STGMEDIUM> {
    // OLE owns the movable global memory after GetData returns successfully.
    unsafe {
        let handle = GlobalAlloc(GMEM_MOVEABLE, size_of::<T>())?;
        let target = GlobalLock(handle).cast::<T>();
        if target.is_null() {
            let _ = GlobalFree(Some(handle));
            return Err(E_OUTOFMEMORY.into());
        }
        target.write_unaligned(value);
        let _ = GlobalUnlock(handle);
        Ok(STGMEDIUM {
            tymed: TYMED_HGLOBAL.0 as u32,
            u: STGMEDIUM_0 { hGlobal: handle },
            ..Default::default()
        })
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    #[test]
    fn ole_offers_metadata_on_hover_and_marshals_a_seekable_stream_after_release() {
        unsafe { OleInitialize(None).unwrap() };
        let _ole = OleThread;
        let opens = Arc::new(Mutex::new(Vec::new()));
        let source = Arc::new(Source {
            name: "資料.bin".into(),
            length: Some(5),
            modified: None,
            open: Box::new({
                let opens = opens.clone();
                move |offset| {
                    opens.lock().unwrap().push(offset);
                    let mut input = Cursor::new(b"bytes");
                    input.set_position(offset);
                    Box::pin(async move { Ok(Box::new(input) as sshastra_core::files::FileReader) })
                }
            }),
        });
        let (sender, mut result) = tokio::sync::oneshot::channel();
        let report = Arc::new(Report(Mutex::new(Some(sender))));
        let (drag, finished) = Drag::new(source, report);
        let formats = Formats::new().unwrap();
        let [descriptor_format, stream_format, loop_format, _] = formats.offer();
        let object = data_on_mta(
            DataObject {
                formats,
                drag: drag.clone(),
            },
            finished,
        )
        .unwrap();
        let target: IDropSource = DropSource { drag }.into();

        // Every call below goes through the public OLE interfaces, including the STA-to-MTA proxy.
        unsafe {
            assert_eq!(object.QueryGetData(&descriptor_format), S_OK);
            assert_eq!(object.QueryGetData(&stream_format), S_OK);
            let mut metadata = object.GetData(&descriptor_format).unwrap();
            let handle = metadata.u.hGlobal;
            let descriptor = GlobalLock(handle)
                .cast::<FILEGROUPDESCRIPTORW>()
                .read_unaligned();
            let _ = GlobalUnlock(handle);
            ReleaseStgMedium(&mut metadata);
            let name = descriptor.fgd[0].cFileName;
            assert_eq!(String::from_utf16(&name[..6]).unwrap(), "資料.bin");

            let mut in_drag = object.GetData(&loop_format).unwrap();
            let handle = in_drag.u.hGlobal;
            assert_eq!(GlobalLock(handle).cast::<u32>().read_unaligned(), 1);
            let _ = GlobalUnlock(handle);
            ReleaseStgMedium(&mut in_drag);

            let mut medium = object.GetData(&stream_format).unwrap();
            let stream = medium.u.pstm.as_ref().unwrap().clone();
            ReleaseStgMedium(&mut medium);
            let mut content = [0_u8; 5];
            let waiting = stream.Read(content.as_mut_ptr().cast(), 5, None);
            assert!(waiting.is_err());
            assert!(opens.lock().unwrap().is_empty());

            assert_eq!(
                target.GiveFeedback(DROPEFFECT_COPY),
                DRAGDROP_S_USEDEFAULTCURSORS
            );
            assert_eq!(
                target.QueryContinueDrag(false, MODIFIERKEYS_FLAGS(0)),
                DRAGDROP_S_DROP
            );
            let operation = object.cast::<IDataObjectAsyncCapability>().unwrap();
            assert!(operation.GetAsyncMode().unwrap().as_bool());
            operation.StartOperation(None::<&IBindCtx>).unwrap();
            assert!(operation.InOperation().unwrap().as_bool());

            assert_eq!(stream.Read(content.as_mut_ptr().cast(), 5, None), S_OK);
            assert_eq!(&content, b"bytes");
            stream
                .Seek(2, windows::Win32::System::Com::STREAM_SEEK_SET, None)
                .unwrap();
            let clone = stream.Clone().unwrap();
            let mut bytes = [0_u8; 4];
            let mut read = 0;
            assert_eq!(
                clone.Read(bytes.as_mut_ptr().cast(), 4, Some(&mut read)),
                S_FALSE
            );
            assert_eq!(read, 3);
            assert_eq!(&bytes[..3], b"tes");
            assert_eq!(opens.lock().unwrap().as_slice(), &[0, 2]);

            operation
                .EndOperation(S_OK, None::<&IBindCtx>, DROPEFFECT_COPY.0)
                .unwrap();
            assert_eq!(result.try_recv(), Ok(Ok(true)));
            assert!(!operation.InOperation().unwrap().as_bool());
        }
    }
}
