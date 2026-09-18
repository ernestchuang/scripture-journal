use journal_core::{
    ChapterRef, ChapterStream, CompleteStreamRequest, EntryContent, ExplicitScheduleDay,
    JournalStore, Passage, PlanDefinition, PlanSchedule, SaveRequest, StreamEnrollment,
};
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

fn stream_definition(name: &str) -> PlanDefinition {
    PlanDefinition {
        schema_version: 1,
        name: name.into(),
        description: Some("Independent chapter streams".into()),
        schedule: PlanSchedule::ChapterStreams {
            streams: vec![
                ChapterStream {
                    id: "old-testament".into(),
                    name: "Old Testament".into(),
                    chapters: vec![
                        ChapterRef {
                            book: 1,
                            chapter: 1,
                        },
                        ChapterRef {
                            book: 1,
                            chapter: 2,
                        },
                    ],
                },
                ChapterStream {
                    id: "new-testament".into(),
                    name: "New Testament".into(),
                    chapters: vec![ChapterRef {
                        book: 40,
                        chapter: 1,
                    }],
                },
            ],
        },
    }
}

#[test]
fn plan_definitions_round_trip_and_prior_versions_are_retained() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let first_definition = stream_definition("Four streams");
    let first = store
        .create_plan_definition(first_definition.clone())
        .unwrap();
    assert_eq!(first.version, 1);
    assert_eq!(first.definition, first_definition);

    let second_definition = PlanDefinition {
        schema_version: 1,
        name: "Four streams, revised".into(),
        description: None,
        schedule: PlanSchedule::ExplicitSchedule {
            days: vec![ExplicitScheduleDay {
                day: 1,
                passages: vec![Passage {
                    book: 43,
                    chapter: 3,
                    start_verse: Some(16),
                    end_verse: Some(21),
                }],
            }],
        },
    };
    let second = store
        .create_plan_definition_version(&first.plan_id, second_definition.clone())
        .unwrap();
    assert_eq!(second.version, 2);
    assert_eq!(second.definition, second_definition);
    assert_eq!(
        store
            .get_plan_definition_version(&first.id)
            .unwrap()
            .unwrap()
            .definition,
        first_definition
    );
    assert_eq!(
        store
            .list_plan_definition_versions(&first.plan_id)
            .unwrap()
            .iter()
            .map(|version| version.version)
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
    drop(store);

    let conn = rusqlite::Connection::open(path).unwrap();
    assert!(conn
        .execute(
            "UPDATE plan_definition_versions SET definition='{}' WHERE id=?1",
            [&first.id],
        )
        .is_err());
    assert!(conn
        .execute(
            "DELETE FROM plan_definition_versions WHERE id=?1",
            [&first.id]
        )
        .is_err());
}

#[test]
fn malformed_plan_definitions_are_rejected_without_partial_rows() {
    let dir = TempDir::new().unwrap();
    let mut store = JournalStore::open(&dir.path().join("j.db")).unwrap();
    let mut invalid = stream_definition("Invalid");
    let PlanSchedule::ChapterStreams { streams } = &mut invalid.schedule else {
        unreachable!()
    };
    streams[0].chapters[0].chapter = 51;
    assert!(store.create_plan_definition(invalid).is_err());

    let first = store
        .create_plan_definition(stream_definition("Version rollback"))
        .unwrap();
    let invalid_verse = PlanDefinition {
        schema_version: 1,
        name: "Out of range verse".into(),
        description: None,
        schedule: PlanSchedule::ExplicitSchedule {
            days: vec![
                ExplicitScheduleDay {
                    day: 1,
                    passages: vec![Passage {
                        book: 43,
                        chapter: 3,
                        start_verse: Some(16),
                        end_verse: Some(21),
                    }],
                },
                ExplicitScheduleDay {
                    day: 2,
                    passages: vec![Passage {
                        book: 43,
                        chapter: 3,
                        start_verse: Some(999),
                        end_verse: Some(1_000),
                    }],
                },
            ],
        },
    };
    assert!(store
        .create_plan_definition_version(&first.plan_id, invalid_verse)
        .unwrap_err()
        .to_string()
        .contains("Verse exceeds chapter limit"));
    assert_eq!(
        store
            .list_plan_definition_versions(&first.plan_id)
            .unwrap()
            .len(),
        1
    );
    let boundary_definition = PlanDefinition {
        schema_version: 1,
        name: "Valid verse boundary".into(),
        description: None,
        schedule: PlanSchedule::ExplicitSchedule {
            days: vec![ExplicitScheduleDay {
                day: 1,
                passages: vec![Passage {
                    book: 43,
                    chapter: 3,
                    start_verse: Some(36),
                    end_verse: None,
                }],
            }],
        },
    };
    let second = store
        .create_plan_definition_version(&first.plan_id, boundary_definition)
        .unwrap();
    assert_eq!(second.version, 2);

    let mut invalid = stream_definition("Duplicate IDs");
    let PlanSchedule::ChapterStreams { streams } = &mut invalid.schedule else {
        unreachable!()
    };
    streams[1].id = streams[0].id.clone();
    assert!(store.create_plan_definition(invalid).is_err());

    let invalid = PlanDefinition {
        schema_version: 1,
        name: "Skipped day".into(),
        description: None,
        schedule: PlanSchedule::ExplicitSchedule {
            days: vec![ExplicitScheduleDay {
                day: 2,
                passages: vec![Passage {
                    book: 67,
                    chapter: 1,
                    start_verse: None,
                    end_verse: None,
                }],
            }],
        },
    };
    assert!(store.create_plan_definition(invalid).is_err());
    assert!(serde_json::from_str::<PlanDefinition>(
        r#"{"schemaVersion":1,"name":"Imported","schedule":{"kind":"chapterStreams","streams":[]},"executable":"code"}"#
    )
    .is_err());

    let valid = store
        .create_plan_definition(stream_definition("Valid after failures"))
        .unwrap();
    assert_eq!(valid.version, 1);
}

