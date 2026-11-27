use std::collections::HashMap;

use serde::Deserialize;
use tauri::menu::{
    AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID,
    WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::quit::QuitMenu;

const ACTION_PREFIX: &str = "macos-menu:";

#[derive(Deserialize)]
struct ActionItem {
    id: String,
    title: String,
    enabled: bool,
    accelerator: Option<String>,
}

#[derive(Deserialize)]
pub struct MacosMenuSpec {
    labels: HashMap<String, String>,
    application: Vec<ActionItem>,
    file: Vec<ActionItem>,
    view: Vec<ActionItem>,
    help: Vec<ActionItem>,
}

fn append_actions(menu: &Submenu<tauri::Wry>, actions: Vec<ActionItem>) -> tauri::Result<()> {
    for action in actions {
        menu.append(&MenuItem::with_id(
            menu.app_handle(),
            format!("{ACTION_PREFIX}{}", action.id),
            action.title,
            action.enabled,
            action.accelerator,
        )?)?;
    }
    Ok(())
}

fn build_menu(
    app: &AppHandle,
    quit: &MenuItem<tauri::Wry>,
    spec: MacosMenuSpec,
) -> tauri::Result<Menu<tauri::Wry>> {
    let label = |id| spec.labels.get(id).map(String::as_str);
    let separator = PredefinedMenuItem::separator(app)?;
    let name = &app.package_info().name;
    let about = AboutMetadata {
        name: Some(name.clone()),
        version: Some(app.package_info().version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        ..Default::default()
    };
    let application = Submenu::with_items(
        app,
        name,
        true,
        &[
            &PredefinedMenuItem::about(app, label("about"), Some(about))?,
            &separator,
        ],
    )?;
    append_actions(&application, spec.application)?;
    application.append_items(&[
        &separator,
        &PredefinedMenuItem::services(app, label("services"))?,
        &separator,
        &PredefinedMenuItem::hide(app, label("hide"))?,
        &PredefinedMenuItem::hide_others(app, label("hideOthers"))?,
        &PredefinedMenuItem::show_all(app, label("showAll"))?,
        &separator,
        quit,
    ])?;

    let file = Submenu::new(app, label("file").unwrap_or("File"), true)?;
    append_actions(&file, spec.file)?;

    // Copy and Paste target the focused webview's native responder, which also
    // delivers clipboard events to xterm. Select All needs xterm's buffer selection.
    let edit = Submenu::with_items(
        app,
        label("edit").unwrap_or("Edit"),
        true,
        &[
            &PredefinedMenuItem::undo(app, label("undo"))?,
            &PredefinedMenuItem::redo(app, label("redo"))?,
            &separator,
            &PredefinedMenuItem::cut(app, label("cut"))?,
            &PredefinedMenuItem::copy(app, label("copy"))?,
            &PredefinedMenuItem::paste(app, label("paste"))?,
            &MenuItem::with_id(
                app,
                format!("{ACTION_PREFIX}select-all"),
                label("selectAll").unwrap_or("Select All"),
                true,
                Some("Cmd+A"),
            )?,
        ],
    )?;

    let view = Submenu::new(app, label("view").unwrap_or("View"), true)?;
    append_actions(&view, spec.view)?;
    view.append_items(&[
        &separator,
        &PredefinedMenuItem::fullscreen(app, label("fullscreen"))?,
    ])?;

    let window = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        label("window").unwrap_or("Window"),
        true,
        &[
            &PredefinedMenuItem::minimize(app, label("minimize"))?,
            &PredefinedMenuItem::maximize(app, label("zoom"))?,
            &separator,
            &PredefinedMenuItem::bring_all_to_front(app, label("bringAllToFront"))?,
        ],
    )?;

    let help = Submenu::with_id(app, HELP_SUBMENU_ID, label("help").unwrap_or("Help"), true)?;
    append_actions(&help, spec.help)?;

    Menu::with_items(app, &[&application, &file, &edit, &view, &window, &help])
}

#[tauri::command]
pub fn macos_menu_set(
    app: AppHandle,
    quit: State<'_, QuitMenu>,
    spec: MacosMenuSpec,
) -> Result<(), String> {
    // Replacing the menu also clears accelerators that have become unassigned.
    let menu = build_menu(&app, &quit.quit, spec).map_err(|error| error.to_string())?;
    app.set_menu(menu).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    let Some(action) = event.id().as_ref().strip_prefix(ACTION_PREFIX) else {
        return;
    };
    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = window.emit("macos-menu-action", action) {
            log::warn!("could not dispatch macOS menu action: {error}");
        }
    }
}
