//! Explicit Terminal paste is the only entry point for clipboard image reads.

use std::io;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use arboard::{Clipboard, Error as ClipboardError, ImageData};
use sshastra_core::files::{join, FsError, RemoteFs, RemoteTransfer, TransferHost};
use sshastra_core::ssh::ConnectionManager;
use sshastra_core::terminal::{TerminalId, TerminalRegistry};
use tauri::{State, WebviewWindow};
use tempfile::{Builder, NamedTempFile, TempDir};

use super::{terminal::with_terminal, transfers::TransfersState};
use crate::error::CommandResult;

const CACHE_DIRECTORY: &str = ".sshastra-clipboard";
const MAX_PIXELS: usize = 16 * 1024 * 1024;
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Default)]
pub struct ClipboardImages {
    /// At most one decoded image and one pending image upload.
    active: tokio::sync::Mutex<()>,
    directory: Arc<Mutex<Option<TempDir>>>,
}

impl ClipboardImages {
    pub fn close(&self) {
        let directory = self
            .directory
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        drop(directory);
    }
}

#[tauri::command]
pub async fn terminal_save_clipboard_image(
    window: WebviewWindow,
    images: State<'_, ClipboardImages>,
    connections: State<'_, ConnectionManager>,
    transfers: State<'_, TransfersState>,
    terminals: State<'_, TerminalRegistry>,
    id: TerminalId,
    host: Option<TransferHost>,
    generation: Option<u64>,
) -> CommandResult<Option<String>> {
    let connection = with_terminal(&window, id, || Ok(terminals.connection(id)?))?;
    let target = match (host, generation, connection) {
        (Some(host), Some(expected), Some((actual, connection))) if expected == actual => {
            Some((host, expected, connection))
        }
        (None, None, None) => None,
        _ => return Err(FsError::NotConnected.into()),
    };
    let _active = images.active.try_lock().map_err(|_| {
        io::Error::new(
            io::ErrorKind::WouldBlock,
            "another clipboard image paste is active",
        )
    })?;
    let directory = Arc::clone(&images.directory);
    let file = tauri::async_runtime::spawn_blocking(move || {
        let Some(image) = read_image_only()? else {
            return Ok::<_, io::Error>(None);
        };
        let path = {
            let mut directory = directory
                .lock()
                .map_err(|_| io::Error::other("clipboard image directory unavailable"))?;
            if directory.is_none() {
                *directory = Some(Builder::new().prefix("sshastra-clipboard-").tempdir()?);
            }
            directory
                .as_ref()
                .expect("clipboard image directory was initialized")
                .path()
                .to_owned()
        };
        Ok(Some(write_png(image, &path)?))
    })
    .await
    .map_err(io::Error::other)??;
    let Some(file) = file else { return Ok(None) };

    let path = if let Some((host, generation, connection)) = target {
        if !matches!(terminals.connection(id)?, Some((current, _)) if current == generation) {
            return Err(FsError::NotConnected.into());
        }
        let sftp = connections
            .sftp_for_connection(&host.id, &connection)
            .await?;
        let remote_directory = sftp.private_home_directory(CACHE_DIRECTORY).await?;
        let filename = file
            .path()
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or(FsError::InvalidName)?;
        let path = join(&remote_directory, filename);
        if !path.starts_with('/') || path.chars().any(char::is_control) {
            return Err(FsError::InvalidName.into());
        }
        // The upload must use this Connection even if the Host reconnects while
        // it is queued. The queue row must never keep the Connection alive.
        let fs: Arc<dyn RemoteFs> = sftp;
        let pinned = Arc::downgrade(&fs);
        let target = RemoteTransfer {
            host,
            open: Arc::new(move || {
                let fs = pinned.upgrade();
                Box::pin(
                    async move { fs.ok_or_else(|| FsError::Io("image paste has ended".into())) },
                )
            }),
        };
        let queue = transfers.queue();
        let (id, complete) =
            queue.upload_private_file(target, file.path().to_owned(), remote_directory);
        match tokio::time::timeout(UPLOAD_TIMEOUT, complete).await {
            Ok(result) => result.map_err(io::Error::other)??,
            Err(_) => {
                queue.cancel(id);
                return Err(FsError::TimedOut.into());
            }
        }
        path
    } else {
        let path = file.path().to_str().ok_or(FsError::InvalidName)?.to_owned();
        // A local paste needs the PNG after IPC returns. Its containing
        // private TempDir is owned by the application for this run.
        file.keep().map_err(|error| error.error)?;
        path
    };
    Ok(Some(path))
}

