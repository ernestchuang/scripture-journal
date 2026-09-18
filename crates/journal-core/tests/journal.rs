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
        "DROP TABLE plan_stream_progress_epochs;
         DROP TABLE reading_completion_undos;
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
        6
    );
}

fn stream_selections(loop_after_end: bool) -> Vec<StreamEnrollment> {
    vec![
        StreamEnrollment {
            stream_id: "old-testament".into(),
            starting_position: 0,
            loop_after_end,
        },
        StreamEnrollment {
            stream_id: "new-testament".into(),
            starting_position: 0,
            loop_after_end,
        },
    ]
}

fn progress_fingerprint(path: &std::path::Path) -> Vec<String> {
    let conn = rusqlite::Connection::open(path).unwrap();
    [
        "SELECT group_concat(id||':'||definition_version_id||':'||created_at,'|') FROM (SELECT * FROM plan_enrollments ORDER BY id)",
        "SELECT group_concat(enrollment_id||':'||stream_id||':'||loop_after_end,'|') FROM (SELECT * FROM plan_enrollment_streams ORDER BY enrollment_id,stream_id)",
        "SELECT group_concat(id||':'||enrollment_id||':'||stream_id||':'||ordinal||':'||cycle||':'||passage||':'||COALESCE(stream_position,'null'),'|') FROM (SELECT * FROM plan_assignments ORDER BY id)",
        "SELECT group_concat(id||':'||assignment_id||':'||completed_at,'|') FROM (SELECT * FROM reading_completions ORDER BY id)",
        "SELECT group_concat(id||':'||completion_id||':'||undone_at,'|') FROM (SELECT * FROM reading_completion_undos ORDER BY id)",
        "SELECT group_concat(id||':'||enrollment_id||':'||stream_id||':'||sequence||':'||assignment_id||':'||created_at,'|') FROM (SELECT * FROM plan_stream_progress_epochs ORDER BY id)",
    ]
    .into_iter()
    .map(|query| {
        conn.query_row(query, [], |row| row.get::<_, Option<String>>(0))
            .unwrap()
            .unwrap_or_default()
    })
    .collect()
}

#[test]
fn enrollment_failure_after_partial_stream_writes_rolls_back_exactly() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let version = store
        .create_plan_definition(stream_definition("Injected enrollment failure"))
        .unwrap();
    drop(store);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER inject_enrollment_failure BEFORE INSERT ON plan_assignments
         WHEN NEW.stream_id='new-testament'
         BEGIN SELECT RAISE(ABORT,'injected enrollment failure'); END;",
    )
    .unwrap();
    drop(conn);
    let before = progress_fingerprint(&path);

    let mut store = JournalStore::open(&path).unwrap();
    assert!(store
        .enroll_in_chapter_streams(&version.id, stream_selections(false))
        .unwrap_err()
        .to_string()
        .contains("injected enrollment failure"));
    drop(store);
    assert_eq!(progress_fingerprint(&path), before);
}

#[test]
fn completion_failure_after_history_and_assignment_writes_rolls_back_exactly() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let version = store
        .create_plan_definition(stream_definition("Injected completion failure"))
        .unwrap();
    let enrollment = store
        .enroll_in_chapter_streams(&version.id, stream_selections(false))
        .unwrap();
    let assignment = store
        .active_plan_assignments(&enrollment.id)
        .unwrap()
        .into_iter()
        .find(|value| value.stream_id == "old-testament")
        .unwrap();
    drop(store);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER inject_completion_failure BEFORE INSERT ON plan_stream_progress_epochs
         WHEN NEW.stream_id='old-testament' AND NEW.sequence=2
         BEGIN SELECT RAISE(ABORT,'injected completion failure'); END;",
    )
    .unwrap();
    drop(conn);
    let before = progress_fingerprint(&path);

    let mut store = JournalStore::open(&path).unwrap();
    assert!(store
        .complete_plan_stream(CompleteStreamRequest {
            enrollment_id: enrollment.id,
            stream_id: assignment.stream_id,
            expected_assignment_id: assignment.id,
            expected_progress_id: assignment.progress_id,
        })
        .unwrap_err()
        .to_string()
        .contains("injected completion failure"));
    drop(store);
    assert_eq!(progress_fingerprint(&path), before);
}

