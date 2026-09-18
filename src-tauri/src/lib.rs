use journal_core::{Entry, ExportReport, JournalStore, Revision, SaveRequest};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

struct AppState {
    journal: Arc<Mutex<JournalStore>>,
    export_directories: Mutex<HashSet<PathBuf>>,
}

#[tauri::command]
fn startup_appearance() -> Option<&'static str> {
    // Isolated debug smoke tests must not flash a bright window on the user's desktop.
    // Release builds never read this test-only override.
    if cfg!(debug_assertions) && std::env::var("SCRIPTURE_JOURNAL_SMOKE_DARK").as_deref() == Ok("1")
    {
        Some("dark")
    } else {
        None
    }
}

#[tauri::command]
fn apply_appearance(
    window: tauri::WebviewWindow,
    theme: String,
    background: String,
) -> Result<(), String> {
    let theme = match theme.as_str() {
        "dark" => tauri::Theme::Dark,
        "light" => tauri::Theme::Light,
        _ => return Err("Unknown appearance".into()),
    };
    let color = appearance_color(&background)?;
    let appearance = window
        .set_background_color(Some(color))
        .and_then(|_| window.set_theme(Some(theme)));
    // A platform-specific decoration error must not strand an invisible window.
    if !window.is_visible().map_err(|e| e.to_string())? {
        window.show().map_err(|e| e.to_string())?;
    }
    appearance.map_err(|e| e.to_string())
}

fn appearance_color(background: &str) -> Result<tauri::window::Color, String> {
    let hex = background
        .strip_prefix('#')
        .filter(|value| value.len() == 6 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| "Invalid appearance background".to_string())?;
    let channel = |range| {
        u8::from_str_radix(&hex[range], 16).map_err(|_| "Invalid appearance background".to_string())
    };
    Ok(tauri::window::Color(
        channel(0..2)?,
        channel(2..4)?,
        channel(4..6)?,
        255,
    ))
}

#[tauri::command]
fn read_omarchy_theme() -> Result<Option<String>, String> {
    #[cfg(target_os = "linux")]
    {
        let Some(home) = std::env::var_os("HOME") else {
            return Ok(None);
        };
        let path = PathBuf::from(home).join(".local/state/omarchy/current/theme/colors.toml");
        match std::fs::File::open(path) {
            Ok(file) => read_palette(file).map(Some),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }
    #[cfg(not(target_os = "linux"))]
    Ok(None)
}

#[cfg(any(target_os = "linux", test))]
fn read_palette(reader: impl std::io::Read) -> Result<String, String> {
    use std::io::Read;
    let mut bytes = Vec::new();
    reader
        .take(64 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > 64 * 1024 {
        return Err("The active Omarchy palette is too large.".into());
    }
    String::from_utf8(bytes).map_err(|error| error.to_string())
}

#[cfg(test)]
mod appearance_tests {
    use super::*;

    #[test]
    fn invalid_backgrounds_never_panic() {
        for value in [
            "#€€", "#a€bc", "#１２", "#xyzxyz", "123456", "#123", "#1234567",
        ] {
            assert!(appearance_color(value).is_err(), "{value}");
        }
        assert!(appearance_color("#abcdef").is_ok());
        assert!(appearance_color("#ABC123").is_ok());
    }

    #[test]
    fn palette_read_is_bounded_and_requires_utf8() {
        assert!(read_palette(std::io::repeat(b'x')).is_err());
        assert!(read_palette(&[255u8][..]).is_err());
        assert_eq!(
            read_palette(&b"mode = \"dark\""[..]).unwrap(),
            "mode = \"dark\""
        );
    }
}

async fn run_store<T, F>(store: Arc<Mutex<JournalStore>>, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&mut JournalStore) -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let mut journal = store
            .lock()
            .map_err(|_| "Journal is unavailable; restart the app.".to_string())?;
        operation(&mut journal)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn list_entries(state: State<'_, AppState>) -> Result<Vec<Entry>, String> {
    run_store(state.journal.clone(), |journal| {
        journal.list_entries().map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn save_entry(state: State<'_, AppState>, request: SaveRequest) -> Result<Entry, String> {
    run_store(state.journal.clone(), move |journal| {
        journal.save_entry(request).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn get_history(
    state: State<'_, AppState>,
    entry_id: String,
) -> Result<Vec<Revision>, String> {
    run_store(state.journal.clone(), move |journal| {
        journal.get_history(&entry_id).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn restore_revision(
    state: State<'_, AppState>,
    entry_id: String,
    revision_id: String,
    expected_revision_id: String,
) -> Result<Entry, String> {
    run_store(state.journal.clone(), move |journal| {
        journal
            .restore_revision(&entry_id, &revision_id, Some(&expected_revision_id))
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn choose_export_directory(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let selected = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Choose a folder for your finished journal entries")
            .blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|e| e.to_string())?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    state
        .export_directories
        .lock()
        .map_err(|_| "Folder access is unavailable.".to_string())?
        .insert(path.clone());
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn export_journal(
    state: State<'_, AppState>,
    directory: String,
) -> Result<ExportReport, String> {
    let path = PathBuf::from(directory)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !state
        .export_directories
        .lock()
        .map_err(|_| "Folder access is unavailable.".to_string())?
        .contains(&path)
    {
        return Err("Choose the export folder using the app's folder picker first.".into());
    }
    run_store(state.journal.clone(), move |journal| {
        journal.export_journal(&path).map_err(|e| e.to_string())
    })
    .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let root = app.path().app_data_dir()?;
            std::fs::create_dir_all(&root)?;
            let journal = JournalStore::open(&root.join("journal.sqlite3"))?;
            app.manage(AppState {
                journal: Arc::new(Mutex::new(journal)),
                export_directories: Mutex::new(HashSet::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_entries,
            save_entry,
            get_history,
            restore_revision,
            choose_export_directory,
            export_journal,
            apply_appearance,
            read_omarchy_theme,
            startup_appearance
        ])
        .run(tauri::generate_context!())
        .expect("Could not start Scripture Journal");
}
