# Tauri 2 shell with the SSH stack in Rust

We build the desktop app on Tauri 2: a React + TypeScript web front end, with xterm.js as the terminal. SSH and SFTP live in the Rust backend (`russh` / `russh-sftp`). We did not use Electron + Node `ssh2`, the path Tabby and Termius took, even though `ssh2` is the more mature library.

The reason is small installers and low memory use. A lightweight app sets us apart from the existing Electron clients. Keeping the protocol stack and large file transfers in Rust also keeps secrets and heavy I/O out of the webview.

## Consequences

- `russh` is younger than OpenSSH or libssh2, so we may need to add edge-case algorithms or proxy and agent support ourselves.
- Every SSH capability the UI uses crosses the Tauri IPC boundary. Terminal output is streamed to the front end, not polled.