#[test]
fn undo_failure_after_undo_history_write_rolls_back_exactly() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let version = store
        .create_plan_definition(stream_definition("Injected undo failure"))
        .unwrap();
    let enrollment = store
        .enroll_in_chapter_streams(&version.id, stream_selections(false))
        .unwrap();
    let assignment = store
        .active_plan_assignments(&enrollment.id)
        .unwrap()
        .into_iter()
        .find(|value| value.stream_id == "old-testament")
        .unwrap();
    let completion = store
        .complete_plan_stream(CompleteStreamRequest {
            enrollment_id: enrollment.id,
            stream_id: assignment.stream_id,
            expected_assignment_id: assignment.id,
            expected_progress_id: assignment.progress_id,
        })
        .unwrap();
    drop(store);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER inject_undo_failure BEFORE INSERT ON plan_stream_progress_epochs
         WHEN NEW.stream_id='old-testament' AND NEW.sequence=3
         BEGIN SELECT RAISE(ABORT,'injected undo failure'); END;",
    )
    .unwrap();
    drop(conn);
    let before = progress_fingerprint(&path);

    let mut store = JournalStore::open(&path).unwrap();
    assert!(store
        .undo_plan_completion(&completion.id)
        .unwrap_err()
        .to_string()
        .contains("injected undo failure"));
    drop(store);
    assert_eq!(progress_fingerprint(&path), before);
}

