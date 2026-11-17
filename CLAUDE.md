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
- `src-tauri/` — Cargo workspace root and the Tauri app crate (`sshastra`, lib `sshastra_lib`): a thin IPC bridge.
  - `src-tauri/src/commands/<domain>.rs` — Tauri commands, registered in `src-tauri/src/lib.rs`. Errors map to `CommandError { kind, message }` in `src-tauri/src/error.rs`.
  - `src-tauri/crates/sshastra-core/` — all domain logic, no Tauri dependency (CI checks this). Tests in `crates/sshastra-core/tests/`.
- Streams (terminal output, later transfer progress / Connection state) go to the UI through a `tauri::ipc::Channel` passed as a command argument, never polled. Terminals use one channel each: raw bytes for output, then a JSON `{ exitCode }` message last.

## Commands

- `pnpm dev` / `pnpm tauri dev` — front end only / full app
- `pnpm lint`, `pnpm typecheck`, `pnpm test` (Vitest)
- `cd src-tauri && cargo test --workspace` (also `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`)
- `pnpm tauri build --debug --no-bundle` — build the app
