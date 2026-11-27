<div align="center">

<img src="src-tauri/icons/icon-source.png" alt="SSH Astra logo" width="112" height="112">

# SSH Astra

现代、美观的跨平台 SSH / SFTP 客户端，支持 Windows、macOS、Linux。

[![CI](https://img.shields.io/github/actions/workflow/status/amemiya02/ssh-astra/ci.yml?branch=main&label=CI&logo=githubactions&logoColor=white)](https://github.com/amemiya02/ssh-astra/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/amemiya02/ssh-astra?include_prereleases&sort=semver&logo=github)](https://github.com/amemiya02/ssh-astra/releases)
[![License: MIT](https://img.shields.io/github/license/amemiya02/ssh-astra?color=blue)](LICENSE)
![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24C8DB?logo=tauri&logoColor=white)](https://tauri.app)

[English](README.md) · **简体中文**

<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/screenshots/main-light.png">
  <img src="docs/screenshots/hero-dark.png" alt="SSH Astra：Host 列表、终端，以及跟随 cd 的文件面板" width="100%">
</picture>

</div>

## 功能

- **Host 管理**：分组、搜索，导入 `~/.ssh/config`，跳板机
- **终端**：多标签 + 分屏，xterm.js WebGL 渲染
- **SFTP 文件面板**：跟随终端 `cd`；传输队列、拖拽上传；远程编辑，保存后自动传回
- **端口转发**：本地 / 远程 / SOCKS5，可随连接自动启动
- **安全**：ssh-agent、私钥、密码、二次验证；凭据存系统钥匙串；与 OpenSSH 共用 `known_hosts`
- **断线自动重连**
- **体验**：⌘K 命令面板，深色 / 浅色主题，中英双语，应用内更新

<table>
  <tr>
    <td><img src="docs/screenshots/split-panes.png" alt="分屏"></td>
    <td><img src="docs/screenshots/file-transfers.png" alt="传输队列"></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/port-forwards.png" alt="端口转发"></td>
    <td><img src="docs/screenshots/command-palette.png" alt="命令面板"></td>
  </tr>
</table>

## 安装

从 [Releases](https://github.com/amemiya02/ssh-astra/releases) 下载：`.msi`（Windows）、通用 `.dmg`（macOS）、`.AppImage` / `.deb`（Linux）。

> [!NOTE]
> 安装包暂未做代码签名：
> - **macOS**：首次打开请右键点应用 → **打开**。
> - **Windows**：SmartScreen 提示时点 **更多信息 → 仍要运行**。

## 从源码构建

需要 Node.js 22+、pnpm、Rust stable 以及 [Tauri 前置依赖](https://tauri.app/start/prerequisites/)。

```bash
pnpm install
pnpm tauri dev      # 运行
pnpm tauri build    # 打包
```

## 参与贡献

欢迎提 Issue 和 PR。项目结构与开发约定见 [`CLAUDE.md`](CLAUDE.md)，领域术语见 [`GLOSSARY.md`](GLOSSARY.md)。

在 macOS 上启动 Docker 后运行 `pnpm performance`，即可重跑[性能基线](docs/baseline.md)。

## 许可证

[MIT](LICENSE)
