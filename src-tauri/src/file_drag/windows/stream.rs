use std::ffi::c_void;
use std::ptr;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use windows::core::{implement, Error, Ref, Result, HRESULT, PWSTR};
use windows::Win32::Foundation::{
    E_INVALIDARG, E_OUTOFMEMORY, E_POINTER, STG_E_ACCESSDENIED, STG_E_INVALIDFUNCTION,
    STG_E_MEDIUMFULL, S_FALSE, S_OK,
};
use windows::Win32::System::Com::{
    CoTaskMemAlloc, ISequentialStream_Impl, IStream, IStream_Impl, LOCKTYPE, STATFLAG,
    STATFLAG_NONAME, STATSTG, STGC, STGM_READ, STGTY_STREAM, STREAM_SEEK, STREAM_SEEK_CUR,
    STREAM_SEEK_END, STREAM_SEEK_SET,
};

use super::super::{RemoteRead, CHUNK_SIZE};
use super::{filetime, Drag};

// E_PENDING: the stream can be queried during hover, but no content is ready.
const WAIT_FOR_DROP: HRESULT = HRESULT(0x8000_000a_u32 as i32);

pub(super) struct Cursor {
    offset: u64,
    read: RemoteRead,
}

impl Cursor {
    pub(super) fn close(&mut self) {
        self.read.input = None;
    }
}

#[implement(IStream)]
pub(super) struct FileStream {
    drag: Arc<Drag>,
    cursor: Arc<Mutex<Cursor>>,
}

impl FileStream {
    pub(super) fn new(drag: Arc<Drag>, offset: u64) -> Self {
        let cursor = Arc::new(Mutex::new(Cursor {
            offset,
            read: RemoteRead::new(drag.source.clone()),
        }));
        {
            let mut streams = drag.streams.lock().unwrap();
            streams.retain(|stream| stream.strong_count() != 0);
            streams.push(Arc::downgrade(&cursor));
        }
        Self { cursor, drag }
    }
}

impl ISequentialStream_Impl for FileStream_Impl {
    fn Read(&self, target: *mut c_void, requested: u32, read: *mut u32) -> HRESULT {
        set_count(read, 0);
        if requested == 0 {
            return S_OK;
        }
        if target.is_null() {
            return E_POINTER;
        }
        if requested as usize > isize::MAX as usize {
            return E_INVALIDARG;
        }
        if !self.drag.accepted.load(Ordering::Acquire) {
            return WAIT_FOR_DROP;
        }

        let mut cursor = self.cursor.lock().unwrap();
        let mut copied = 0_u32;
        let mut buffer = [0; CHUNK_SIZE];
        let runtime = tauri::async_runtime::handle();
        while copied < requested {
            if !self.drag.accepted.load(Ordering::Acquire) {
                cursor.close();
                return WAIT_FOR_DROP;
            }
            let capacity = ((requested - copied) as usize).min(buffer.len());
            let offset = cursor.offset;
            let count = match runtime.block_on(cursor.read.read_at(offset, &mut buffer[..capacity]))
            {
                Ok(count) => count,
                Err(error) => {
                    cursor.close();
                    drop(cursor);
                    return self.drag.failed(error);
                }
            };
            if !self.drag.accepted.load(Ordering::Acquire) {
                cursor.close();
                return WAIT_FOR_DROP;
            }
            self.drag.read_started.store(true, Ordering::Release);
            if count == 0 {
                cursor.close();
                return S_FALSE;
            }
            // Copy instead of borrowing the caller's potentially uninitialized buffer.
            unsafe {
                ptr::copy_nonoverlapping(
                    buffer.as_ptr(),
                    target.cast::<u8>().add(copied as usize),
                    count,
                )
            };
            cursor.offset += count as u64;
            copied += count as u32;
            set_count(read, copied);
        }
        S_OK
    }

    fn Write(&self, _data: *const c_void, _count: u32, written: *mut u32) -> HRESULT {
        set_count(written, 0);
        STG_E_ACCESSDENIED
    }
}

