//! IPC for the saved Snippet library.

use std::path::PathBuf;
use std::sync::Mutex;

use sshastra_core::snippets::{
    Snippet, SnippetDraft, SnippetId, SnippetImportReport, SnippetStore,
};
use tauri::State;

use crate::error::{CommandError, CommandResult};

/// Keep the startup error so a damaged library is left untouched.
pub struct SnippetsState(Mutex<Result<SnippetStore, CommandError>>);

impl SnippetsState {
    pub fn new(store: Result<SnippetStore, CommandError>) -> Self {
        Self(Mutex::new(store))
    }

    fn with<T>(&self, f: impl FnOnce(&mut SnippetStore) -> CommandResult<T>) -> CommandResult<T> {
        let mut guard = self.0.lock().unwrap_or_else(|p| p.into_inner());
        match guard.as_mut() {
            Ok(store) => f(store),
            Err(error) => Err(error.clone()),
        }
    }
}

#[tauri::command]
pub fn snippets_list(snippets: State<'_, SnippetsState>) -> CommandResult<Vec<Snippet>> {
    snippets.with(|store| Ok(store.list().to_vec()))
}

#[tauri::command]
pub fn snippet_save(
    snippets: State<'_, SnippetsState>,
    id: Option<SnippetId>,
    draft: SnippetDraft,
) -> CommandResult<Snippet> {
    snippets.with(|store| Ok(store.upsert(id, draft)?))
}

#[tauri::command]
pub fn snippet_delete(snippets: State<'_, SnippetsState>, id: SnippetId) -> CommandResult<()> {
    snippets.with(|store| Ok(store.delete(&id)?))
}

#[tauri::command]
pub fn snippets_export(snippets: State<'_, SnippetsState>, path: PathBuf) -> CommandResult<()> {
    snippets.with(|store| Ok(store.export_to(&path)?))
}

#[tauri::command]
pub fn snippets_import(
    snippets: State<'_, SnippetsState>,
    path: PathBuf,
) -> CommandResult<SnippetImportReport> {
    snippets.with(|store| Ok(store.import_from(&path)?))
}