#[test]
fn schema_one_journal_data_survives_plan_migration() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let mut target_request = request("Existing target", true);
    let first_target = store.save_entry(target_request.clone()).unwrap();
    target_request.expected_revision_id = Some(first_target.working_revision_id);
    target_request.content.body = "A retained second revision".into();
    let saved_target = store.save_entry(target_request.clone()).unwrap();
    let mut source_request = request("Existing linked source", false);
    source_request.content.links.push(saved_target.id.clone());
    let saved_source = store.save_entry(source_request.clone()).unwrap();
    drop(store);

    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "DROP TABLE reading_completion_undos;
         DROP TABLE reading_completions;
         DROP TABLE plan_assignments;
         DROP TABLE plan_enrollment_streams;
         DROP TABLE plan_enrollments;
         DROP TRIGGER plans_retained;
         DROP TRIGGER plan_definition_versions_retained;
         DROP TRIGGER plan_definition_versions_immutable;
         DROP TABLE plan_definition_versions;
         DROP TABLE plans;
         PRAGMA user_version=1;",
    )
    .unwrap();
    drop(conn);

    let mut migrated = JournalStore::open(&path).unwrap();
    let entries = migrated.list_entries().unwrap();
    assert_eq!(entries.len(), 2);
    let target = entries
        .iter()
        .find(|entry| entry.id == saved_target.id)
        .unwrap();
    assert_eq!(target.content, target_request.content);
    let source = entries
        .iter()
        .find(|entry| entry.id == saved_source.id)
        .unwrap();
    assert_eq!(source.content, source_request.content);
    assert_eq!(source.content.links, vec![saved_target.id.clone()]);
    assert_eq!(migrated.get_history(&saved_target.id).unwrap().len(), 2);
    assert_eq!(migrated.get_history(&saved_source.id).unwrap().len(), 1);
    let plan = migrated
        .create_plan_definition(stream_definition("After migration"))
        .unwrap();
    assert_eq!(plan.version, 1);
    drop(migrated);
    let conn = rusqlite::Connection::open(path).unwrap();
    assert_eq!(
        conn.pragma_query_value::<u32, _>(None, "user_version", |row| row.get(0))
            .unwrap(),
        3
    );
}

fn stream_selections(loop_after_end: bool) -> Vec<StreamEnrollment> {
    vec![
        StreamEnrollment {
            stream_id: "old-testament".into(),
            starting_chapter: ChapterRef {
                book: 1,
                chapter: 1,
            },
            loop_after_end,
        },
        StreamEnrollment {
            stream_id: "new-testament".into(),
            starting_chapter: ChapterRef {
                book: 40,
                chapter: 1,
            },
            loop_after_end,
        },
    ]
}