#[test]
fn stream_enrollment_is_pinned_survives_reopen_and_advances_independently() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let mut original_definition = stream_definition("Original");
    let PlanSchedule::ChapterStreams { streams } = &mut original_definition.schedule else {
        unreachable!();
    };
    streams
        .iter_mut()
        .find(|stream| stream.id == "old-testament")
        .unwrap()
        .chapters
        .push(ChapterRef {
            book: 1,
            chapter: 3,
        });
    let version = store
        .create_plan_definition(original_definition.clone())
        .unwrap();
    let mut invalid = stream_selections(false);
    invalid[0].starting_position = 50;
    assert!(store
        .enroll_in_chapter_streams(&version.id, invalid)
        .is_err());
    let enrollment = store
        .enroll_in_chapter_streams(&version.id, stream_selections(false))
        .unwrap();
    assert_eq!(enrollment.definition_version_id, version.id);
    let mut edited_definition = stream_definition("Edited and reordered");
    let PlanSchedule::ChapterStreams { streams } = &mut edited_definition.schedule else {
        unreachable!();
    };
    streams.swap(0, 1);
    let edited_old_testament = streams
        .iter_mut()
        .find(|stream| stream.id == "old-testament")
        .unwrap();
    edited_old_testament.chapters = vec![
        ChapterRef {
            book: 1,
            chapter: 1,
        },
        ChapterRef {
            book: 1,
            chapter: 3,
        },
        ChapterRef {
            book: 1,
            chapter: 4,
        },
    ];
    let edited_version = store
        .create_plan_definition_version(&version.plan_id, edited_definition.clone())
        .unwrap();
    let before = store.active_plan_assignments(&enrollment.id).unwrap();
    let old = before
        .iter()
        .find(|assignment| assignment.stream_id == "old-testament")
        .unwrap();
    let completion = store
        .complete_plan_stream(CompleteStreamRequest {
            enrollment_id: enrollment.id.clone(),
            stream_id: old.stream_id.clone(),
            expected_assignment_id: old.id.clone(),
            expected_progress_id: old.progress_id.clone(),
        })
        .unwrap();
    let advanced_before_reopen = store.active_plan_assignments(&enrollment.id).unwrap();
    let advanced_old = advanced_before_reopen
        .iter()
        .find(|assignment| assignment.stream_id == "old-testament")
        .unwrap();
    assert_eq!(
        (
            advanced_old.passage.book,
            advanced_old.passage.chapter,
            advanced_old.ordinal
        ),
        (1, 2, 2)
    );
    let retained_progress = progress_fingerprint(&path);
    drop(store);

    let mut store = JournalStore::open(&path).unwrap();
    let after = store.active_plan_assignments(&enrollment.id).unwrap();
    assert_eq!(after, advanced_before_reopen);
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
    assert_eq!(progress_fingerprint(&path), retained_progress);
    assert!(retained_progress[3].contains(&completion.id));
    let next_completion = store
        .complete_plan_stream(CompleteStreamRequest {
            enrollment_id: enrollment.id.clone(),
            stream_id: old.stream_id.clone(),
            expected_assignment_id: old.id.clone(),
            expected_progress_id: old.progress_id.clone(),
        })
        .unwrap();
    let advanced_after_reopen = store.active_plan_assignments(&enrollment.id).unwrap();
    let next_old = advanced_after_reopen
        .iter()
        .find(|assignment| assignment.stream_id == "old-testament")
        .unwrap();
    assert_eq!(
        (
            next_old.passage.book,
            next_old.passage.chapter,
            next_old.ordinal
        ),
        (1, 3, 3)
    );
    assert_eq!(
        advanced_after_reopen
            .iter()
            .find(|assignment| assignment.stream_id == "new-testament")
            .unwrap()
            .id,
        new.id
    );
    let retained_after_completion = progress_fingerprint(&path);
    assert!(retained_after_completion[3].contains(&completion.id));
    assert!(retained_after_completion[3].contains(&next_completion.id));
    drop(store);

    let store = JournalStore::open(&path).unwrap();
    assert_eq!(
        store.active_plan_assignments(&enrollment.id).unwrap(),
        advanced_after_reopen
    );
    assert_eq!(progress_fingerprint(&path), retained_after_completion);
    assert_eq!(
        store
            .get_plan_definition_version(&version.id)
            .unwrap()
            .unwrap()
            .definition,
        original_definition
    );
    assert_eq!(
        store
            .get_plan_definition_version(&edited_version.id)
            .unwrap()
            .unwrap()
            .definition,
        edited_definition
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
            expected_progress_id: first.progress_id.clone(),
        })
        .unwrap();
    assert!(store
        .complete_plan_stream(CompleteStreamRequest {
            enrollment_id: stopped.id.clone(),
            stream_id: first.stream_id.clone(),
            expected_assignment_id: first.id,
            expected_progress_id: first.progress_id,
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
            expected_progress_id: second.progress_id,
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
                expected_progress_id: assignment.progress_id,
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

fn schema_two_retained_fingerprint(path: &std::path::Path) -> Vec<String> {
    let conn = rusqlite::Connection::open(path).unwrap();
    [
        "SELECT group_concat(id||':'||created_at||':'||updated_at||':'||working_revision_id||':'||COALESCE(published_revision_id,'null'),'|') FROM (SELECT * FROM entries ORDER BY id)",
        "SELECT group_concat(id||':'||entry_id||':'||COALESCE(parent_id,'null')||':'||COALESCE(restored_from_id,'null')||':'||created_at||':'||content,'|') FROM (SELECT * FROM revisions ORDER BY id)",
        "SELECT group_concat(sequence||':'||operation_id||':'||entry_id||':'||kind||':'||revision_id,'|') FROM (SELECT * FROM changes ORDER BY sequence)",
        "SELECT group_concat(id||':'||created_at,'|') FROM (SELECT * FROM plans ORDER BY id)",
        "SELECT group_concat(id||':'||plan_id||':'||version||':'||created_at||':'||definition,'|') FROM (SELECT * FROM plan_definition_versions ORDER BY plan_id,version)",
    ]
    .into_iter()
    .map(|query| {
        conn.query_row(query, [], |row| row.get::<_, Option<String>>(0))
            .unwrap()
            .unwrap_or_default()
    })
    .collect()
}

#[test]
fn populated_schema_two_journal_and_plan_versions_survive_migration_and_reopen() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let mut target_request = request("Published target", true);
    let published_target = store.save_entry(target_request.clone()).unwrap();
    target_request.expected_revision_id = Some(published_target.working_revision_id.clone());
    target_request.content.body = "Retained unfinished target edit".into();
    target_request.finish = false;
    let working_target = store.save_entry(target_request.clone()).unwrap();
    let mut source_request = request("Linked source", true);
    source_request.content.links.push(working_target.id.clone());
    let source = store.save_entry(source_request.clone()).unwrap();

    let first_definition = stream_definition("Schema two version one");
    let first = store
        .create_plan_definition(first_definition.clone())
        .unwrap();
    let mut second_definition = stream_definition("Schema two version two");
    let PlanSchedule::ChapterStreams { streams } = &mut second_definition.schedule else {
        unreachable!()
    };
    streams[0].chapters.push(ChapterRef {
        book: 1,
        chapter: 3,
    });
    let second = store
        .create_plan_definition_version(&first.plan_id, second_definition.clone())
        .unwrap();
    drop(store);

    let retained_before = schema_two_retained_fingerprint(&path);
    let conn = rusqlite::Connection::open(&path).unwrap();
    for table in [
        "plan_stream_progress_epochs",
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
    assert_eq!(schema_two_retained_fingerprint(&path), retained_before);
    let entries = store.list_entries().unwrap();
    let migrated_target = entries
        .iter()
        .find(|entry| entry.id == working_target.id)
        .unwrap();
    assert_eq!(
        migrated_target.working_revision_id,
        working_target.working_revision_id
    );
    assert_eq!(
        migrated_target.published_revision_id,
        published_target.published_revision_id
    );
    assert_eq!(migrated_target.content, target_request.content);
    let migrated_source = entries.iter().find(|entry| entry.id == source.id).unwrap();
    assert_eq!(
        migrated_source.content.links,
        vec![working_target.id.clone()]
    );
    assert_eq!(store.get_history(&working_target.id).unwrap().len(), 2);
    assert_eq!(store.get_history(&source.id).unwrap().len(), 1);
    assert_eq!(
        store.list_plan_definition_versions(&first.plan_id).unwrap(),
        vec![first.clone(), second.clone()]
    );
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
            .get_plan_definition_version(&second.id)
            .unwrap()
            .unwrap()
            .definition,
        second_definition
    );
    drop(store);

    let reopened = JournalStore::open(&path).unwrap();
    assert_eq!(schema_two_retained_fingerprint(&path), retained_before);
    assert_eq!(reopened.get_history(&working_target.id).unwrap().len(), 2);
    assert_eq!(
        reopened
            .list_plan_definition_versions(&first.plan_id)
            .unwrap(),
        vec![first, second]
    );
    drop(reopened);

    let conn = rusqlite::Connection::open(path).unwrap();
    assert_eq!(
        conn.pragma_query_value::<u32, _>(None, "user_version", |row| row.get(0))
            .unwrap(),
        6
    );
    assert_eq!(
        conn.query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
            row.get::<_, u32>(0)
        })
        .unwrap(),
        0
    );
}

