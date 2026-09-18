mod support;
use journal_core::{Entry, EntryContent, JournalStore, SaveRequest};
use uuid::Uuid;

fn save(store: &mut JournalStore, old: Option<&Entry>, body: &str, finish: bool) -> Entry {
    store
        .save_entry(SaveRequest {
            entry_id: old
                .map(|e| e.id.clone())
                .unwrap_or_else(|| Uuid::new_v4().to_string()),
            expected_revision_id: old.map(|e| e.working_revision_id.clone()),
            content: EntryContent {
                body: body.into(),
                ..old.map(|e| e.content.clone()).unwrap_or_default()
            },
            finish,
        })
        .unwrap()
}

#[test]
fn explicit_deletion_preserves_other_snapshots_and_rejects_stale_writers() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal.db");
    let mut store = JournalStore::open(&path).unwrap();
    let first = save(&mut store, None, "first", false);
    let finished = save(&mut store, Some(&first), "finished", true);
    let latest = save(&mut store, Some(&finished), "draft", false);
    assert!(store
        .purge_revision(
            &first.id,
            &first.working_revision_id,
            &finished.working_revision_id
        )
        .is_err());
    assert!(store
        .purge_revision(
            &first.id,
            &finished.working_revision_id,
            &latest.working_revision_id
        )
        .is_err());
    assert!(store
        .purge_revision(
            &first.id,
            &latest.working_revision_id,
            &latest.working_revision_id
        )
        .is_err());
    store
        .purge_revision(
            &first.id,
            &first.working_revision_id,
            &latest.working_revision_id,
        )
        .unwrap();
    let history = store.get_history(&first.id).unwrap();
    assert_eq!(history.len(), 2);
    assert_eq!(
        history[1].parent_id.as_deref(),
        Some(first.working_revision_id.as_str())
    );
    assert_eq!(history[1].content.body, "finished");
    let linked = store
        .save_entry(SaveRequest {
            entry_id: Uuid::new_v4().to_string(),
            expected_revision_id: None,
            content: EntryContent {
                links: vec![first.id.clone()],
                ..Default::default()
            },
            finish: false,
        })
        .unwrap();
    assert!(store
        .purge_entry(&first.id, &latest.working_revision_id)
        .is_err());
    store
        .set_entry_trashed(&first.id, &latest.working_revision_id, true)
        .unwrap();
    assert_eq!(store.list_entries().unwrap().len(), 1);
    assert_eq!(store.list_trash().unwrap().len(), 1);
    assert!(store
        .save_entry(SaveRequest {
            entry_id: latest.id.clone(),
            expected_revision_id: Some(latest.working_revision_id.clone()),
            content: latest.content.clone(),
            finish: false
        })
        .is_err());
    store
        .set_entry_trashed(&first.id, &latest.working_revision_id, false)
        .unwrap();
    assert_eq!(store.get_history(&first.id).unwrap().len(), 2);
    store
        .set_entry_trashed(&first.id, &latest.working_revision_id, true)
        .unwrap();
    store
        .purge_entry(&first.id, &latest.working_revision_id)
        .unwrap();
    assert!(store
        .save_entry(SaveRequest {
            entry_id: first.id.clone(),
            expected_revision_id: None,
            content: first.content,
            finish: false
        })
        .is_err());
    let retained = save(&mut store, Some(&linked), "kept link", false);
    let recovered = store
        .save_entry(SaveRequest {
            entry_id: Uuid::new_v4().to_string(),
            expected_revision_id: None,
            content: retained.content.clone(),
            finish: false,
        })
        .unwrap();
    assert_eq!(recovered.content.links, retained.content.links);
    assert_eq!(retained.content.links, vec![first.id]);
    drop(store);
    let store = JournalStore::open(&path).unwrap();
    assert_eq!(store.list_entries().unwrap().len(), 2);
    assert!(store.list_trash().unwrap().is_empty());
}

#[test]
fn trash_export_is_receipt_gated_and_restores_only_finished_content() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = JournalStore::open(&dir.path().join("journal.db")).unwrap();
    let published = save(&mut store, None, "finished content", true);
    let draft = save(&mut store, Some(&published), "private draft", false);
    let export = dir.path().join("existing");
    store.export_journal(&export).unwrap();
    store
        .set_entry_trashed(&draft.id, &draft.working_revision_id, true)
        .unwrap();
    store.export_journal(&export).unwrap();
    let note = export.join(format!("{}.md", draft.id));
    let bytes = std::fs::read_to_string(&note).unwrap();
    assert!(bytes.contains("deleted: true"));
    assert!(!bytes.contains("finished content"));
    let fresh = dir.path().join("fresh");
    assert_eq!(store.export_journal(&fresh).unwrap().written, 0);
    store
        .set_entry_trashed(&draft.id, &draft.working_revision_id, false)
        .unwrap();
    store.export_journal(&export).unwrap();
    let bytes = std::fs::read_to_string(&note).unwrap();
    assert!(bytes.contains("finished content"));
    assert!(!bytes.contains("private draft"));
    store
        .set_entry_trashed(&draft.id, &draft.working_revision_id, true)
        .unwrap();
    store
        .purge_entry(&draft.id, &draft.working_revision_id)
        .unwrap();
    store.export_journal(&export).unwrap();
    assert!(std::fs::read_to_string(&note)
        .unwrap()
        .contains("deleted: true"));
    assert_eq!(store.export_journal(&fresh).unwrap().written, 0);
}

#[test]
fn schema_twelve_migration_preserves_history_order_and_ancestry() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal.db");
    let mut store = JournalStore::open(&path).unwrap();
    let first = save(&mut store, None, "first", true);
    let second = save(&mut store, Some(&first), "second", false);
    let before = serde_json::to_value(store.get_history(&first.id).unwrap()).unwrap();
    drop(store);
    let conn = rusqlite::Connection::open(&path).unwrap();
    support::remove_deletion_schema(&conn);
    drop(conn);
    let mut store = JournalStore::open(&path).unwrap();
    assert_eq!(
        serde_json::to_value(store.get_history(&first.id).unwrap()).unwrap(),
        before
    );
    store
        .set_entry_trashed(&first.id, &second.working_revision_id, true)
        .unwrap();
    assert_eq!(store.list_trash().unwrap()[0].content.body, "second");
}