impl IStream_Impl for FileStream_Impl {
    fn Seek(&self, delta: i64, origin: STREAM_SEEK, position: *mut u64) -> Result<()> {
        let mut cursor = self.cursor.lock().unwrap();
        let offset = match origin {
            STREAM_SEEK_SET => u64::try_from(delta).ok(),
            STREAM_SEEK_CUR => cursor.offset.checked_add_signed(delta),
            STREAM_SEEK_END => self
                .drag
                .source
                .length
                .unwrap_or_default()
                .checked_add_signed(delta),
            _ => None,
        }
        .ok_or_else(|| Error::from_hresult(STG_E_INVALIDFUNCTION))?;
        if offset != cursor.offset {
            cursor.close();
            cursor.offset = offset;
        }
        set_count(position, offset);
        Ok(())
    }

    fn SetSize(&self, _: u64) -> Result<()> {
        Err(STG_E_ACCESSDENIED.into())
    }

    fn CopyTo(
        &self,
        destination: Ref<IStream>,
        total: u64,
        read: *mut u64,
        written: *mut u64,
    ) -> Result<()> {
        set_count(read, 0);
        set_count(written, 0);
        let destination = destination
            .as_ref()
            .ok_or_else(|| Error::from_hresult(E_POINTER))?;
        let mut buffer = [0_u8; CHUNK_SIZE];
        let mut bytes_read = 0;
        let mut bytes_written = 0;
        while bytes_read < total {
            let capacity = (total - bytes_read).min(buffer.len() as u64) as u32;
            let mut count = 0;
            self.Read(buffer.as_mut_ptr().cast(), capacity, &mut count)
                .ok()?;
            if count == 0 {
                break;
            }
            bytes_read += u64::from(count);
            set_count(read, bytes_read);
            let mut consumed = 0;
            let status =
                unsafe { destination.Write(buffer.as_ptr().cast(), count, Some(&mut consumed)) };
            bytes_written += u64::from(consumed);
            set_count(written, bytes_written);
            status.ok()?;
            if consumed != count {
                return Err(STG_E_MEDIUMFULL.into());
            }
        }
        Ok(())
    }

    fn Commit(&self, _: &STGC) -> Result<()> {
        Ok(())
    }

    fn Revert(&self) -> Result<()> {
        Err(STG_E_INVALIDFUNCTION.into())
    }

    fn LockRegion(&self, _: u64, _: u64, _: &LOCKTYPE) -> Result<()> {
        Err(STG_E_INVALIDFUNCTION.into())
    }

    fn UnlockRegion(&self, _: u64, _: u64, _: u32) -> Result<()> {
        Err(STG_E_INVALIDFUNCTION.into())
    }

    fn Stat(&self, output: *mut STATSTG, flags: &STATFLAG) -> Result<()> {
        if output.is_null() {
            return Err(E_POINTER.into());
        }
        let source = &self.drag.source;
        let mut stat = STATSTG {
            r#type: STGTY_STREAM.0 as u32,
            cbSize: source.length.unwrap_or_default(),
            grfMode: STGM_READ,
            mtime: source.modified.and_then(filetime).unwrap_or_default(),
            ..Default::default()
        };
        if *flags != STATFLAG_NONAME {
            let name: Vec<u16> = source.name.encode_utf16().chain(Some(0)).collect();
            // The consumer frees STATSTG's name using CoTaskMemFree.
            let buffer =
                unsafe { CoTaskMemAlloc(std::mem::size_of_val(name.as_slice())).cast::<u16>() };
            if buffer.is_null() {
                return Err(E_OUTOFMEMORY.into());
            }
            unsafe { ptr::copy_nonoverlapping(name.as_ptr(), buffer, name.len()) };
            stat.pwcsName = PWSTR(buffer);
        }
        unsafe { output.write(stat) };
        Ok(())
    }

    fn Clone(&self) -> Result<IStream> {
        let offset = self.cursor.lock().unwrap().offset;
        Ok(FileStream::new(self.drag.clone(), offset).into())
    }
}

fn set_count<T>(out: *mut T, value: T) {
    if !out.is_null() {
        // COM permits callers to omit count output parameters.
        unsafe { out.write(value) };
    }
}
