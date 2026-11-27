use sshastra_core::ssh::ConnectionManager;
use tauri::menu::{Menu, MenuEvent, MenuItem, MenuItemKind, Submenu};
use tauri::{AppHandle, Manager, State};

const QUIT: &str = "app-quit";

pub struct QuitMenu {
    file: Option<Submenu<tauri::Wry>>,
    pub(crate) quit: MenuItem<tauri::Wry>,
}

pub fn menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    // Leave Ctrl+Q available to the shell on Windows and Linux.
    let accelerator = if cfg!(target_os = "macos") {
        "Cmd+Q"
    } else {
        "Ctrl+Shift+Q"
    };
    let quit = MenuItem::with_id(app, QUIT, "Quit SSH Astra", true, Some(accelerator))?;

    let (menu, file) = if cfg!(target_os = "macos") {
        let menu = Menu::default(app)?;
        let Some(MenuItemKind::Submenu(submenu)) = menu.items()?.into_iter().next() else {
            return Err(std::io::Error::other("Tauri's default app submenu is missing").into());
        };
        // Replace the predefined quit, which uses the system terminate action directly.
        let items = submenu.items()?;
        if let Some(MenuItemKind::Predefined(item)) = items.last() {
            submenu.remove(item)?;
        }
        submenu.append(&quit)?;
        (menu, None)
    } else {
        let file = Submenu::with_items(app, "File", true, &[&quit])?;
        (Menu::with_items(app, &[&file])?, Some(file))
    };

    app.manage(QuitMenu { file, quit });
    Ok(menu)
}

pub fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    if event.id() == QUIT {
        if let Some(window) = app.get_webview_window("main") {
            if let Err(error) = window.close() {
                log::warn!("could not request app quit: {error}");
            }
        }
    }
}

#[tauri::command]
pub fn quit_menu_localize(
    menu: State<'_, QuitMenu>,
    file: String,
    quit: String,
) -> Result<(), String> {
    if let Some(submenu) = &menu.file {
        submenu.set_text(file).map_err(|error| error.to_string())?;
    }
    menu.quit.set_text(quit).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn quit_live_connection_count(connections: State<'_, ConnectionManager>) -> usize {
    connections.live_count()
}