#[test]
fn schema_three_progress_migration_preserves_history_and_adds_command_epoch() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let version = store
        .create_plan_definition(stream_definition("Schema three"))
        .unwrap();
    let enrollment = store
        .enroll_in_chapter_streams(&version.id, stream_selections(false))
        .unwrap();
    let first = store
        .active_plan_assignments(&enrollment.id)
        .unwrap()
        .into_iter()
        .find(|a| a.stream_id == "old-testament")
        .unwrap();
    store
        .complete_plan_stream(CompleteStreamRequest {
            enrollment_id: enrollment.id.clone(),
            stream_id: first.stream_id,
            expected_assignment_id: first.id,
            expected_progress_id: first.progress_id,
        })
        .unwrap();
    drop(store);

    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "DROP TABLE plan_stream_progress_epochs;
         DROP TRIGGER plan_assignments_immutable;
         DROP TRIGGER plan_assignments_position_required;
         ALTER TABLE plan_assignments DROP COLUMN stream_position;
         CREATE TRIGGER plan_assignments_immutable BEFORE UPDATE ON plan_assignments BEGIN SELECT RAISE(ABORT,'Plan assignments are immutable'); END;",
    )
    .unwrap();
    conn.pragma_update(None, "user_version", 3).unwrap();
    drop(conn);

    let store = JournalStore::open(&path).unwrap();
    let active = store
        .active_plan_assignments(&enrollment.id)
        .unwrap()
        .into_iter()
        .find(|a| a.stream_id == "old-testament")
        .unwrap();
    assert_eq!(active.ordinal, 2);
    assert!(Uuid::parse_str(&active.progress_id).is_ok());
    drop(store);
    let conn = rusqlite::Connection::open(path).unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM reading_completions", [], |row| row
            .get::<_, u32>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        conn.pragma_query_value::<u32, _>(None, "user_version", |row| row.get(0))
            .unwrap(),
        6
    );
}

