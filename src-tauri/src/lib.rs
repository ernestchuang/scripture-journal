use journal_core::{
    CalendarPlanEnrollment, CalendarScheduleMode, CompleteStreamRequest, DatedPlanAssignment,
    Entry, ExportReport, JournalStore, PlanAssignment, PlanCompletion, PlanCompletionHistoryItem,
    PlanDefinition, PlanDefinitionVersion, PlanEnrollment, Revision, SaveRequest, StreamEnrollment,
};
use serde::Deserialize;
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CalendarEnrollmentRequest {
    definition_version_id: String,
    start_date: String,
    schedule_mode: CalendarScheduleMode,
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
async fn read_omarchy_theme(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || read_system_palette(&home))
        .await
        .map_err(|error| error.to_string())?
}

fn read_system_palette(home: &std::path::Path) -> Result<Option<String>, String> {
    // Detect the compatible file convention, not a distribution or OS brand.
    // Older installations use .config; prefer the current source if both exist.
    for relative in [
        ".local/state/omarchy/current/theme/colors.toml",
        ".config/omarchy/current/theme/colors.toml",
    ] {
        let path = home.join(relative);
        match std::fs::metadata(&path) {
            Ok(metadata) if metadata.is_file() => {}
            Ok(_) => return Err("System palette source must be a regular file.".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.to_string()),
        }
        match std::fs::File::open(path) {
            Ok(file) => return read_palette(file).map(Some),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(None)
}

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
    fn system_palette_detection_is_optional_and_prefers_current_layout() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(read_system_palette(home.path()).unwrap(), None);
        let legacy = home
            .path()
            .join(".config/omarchy/current/theme/colors.toml");
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(&legacy, "legacy palette").unwrap();
        assert_eq!(
            read_system_palette(home.path()).unwrap().as_deref(),
            Some("legacy palette")
        );
        let current = home
            .path()
            .join(".local/state/omarchy/current/theme/colors.toml");
        std::fs::create_dir_all(current.parent().unwrap()).unwrap();
        std::fs::write(&current, "current palette").unwrap();
        assert_eq!(
            read_system_palette(home.path()).unwrap().as_deref(),
            Some("current palette")
        );
        std::fs::write(&current, [255u8]).unwrap();
        assert!(read_system_palette(home.path()).is_err());
        std::fs::remove_file(&current).unwrap();
        std::fs::create_dir(&current).unwrap();
        assert!(read_system_palette(home.path()).is_err());
        std::fs::remove_dir(current).unwrap();
        assert_eq!(
            read_system_palette(home.path()).unwrap().as_deref(),
            Some("legacy palette")
        );
        std::fs::remove_file(legacy).unwrap();
        assert_eq!(read_system_palette(home.path()).unwrap(), None);
    }

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

async fn register_four_stream_plan_for_store(
    store: Arc<Mutex<JournalStore>>,
) -> Result<PlanDefinitionVersion, String> {
    run_store(store, |journal| {
        journal
            .register_four_stream_plan()
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn register_four_stream_plan(
    state: State<'_, AppState>,
) -> Result<PlanDefinitionVersion, String> {
    register_four_stream_plan_for_store(state.journal.clone()).await
}

async fn register_mcheyne_plan_for_store(
    store: Arc<Mutex<JournalStore>>,
) -> Result<PlanDefinitionVersion, String> {
    run_store(store, |journal| {
        journal.register_mcheyne_plan().map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn register_mcheyne_plan(
    state: State<'_, AppState>,
) -> Result<PlanDefinitionVersion, String> {
    register_mcheyne_plan_for_store(state.journal.clone()).await
}

async fn import_plan_definition_json_for_store(
    store: Arc<Mutex<JournalStore>>,
    input: String,
) -> Result<PlanDefinitionVersion, String> {
    run_store(store, move |journal| {
        journal
            .import_plan_definition_json(&input)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn import_plan_definition_json(
    state: State<'_, AppState>,
    input: String,
) -> Result<PlanDefinitionVersion, String> {
    import_plan_definition_json_for_store(state.journal.clone(), input).await
}

async fn create_plan_definition_version_for_store(
    store: Arc<Mutex<JournalStore>>,
    plan_id: String,
    definition: PlanDefinition,
) -> Result<PlanDefinitionVersion, String> {
    run_store(store, move |journal| {
        journal
            .create_plan_definition_version(&plan_id, definition)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn create_plan_definition_version(
    state: State<'_, AppState>,
    plan_id: String,
    definition: PlanDefinition,
) -> Result<PlanDefinitionVersion, String> {
    create_plan_definition_version_for_store(state.journal.clone(), plan_id, definition).await
}

async fn export_plan_definition_json_for_store(
    store: Arc<Mutex<JournalStore>>,
    version_id: String,
) -> Result<String, String> {
    run_store(store, move |journal| {
        journal
            .export_plan_definition_json(&version_id)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn export_plan_definition_json(
    state: State<'_, AppState>,
    version_id: String,
) -> Result<String, String> {
    export_plan_definition_json_for_store(state.journal.clone(), version_id).await
}

async fn get_plan_definition_version_for_store(
    store: Arc<Mutex<JournalStore>>,
    version_id: String,
) -> Result<Option<PlanDefinitionVersion>, String> {
    run_store(store, move |journal| {
        journal
            .get_plan_definition_version(&version_id)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn get_plan_definition_version(
    state: State<'_, AppState>,
    version_id: String,
) -> Result<Option<PlanDefinitionVersion>, String> {
    get_plan_definition_version_for_store(state.journal.clone(), version_id).await
}

async fn list_plan_definition_versions_for_store(
    store: Arc<Mutex<JournalStore>>,
    plan_id: String,
) -> Result<Vec<PlanDefinitionVersion>, String> {
    run_store(store, move |journal| {
        journal
            .list_plan_definition_versions(&plan_id)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn list_plan_definition_versions(
    state: State<'_, AppState>,
    plan_id: String,
) -> Result<Vec<PlanDefinitionVersion>, String> {
    list_plan_definition_versions_for_store(state.journal.clone(), plan_id).await
}

async fn list_latest_plan_definition_versions_for_store(
    store: Arc<Mutex<JournalStore>>,
) -> Result<Vec<PlanDefinitionVersion>, String> {
    run_store(store, |journal| {
        journal
            .list_latest_plan_definition_versions()
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn list_latest_plan_definition_versions(
    state: State<'_, AppState>,
) -> Result<Vec<PlanDefinitionVersion>, String> {
    list_latest_plan_definition_versions_for_store(state.journal.clone()).await
}

async fn list_plan_enrollments_for_store(
    store: Arc<Mutex<JournalStore>>,
) -> Result<Vec<PlanEnrollment>, String> {
    run_store(store, |journal| {
        journal.list_plan_enrollments().map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn list_plan_enrollments(state: State<'_, AppState>) -> Result<Vec<PlanEnrollment>, String> {
    list_plan_enrollments_for_store(state.journal.clone()).await
}

async fn enroll_in_chapter_streams_for_store(
    store: Arc<Mutex<JournalStore>>,
    definition_version_id: String,
    streams: Vec<StreamEnrollment>,
) -> Result<PlanEnrollment, String> {
    run_store(store, move |journal| {
        journal
            .enroll_in_chapter_streams(&definition_version_id, streams)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn enroll_in_chapter_streams(
    state: State<'_, AppState>,
    definition_version_id: String,
    streams: Vec<StreamEnrollment>,
) -> Result<PlanEnrollment, String> {
    enroll_in_chapter_streams_for_store(state.journal.clone(), definition_version_id, streams).await
}

async fn enroll_in_calendar_for_store(
    store: Arc<Mutex<JournalStore>>,
    request: CalendarEnrollmentRequest,
) -> Result<CalendarPlanEnrollment, String> {
    let bytes = request.start_date.as_bytes();
    let has_exact_iso_date_grammar = bytes.len() == 10
        && bytes[0..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[7] == b'-'
        && bytes[8..10].iter().all(u8::is_ascii_digit);
    if !has_exact_iso_date_grammar {
        return Err("Calendar start date must be an ISO local date (YYYY-MM-DD).".into());
    }
    let start_date = chrono::NaiveDate::parse_from_str(&request.start_date, "%Y-%m-%d")
        .map_err(|_| "Calendar start date must be an ISO local date (YYYY-MM-DD).".to_string())?;
    run_store(store, move |journal| {
        journal
            .enroll_in_calendar(
                &request.definition_version_id,
                start_date,
                request.schedule_mode,
            )
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn enroll_in_calendar(
    state: State<'_, AppState>,
    request: CalendarEnrollmentRequest,
) -> Result<CalendarPlanEnrollment, String> {
    enroll_in_calendar_for_store(state.journal.clone(), request).await
}

async fn get_calendar_plan_enrollment_for_store(
    store: Arc<Mutex<JournalStore>>,
    enrollment_id: String,
) -> Result<Option<CalendarPlanEnrollment>, String> {
    run_store(store, move |journal| {
        journal
            .get_calendar_plan_enrollment(&enrollment_id)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn get_calendar_plan_enrollment(
    state: State<'_, AppState>,
    enrollment_id: String,
) -> Result<Option<CalendarPlanEnrollment>, String> {
    get_calendar_plan_enrollment_for_store(state.journal.clone(), enrollment_id).await
}

async fn calendar_plan_assignments_for_store(
    store: Arc<Mutex<JournalStore>>,
    enrollment_id: String,
) -> Result<Vec<DatedPlanAssignment>, String> {
    run_store(store, move |journal| {
        journal
            .calendar_plan_assignments(&enrollment_id)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn calendar_plan_assignments(
    state: State<'_, AppState>,
    enrollment_id: String,
) -> Result<Vec<DatedPlanAssignment>, String> {
    calendar_plan_assignments_for_store(state.journal.clone(), enrollment_id).await
}

async fn active_plan_assignments_for_store(
    store: Arc<Mutex<JournalStore>>,
    enrollment_id: String,
) -> Result<Vec<PlanAssignment>, String> {
    run_store(store, move |journal| {
        journal
            .active_plan_assignments(&enrollment_id)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn active_plan_assignments(
    state: State<'_, AppState>,
    enrollment_id: String,
) -> Result<Vec<PlanAssignment>, String> {
    active_plan_assignments_for_store(state.journal.clone(), enrollment_id).await
}

async fn plan_completion_history_for_store(
    store: Arc<Mutex<JournalStore>>,
    enrollment_id: String,
) -> Result<Vec<PlanCompletionHistoryItem>, String> {
    run_store(store, move |journal| {
        journal
            .plan_completion_history(&enrollment_id)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn plan_completion_history(
    state: State<'_, AppState>,
    enrollment_id: String,
) -> Result<Vec<PlanCompletionHistoryItem>, String> {
    plan_completion_history_for_store(state.journal.clone(), enrollment_id).await
}

async fn complete_plan_stream_for_store(
    store: Arc<Mutex<JournalStore>>,
    request: CompleteStreamRequest,
) -> Result<PlanCompletion, String> {
    run_store(store, move |journal| {
        journal
            .complete_plan_stream(request)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn complete_plan_stream(
    state: State<'_, AppState>,
    request: CompleteStreamRequest,
) -> Result<PlanCompletion, String> {
    complete_plan_stream_for_store(state.journal.clone(), request).await
}

async fn undo_plan_completion_for_store(
    store: Arc<Mutex<JournalStore>>,
    completion_id: String,
) -> Result<(), String> {
    run_store(store, move |journal| {
        journal
            .undo_plan_completion(&completion_id)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn undo_plan_completion(
    state: State<'_, AppState>,
    completion_id: String,
) -> Result<(), String> {
    undo_plan_completion_for_store(state.journal.clone(), completion_id).await
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

#[cfg(test)]
mod plan_command_tests {
    use super::*;

    fn test_store() -> (tempfile::TempDir, Arc<Mutex<JournalStore>>) {
        let directory = tempfile::tempdir().unwrap();
        let store = JournalStore::open(&directory.path().join("journal.sqlite3")).unwrap();
        (directory, Arc::new(Mutex::new(store)))
    }

    #[test]
    fn typed_plan_commands_serialize_store_access_and_preserve_core_errors() {
        tauri::async_runtime::block_on(async {
            let (_directory, store) = test_store();
            let built_in = register_four_stream_plan_for_store(store.clone())
                .await
                .unwrap();
            let json = export_plan_definition_json_for_store(store.clone(), built_in.id.clone())
                .await
                .unwrap();
            let imported = import_plan_definition_json_for_store(store.clone(), json.clone())
                .await
                .unwrap();
            assert_ne!(imported.plan_id, built_in.plan_id);
            assert_eq!(
                serde_json::from_str::<PlanDefinitionVersion>(
                    &serde_json::to_string(&imported).unwrap()
                )
                .unwrap(),
                imported
            );
            assert_eq!(
                export_plan_definition_json_for_store(store.clone(), imported.id.clone())
                    .await
                    .unwrap(),
                json
            );
            assert_eq!(
                get_plan_definition_version_for_store(store.clone(), imported.id.clone())
                    .await
                    .unwrap(),
                Some(imported.clone())
            );
            assert_eq!(
                list_plan_definition_versions_for_store(store.clone(), imported.plan_id.clone())
                    .await
                    .unwrap(),
                vec![imported]
            );

            let before_invalid =
                list_plan_definition_versions_for_store(store.clone(), built_in.plan_id.clone())
                    .await
                    .unwrap();
            assert!(
                import_plan_definition_json_for_store(store.clone(), "{".into())
                    .await
                    .unwrap_err()
                    .contains("Invalid plan definition JSON")
            );
            assert_eq!(
                list_plan_definition_versions_for_store(store.clone(), built_in.plan_id.clone())
                    .await
                    .unwrap(),
                before_invalid
            );
            let missing = "00000000-0000-4000-a000-000000000000".to_string();
            assert_eq!(
                get_plan_definition_version_for_store(store.clone(), missing.clone())
                    .await
                    .unwrap(),
                None
            );
            assert!(
                export_plan_definition_json_for_store(store.clone(), missing)
                    .await
                    .unwrap_err()
                    .contains("Plan definition version not found")
            );
            assert_eq!(
                list_plan_definition_versions_for_store(
                    Arc::clone(&store),
                    built_in.plan_id.clone()
                )
                .await
                .unwrap(),
                before_invalid
            );
        });
    }

    #[test]
    fn typed_mcheyne_registration_is_idempotent_serialized_and_propagates_store_errors() {
        tauri::async_runtime::block_on(async {
            let (_directory, store) = test_store();
            let first = register_mcheyne_plan_for_store(store.clone())
                .await
                .unwrap();
            assert_eq!(
                register_mcheyne_plan_for_store(store.clone())
                    .await
                    .unwrap(),
                first
            );
            assert_eq!(first.definition.name, "M’Cheyne's Daily Bible Readings");
            assert_eq!(
                serde_json::from_str::<PlanDefinitionVersion>(
                    &serde_json::to_string(&first).unwrap()
                )
                .unwrap(),
                first
            );

            let poisoned = store.clone();
            assert!(std::thread::spawn(move || {
                let _guard = poisoned.lock().unwrap();
                panic!("poison the test mutex");
            })
            .join()
            .is_err());
            assert_eq!(
                register_mcheyne_plan_for_store(store).await.unwrap_err(),
                "Journal is unavailable; restart the app."
            );
        });
    }

    #[test]
    fn typed_calendar_commands_validate_dates_and_preserve_durable_readback() {
        tauri::async_runtime::block_on(async {
            let (_directory, store) = test_store();
            let definition = register_mcheyne_plan_for_store(store.clone())
                .await
                .unwrap();
            let request = CalendarEnrollmentRequest {
                definition_version_id: definition.id.clone(),
                start_date: "2024-02-28".into(),
                schedule_mode: CalendarScheduleMode::DayOne,
            };
            let enrollment = enroll_in_calendar_for_store(store.clone(), request)
                .await
                .unwrap();
            assert_eq!(enrollment.definition_version_id, definition.id);
            assert_eq!(enrollment.start_date.to_string(), "2024-02-28");
            assert_eq!(enrollment.schedule_mode, CalendarScheduleMode::DayOne);
            assert_eq!(
                serde_json::to_value(&enrollment).unwrap(),
                serde_json::json!({
                    "id": enrollment.id,
                    "definitionVersionId": definition.id,
                    "createdAt": enrollment.created_at,
                    "startDate": "2024-02-28",
                    "scheduleMode": "dayOne",
                })
            );
            assert_eq!(
                get_calendar_plan_enrollment_for_store(store.clone(), enrollment.id.clone())
                    .await
                    .unwrap(),
                Some(enrollment.clone())
            );
            let assignments =
                calendar_plan_assignments_for_store(store.clone(), enrollment.id.clone())
                    .await
                    .unwrap();
            assert_eq!(assignments.len(), 365);
            assert_eq!(assignments[0].local_date.to_string(), "2024-02-28");
            assert_eq!(assignments[1].local_date.to_string(), "2024-02-29");
            assert_eq!(assignments[0].definition_version_id, definition.id);
            assert!(!assignments[0].passages.is_empty());
            assert_eq!(
                serde_json::to_value(&assignments[0]).unwrap()["localDate"],
                serde_json::json!("2024-02-28")
            );
            assert_eq!(
                get_calendar_plan_enrollment_for_store(
                    store.clone(),
                    "00000000-0000-4000-a000-000000000000".into()
                )
                .await
                .unwrap(),
                None
            );
            assert!(
                calendar_plan_assignments_for_store(store.clone(), "not-an-id".into())
                    .await
                    .is_err()
            );
            let retained_enrollments = list_plan_enrollments_for_store(store.clone())
                .await
                .unwrap();
            for start_date in [
                "2024-2-28",
                "+10000-01-01",
                "-0001-01-01",
                "2024-01-01Z",
                "２０２４-01-01",
            ] {
                assert_eq!(
                    enroll_in_calendar_for_store(
                        store.clone(),
                        CalendarEnrollmentRequest {
                            definition_version_id: definition.id.clone(),
                            start_date: start_date.into(),
                            schedule_mode: CalendarScheduleMode::DayOne,
                        }
                    )
                    .await
                    .unwrap_err(),
                    "Calendar start date must be an ISO local date (YYYY-MM-DD).",
                    "{start_date}"
                );
                assert_eq!(
                    list_plan_enrollments_for_store(store.clone())
                        .await
                        .unwrap(),
                    retained_enrollments
                );
            }
        });
    }

    #[test]
    fn version_creation_appends_and_preserves_retained_progress_on_rejection() {
        tauri::async_runtime::block_on(async {
            let (_directory, store) = test_store();
            let portable = r#"{"schemaVersion":1,"name":"Editable streams","schedule":{"kind":"chapterStreams","streams":[{"id":"stream","name":"Stream","chapters":[{"book":43,"chapter":1},{"book":43,"chapter":2}]}]}}"#;
            let first = import_plan_definition_json_for_store(store.clone(), portable.into())
                .await
                .unwrap();
            let enrollment = enroll_in_chapter_streams_for_store(
                store.clone(),
                first.id.clone(),
                vec![StreamEnrollment {
                    stream_id: "stream".into(),
                    starting_position: 0,
                    loop_after_end: true,
                }],
            )
            .await
            .unwrap();
            let assignment =
                active_plan_assignments_for_store(store.clone(), enrollment.id.clone())
                    .await
                    .unwrap()
                    .remove(0);
            complete_plan_stream_for_store(
                store.clone(),
                CompleteStreamRequest {
                    enrollment_id: enrollment.id.clone(),
                    stream_id: assignment.stream_id.clone(),
                    expected_assignment_id: assignment.id,
                    expected_progress_id: assignment.progress_id,
                },
            )
            .await
            .unwrap();
            let retained_enrollments = list_plan_enrollments_for_store(store.clone())
                .await
                .unwrap();
            let retained_assignments =
                active_plan_assignments_for_store(store.clone(), enrollment.id.clone())
                    .await
                    .unwrap();
            let retained_history =
                plan_completion_history_for_store(store.clone(), enrollment.id.clone())
                    .await
                    .unwrap();

            let mut edited = first.definition.clone();
            edited.name = "Edited streams".into();
            let second = create_plan_definition_version_for_store(
                store.clone(),
                first.plan_id.clone(),
                edited.clone(),
            )
            .await
            .unwrap();
            assert_eq!(second.plan_id, first.plan_id);
            assert_eq!(second.version, 2);
            assert_eq!(second.definition, edited);
            let retained_versions = vec![first.clone(), second];
            assert_eq!(
                list_plan_definition_versions_for_store(store.clone(), first.plan_id.clone())
                    .await
                    .unwrap(),
                retained_versions
            );
            assert_eq!(
                get_plan_definition_version_for_store(store.clone(), first.id.clone())
                    .await
                    .unwrap(),
                Some(first.clone())
            );

            let mut invalid = first.definition.clone();
            invalid.name.clear();
            assert!(create_plan_definition_version_for_store(
                store.clone(),
                first.plan_id.clone(),
                invalid,
            )
            .await
            .unwrap_err()
            .contains("Invalid plan name"));
            assert!(create_plan_definition_version_for_store(
                store.clone(),
                "00000000-0000-4000-a000-000000000000".into(),
                first.definition,
            )
            .await
            .unwrap_err()
            .contains("Plan not found"));
            assert_eq!(
                list_plan_definition_versions_for_store(store.clone(), first.plan_id.clone())
                    .await
                    .unwrap(),
                retained_versions
            );
            assert_eq!(
                list_plan_enrollments_for_store(store.clone())
                    .await
                    .unwrap(),
                retained_enrollments
            );
            assert_eq!(
                active_plan_assignments_for_store(store.clone(), enrollment.id.clone())
                    .await
                    .unwrap(),
                retained_assignments
            );
            assert_eq!(
                plan_completion_history_for_store(store, enrollment.id)
                    .await
                    .unwrap(),
                retained_history
            );
        });
    }

    #[test]
    fn latest_plan_definition_discovery_is_empty_ordered_durable_and_propagates_errors() {
        tauri::async_runtime::block_on(async {
            let (directory, store) = test_store();
            assert!(
                list_latest_plan_definition_versions_for_store(store.clone())
                    .await
                    .unwrap()
                    .is_empty()
            );

            let portable = r#"{"schemaVersion":1,"name":"Discovery","schedule":{"kind":"explicitSchedule","days":[{"day":1,"passages":[{"book":43,"chapter":3}]}]}}"#;
            let first = import_plan_definition_json_for_store(store.clone(), portable.into())
                .await
                .unwrap();
            let second = import_plan_definition_json_for_store(store.clone(), portable.into())
                .await
                .unwrap();
            let expected = store
                .lock()
                .unwrap()
                .list_latest_plan_definition_versions()
                .unwrap();
            assert_eq!(
                list_latest_plan_definition_versions_for_store(store.clone())
                    .await
                    .unwrap(),
                expected
            );
            assert_eq!(expected.len(), 2);
            assert!(expected.iter().any(|version| version.id == first.id));
            assert!(expected.iter().any(|version| version.id == second.id));
            assert!(store
                .lock()
                .unwrap()
                .list_plan_enrollments()
                .unwrap()
                .is_empty());

            let path = directory.path().join("journal.sqlite3");
            drop(store);
            let reopened = Arc::new(Mutex::new(JournalStore::open(&path).unwrap()));
            assert_eq!(
                list_latest_plan_definition_versions_for_store(reopened.clone())
                    .await
                    .unwrap(),
                expected
            );
            assert!(reopened
                .lock()
                .unwrap()
                .list_plan_enrollments()
                .unwrap()
                .is_empty());

            let poisoned = reopened.clone();
            assert!(std::thread::spawn(move || {
                let _guard = poisoned.lock().unwrap();
                panic!("poison the test mutex");
            })
            .join()
            .is_err());
            assert_eq!(
                list_latest_plan_definition_versions_for_store(reopened)
                    .await
                    .unwrap_err(),
                "Journal is unavailable; restart the app."
            );
        });
    }

    #[test]
    fn typed_progress_commands_preserve_stale_completion_protection() {
        tauri::async_runtime::block_on(async {
            let (_directory, store) = test_store();
            let definition = register_four_stream_plan_for_store(store.clone())
                .await
                .unwrap();
            let enrollment = enroll_in_chapter_streams_for_store(
                store.clone(),
                definition.id.clone(),
                vec![
                    StreamEnrollment {
                        stream_id: "old-testament".into(),
                        starting_position: 0,
                        loop_after_end: true,
                    },
                    StreamEnrollment {
                        stream_id: "new-testament".into(),
                        starting_position: 0,
                        loop_after_end: true,
                    },
                    StreamEnrollment {
                        stream_id: "psalms".into(),
                        starting_position: 0,
                        loop_after_end: true,
                    },
                    StreamEnrollment {
                        stream_id: "proverbs".into(),
                        starting_position: 0,
                        loop_after_end: true,
                    },
                ],
            )
            .await
            .unwrap();
            assert_eq!(
                serde_json::to_value(&enrollment).unwrap()["definitionVersionId"],
                enrollment.definition_version_id
            );
            let assignments =
                active_plan_assignments_for_store(store.clone(), enrollment.id.clone())
                    .await
                    .unwrap();
            assert_eq!(assignments.len(), 4);
            let assignment = assignments
                .iter()
                .find(|assignment| assignment.stream_id == "old-testament")
                .unwrap()
                .clone();
            assert_eq!(
                serde_json::to_value(&assignment).unwrap()["progressId"],
                assignment.progress_id
            );
            let request = CompleteStreamRequest {
                enrollment_id: enrollment.id.clone(),
                stream_id: assignment.stream_id.clone(),
                expected_assignment_id: assignment.id.clone(),
                expected_progress_id: assignment.progress_id.clone(),
            };
            assert_eq!(
                serde_json::to_value(&request).unwrap()["expectedProgressId"],
                request.expected_progress_id
            );
            let completion = complete_plan_stream_for_store(store.clone(), request.clone())
                .await
                .unwrap();
            assert_eq!(
                serde_json::to_value(&completion).unwrap()["assignmentId"],
                assignment.id
            );
            undo_plan_completion_for_store(store.clone(), completion.id)
                .await
                .unwrap();

            let restored = active_plan_assignments_for_store(store.clone(), enrollment.id.clone())
                .await
                .unwrap();
            let restored_assignment = restored
                .iter()
                .find(|candidate| candidate.stream_id == request.stream_id)
                .unwrap();
            assert_eq!(restored_assignment.id, request.expected_assignment_id);
            assert_ne!(
                restored_assignment.progress_id,
                request.expected_progress_id
            );
            assert!(complete_plan_stream_for_store(store.clone(), request)
                .await
                .unwrap_err()
                .contains("Conflict: assignment changed"));
            assert_eq!(
                active_plan_assignments_for_store(store.clone(), enrollment.id.clone())
                    .await
                    .unwrap(),
                restored
            );

            let invalid =
                enroll_in_chapter_streams_for_store(store.clone(), definition.id, Vec::new())
                    .await
                    .unwrap_err();
            assert!(invalid.contains("Select one starting chapter for every stream"));
            assert_eq!(
                active_plan_assignments_for_store(store, enrollment.id)
                    .await
                    .unwrap(),
                restored
            );
        });
    }

    #[test]
    fn completion_history_command_retains_undone_recompletion_and_empty_results() {
        tauri::async_runtime::block_on(async {
            let (_directory, store) = test_store();
            let definition = register_four_stream_plan_for_store(store.clone())
                .await
                .unwrap();
            let selections = || {
                vec![
                    StreamEnrollment {
                        stream_id: "old-testament".into(),
                        starting_position: 0,
                        loop_after_end: true,
                    },
                    StreamEnrollment {
                        stream_id: "new-testament".into(),
                        starting_position: 0,
                        loop_after_end: true,
                    },
                    StreamEnrollment {
                        stream_id: "psalms".into(),
                        starting_position: 0,
                        loop_after_end: true,
                    },
                    StreamEnrollment {
                        stream_id: "proverbs".into(),
                        starting_position: 0,
                        loop_after_end: true,
                    },
                ]
            };
            let empty = enroll_in_chapter_streams_for_store(
                store.clone(),
                definition.id.clone(),
                selections(),
            )
            .await
            .unwrap();
            assert!(plan_completion_history_for_store(store.clone(), empty.id)
                .await
                .unwrap()
                .is_empty());
            assert!(plan_completion_history_for_store(
                store.clone(),
                "00000000-0000-4000-8000-000000000000".into(),
            )
            .await
            .unwrap()
            .is_empty());

            let enrollment =
                enroll_in_chapter_streams_for_store(store.clone(), definition.id, selections())
                    .await
                    .unwrap();
            let assignment =
                active_plan_assignments_for_store(store.clone(), enrollment.id.clone())
                    .await
                    .unwrap()
                    .into_iter()
                    .find(|assignment| assignment.stream_id == "old-testament")
                    .unwrap();
            let request = CompleteStreamRequest {
                enrollment_id: enrollment.id.clone(),
                stream_id: assignment.stream_id.clone(),
                expected_assignment_id: assignment.id.clone(),
                expected_progress_id: assignment.progress_id,
            };
            let original = complete_plan_stream_for_store(store.clone(), request)
                .await
                .unwrap();
            undo_plan_completion_for_store(store.clone(), original.id.clone())
                .await
                .unwrap();
            let refreshed = active_plan_assignments_for_store(store.clone(), enrollment.id.clone())
                .await
                .unwrap()
                .into_iter()
                .find(|assignment| assignment.stream_id == "old-testament")
                .unwrap();
            let recompletion = complete_plan_stream_for_store(
                store.clone(),
                CompleteStreamRequest {
                    enrollment_id: enrollment.id.clone(),
                    stream_id: refreshed.stream_id,
                    expected_assignment_id: refreshed.id,
                    expected_progress_id: refreshed.progress_id,
                },
            )
            .await
            .unwrap();
            let history = plan_completion_history_for_store(store.clone(), enrollment.id.clone())
                .await
                .unwrap();
            assert_eq!(history.len(), 2);
            assert_eq!(history[0].assignment_id, original.assignment_id);
            assert_eq!(history[1].assignment_id, recompletion.assignment_id);
            assert_eq!(history[0].assignment_id, history[1].assignment_id);
            assert!(history[0].undone);
            assert!(!history[1].undone);
            assert_eq!(history[0].enrollment_id, enrollment.id);
            assert_eq!(history[0].stream_id, "old-testament");
            assert_eq!(history[0].stream_position, Some(0));
            assert_eq!(
                serde_json::to_value(&history[0]).unwrap()["streamPosition"],
                0
            );
            assert_eq!(serde_json::to_value(&history[0]).unwrap()["undone"], true);
        });
    }

    #[test]
    fn completion_history_command_propagates_core_errors() {
        tauri::async_runtime::block_on(async {
            let (_directory, store) = test_store();
            assert!(
                plan_completion_history_for_store(store, "not-a-uuid".into())
                    .await
                    .unwrap_err()
                    .contains("Invalid entry or revision UUID")
            );
        });
    }

    #[test]
    fn enrollment_discovery_returns_retained_records_in_core_order() {
        tauri::async_runtime::block_on(async {
            let (_directory, store) = test_store();
            assert!(list_plan_enrollments_for_store(store.clone())
                .await
                .unwrap()
                .is_empty());
            let definition = register_four_stream_plan_for_store(store.clone())
                .await
                .unwrap();
            let selections = || {
                vec![
                    StreamEnrollment {
                        stream_id: "old-testament".into(),
                        starting_position: 0,
                        loop_after_end: true,
                    },
                    StreamEnrollment {
                        stream_id: "new-testament".into(),
                        starting_position: 0,
                        loop_after_end: true,
                    },
                    StreamEnrollment {
                        stream_id: "psalms".into(),
                        starting_position: 0,
                        loop_after_end: true,
                    },
                    StreamEnrollment {
                        stream_id: "proverbs".into(),
                        starting_position: 0,
                        loop_after_end: true,
                    },
                ]
            };
            let first = enroll_in_chapter_streams_for_store(
                store.clone(),
                definition.id.clone(),
                selections(),
            )
            .await
            .unwrap();
            let second =
                enroll_in_chapter_streams_for_store(store.clone(), definition.id, selections())
                    .await
                    .unwrap();
            let mut expected = vec![first, second];
            expected
                .sort_by_key(|enrollment| (enrollment.created_at.clone(), enrollment.id.clone()));
            let listed = list_plan_enrollments_for_store(store).await.unwrap();
            assert_eq!(listed, expected);
            for enrollment in listed {
                assert_eq!(
                    serde_json::to_value(&enrollment).unwrap(),
                    serde_json::json!({
                        "id": enrollment.id,
                        "definitionVersionId": enrollment.definition_version_id,
                        "createdAt": enrollment.created_at,
                    })
                );
            }
        });
    }

    #[test]
    fn enrollment_discovery_propagates_an_unavailable_store_error() {
        tauri::async_runtime::block_on(async {
            let (_directory, store) = test_store();
            let poisoned = store.clone();
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _guard = poisoned.lock().unwrap();
                panic!("poison the synthetic discovery store");
            }));

            assert_eq!(
                list_plan_enrollments_for_store(store).await.unwrap_err(),
                "Journal is unavailable; restart the app."
            );
        });
    }
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
            register_four_stream_plan,
            register_mcheyne_plan,
            import_plan_definition_json,
            create_plan_definition_version,
            export_plan_definition_json,
            get_plan_definition_version,
            list_plan_definition_versions,
            list_latest_plan_definition_versions,
            list_plan_enrollments,
            enroll_in_chapter_streams,
            enroll_in_calendar,
            get_calendar_plan_enrollment,
            calendar_plan_assignments,
            active_plan_assignments,
            plan_completion_history,
            complete_plan_stream,
            undo_plan_completion,
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
