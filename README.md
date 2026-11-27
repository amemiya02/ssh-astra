<div align="center">

<img src="src-tauri/icons/icon-source.png" alt="SSH Astra logo" width="112" height="112">

# SSH Astra

A modern, good-looking SSH & SFTP client for Windows, macOS and Linux.

[![CI](https://img.shields.io/github/actions/workflow/status/amemiya02/ssh-astra/ci.yml?branch=main&label=CI&logo=githubactions&logoColor=white)](https://github.com/amemiya02/ssh-astra/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/amemiya02/ssh-astra?include_prereleases&sort=semver&logo=github)](https://github.com/amemiya02/ssh-astra/releases)
[![License: MIT](https://img.shields.io/github/license/amemiya02/ssh-astra?color=blue)](LICENSE)
![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24C8DB?logo=tauri&logoColor=white)](https://tauri.app)

**English** · [简体中文](README.zh-CN.md)

<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/screenshots/main-light.png">
  <img src="docs/screenshots/hero-dark.png" alt="SSH Astra: Host list, Terminal and a File panel following the shell's cd" width="100%">
</picture>

</div>

## Features

- **Hosts**: groups, search, import from `~/.ssh/config` and CSV, Jump hosts.
- **Terminals**: tabs and split panes; xterm.js with WebGL rendering.
- **SFTP File panel**: follows your shell's `cd`. Has a transfer queue and drag-and-drop upload. Edited files save back to the server on their own.
- **Port forwards**: local, remote and SOCKS5; can start when you connect.
- **Security**: ssh-agent, private keys, OpenSSH user certificates, passwords and 2FA; secrets stay in the OS keychain; shares `known_hosts` with OpenSSH.
- **Reconnects** on its own after a dropped Connection.
- **System notifications** report finished transfer batches, failed reconnections, and requests from Terminal programs while the window is in the background. Choose categories in **Settings → Notifications**.
- **Polish**: ⌘K command palette, light and dark themes, English, 简体中文, and 繁體中文, in-app updates.

<table>
  <tr>
    <td><img src="docs/screenshots/split-panes.png" alt="Split panes"></td>
    <td><img src="docs/screenshots/file-transfers.png" alt="Transfer queue"></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/port-forwards.png" alt="Port forwards"></td>
    <td><img src="docs/screenshots/command-palette.png" alt="Command palette"></td>
  </tr>
</table>

## Terminal shortcuts

| Action | macOS | Windows and Linux |
| --- | --- | --- |
| Increase font size | `⌘+` | `Ctrl++` |
| Decrease font size | `⌘-` | `Ctrl+-` |
| Zoom with the wheel | Hold Command or Control and scroll over a Terminal | Hold Ctrl and scroll over a Terminal |

Zoom changes the saved font size for all Terminals within 8–32 px. The increase shortcut also accepts the `=` key.

### Terminal logs

Start or stop a Terminal log from its tab menu or the command palette. An active log is marked on the tab, including when a split is unfocused. In **Settings → Terminal**, choose a save folder and optionally turn on logging for every new Terminal. The default is off.

Each UTF-8 file is named using the Host name (or `Local`) and start time in UTC. Remote Terminals keep writing to the same file when they reconnect. Logs contain plain-text shell output, including any commands the shell echoes. When the save folder is left at its default, files go into `terminal-logs` in SSH Astra's data directory.

### Recordings

Choose **Start Recording** or **Stop Recording** from the Terminal context menu, tab menu, or command palette. The tab shows a recording indicator while any of its Terminals is recording. A Recording and a Terminal log can run at the same time.

Each `.cast` file contains timed Terminal output and grid size changes in asciicast v2 format. It uses the same naming and **Terminal output folder** setting as Terminal logs. Play it with `asciinema play /path/to/recording.cast`.

### Terminal protocol support

SSH Astra uses xterm.js 6.0.0.

- **Synchronized output (DECSET 2026)** is supported. xterm.js batches redraws until the program resets the mode, with a one-second fallback if the program leaves it enabled. [6.0.0 release notes](https://github.com/xtermjs/xterm.js/releases/tag/6.0.0) · [6.0.0 render service](https://github.com/xtermjs/xterm.js/blob/6.0.0/src/browser/services/RenderService.ts#L320-L352)
- **Kitty keyboard protocol** is unsupported in 6.0.0. Its CSI handlers lack Kitty keyboard negotiation and its keyboard encoder uses legacy sequences. [6.0.0 CSI handlers](https://github.com/xtermjs/xterm.js/blob/6.0.0/src/common/InputHandler.ts#L219-L268) · [6.0.0 keyboard encoder](https://github.com/xtermjs/xterm.js/blob/6.0.0/src/common/input/Keyboard.ts)
- **Terminal program notifications** accept iTerm2 OSC 9 and rxvt OSC 777 `notify`. Each Terminal can send one notification per second. [Escape sequence formats](https://github.com/wezterm/wezterm/blob/main/docs/escape-sequences.md)

## Install

Download from [Releases](https://github.com/amemiya02/ssh-astra/releases): `.msi` (Windows), universal `.dmg` (macOS), `.AppImage` / `.deb` (Linux).

> [!NOTE]
> The installers are not code-signed yet.
> - **macOS:** right-click the app and choose **Open** the first time.
> - **Windows:** click **More info → Run anyway**.

## Build from source

Requires Node.js 22+, pnpm, Rust stable and the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```bash
pnpm install
pnpm tauri dev      # run
pnpm tauri build    # package
```

## Logs and diagnostics

Open **Settings → Diagnostics** or use **Open log folder** in the command palette. The default location depends on the platform.

- macOS — `~/Library/Logs/dev.sshastra.app/`
- Linux — `$XDG_DATA_HOME/dev.sshastra.app/logs/` (typically `~/.local/share/dev.sshastra.app/logs/`)
- Windows — `%LOCALAPPDATA%\dev.sshastra.app\logs\`

SSH Astra keeps four application log files of up to 1 MiB each and the five most recent Rust panic reports. The logs cover startup and app version, SSH connection and authentication steps, reconnects, Port forwards, transfers, Remote edit uploads, Host and settings file errors, update checks, and uncaught interface errors. Panic reports include the error category and source location. Host names, addresses, and SSH usernames appear in the local logs.

Diagnostic logs omit Terminal input and output, passwords, key passphrases, private key contents, clipboard contents, and raw frontend error messages and stacks. **Copy diagnostic information** copies the app version, operating system, architecture, and redacted logs. It replaces Host names, addresses and usernames, Jump host references, Port forward destinations, key file paths, the local home directory and username, and IP addresses. All logs are stored locally. SSH Astra never uploads them.

## Contributing

Issues and PRs are welcome. [`CLAUDE.md`](CLAUDE.md) describes the project layout and conventions, and [`GLOSSARY.md`](GLOSSARY.md) the domain terms.

Run `pnpm performance` on macOS with Docker running to reproduce the [performance baseline](docs/baseline.md).

## License

[MIT](LICENSE)