#[test]
fn stream_enrollment_is_pinned_survives_reopen_and_advances_independently() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let version = store
        .create_plan_definition(stream_definition("Original"))
        .unwrap();
    let mut invalid = stream_selections(false);
    invalid[0].starting_chapter.chapter = 50;
    assert!(store
        .enroll_in_chapter_streams(&version.id, invalid)
        .is_err());
    let enrollment = store
        .enroll_in_chapter_streams(&version.id, stream_selections(false))
        .unwrap();
    store
        .create_plan_definition_version(&version.plan_id, stream_definition("Edited"))
        .unwrap();
    let before = store.active_plan_assignments(&enrollment.id).unwrap();
    let old = before
        .iter()
        .find(|assignment| assignment.stream_id == "old-testament")
        .unwrap();
    store
        .complete_plan_stream(CompleteStreamRequest {
            enrollment_id: enrollment.id.clone(),
            stream_id: old.stream_id.clone(),
            expected_assignment_id: old.id.clone(),
        })
        .unwrap();
    drop(store);

    let store = JournalStore::open(&path).unwrap();
    let after = store.active_plan_assignments(&enrollment.id).unwrap();
    assert_eq!(after.len(), 2);
    let old = after
        .iter()
        .find(|assignment| assignment.stream_id == "old-testament")
        .unwrap();
    assert_eq!(
        (old.passage.book, old.passage.chapter, old.ordinal),
        (1, 2, 2)
    );
    let new = after
        .iter()
        .find(|assignment| assignment.stream_id == "new-testament")
        .unwrap();
    assert_eq!(
        new.id,
        before
            .iter()
            .find(|a| a.stream_id == "new-testament")
            .unwrap()
            .id
    );
}

#[test]
fn stop_loop_stale_completion_and_ordered_undo_preserve_history() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let version = store
        .create_plan_definition(stream_definition("Progress"))
        .unwrap();
    let stopped = store
        .enroll_in_chapter_streams(&version.id, stream_selections(false))
        .unwrap();
    let first = store
        .active_plan_assignments(&stopped.id)
        .unwrap()
        .into_iter()
        .find(|a| a.stream_id == "old-testament")
        .unwrap();
    let first_completion = store
        .complete_plan_stream(CompleteStreamRequest {
            enrollment_id: stopped.id.clone(),
            stream_id: first.stream_id.clone(),
            expected_assignment_id: first.id.clone(),
        })
        .unwrap();
    assert!(store
        .complete_plan_stream(CompleteStreamRequest {
            enrollment_id: stopped.id.clone(),
            stream_id: first.stream_id.clone(),
            expected_assignment_id: first.id,
        })
        .unwrap_err()
        .to_string()
        .contains("Conflict"));
    let second = store
        .active_plan_assignments(&stopped.id)
        .unwrap()
        .into_iter()
        .find(|a| a.stream_id == first.stream_id)
        .unwrap();
    let second_completion = store
        .complete_plan_stream(CompleteStreamRequest {
            enrollment_id: stopped.id.clone(),
            stream_id: second.stream_id.clone(),
            expected_assignment_id: second.id,
        })
        .unwrap();
    assert!(store.undo_plan_completion(&first_completion.id).is_err());
    store.undo_plan_completion(&second_completion.id).unwrap();
    store.undo_plan_completion(&first_completion.id).unwrap();
    assert_eq!(
        store
            .active_plan_assignments(&stopped.id)
            .unwrap()
            .into_iter()
            .find(|a| a.stream_id == first.stream_id)
            .unwrap()
            .ordinal,
        1
    );

    let looped = store
        .enroll_in_chapter_streams(&version.id, stream_selections(true))
        .unwrap();
    for expected_cycle in [1, 1] {
        let assignment = store
            .active_plan_assignments(&looped.id)
            .unwrap()
            .into_iter()
            .find(|a| a.stream_id == "old-testament")
            .unwrap();
        assert_eq!(assignment.cycle, expected_cycle);
        store
            .complete_plan_stream(CompleteStreamRequest {
                enrollment_id: looped.id.clone(),
                stream_id: assignment.stream_id,
                expected_assignment_id: assignment.id,
            })
            .unwrap();
    }
    let wrapped = store
        .active_plan_assignments(&looped.id)
        .unwrap()
        .into_iter()
        .find(|a| a.stream_id == "old-testament")
        .unwrap();
    assert_eq!(
        (wrapped.ordinal, wrapped.cycle, wrapped.passage.chapter),
        (3, 2, 1)
    );

    drop(store);
    let conn = rusqlite::Connection::open(path).unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM reading_completions", [], |r| r
            .get::<_, u32>(0))
            .unwrap(),
        4
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM reading_completion_undos", [], |r| r
            .get::<_, u32>(
            0
        ))
        .unwrap(),
        2
    );
}

#[test]
fn schema_two_plan_rows_survive_progress_migration() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let plan = store
        .create_plan_definition(stream_definition("Before progress"))
        .unwrap();
    drop(store);
    let conn = rusqlite::Connection::open(&path).unwrap();
    for table in [
        "reading_completion_undos",
        "reading_completions",
        "plan_assignments",
        "plan_enrollment_streams",
        "plan_enrollments",
    ] {
        conn.execute(&format!("DROP TABLE {table}"), []).unwrap();
    }
    conn.pragma_update(None, "user_version", 2).unwrap();
    drop(conn);
    let store = JournalStore::open(&path).unwrap();
    assert_eq!(
        store
            .get_plan_definition_version(&plan.id)
            .unwrap()
            .unwrap(),
        plan
    );
}

