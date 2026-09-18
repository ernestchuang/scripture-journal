use journal_core::JournalStore;
use rusqlite::Connection;
use std::fs;

fn entry(source: &tempfile::TempDir, name: &str, bytes: &[u8]) {
    let path = source.path().join("journal").join(name);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

#[test]
fn preview_is_read_only_and_import_is_repeatable_with_exact_provenance() {
    let source = tempfile::tempdir().unwrap();
    let alpha = b"---\r\ndate: \"2026-01-02\"\r\nbook: John\r\nchapter: 3\r\ntags: [mercy, hope]\r\nlegacy-color: blue\r\n---\r\n# Alpha\r\nSee [[Beta]] and [[missing]].\r\n";
    entry(&source, "alpha.md", alpha);
    entry(
        &source,
        "John/004/beta.md",
        b"---\ndate: 2026-01-03\nbook: John\nchapter: 4\n---\n# Beta\nBack to [[Alpha|the first note]].\n",
    );
    entry(&source, "John/004/04-notes.md", b"chapter notes");
    entry(&source, "bad.md", b"---\ndate: 2026-99-99\n---\nbad");

    let db = tempfile::NamedTempFile::new().unwrap();
    let mut store = JournalStore::open(db.path()).unwrap();
    let preview = store.preview_legacy_import(source.path()).unwrap();
    assert_eq!(
        (
            preview.recognized,
            preview.unsupported,
            preview.unresolved_links
        ),
        (2, 2, 1)
    );
    assert!(
        store.list_entries().unwrap().is_empty(),
        "preview must not write"
    );
    assert_eq!(
        fs::read(source.path().join("journal/alpha.md")).unwrap(),
        alpha
    );

    let result = store
        .import_legacy_journal(source.path(), &preview.preview_id)
        .unwrap();
    assert_eq!(
        (result.imported, result.revisions_created, result.unchanged),
        (2, 2, 0)
    );
    let entries = store.list_entries().unwrap();
    let alpha_entry = entries
        .iter()
        .find(|item| item.content.title == "Alpha")
        .unwrap();
    let beta_entry = entries
        .iter()
        .find(|item| item.content.title == "Beta")
        .unwrap();
    assert_eq!(alpha_entry.content.links, vec![beta_entry.id.clone()]);
    assert_eq!(beta_entry.content.links, vec![alpha_entry.id.clone()]);
    let alpha_id = alpha_entry.id.clone();

    let again = store
        .import_legacy_journal(source.path(), &preview.preview_id)
        .unwrap();
    assert_eq!(
        (again.imported, again.revisions_created, again.unchanged),
        (0, 0, 2)
    );
    assert_eq!(store.get_history(&alpha_id).unwrap().len(), 1);
    drop(store);

    let conn = Connection::open(db.path()).unwrap();
    let retained: Vec<u8> = conn
        .query_row(
            "SELECT source_bytes FROM legacy_import_sources WHERE relative_path='alpha.md'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(retained, alpha);
    let metadata: String = conn
        .query_row(
            "SELECT metadata_json FROM legacy_import_sources WHERE relative_path='alpha.md'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(metadata.contains("legacy-color: blue"));
    assert!(metadata.contains("2026-01-02"));
}

#[test]
fn changed_source_creates_a_revision_and_stale_confirmation_writes_nothing() {
    let source = tempfile::tempdir().unwrap();
    let initial = b"---\ndate: 2026-01-02\nbook: John\nchapter: 3\n---\n# Alpha\nFirst.\n";
    entry(&source, "alpha.md", initial);
    let db = tempfile::NamedTempFile::new().unwrap();
    let mut store = JournalStore::open(db.path()).unwrap();
    let preview = store.preview_legacy_import(source.path()).unwrap();
    store
        .import_legacy_journal(source.path(), &preview.preview_id)
        .unwrap();
    let id = store.list_entries().unwrap()[0].id.clone();

    entry(
        &source,
        "alpha.md",
        b"---\ndate: 2026-01-02\nbook: John\nchapter: 3\nlegacy: kept\n---\n# Alpha\nSecond.\n",
    );
    let changed = store.preview_legacy_import(source.path()).unwrap();
    assert_eq!((changed.changed, changed.unchanged), (1, 0));
    let result = store
        .import_legacy_journal(source.path(), &changed.preview_id)
        .unwrap();
    assert_eq!((result.imported, result.revisions_created), (0, 1));
    assert_eq!(store.list_entries().unwrap()[0].id, id);
    assert_eq!(store.get_history(&id).unwrap().len(), 2);

    let before = store.list_entries().unwrap();
    let error = store
        .import_legacy_journal(source.path(), "stale-preview")
        .unwrap_err();
    assert!(error.to_string().contains("preview it again"));
    assert_eq!(
        store.list_entries().unwrap()[0].working_revision_id,
        before[0].working_revision_id
    );

    let current = store.preview_legacy_import(source.path()).unwrap();
    entry(
        &source,
        "alpha.md",
        b"---\ndate: 2026-01-02\nbook: John\nchapter: 3\n---\n# Alpha\nThird.\n",
    );
    let error = store
        .import_legacy_journal(source.path(), &current.preview_id)
        .unwrap_err();
    assert!(error.to_string().contains("preview it again"));
    assert_eq!(store.get_history(&id).unwrap().len(), 2);
}

#[test]
fn unsafe_yaml_is_reported_without_blocking_valid_records() {
    let source = tempfile::tempdir().unwrap();
    entry(
        &source,
        "unsafe.md",
        b"---\ndate: 2026-01-02\nbook: !Thing John\nchapter: 3\n---\nunsafe\n",
    );
    entry(
        &source,
        "valid.md",
        b"---\ndate: 2026-01-02\nbook: John\nchapter: 3\n---\nvalid\n",
    );
    let db = tempfile::NamedTempFile::new().unwrap();
    let mut store = JournalStore::open(db.path()).unwrap();
    let preview = store.preview_legacy_import(source.path()).unwrap();
    assert_eq!((preview.recognized, preview.unsupported), (1, 1));
    assert!(preview.records.iter().any(|record| record
        .warnings
        .iter()
        .any(|warning| warning.contains("Unsafe YAML"))));
    let imported = store
        .import_legacy_journal(source.path(), &preview.preview_id)
        .unwrap();
    assert_eq!((imported.imported, imported.unsupported), (1, 1));
}
