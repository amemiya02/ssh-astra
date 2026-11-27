// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("mcp")) {
        if let Err(error) = sshastra_lib::run_agent_stdio() {
            eprintln!("SSH Astra MCP transport: {}", error.kind());
            std::process::exit(1);
        }
        return;
    }
    sshastra_lib::run()
}
