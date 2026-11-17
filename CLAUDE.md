# ssh-astra

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `amemiya02/ssh-astra` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the five default triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Project layout

- `src/` — front end (pnpm + Vite + React + TS + Tailwind v4 + shadcn/ui). `@/` aliases `src/`.
  - `src/features/<domain>/` — UI per domain (e.g. `terminal/`).
  - `src/lib/ipc/<domain>.ts` — the only place that calls `invoke`/`Channel`; typed wrappers over Tauri commands.
  - `src/i18n/locales/{en,zh}.json` — all UI copy. Keys must match exactly (enforced by `src/i18n/locales.test.ts`).
  - `src/components/ui/` — shadcn components (`pnpm dlx shadcn@latest add <name>`).
  - UI follows `DESIGN.md`. `src/App.tsx` fills the `AppShell` slots (sidebar, tabs, workspace, filePanel, status); the Host list lives in `HostsSidebar` (`features/hosts/HostsPanel.tsx`). A tab holds one or more panes split in one orientation (`features/workspace/tabs.ts`, a pure reducer); a new pane kind extends the `PaneKind` union plus a case in `PaneContent` (`TabPanels.tsx`), and stays mounted while hidden or when neighbours split/close. A remote Terminal pane reports its Connection status (`connecting`/`connected`/`disconnected`) up to the tab dot and status bar. Window-wide shortcuts are a table in `features/workspace/shortcuts.ts` (macOS uses Cmd; elsewhere Ctrl+Shift, never plain Ctrl+letter, which the shell owns). Semantic token classes only (literal hex only in `src/theme/terminal-themes.ts`); icon-only controls are `IconButton` with a `label`; prefs go through `src/lib/storage.ts`.
- `src-tauri/` — Cargo workspace root and the Tauri app crate (`sshastra`, lib `sshastra_lib`): a thin IPC bridge.
  - `src-tauri/src/commands/<domain>.rs` — Tauri commands, registered in `src-tauri/src/lib.rs`. Errors map to `CommandError { kind, message }` in `src-tauri/src/error.rs`.
  - `src-tauri/crates/sshastra-core/` — all domain logic, no Tauri dependency (CI checks this). Tests in `crates/sshastra-core/tests/`.
- Streams (terminal output, later transfer progress / Connection state) go to the UI through a `tauri::ipc::Channel` passed as a command argument, never polled. Terminals use one channel each: raw bytes for output, then a JSON `{ exitCode }` message last.
- Core modules: `hosts` (HostStore: versioned JSON, atomic writes, no secrets), `known_hosts` (OpenSSH `known_hosts`, shared with the `ssh` CLI), `ssh` (ConnectionManager / Connection / RemoteShell), `terminal` (Terminal trait, LocalPty, TerminalRegistry).
- SSH: get a Connection with `ConnectionManager::connect(&host, prompter)`; it is shared per Host and lives while any holder keeps its `Arc` (a RemoteShell holds one); dropping the last one disconnects. Concurrent connects to the same Host coalesce on a per-Host slot (the later ones wait and share the result; if the first fails they try themselves). Anything needing the user mid-connect (host key, password, later passphrase / keyboard-interactive) is a method on the `ssh::Prompter` trait; the app implements it in `src-tauri/src/prompts.rs` as a prompt `Channel` plus the `prompt_answer` command. Host key Mismatch/Revoked is never a prompt: it fails with a `ConnectError`.

## Integration tests (Docker OpenSSH)

- `src-tauri/crates/sshastra-core/tests/sshd/`: Debian OpenSSH image (user `tester` / `testpass`, fixed test-only host key) and `docker-compose.yml` (project `sshastra-it`): `ssh` (published on a random loopback port), `jump` (published + private network), `internal` (private network only, reach it via `jump` as `internal:22`), `counted` (only `tests/connection_lifecycle.rs` connects to it, so it can count server-side TCP connections with `Sshd::established_connections()`; tests using it hold a shared lock). Add new servers/services (echo server for Port forwards, key/agent users) here, not from individual tests.
- In a test: `mod support;` then `let Some(sshd) = support::sshd(Service::Ssh) else { return };` (see `tests/ssh_connection.rs`). The harness runs `docker compose up --build --wait` once per test binary and leaves containers running; stop them with `docker compose -p sshastra-it down`.
- `SSHASTRA_DOCKER_TESTS`: unset/`auto` runs them when Docker works and skips otherwise; `require` fails instead of skipping (CI Linux); `skip` never touches Docker (CI macOS/Windows).

## Commands

- `pnpm dev` / `pnpm tauri dev` — front end only / full app
- `pnpm lint`, `pnpm typecheck`, `pnpm test` (Vitest)
- `cd src-tauri && cargo test --workspace` (runs the Docker integration tests if Docker is available; also `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`)
- `pnpm tauri build --debug --no-bundle` — build the app
