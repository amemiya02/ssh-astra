# Product

<!-- impeccable:product-schema 1 -->

> Inferred from the MVP PRD (amemiya02/ssh-astra#1) and ticket #3 by an agent with no interview round; the owner pre-approved the design direction. Correct anything that is wrong.

## Platform

web

(A Tauri 2 desktop app: the UI is a web front end in the system webview on Windows, macOS and Linux. Standard web components, desktop density, no touch-first layouts.)

## Users

Developers and operators who log in to remote machines every day: run commands, read logs, move files. They live in a terminal for hours, often with an IDE beside it, and switch between a handful to a few dozen Hosts.

## Product Purpose

SSH Astra is a cross-platform SSH/SFTP desktop client: saved Hosts on the left, tabbed and split Terminals in the middle, and a File panel docked beside the Terminal that follows the shell's directory. It replaces MobaXterm (Windows-only, dated, cluttered) and heavier Electron clients. Success: open a Host, work, and move files without leaving the window or typing paths.

## Positioning

Small and fast (Tauri + Rust SSH stack, see ADR-0001), no account, no cloud: passwords live only in the system keychain, host keys are shared with OpenSSH `~/.ssh/known_hosts`. The Terminal and the File panel share one Connection, authenticated once.

## Operating Context

Long sessions at a desk, light or dark system appearance, often next to an editor. Keyboard-first (⌘K / Ctrl+K palette, shortcuts), but the Host list and File panel are pointer-driven (double-click, drag and drop from the OS file manager).

## Capabilities and Constraints

- Vocabulary is fixed by `GLOSSARY.md`: Host, Group, Jump host, Connection, Known host, Terminal, Local terminal, File panel, Port forward.
- UI copy in English and Chinese (`src/i18n/locales`), default from system language.
- Light and dark follow the system, with a manual override (PRD story 73).
- Window size, sidebar width and File panel dock position persist across restarts (story 77).

## Brand Commitments

- Name: SSH Astra (shown to users). Code, crates, the binary, the keychain service and file names keep the lowercase id `sshastra`.
- Visual reference pinned by the owner: the restraint of Termius and Linear: large radii, thin borders, soft shadows, moderate density, one consistent look across screens.

## Evidence on Hand

No logo, screenshots, testimonials or benchmarks exist yet. Do not invent install sizes, user counts or performance numbers.

## Product Principles

1. The Terminal is the work; chrome stays quiet around it.
2. Security states are never subtle: an unknown or changed host key is stated plainly, a mismatch is red and blocks.
3. One Host, one Connection: the UI shows Connection state wherever a Host appears.
4. Keyboard first, pointer friendly.

## Accessibility & Inclusion

WCAG AA contrast in both themes; every control reachable and visibly focused by keyboard; Terminal keystrokes are not swallowed by app shortcuts beyond a small global set.
