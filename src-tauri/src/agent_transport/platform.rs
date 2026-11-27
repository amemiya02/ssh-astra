#[cfg(unix)]
#[path = "unix.rs"]
mod endpoint;
#[cfg(windows)]
#[path = "windows.rs"]
mod endpoint;

pub(super) use endpoint::{Endpoint, Listener};
