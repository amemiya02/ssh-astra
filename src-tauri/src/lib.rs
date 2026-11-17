//! The sshastra desktop app: a thin IPC bridge that exposes `sshastra-core`
//! as Tauri commands and pushes its event streams to the front end through
//! Tauri channels. Domain logic belongs in `sshastra-core`, not here.

mod commands;
mod error;

use sshastra_core::terminal::TerminalRegistry;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(TerminalRegistry::default())
        .invoke_handler(tauri::generate_handler![
            commands::terminal::local_terminal_open,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running sshastra");
}