fn export_fixture(dir: &TempDir, name: &str) -> std::path::PathBuf {
    // macOS exposes its temporary directory through /var -> /private/var. Resolve
    // that trusted test-fixture alias; production must keep rejecting selected
    // destinations with symlink ancestors.
    dir.path().canonicalize().unwrap().join(name)
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
    let out = export_fixture(&dir, "export");
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
    let out = export_fixture(&dir, "out");
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
fn selected_symlink_destinations_are_rejected_without_touching_outside_files() {
    use std::os::unix::fs::symlink;
    let dir = TempDir::new().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let mut store = JournalStore::open(&base.join("j.db")).unwrap();
    store.save_entry(request("Published", true)).unwrap();
    let real = base.join("real");
    fs::create_dir(&real).unwrap();
    assert_eq!(store.export_journal(&real).unwrap().written, 1);

    let outside = base.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("external.md"), b"outside bytes").unwrap();
    let link = base.join("link");
    symlink(&outside, &link).unwrap();
    assert!(store.export_journal(&link).is_err());
    let ancestor = base.join("ancestor");
    symlink(&outside, &ancestor).unwrap();
    assert!(store.export_journal(&ancestor.join("nested")).is_err());

    assert_eq!(
        fs::read(outside.join("external.md")).unwrap(),
        b"outside bytes"
    );
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
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

#[cfg(unix)]
#[test]
fn export_rejects_symlinked_managed_files_without_touching_external_bytes() {
    use std::os::unix::fs::symlink;
    for managed in ["lock", "manifest", "entry"] {
        let dir = TempDir::new().unwrap();
        let mut store = JournalStore::open(&dir.path().join("j.db")).unwrap();
        let req = request("Synthetic published entry", true);
        store.save_entry(req.clone()).unwrap();
        let out = dir.path().canonicalize().unwrap().join("out");
        fs::create_dir(&out).unwrap();
        let external = dir.path().join("external.txt");
        fs::write(&external, "External content must survive").unwrap();
        let name = match managed {
            "lock" => ".scripture-journal-export.lock".to_string(),
            "manifest" => ".scripture-journal-export.json".to_string(),
            _ => format!("{}.md", req.entry_id),
        };
        let link = out.join(name);
        symlink(&external, &link).unwrap();
        let result = store.export_journal(&out);
        if managed == "entry" {
            let report = result.unwrap();
            assert_eq!(report.written, 0);
            assert_eq!(report.conflicts.len(), 1);
        } else {
            assert!(result.is_err(), "{managed} symlink must reject export");
        }
        assert_eq!(
            fs::read_to_string(&external).unwrap(),
            "External content must survive"
        );
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
    }
}

#[cfg(unix)]
#[test]
fn symlinked_recovery_directory_preserves_previous_export_and_can_retry() {
    use std::os::unix::fs::symlink;
    let dir = TempDir::new().unwrap();
    let mut store = JournalStore::open(&dir.path().join("j.db")).unwrap();
    let mut req = request("Synthetic published entry", true);
    let first = store.save_entry(req.clone()).unwrap();
    let out = dir.path().canonicalize().unwrap().join("out");
    store.export_journal(&out).unwrap();
    let target = out.join(format!("{}.md", req.entry_id));
    let original = fs::read(&target).unwrap();
    req.expected_revision_id = Some(first.working_revision_id);
    req.content.body = "New finished synthetic text".into();
    store.save_entry(req).unwrap();
    let external = dir.path().join("external");
    fs::create_dir(&external).unwrap();
    let recovery = out.join(".scripture-journal-recovery");
    symlink(&external, &recovery).unwrap();
    let report = store.export_journal(&out).unwrap();
    assert_eq!(report.written, 0);
    assert_eq!(report.conflicts.len(), 1);
    assert_eq!(fs::read(&target).unwrap(), original);
    assert_eq!(fs::read_dir(&external).unwrap().count(), 0);
    assert!(fs::symlink_metadata(&recovery)
        .unwrap()
        .file_type()
        .is_symlink());

    // Explicitly remove the test obstruction, then retry the pending export.
    fs::remove_file(&recovery).unwrap();
    let report = store.export_journal(&out).unwrap();
    assert_eq!(report.written, 1);
    assert!(report.conflicts.is_empty());
    assert!(fs::read_to_string(&target)
        .unwrap()
        .contains("New finished synthetic text"));
    let saved: Vec<_> = fs::read_dir(&recovery).unwrap().collect();
    assert_eq!(saved.len(), 1);
    assert_eq!(
        fs::read(saved[0].as_ref().unwrap().path()).unwrap(),
        original
    );
    assert_eq!(fs::read_dir(&external).unwrap().count(), 0);
}