fn missing<T>(result: Result<T, ClipboardError>) -> io::Result<bool> {
    match result {
        Ok(_) => Ok(false),
        Err(ClipboardError::ContentNotAvailable) => Ok(true),
        Err(error) => Err(io::Error::other(error)),
    }
}

fn read_image_only() -> io::Result<Option<ImageData<'static>>> {
    // The existing clipboard plugin uses arboard as well. Use its typed
    // format errors here to distinguish absent content from a failed read.
    let mut clipboard = Clipboard::new().map_err(io::Error::other)?;
    if !image_formats_only(&mut clipboard)? {
        return Ok(None);
    }
    let image = match clipboard.get_image() {
        Ok(image) => image,
        Err(ClipboardError::ContentNotAvailable) => return Ok(None),
        Err(error) => return Err(io::Error::other(error)),
    };
    // A different clipboard owner may have published text during the read.
    Ok(image_formats_only(&mut clipboard)?.then_some(image))
}

fn image_formats_only(clipboard: &mut Clipboard) -> io::Result<bool> {
    Ok(missing(clipboard.get_text())?
        && missing(clipboard.get().html())?
        && missing(clipboard.get().file_list())?)
}

fn write_png(image: ImageData<'_>, directory: &Path) -> io::Result<NamedTempFile> {
    let pixels = image.width.checked_mul(image.height);
    if !matches!(pixels, Some(count) if count > 0 && count <= MAX_PIXELS && image.bytes.len() == count * 4)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "clipboard image dimensions are invalid or too large",
        ));
    }
    let mut file = Builder::new()
        .prefix("image-")
        .suffix(".png")
        .rand_bytes(24)
        .tempfile_in(directory)?;
    let mut png = png::Encoder::new(file.as_file_mut(), image.width as u32, image.height as u32);
    png.set_color(png::ColorType::Rgba);
    png.set_depth(png::BitDepth::Eight);
    let mut writer = png.write_header().map_err(io::Error::other)?;
    writer
        .write_image_data(&image.bytes)
        .map_err(io::Error::other)?;
    writer.finish().map_err(io::Error::other)?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::borrow::Cow;
    use std::io::BufReader;

    #[test]
    fn private_temp_files_hold_the_original_pixels_under_distinct_png_paths() {
        let directory = tempfile::tempdir().unwrap();
        let pixels = [3, 127, 250, 192];
        let image = ImageData {
            width: 1,
            height: 1,
            bytes: Cow::Borrowed(&pixels),
        };
        let first = write_png(image.clone(), directory.path()).unwrap();
        let second = write_png(image, directory.path()).unwrap();
        assert_ne!(first.path(), second.path());
        assert_eq!(first.path().extension().unwrap(), "png");
        assert_eq!(first.path().parent().unwrap(), directory.path());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                first.as_file().metadata().unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        let file = std::fs::File::open(first.path()).unwrap();
        let mut reader = png::Decoder::new(BufReader::new(file)).read_info().unwrap();
        let mut decoded = vec![0; reader.output_buffer_size().unwrap()];
        let frame = reader.next_frame(&mut decoded).unwrap();
        assert_eq!((frame.width, frame.height), (1, 1));
        assert_eq!(decoded, pixels);
    }

    #[test]
    fn oversized_or_malformed_images_leave_no_temporary_file() {
        let directory = tempfile::tempdir().unwrap();
        for (width, height) in [(MAX_PIXELS, 2), (usize::MAX, 2), (1, 1)] {
            let image = ImageData {
                width,
                height,
                bytes: Cow::Borrowed(&[]),
            };
            assert_eq!(
                write_png(image, directory.path()).unwrap_err().kind(),
                io::ErrorKind::InvalidData
            );
        }
        assert!(std::fs::read_dir(directory.path())
            .unwrap()
            .next()
            .is_none());
    }
}