#[test]
fn stale_completion_epoch_is_rejected_after_undo_reopen_and_recompletion() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut first_store = JournalStore::open(&path).unwrap();
    let version = first_store
        .create_plan_definition(stream_definition("Epochs"))
        .unwrap();
    let enrollment = first_store
        .enroll_in_chapter_streams(&version.id, stream_selections(false))
        .unwrap();
    let assignment = first_store
        .active_plan_assignments(&enrollment.id)
        .unwrap()
        .into_iter()
        .find(|a| a.stream_id == "old-testament")
        .unwrap();
    let stale = CompleteStreamRequest {
        enrollment_id: enrollment.id.clone(),
        stream_id: assignment.stream_id.clone(),
        expected_assignment_id: assignment.id.clone(),
        expected_progress_id: assignment.progress_id.clone(),
    };
    let completion = first_store.complete_plan_stream(stale.clone()).unwrap();
    first_store.undo_plan_completion(&completion.id).unwrap();
    drop(first_store);

    let mut reopened = JournalStore::open(&path).unwrap();
    let fresh_assignment = reopened
        .active_plan_assignments(&enrollment.id)
        .unwrap()
        .into_iter()
        .find(|a| a.stream_id == "old-testament")
        .unwrap();
    assert_eq!(fresh_assignment.id, assignment.id);
    assert_ne!(fresh_assignment.progress_id, assignment.progress_id);
    assert!(reopened.complete_plan_stream(stale).is_err());
    let counts_after_rejection = rusqlite::Connection::open(&path)
        .unwrap()
        .query_row(
            "SELECT (SELECT count(*) FROM reading_completions),(SELECT count(*) FROM reading_completion_undos),(SELECT count(*) FROM plan_stream_progress_epochs)",
            [],
            |row| Ok((row.get::<_, u32>(0)?, row.get::<_, u32>(1)?, row.get::<_, u32>(2)?)),
        )
        .unwrap();
    assert_eq!(counts_after_rejection, (1, 1, 4));

    let fresh = CompleteStreamRequest {
        enrollment_id: enrollment.id.clone(),
        stream_id: fresh_assignment.stream_id,
        expected_assignment_id: fresh_assignment.id,
        expected_progress_id: fresh_assignment.progress_id,
    };
    let recompletion = reopened.complete_plan_stream(fresh.clone()).unwrap();
    reopened.undo_plan_completion(&recompletion.id).unwrap();
    let before_second_rejection = rusqlite::Connection::open(&path)
        .unwrap()
        .query_row(
            "SELECT (SELECT count(*) FROM reading_completions),(SELECT count(*) FROM reading_completion_undos),(SELECT count(*) FROM plan_stream_progress_epochs)",
            [],
            |row| Ok((row.get::<_, u32>(0)?, row.get::<_, u32>(1)?, row.get::<_, u32>(2)?)),
        )
        .unwrap();
    assert!(reopened.complete_plan_stream(fresh).is_err());
    let after_second_rejection = rusqlite::Connection::open(&path)
        .unwrap()
        .query_row(
            "SELECT (SELECT count(*) FROM reading_completions),(SELECT count(*) FROM reading_completion_undos),(SELECT count(*) FROM plan_stream_progress_epochs)",
            [],
            |row| Ok((row.get::<_, u32>(0)?, row.get::<_, u32>(1)?, row.get::<_, u32>(2)?)),
        )
        .unwrap();
    assert_eq!(after_second_rejection, before_second_rejection);
    let intentional = reopened
        .active_plan_assignments(&enrollment.id)
        .unwrap()
        .into_iter()
        .find(|a| a.stream_id == "old-testament")
        .unwrap();
    reopened
        .complete_plan_stream(CompleteStreamRequest {
            enrollment_id: enrollment.id,
            stream_id: intentional.stream_id,
            expected_assignment_id: intentional.id,
            expected_progress_id: intentional.progress_id,
        })
        .unwrap();
}

fn repeated_chapter_definition() -> PlanDefinition {
    PlanDefinition {
        schema_version: 1,
        name: "Repeated chapters".into(),
        description: None,
        schedule: PlanSchedule::ChapterStreams {
            streams: vec![ChapterStream {
                id: "repeated".into(),
                name: "Repeated".into(),
                chapters: vec![
                    ChapterRef {
                        book: 1,
                        chapter: 1,
                    },
                    ChapterRef {
                        book: 1,
                        chapter: 2,
                    },
                    ChapterRef {
                        book: 1,
                        chapter: 1,
                    },
                    ChapterRef {
                        book: 1,
                        chapter: 3,
                    },
                ],
            }],
        },
    }
}

