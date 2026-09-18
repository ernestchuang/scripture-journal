use super::{run_store, AppState};
use journal_core::Entry;
use tauri::State;

#[tauri::command]
pub async fn list_trash(state: State<'_, AppState>) -> Result<Vec<Entry>, String> {
    run_store(state.journal.clone(), |store| {
        store.list_trash().map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn set_entry_trashed(
    state: State<'_, AppState>,
    entry_id: String,
    expected_revision_id: String,
    trashed: bool,
) -> Result<Entry, String> {
    run_store(state.journal.clone(), move |store| {
        store
            .set_entry_trashed(&entry_id, &expected_revision_id, trashed)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn purge_entry(
    state: State<'_, AppState>,
    entry_id: String,
    expected_revision_id: String,
) -> Result<(), String> {
    run_store(state.journal.clone(), move |store| {
        store
            .purge_entry(&entry_id, &expected_revision_id)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn purge_revision(
    state: State<'_, AppState>,
    entry_id: String,
    revision_id: String,
    expected_revision_id: String,
) -> Result<(), String> {
    run_store(state.journal.clone(), move |store| {
        store
            .purge_revision(&entry_id, &revision_id, &expected_revision_id)
            .map_err(|e| e.to_string())
    })
    .await
}
