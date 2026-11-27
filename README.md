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

- **Hosts**: groups, search, import from `~/.ssh/config`, Jump hosts.
- **Terminals**: tabs and split panes; xterm.js with WebGL rendering.
- **SFTP File panel**: follows your shell's `cd`. Has a transfer queue and drag-and-drop upload. Edited files save back to the server on their own.
- **Port forwards**: local, remote and SOCKS5; can start when you connect.
- **Security**: ssh-agent, keys, password and 2FA; secrets stay in the OS keychain; shares `known_hosts` with OpenSSH.
- **Reconnects** on its own after a dropped Connection.
- **Polish**: ⌘K command palette, light and dark themes, English and 简体中文, in-app updates.

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

Open **Settings → Diagnostics** or use **Open log folder** in the command palette. The default locations are:

- macOS — `~/Library/Logs/dev.sshastra.app/`
- Linux — `$XDG_DATA_HOME/dev.sshastra.app/logs/` (typically `~/.local/share/dev.sshastra.app/logs/`)
- Windows — `%LOCALAPPDATA%\dev.sshastra.app\logs\`

SSH Astra keeps four application log files of up to 1 MiB each and the five most recent Rust panic reports. The logs cover startup and app version, SSH connection and authentication steps, reconnects, Port forwards, transfers, Remote edit uploads, Host and settings file errors, update checks, and uncaught interface errors. Panic reports include the error category and source location. Host names, addresses, and SSH usernames appear in the local logs.

SSH Astra never logs Terminal input or output, passwords, key passphrases, private key contents, clipboard contents, or raw frontend error messages and stacks. **Copy diagnostic information** copies the app version, operating system, architecture, and redacted logs. It replaces Host names, addresses and usernames, Jump host references, Port forward destinations, key file paths, the local home directory and username, and IP addresses. All logs are stored locally. SSH Astra never uploads them.

## Contributing

Issues and PRs are welcome. [`CLAUDE.md`](CLAUDE.md) describes the project layout and conventions, and [`GLOSSARY.md`](GLOSSARY.md) the domain terms.

## License

[MIT](LICENSE)