fn complete_active(store: &mut JournalStore, enrollment_id: &str) -> journal_core::PlanCompletion {
    let assignment = store
        .active_plan_assignments(enrollment_id)
        .unwrap()
        .remove(0);
    store
        .complete_plan_stream(CompleteStreamRequest {
            enrollment_id: enrollment_id.into(),
            stream_id: assignment.stream_id,
            expected_assignment_id: assignment.id,
            expected_progress_id: assignment.progress_id,
        })
        .unwrap()
}

#[test]
fn repeated_chapter_occurrences_stop_loop_reopen_and_recomplete_in_order() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let version = store
        .create_plan_definition(repeated_chapter_definition())
        .unwrap();
    let stopped = store
        .enroll_in_chapter_streams(
            &version.id,
            vec![StreamEnrollment {
                stream_id: "repeated".into(),
                starting_position: 0,
                loop_after_end: false,
            }],
        )
        .unwrap();
    complete_active(&mut store, &stopped.id);
    complete_active(&mut store, &stopped.id);
    drop(store);

    let mut store = JournalStore::open(&path).unwrap();
    let repeated = store
        .active_plan_assignments(&stopped.id)
        .unwrap()
        .remove(0);
    assert_eq!(
        (
            repeated.stream_position,
            repeated.passage.chapter,
            repeated.ordinal
        ),
        (Some(2), 1, 3)
    );
    let third = complete_active(&mut store, &stopped.id);
    let final_assignment = store
        .active_plan_assignments(&stopped.id)
        .unwrap()
        .remove(0);
    assert_eq!(
        (
            final_assignment.stream_position,
            final_assignment.passage.chapter,
            final_assignment.ordinal,
        ),
        (Some(3), 3, 4)
    );
    complete_active(&mut store, &stopped.id);
    assert!(store
        .active_plan_assignments(&stopped.id)
        .unwrap()
        .is_empty());

    let looped = store
        .enroll_in_chapter_streams(
            &version.id,
            vec![StreamEnrollment {
                stream_id: "repeated".into(),
                starting_position: 2,
                loop_after_end: true,
            }],
        )
        .unwrap();
    let selected = store.active_plan_assignments(&looped.id).unwrap().remove(0);
    assert_eq!(
        (selected.stream_position, selected.passage.chapter),
        (Some(2), 1)
    );
    complete_active(&mut store, &looped.id);
    let last = store.active_plan_assignments(&looped.id).unwrap().remove(0);
    assert_eq!(
        (last.stream_position, last.passage.chapter, last.cycle),
        (Some(3), 3, 1)
    );
    let last_completion = complete_active(&mut store, &looped.id);
    let wrapped = store.active_plan_assignments(&looped.id).unwrap().remove(0);
    assert_eq!(
        (
            wrapped.stream_position,
            wrapped.passage.chapter,
            wrapped.cycle
        ),
        (Some(0), 1, 2)
    );
    store.undo_plan_completion(&last_completion.id).unwrap();
    let restored = store.active_plan_assignments(&looped.id).unwrap().remove(0);
    assert_eq!(
        (restored.stream_position, restored.passage.chapter),
        (Some(3), 3)
    );
    complete_active(&mut store, &looped.id);
    let rewrapped = store.active_plan_assignments(&looped.id).unwrap().remove(0);
    assert_eq!(
        (
            rewrapped.stream_position,
            rewrapped.passage.chapter,
            rewrapped.cycle
        ),
        (Some(0), 1, 2)
    );

    store.undo_plan_completion(&third.id).unwrap_err();
    drop(store);
    let conn = rusqlite::Connection::open(path).unwrap();
    let snapshots = conn
        .prepare("SELECT stream_position,json_extract(passage,'$.chapter') FROM plan_assignments WHERE enrollment_id=?1 ORDER BY ordinal")
        .unwrap()
        .query_map([stopped.id], |row| Ok((row.get::<_, u32>(0)?, row.get::<_, u32>(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(snapshots, vec![(0, 1), (1, 2), (2, 1), (3, 3)]);
}

#[test]
fn schema_four_reconstructs_repeated_occurrences_without_rewriting_snapshots() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let version = store
        .create_plan_definition(repeated_chapter_definition())
        .unwrap();
    let enrollment = store
        .enroll_in_chapter_streams(
            &version.id,
            vec![StreamEnrollment {
                stream_id: "repeated".into(),
                starting_position: 0,
                loop_after_end: false,
            }],
        )
        .unwrap();
    complete_active(&mut store, &enrollment.id);
    complete_active(&mut store, &enrollment.id);
    let before = store
        .active_plan_assignments(&enrollment.id)
        .unwrap()
        .remove(0);
    assert_eq!(
        (before.stream_position, before.passage.chapter),
        (Some(2), 1)
    );
    drop(store);

    let conn = rusqlite::Connection::open(&path).unwrap();
    let snapshots_before: String = conn
        .query_row(
            "SELECT group_concat(id||':'||passage,'|') FROM (SELECT id,passage FROM plan_assignments WHERE enrollment_id=?1 ORDER BY ordinal)",
            [&enrollment.id],
            |row| row.get(0),
        )
        .unwrap();
    conn.execute_batch(
        "DROP TRIGGER plan_assignments_immutable;
         DROP TRIGGER plan_assignments_position_required;
         ALTER TABLE plan_assignments DROP COLUMN stream_position;
         CREATE TRIGGER plan_assignments_immutable BEFORE UPDATE ON plan_assignments BEGIN SELECT RAISE(ABORT,'Plan assignments are immutable'); END;
         PRAGMA user_version=4;",
    )
    .unwrap();
    drop(conn);

    let mut store = JournalStore::open(&path).unwrap();
    let migrated = store
        .active_plan_assignments(&enrollment.id)
        .unwrap()
        .remove(0);
    assert_eq!(
        (migrated.stream_position, migrated.passage.chapter),
        (Some(2), 1)
    );
    complete_active(&mut store, &enrollment.id);
    let final_assignment = store
        .active_plan_assignments(&enrollment.id)
        .unwrap()
        .remove(0);
    assert_eq!(
        (
            final_assignment.stream_position,
            final_assignment.passage.chapter
        ),
        (Some(3), 3)
    );
    drop(store);
    let conn = rusqlite::Connection::open(path).unwrap();
    let retained_prefix: String = conn
        .query_row(
            "SELECT group_concat(id||':'||passage,'|') FROM (SELECT id,passage FROM plan_assignments WHERE enrollment_id=?1 ORDER BY ordinal LIMIT 3)",
            [enrollment.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(retained_prefix, snapshots_before);
}

#[test]
fn ambiguous_legacy_occurrence_is_retained_and_refuses_guessed_progression() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let version = store
        .create_plan_definition(repeated_chapter_definition())
        .unwrap();
    let enrollment = store
        .enroll_in_chapter_streams(
            &version.id,
            vec![StreamEnrollment {
                stream_id: "repeated".into(),
                starting_position: 0,
                loop_after_end: false,
            }],
        )
        .unwrap();
    for _ in 0..3 {
        complete_active(&mut store, &enrollment.id);
    }
    drop(store);

    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "DROP TRIGGER plan_assignments_immutable;
         DROP TRIGGER plan_assignments_position_required;
         UPDATE plan_assignments SET passage=json_set(passage,'$.chapter',2) WHERE ordinal=4;
         ALTER TABLE plan_assignments DROP COLUMN stream_position;
         CREATE TRIGGER plan_assignments_immutable BEFORE UPDATE ON plan_assignments BEGIN SELECT RAISE(ABORT,'Plan assignments are immutable'); END;
         PRAGMA user_version=4;",
    )
    .unwrap();
    drop(conn);

    let mut store = JournalStore::open(&path).unwrap();
    let retained = store
        .active_plan_assignments(&enrollment.id)
        .unwrap()
        .remove(0);
    assert_eq!(
        (retained.stream_position, retained.passage.chapter),
        (None, 2)
    );
    let error = store
        .complete_plan_stream(CompleteStreamRequest {
            enrollment_id: enrollment.id,
            stream_id: retained.stream_id,
            expected_assignment_id: retained.id,
            expected_progress_id: retained.progress_id,
        })
        .unwrap_err();
    assert!(error.to_string().contains("ambiguous occurrence identity"));
}

#[test]
fn divergent_v5_suffix_is_invalidated_without_chapter_skips_or_history_rewrite() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let mut definition = repeated_chapter_definition();
    let PlanSchedule::ChapterStreams { streams } = &mut definition.schedule else {
        unreachable!()
    };
    streams[0].chapters.extend([
        ChapterRef {
            book: 1,
            chapter: 1,
        },
        ChapterRef {
            book: 1,
            chapter: 4,
        },
    ]);
    let version = store.create_plan_definition(definition).unwrap();
    let enrollment = store
        .enroll_in_chapter_streams(
            &version.id,
            vec![StreamEnrollment {
                stream_id: "repeated".into(),
                starting_position: 0,
                loop_after_end: false,
            }],
        )
        .unwrap();
    let mut completions = Vec::new();
    for _ in 0..4 {
        completions.push(complete_active(&mut store, &enrollment.id));
    }
    store.undo_plan_completion(&completions[3].id).unwrap();
    completions[3] = complete_active(&mut store, &enrollment.id);
    drop(store);

    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "DROP TRIGGER plan_assignments_immutable;
         UPDATE plan_assignments SET passage=json_set(passage,'$.chapter',2) WHERE ordinal=4;
         CREATE TRIGGER plan_assignments_immutable BEFORE UPDATE ON plan_assignments BEGIN SELECT RAISE(ABORT,'Plan assignments are immutable'); END;
         PRAGMA user_version=5;",
    )
    .unwrap();
    let retained_before: (String, String, String, String) = conn
        .query_row(
            "SELECT
              (SELECT group_concat(id||':'||passage,'|') FROM (SELECT id,passage FROM plan_assignments ORDER BY ordinal)),
              (SELECT group_concat(id||':'||assignment_id,'|') FROM (SELECT id,assignment_id FROM reading_completions ORDER BY rowid)),
              (SELECT group_concat(id||':'||completion_id,'|') FROM (SELECT id,completion_id FROM reading_completion_undos ORDER BY rowid)),
              (SELECT group_concat(id||':'||assignment_id,'|') FROM (SELECT id,assignment_id FROM plan_stream_progress_epochs ORDER BY sequence))",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    drop(conn);

    let mut store = JournalStore::open(&path).unwrap();
    let active = store
        .active_plan_assignments(&enrollment.id)
        .unwrap()
        .remove(0);
    assert_eq!(
        (
            active.ordinal,
            active.stream_position,
            active.passage.chapter
        ),
        (5, None, 1)
    );
    let request = CompleteStreamRequest {
        enrollment_id: enrollment.id.clone(),
        stream_id: active.stream_id,
        expected_assignment_id: active.id,
        expected_progress_id: active.progress_id,
    };
    assert!(store
        .complete_plan_stream(request)
        .unwrap_err()
        .to_string()
        .contains("ambiguous occurrence identity"));
    drop(store);

    let conn = rusqlite::Connection::open(&path).unwrap();
    let retained_after: (String, String, String, String) = conn
        .query_row(
            "SELECT
              (SELECT group_concat(id||':'||passage,'|') FROM (SELECT id,passage FROM plan_assignments ORDER BY ordinal)),
              (SELECT group_concat(id||':'||assignment_id,'|') FROM (SELECT id,assignment_id FROM reading_completions ORDER BY rowid)),
              (SELECT group_concat(id||':'||completion_id,'|') FROM (SELECT id,completion_id FROM reading_completion_undos ORDER BY rowid)),
              (SELECT group_concat(id||':'||assignment_id,'|') FROM (SELECT id,assignment_id FROM plan_stream_progress_epochs ORDER BY sequence))",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(retained_after, retained_before);
    drop(conn);

    let mut reopened = JournalStore::open(&path).unwrap();
    reopened.undo_plan_completion(&completions[3].id).unwrap();
    let divergent = reopened
        .active_plan_assignments(&enrollment.id)
        .unwrap()
        .remove(0);
    assert_eq!((divergent.ordinal, divergent.stream_position), (4, None));
    assert!(reopened
        .complete_plan_stream(CompleteStreamRequest {
            enrollment_id: enrollment.id.clone(),
            stream_id: divergent.stream_id,
            expected_assignment_id: divergent.id,
            expected_progress_id: divergent.progress_id,
        })
        .is_err());
    reopened.undo_plan_completion(&completions[2].id).unwrap();
    let coherent = reopened
        .active_plan_assignments(&enrollment.id)
        .unwrap()
        .remove(0);
    assert_eq!((coherent.ordinal, coherent.stream_position), (3, Some(2)));
    assert!(reopened
        .complete_plan_stream(CompleteStreamRequest {
            enrollment_id: enrollment.id,
            stream_id: coherent.stream_id,
            expected_assignment_id: coherent.id,
            expected_progress_id: coherent.progress_id,
        })
        .unwrap_err()
        .to_string()
        .contains("conflicts with pinned plan progress"));
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
