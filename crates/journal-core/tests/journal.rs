use journal_core::{EntryContent, JournalStore, Passage, SaveRequest};
use std::fs;
use tempfile::TempDir;
use uuid::Uuid;

fn request(title: &str, finish: bool) -> SaveRequest {
    SaveRequest {
        entry_id: Uuid::new_v4().to_string(),
        expected_revision_id: None,
        finish,
        content: EntryContent {
            title: title.into(),
            body: "A reflection".into(),
            passages: vec![Passage {
                book: 43,
                chapter: 3,
                start_verse: Some(16),
                end_verse: Some(21),
            }],
            tags: vec!["hope".into()],
            links: vec![],
        },
    }
}

#[test]
fn reopen_recovers_full_draft_and_settings() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("journal.db");
    let mut store = JournalStore::open(&path).unwrap();
    let req = request("Draft", false);
    let saved = store.save_entry(req.clone()).unwrap();
    store.set_setting("reader", "{\"book\":43}").unwrap();
    drop(store);
    let store = JournalStore::open(&path).unwrap();
    let entries = store.list_entries().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].content, req.content);
    assert_eq!(entries[0].working_revision_id, saved.working_revision_id);
    assert!(entries[0].published_revision_id.is_none());
    assert_eq!(
        store.get_setting("reader").unwrap().as_deref(),
        Some("{\"book\":43}")
    );
}

#[test]
fn stale_writes_fail_and_finish_publishes_exact_snapshot() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("journal.db");
    let mut store = JournalStore::open(&path).unwrap();
    let mut other = JournalStore::open(&path).unwrap();
    let mut req = request("First", false);
    let first = store.save_entry(req.clone()).unwrap();
    assert!(other
        .save_entry(req.clone())
        .unwrap_err()
        .to_string()
        .contains("Conflict"));
    req.expected_revision_id = Some(first.working_revision_id.clone());
    let same = store.save_entry(req.clone()).unwrap();
    assert_eq!(store.get_history(&req.entry_id).unwrap().len(), 1);
    assert_eq!(same.working_revision_id, first.working_revision_id);
    req.content.body = "Exact pending editor content".into();
    req.finish = true;
    let finished = store.save_entry(req.clone()).unwrap();
    assert_eq!(finished.content.body, req.content.body);
    assert_eq!(
        finished.published_revision_id.as_deref(),
        Some(finished.working_revision_id.as_str())
    );
    assert!(other.save_entry(req.clone()).is_err());
    assert_eq!(store.get_history(&req.entry_id).unwrap().len(), 2);
}

#[test]
fn stable_links_and_restoration_retain_history() {
    let dir = TempDir::new().unwrap();
    let mut store = JournalStore::open(&dir.path().join("j.db")).unwrap();
    let mut target = request("Target", true);
    let original = store.save_entry(target.clone()).unwrap();
    let mut source = request("Source", true);
    source.content.links.push(target.entry_id.clone());
    store.save_entry(source.clone()).unwrap();
    target.expected_revision_id = Some(original.working_revision_id.clone());
    target.content.title = "Renamed".into();
    let renamed = store.save_entry(target.clone()).unwrap();
    assert_eq!(
        store
            .list_entries()
            .unwrap()
            .iter()
            .find(|e| e.id == source.entry_id)
            .unwrap()
            .content
            .links[0],
        target.entry_id
    );
    let restored = store
        .restore_revision(
            &target.entry_id,
            &original.working_revision_id,
            Some(&renamed.working_revision_id),
        )
        .unwrap();
    assert_eq!(restored.content.title, "Target");
    assert_eq!(
        restored.published_revision_id,
        renamed.published_revision_id
    );
    assert_ne!(restored.working_revision_id, original.working_revision_id);
    let history = store.get_history(&target.entry_id).unwrap();
    assert_eq!(history.len(), 3);
    assert_eq!(
        history[0].restored_from_id.as_deref(),
        Some(original.working_revision_id.as_str())
    );
    assert!(store
        .restore_revision(&source.entry_id, &original.working_revision_id, None)
        .is_err());
}

#[test]
fn export_only_published_content_and_preserves_external_changes() {
    let dir = TempDir::new().unwrap();
    let mut store = JournalStore::open(&dir.path().join("j.db")).unwrap();
    let draft = request("TOP SECRET DRAFT", false);
    store.save_entry(draft.clone()).unwrap();
    let mut req = request("Published", true);
    req.content.links.push(draft.entry_id.clone());
    let first = store.save_entry(req.clone()).unwrap();
    let out = dir.path().join("export");
    assert_eq!(store.export_journal(&out).unwrap().written, 1);
    let file = out.join(format!("{}.md", req.entry_id));
    let initial = fs::read_to_string(&file).unwrap();
    assert!(!initial.contains("TOP SECRET"));
    assert!(!initial.contains(&draft.entry_id));
    assert!(!out.join(format!("{}.md", draft.entry_id)).exists());
    req.expected_revision_id = Some(first.working_revision_id);
    req.content.body = "Unfinished secret edit".into();
    req.finish = false;
    let second = store.save_entry(req.clone()).unwrap();
    assert_eq!(store.export_journal(&out).unwrap().unchanged, 1);
    assert_eq!(fs::read_to_string(&file).unwrap(), initial);
    req.expected_revision_id = Some(second.working_revision_id);
    req.finish = true;
    store.save_entry(req.clone()).unwrap();
    assert_eq!(store.export_journal(&out).unwrap().written, 1);
    assert!(fs::read_to_string(&file)
        .unwrap()
        .contains("Unfinished secret edit"));
    fs::write(&file, "External writing").unwrap();
    assert_eq!(store.export_journal(&out).unwrap().conflicts.len(), 1);
    assert_eq!(fs::read_to_string(&file).unwrap(), "External writing");
}

