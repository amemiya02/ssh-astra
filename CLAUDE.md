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
  - UI follows `DESIGN.md`. `src/App.tsx` fills the `AppShell` slots (sidebar, tabs, workspace, filePanel, status); the Host list lives in `HostsSidebar` (`features/hosts/HostsPanel.tsx`). A new tab kind extends the `Tab` union in `features/workspace/tabs.ts` plus a case in `TabContent`, and stays mounted while hidden (Local terminal and remote Terminal both render through it). Semantic token classes only (literal hex only in `src/theme/terminal-themes.ts`); icon-only controls are `IconButton` with a `label`; prefs go through `src/lib/storage.ts`.
- `src-tauri/` — Cargo workspace root and the Tauri app crate (`sshastra`, lib `sshastra_lib`): a thin IPC bridge.
  - `src-tauri/src/commands/<domain>.rs` — Tauri commands, registered in `src-tauri/src/lib.rs`. Errors map to `CommandError { kind, message }` in `src-tauri/src/error.rs`.
  - `src-tauri/crates/sshastra-core/` — all domain logic, no Tauri dependency (CI checks this). Tests in `crates/sshastra-core/tests/`.
- Streams (terminal output, later transfer progress / Connection state) go to the UI through a `tauri::ipc::Channel` passed as a command argument, never polled. Terminals use one channel each: raw bytes for output, then a JSON `{ exitCode }` message last.
- Core modules: `hosts` (HostStore: versioned JSON, atomic writes, no secrets), `known_hosts` (OpenSSH `known_hosts`, shared with the `ssh` CLI), `ssh` (ConnectionManager / Connection / RemoteShell), `terminal` (Terminal trait, LocalPty, TerminalRegistry).
- SSH: get a Connection with `ConnectionManager::connect(&host, prompter)`; it is shared per Host and lives while any holder keeps its `Arc` (a RemoteShell holds one). Anything needing the user mid-connect (host key, password, later passphrase / keyboard-interactive) is a method on the `ssh::Prompter` trait; the app implements it in `src-tauri/src/prompts.rs` as a prompt `Channel` plus the `prompt_answer` command. Host key Mismatch/Revoked is never a prompt: it fails with a `ConnectError`.
- Jump hosts: `Host.jump_host` names another Host. `HostStore::jump_chain(&id)` returns the hops (outermost first, the Host last) and `upsert` refuses loops/missing hops, so callers never re-check. Connect with `ConnectionManager::connect_through(&jumps, &host, prompter)`: every hop is its own shared Connection (known_hosts + auth through the same Prompter), the next hop tunnelled over `direct-tcpip`. A failing hop is `ConnectError::JumpHost { name, source }`; over IPC it keeps the inner `kind` and adds `details.jumpHost`.
- SSH auth (`ssh/auth.rs`) tries, as far as the server's remaining methods allow: ssh-agent, the Host's key file (`HostAuth::Key { identityFile }`), password, keyboard-interactive; "partial success" moves on to the next. If all fail, the `ConnectError` names the last failure (`KeyRejected`, `KeyPassphraseIncorrect`, `KeyUnreadable`, `AgentKeysRejected`, `NoSupportedMethod`, `AuthenticationFailed`). `ConnectionManager::new` uses no agent; the app adds `.with_agent(Agent::System)` (Unix `$SSH_AUTH_SOCK`; Windows OpenSSH agent pipe, else Pageant). New `Prompter` methods get a default impl that answers `None` (cancel).

## Integration tests (Docker OpenSSH)

- `src-tauri/crates/sshastra-core/tests/sshd/`: Debian OpenSSH image (user `tester` / `testpass`, fixed test-only host key) and `docker-compose.yml`: `ssh` (published on a random loopback port), `jump` (published + private network), `internal` (private network only, reach it via `jump` as `internal:22`), `jump2` (private + deep network, via `jump` as `jump2:22`), `deep` (deep network only, via `jump` → `jump2` as `deep:22`). `keyonly` (public keys only) and `kbdint` (keyboard-interactive via PAM, alone or after a key) are the same image with `sshd -o` overrides. Each container's hostname is its service name. Key fixtures live in `tests/sshd/keys/` (`support::key(name)`; all but `*_unauthorized` are in tester's `authorized_keys`; `id_ed25519_passphrase` uses `support::KEY_PASSPHRASE`). Agent tests start their own `ssh-agent` and pass `Agent::Socket`, never the user's agent. Add new servers/services (echo server for Port forwards, …) here, not from individual tests.
- In a test: `mod support;` then `let Some(sshd) = support::sshd(Service::Ssh) else { return };` (see `tests/ssh_connection.rs`). The harness runs `docker compose up --build --wait` once per test binary and leaves containers running. Each checkout/worktree gets its own Compose project and image tag, `$SSHASTRA_IT_PROJECT` or else `sshastra-it-<hash of the checkout path>` (`support::project()`), so parallel worktrees don't clobber each other; find them with `docker compose ls` and stop one with `docker compose -p <project> down`. CI sets `SSHASTRA_IT_PROJECT=sshastra-it-ci`.
- `SSHASTRA_DOCKER_TESTS`: unset/`auto` runs them when Docker works and skips otherwise; `require` fails instead of skipping (CI Linux); `skip` never touches Docker (CI macOS/Windows).

## Commands

- `pnpm dev` / `pnpm tauri dev` — front end only / full app
- `pnpm lint`, `pnpm typecheck`, `pnpm test` (Vitest)
- `cd src-tauri && cargo test --workspace` (runs the Docker integration tests if Docker is available; also `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`)
- `pnpm tauri build --debug --no-bundle` — build the app
