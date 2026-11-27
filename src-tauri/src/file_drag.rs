//! Native promises carry listing metadata until the target asks for a dropped file.

use std::sync::{Arc, Mutex};

use serde::Deserialize;
use sshastra_core::files::{FileReader, FsError, FsId, FsResult};
use sshastra_core::ssh::BoxFuture;
use tokio::io::AsyncReadExt;
use tokio::sync::oneshot;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;
#[cfg(target_os = "macos")]
pub(crate) use macos::capture_mouse_events;

const CHUNK_SIZE: usize = 32 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePromise {
    pub id: FsId,
    directory: String,
    name: String,
    size: u64,
    modified: Option<u64>,
}

impl FilePromise {
    fn path(&self, windows: bool) -> FsResult<String> {
        if !valid_name(&self.name, windows)
            || !self.directory.starts_with('/')
            || self.directory.contains('\0')
            || self
                .directory
                .split('/')
                .any(|component| matches!(component, "." | ".."))
        {
            return Err(FsError::InvalidName);
        }
        Ok(format!(
            "{}/{}",
            self.directory.trim_end_matches('/'),
            self.name
        ))
    }
}

fn valid_name(name: &str, windows: bool) -> bool {
    if matches!(name, "" | "." | "..")
        || name.contains(['/', '\\', ':'])
        || name.chars().any(char::is_control)
    {
        return false;
    }
    if !windows {
        return name.len() <= 255;
    }

    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ');
    let device = stem.to_ascii_uppercase();
    let reserved = matches!(
        device.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || device
        .strip_prefix("COM")
        .or_else(|| device.strip_prefix("LPT"))
        .is_some_and(|number| {
            matches!(
                number,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        });
    !reserved
        && name.encode_utf16().count() <= 255
        && !name.ends_with([' ', '.'])
        && !name.contains(['<', '>', '"', '|', '?', '*'])
}

type OpenReader = dyn Fn(u64) -> BoxFuture<'static, FsResult<FileReader>> + Send + Sync;

struct Source {
    name: String,
    // SFTP listings represent a missing size as zero, which may also be an empty file.
    length: Option<u64>,
    #[cfg(windows)]
    modified: Option<u64>,
    open: Box<OpenReader>,
}

struct RemoteRead {
    source: Arc<Source>,
    input: Option<FileReader>,
    position: u64,
}

impl RemoteRead {
    fn new(source: Arc<Source>) -> Self {
        Self {
            source,
            input: None,
            position: 0,
        }
    }

    /// Serves one bounded chunk at the requested offset. Sequential requests keep one SFTP handle.
    /// A new stream or an out-of-order request starts an independent read on the same Connection.
    async fn read_at(&mut self, offset: u64, output: &mut [u8]) -> FsResult<usize> {
        if output.is_empty() || self.source.length.is_some_and(|length| offset > length) {
            return Ok(0);
        }
        if self.position != offset {
            self.input = None;
        }
        if self.input.is_none() {
            self.input = Some((self.source.open)(offset).await?);
            self.position = offset;
        }
        let input = self.input.as_mut().expect("the reader was opened above");
        let chunk_size = output.len().min(CHUNK_SIZE);
        log::trace!("file drag SFTP read offset={offset} bytes={chunk_size}");
        let read = input
            .read(&mut output[..chunk_size])
            .await
            .map_err(|error| FsError::Io(error.to_string()))?;
        self.position += read as u64;
        if let Some(length) = self.source.length {
            if self.position > length || (read == 0 && self.position < length) {
                self.input = None;
                return Err(FsError::Protocol(
                    "The remote file changed size during the copy".into(),
                ));
            }
        }
        Ok(read)
    }
}

#[cfg(any(windows, target_os = "macos"))]
struct Report(Mutex<Option<oneshot::Sender<FsResult<bool>>>>);

#[cfg(any(windows, target_os = "macos"))]
impl Report {
    fn finish(&self, result: FsResult<bool>) {
        if let Some(sender) = self.0.lock().unwrap().take() {
            let _ = sender.send(result);
        }
    }
}

#[cfg(any(windows, target_os = "macos"))]
pub(crate) async fn start(
    window: tauri::WebviewWindow,
    file: FilePromise,
    fs: Arc<sshastra_core::files::SftpFs>,
) -> crate::error::CommandResult<bool> {
    let path = Arc::<str>::from(file.path(cfg!(windows))?);
    let length = (file.size != 0).then_some(file.size);
    let modified = file.modified;
    let source = Arc::new(Source {
        name: file.name,
        length,
        #[cfg(windows)]
        modified,
        open: Box::new(move |offset| {
            let fs = fs.clone();
            let path = path.clone();
            Box::pin(async move {
                fs.open_regular_read_at(&path, offset, length, modified)
                    .await
            })
        }),
    });
    let (sender, done) = oneshot::channel();
    let report = Arc::new(Report(Mutex::new(Some(sender))));
    #[cfg(target_os = "macos")]
    let started = macos::start(window, source, report);
    #[cfg(windows)]
    let started = windows::start(window, source, report);
    started.map_err(|error| FsError::Io(error.to_string()))?;
    Ok(done.await.unwrap_or(Ok(false))?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Cursor,
        sync::atomic::{AtomicUsize, Ordering},
    };

    #[test]
    fn rejects_path_syntax_and_windows_devices_but_keeps_unicode() {
        for name in ["../file", "a/b", "a\\b", "..", "a:b", "a\0b"] {
            assert!(!valid_name(name, false));
            assert!(!valid_name(name, true));
        }
        for name in ["con", "LPT².txt", "AUX .txt", "file. ", "file*.txt"] {
            assert!(!valid_name(name, true));
        }
        let file = FilePromise {
            id: serde_json::from_str("1").unwrap(),
            directory: "/home/me".into(),
            name: "資料.txt".into(),
            size: 0,
            modified: None,
        };
        assert_eq!(file.path(true), Ok("/home/me/資料.txt".into()));
    }

    #[tokio::test]
    async fn constructs_metadata_without_opening_and_reads_bounded_chunks_at_requested_offsets() {
        let opens = Arc::new(Mutex::new(Vec::new()));
        let reads = Arc::new(AtomicUsize::new(0));
        let bytes = Arc::new((0..100_000).map(|n| (n % 251) as u8).collect::<Vec<_>>());
        let source = Arc::new(Source {
            name: "document.dat".into(),
            length: Some(bytes.len() as u64),
            #[cfg(windows)]
            modified: None,
            open: Box::new({
                let opens = opens.clone();
                let reads = reads.clone();
                let bytes = bytes.clone();
                move |offset| {
                    opens.lock().unwrap().push(offset);
                    let mut reader = Cursor::new(bytes.as_ref().clone());
                    reader.set_position(offset);
                    let reader = CountingReader(reader, reads.clone());
                    Box::pin(async move { Ok(Box::new(reader) as FileReader) })
                }
            }),
        });
        let mut reader = RemoteRead::new(source.clone());
        assert_eq!(source.name, "document.dat");
        assert!(opens.lock().unwrap().is_empty());
        assert_eq!(reads.load(Ordering::Relaxed), 0);

        let mut output = vec![0; 50_000];
        let first = reader.read_at(0, &mut output).await.unwrap();
        assert_eq!(first, 32 * 1024);
        assert_eq!(&output[..first], &bytes[..first]);
        let next = reader.read_at(first as u64, &mut output).await.unwrap();
        assert_eq!(&output[..next], &bytes[first..first + next]);
        let sought = reader.read_at(99_000, &mut output).await.unwrap();
        assert_eq!(&output[..sought], &bytes[99_000..]);
        assert_eq!(reader.read_at(100_000, &mut output).await.unwrap(), 0);
        assert_eq!(opens.lock().unwrap().as_slice(), &[0, 99_000]);
    }

    struct CountingReader(Cursor<Vec<u8>>, Arc<AtomicUsize>);

    impl tokio::io::AsyncRead for CountingReader {
        fn poll_read(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            output: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            self.1.fetch_add(1, Ordering::Relaxed);
            std::pin::Pin::new(&mut self.0).poll_read(cx, output)
        }
    }
}