#[test]
fn export_rejects_unowned_files_and_foreign_journals() {
    let dir = TempDir::new().unwrap();
    let mut store = JournalStore::open(&dir.path().join("j.db")).unwrap();
    let req = request("Published", true);
    store.save_entry(req.clone()).unwrap();
    let out = dir.path().join("out");
    fs::create_dir(&out).unwrap();
    let file = out.join(format!("{}.md", req.entry_id));
    fs::write(&file, "unowned").unwrap();
    assert_eq!(store.export_journal(&out).unwrap().conflicts.len(), 1);
    assert_eq!(fs::read_to_string(file).unwrap(), "unowned");
    let other = JournalStore::open(&dir.path().join("other.db")).unwrap();
    assert!(other.export_journal(&out).is_err());
}

#[test]
fn invalid_links_and_schema_fail_without_partial_entries() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let mut req = request("Bad", false);
    req.content.links.push(Uuid::new_v4().to_string());
    assert!(store.save_entry(req).is_err());
    assert!(store.list_entries().unwrap().is_empty());
    drop(store);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.pragma_update(None, "user_version", 999).unwrap();
    drop(conn);
    assert!(JournalStore::open(&path).is_err());
}

#[cfg(unix)]
#[test]
fn symlink_destinations_are_rejected() {
    use std::os::unix::fs::symlink;
    let dir = TempDir::new().unwrap();
    let store = JournalStore::open(&dir.path().join("j.db")).unwrap();
    let real = dir.path().join("real");
    fs::create_dir(&real).unwrap();
    let link = dir.path().join("link");
    symlink(&real, &link).unwrap();
    assert!(store.export_journal(&link).is_err());
}

#[test]
fn finish_without_changed_content_reuses_revision_and_serializes_contract() {
    let dir = TempDir::new().unwrap();
    let mut store = JournalStore::open(&dir.path().join("j.db")).unwrap();
    let mut req = request("Saved draft", false);
    let saved = store.save_entry(req.clone()).unwrap();
    req.expected_revision_id = Some(saved.working_revision_id.clone());
    req.finish = true;
    let finished = store.save_entry(req).unwrap();
    assert_eq!(store.get_history(&finished.id).unwrap().len(), 1);
    assert_eq!(
        finished.published_revision_id,
        Some(saved.working_revision_id)
    );
    let json = serde_json::to_value(finished).unwrap();
    assert!(json.get("workingRevisionId").is_some());
    assert!(json.get("working_revision_id").is_none());
    assert_eq!(json["content"]["passages"][0]["startVerse"], 16);
}

#[test]
fn export_recovers_receipt_after_file_was_written() {
    let dir = TempDir::new().unwrap();
    let mut store = JournalStore::open(&dir.path().join("j.db")).unwrap();
    let req = request("Published", true);
    store.save_entry(req.clone()).unwrap();
    let out = dir.path().canonicalize().unwrap().join("out");
    store.export_journal(&out).unwrap();
    let manifest_path = out.join(".scripture-journal-export.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    // Simulate interruption after first file installation, before receipt update.
    let receipt = &mut manifest["receipts"][&req.entry_id];
    receipt["pendingHash"] = receipt["hash"].take();
    receipt["revisionId"] = serde_json::Value::Null;
    fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    let report = store.export_journal(&out).unwrap();
    assert_eq!(report.unchanged, 1);
    assert!(report.conflicts.is_empty());
}

#[test]
fn database_prevents_revision_rewrite_and_cross_entry_heads() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let first = store.save_entry(request("A", true)).unwrap();
    let second = store.save_entry(request("B", false)).unwrap();
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    assert!(conn
        .execute(
            "UPDATE revisions SET content='{}' WHERE id=?1",
            [&first.working_revision_id]
        )
        .is_err());
    assert!(conn
        .execute(
            "DELETE FROM revisions WHERE id=?1",
            [&first.working_revision_id]
        )
        .is_err());
    assert!(conn
        .execute(
            "UPDATE entries SET working_revision_id=?1 WHERE id=?2",
            [&second.working_revision_id, &first.id]
        )
        .is_err());
    assert_eq!(store.list_entries().unwrap().len(), 2);
}
