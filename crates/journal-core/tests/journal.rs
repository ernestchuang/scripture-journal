mod support;
use journal_core::{
    four_stream_plan_definition, mcheyne_plan_definition, parse_plan_definition_json,
    serialize_plan_definition_json, ChapterRef, ChapterStream, CompleteStreamRequest, EntryContent,
    ExplicitScheduleDay, JournalStore, Passage, PlanDefinition, PlanSchedule, SaveRequest,
    StreamEnrollment, MAX_PLAN_DEFINITION_JSON_BYTES,
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
fn portable_plan_definition_json_codecs_round_trip_and_reject_invalid_input() {
    let explicit = PlanDefinition {
        schema_version: 1,
        name: "Synthetic explicit plan".into(),
        description: Some("A portable test fixture".into()),
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
    for definition in [explicit, stream_definition("Synthetic streams")] {
        let encoded = serialize_plan_definition_json(&definition).unwrap();
        assert!(encoded.len() <= MAX_PLAN_DEFINITION_JSON_BYTES);
        assert_eq!(parse_plan_definition_json(&encoded).unwrap(), definition);
    }

    for invalid in [
        "{",
        "{\"schemaVersion\":1,\"name\":\"x\",\"schedule\":{\"kind\":\"chapterStreams\",\"streams\":[]}} trailing",
        "{\"schemaVersion\":2,\"name\":\"x\",\"schedule\":{\"kind\":\"chapterStreams\",\"streams\":[]}}",
        "{\"schemaVersion\":1,\"name\":\"x\",\"unexpected\":true,\"schedule\":{\"kind\":\"chapterStreams\",\"streams\":[]}}",
        "{\"schemaVersion\":1,\"name\":\"x\",\"schedule\":{\"kind\":\"explicitSchedule\",\"days\":[{\"day\":1,\"passages\":[{\"book\":43,\"chapter\":3,\"startVerse\":999}]}]}}",
        "{\"schemaVersion\":1,\"name\":\"x\",\"schedule\":{\"kind\":\"explicitSchedule\",\"days\":[{\"day\":2,\"passages\":[{\"book\":43,\"chapter\":3}]}]}}",
    ] {
        assert!(parse_plan_definition_json(invalid).is_err(), "{invalid}");
    }
    assert!(parse_plan_definition_json(&" ".repeat(MAX_PLAN_DEFINITION_JSON_BYTES + 1)).is_err());

    let invalid_definition = PlanDefinition {
        schema_version: 2,
        ..stream_definition("Unsupported")
    };
    assert!(serialize_plan_definition_json(&invalid_definition).is_err());
}

fn valid_explicit_definition_json() -> &'static str {
    "{\"schemaVersion\":1,\"name\":\"Valid\",\"schedule\":{\"kind\":\"explicitSchedule\",\"days\":[{\"day\":1,\"passages\":[{\"book\":43,\"chapter\":3}]}]}}"
}

#[test]
fn portable_plan_definition_json_rejections_are_isolated_and_strict() {
    let valid = valid_explicit_definition_json();
    assert!(parse_plan_definition_json(valid).is_ok());

    let unsupported_schema = valid.replacen("\"schemaVersion\":1", "\"schemaVersion\":2", 1);
    let error = parse_plan_definition_json(&unsupported_schema)
        .unwrap_err()
        .to_string();
    assert!(error.contains("Unsupported plan definition schema version 2"));

    let error = parse_plan_definition_json(&format!("{valid} null")).unwrap_err();
    assert!(error
        .chain()
        .any(|cause| cause.to_string().contains("trailing characters")));

    for invalid in [
        "{\"schemaVersion\":1,\"name\":\"Valid\",\"unknown\":true,\"schedule\":{\"kind\":\"explicitSchedule\",\"days\":[{\"day\":1,\"passages\":[{\"book\":43,\"chapter\":3}]}]}}",
        "{\"schemaVersion\":1,\"name\":\"Valid\",\"schedule\":{\"kind\":\"explicitSchedule\",\"unknown\":true,\"days\":[{\"day\":1,\"passages\":[{\"book\":43,\"chapter\":3}]}]}}",
        "{\"schemaVersion\":1,\"name\":\"Valid\",\"schedule\":{\"kind\":\"explicitSchedule\",\"days\":[{\"day\":1,\"unknown\":true,\"passages\":[{\"book\":43,\"chapter\":3}]}]}}",
        "{\"schemaVersion\":1,\"name\":\"Valid\",\"schedule\":{\"kind\":\"explicitSchedule\",\"days\":[{\"day\":1,\"passages\":[{\"book\":43,\"chapter\":3,\"unknown\":true}]}]}}",
        "{\"schemaVersion\":1,\"name\":\"Valid\",\"schedule\":{\"kind\":\"chapterStreams\",\"streams\":[{\"id\":\"stream\",\"name\":\"Stream\",\"unknown\":true,\"chapters\":[{\"book\":43,\"chapter\":3}]}]}}",
        "{\"schemaVersion\":1,\"name\":\"Valid\",\"schedule\":{\"kind\":\"chapterStreams\",\"streams\":[{\"id\":\"stream\",\"name\":\"Stream\",\"chapters\":[{\"book\":43,\"chapter\":3,\"unknown\":true}]}]}}",
    ] {
        let error = parse_plan_definition_json(invalid).unwrap_err();
        assert!(error
            .chain()
            .any(|cause| cause.to_string().contains("unknown field")));
    }
}

#[test]
fn portable_plan_definition_json_uses_exact_utf8_byte_limit_before_parsing() {
    let size_error = format!("{MAX_PLAN_DEFINITION_JSON_BYTES}-byte limit");
    let unicode_definition = PlanDefinition {
        name: "é".repeat(100),
        ..stream_definition("Byte boundary")
    };
    let compact = serialize_plan_definition_json(&unicode_definition).unwrap();
    let exact_limit = format!(
        "{compact}{}",
        " ".repeat(MAX_PLAN_DEFINITION_JSON_BYTES - compact.len())
    );
    assert_eq!(exact_limit.len(), MAX_PLAN_DEFINITION_JSON_BYTES);
    assert!(exact_limit.chars().count() < MAX_PLAN_DEFINITION_JSON_BYTES);
    assert_eq!(
        parse_plan_definition_json(&exact_limit).unwrap(),
        unicode_definition
    );

    let one_byte_too_large = format!("{exact_limit} ");
    let error = parse_plan_definition_json(&one_byte_too_large)
        .unwrap_err()
        .to_string();
    assert!(error.contains(&size_error));

    let character_count_within_limit = format!(
        "{compact}{}",
        " ".repeat(MAX_PLAN_DEFINITION_JSON_BYTES - compact.chars().count() - 1)
    );
    assert!(character_count_within_limit.chars().count() < MAX_PLAN_DEFINITION_JSON_BYTES);
    assert!(character_count_within_limit.len() > MAX_PLAN_DEFINITION_JSON_BYTES);
    let error = parse_plan_definition_json(&character_count_within_limit)
        .unwrap_err()
        .to_string();
    assert!(error.contains(&size_error));

    let error = parse_plan_definition_json(&"{".repeat(MAX_PLAN_DEFINITION_JSON_BYTES + 1))
        .unwrap_err()
        .to_string();
    assert!(error.contains(&size_error));
}

#[test]
fn portable_plan_definition_json_rejects_domain_valid_oversized_serialization() {
    let size_error = format!("{MAX_PLAN_DEFINITION_JSON_BYTES}-byte limit");
    let passage = Passage {
        book: 1,
        chapter: 1,
        start_verse: None,
        end_verse: None,
    };
    let definition = PlanDefinition {
        schema_version: 1,
        name: "Largest valid explicit schedule".into(),
        description: None,
        schedule: PlanSchedule::ExplicitSchedule {
            days: (1..=1_000)
                .map(|day| ExplicitScheduleDay {
                    day,
                    passages: vec![passage.clone(); 100],
                })
                .collect(),
        },
    };
    let error = serialize_plan_definition_json(&definition).unwrap_err();
    assert!(
        error
            .chain()
            .any(|cause| cause.to_string().contains(&size_error)),
        "{error:?}"
    );
}

#[test]
fn store_imports_new_json_plans_and_exports_selected_versions_without_touching_history() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let built_in = store.register_four_stream_plan().unwrap();
    let existing = store
        .create_plan_definition(stream_definition("Existing retained plan"))
        .unwrap();
    let enrollment = store
        .enroll_in_chapter_streams(&existing.id, stream_selections(false))
        .unwrap();
    let assignment = store
        .active_plan_assignments(&enrollment.id)
        .unwrap()
        .into_iter()
        .find(|value| value.stream_id == "old-testament")
        .unwrap();
    store
        .complete_plan_stream(CompleteStreamRequest {
            enrollment_id: enrollment.id,
            stream_id: assignment.stream_id,
            expected_assignment_id: assignment.id,
            expected_progress_id: assignment.progress_id,
        })
        .unwrap();
    let retained_progress = progress_fingerprint(&path);

    let stream_definition = stream_definition("Imported stream plan");
    let imported_stream = store
        .import_plan_definition_json(&serialize_plan_definition_json(&stream_definition).unwrap())
        .unwrap();
    let explicit_definition = PlanDefinition {
        schema_version: 1,
        name: "Imported explicit plan".into(),
        description: None,
        schedule: PlanSchedule::ExplicitSchedule {
            days: vec![ExplicitScheduleDay {
                day: 1,
                passages: vec![Passage {
                    book: 43,
                    chapter: 3,
                    start_verse: None,
                    end_verse: None,
                }],
            }],
        },
    };
    let imported_explicit = store
        .import_plan_definition_json(&serialize_plan_definition_json(&explicit_definition).unwrap())
        .unwrap();
    assert_ne!(imported_stream.plan_id, existing.plan_id);
    assert_ne!(imported_explicit.plan_id, imported_stream.plan_id);
    let explicit_export = store
        .export_plan_definition_json(&imported_explicit.id)
        .unwrap();
    assert_eq!(
        parse_plan_definition_json(&explicit_export).unwrap(),
        explicit_definition
    );
    let selected_export = store
        .export_plan_definition_json(&imported_stream.id)
        .unwrap();
    let mut edited = stream_definition.clone();
    edited.name = "Later edited stream plan".into();
    store
        .create_plan_definition_version(&imported_stream.plan_id, edited)
        .unwrap();
    assert_eq!(
        store
            .export_plan_definition_json(&imported_stream.id)
            .unwrap(),
        selected_export
    );
    assert_eq!(progress_fingerprint(&path), retained_progress);
    assert_eq!(store.register_four_stream_plan().unwrap(), built_in);
    assert_eq!(
        store
            .list_plan_definition_versions(&existing.plan_id)
            .unwrap(),
        vec![existing]
    );
    drop(store);

    let reopened = JournalStore::open(&path).unwrap();
    assert_eq!(
        reopened
            .export_plan_definition_json(&imported_stream.id)
            .unwrap(),
        selected_export
    );
    assert_eq!(
        reopened
            .export_plan_definition_json(&imported_explicit.id)
            .unwrap(),
        explicit_export
    );
    assert_eq!(progress_fingerprint(&path), retained_progress);
}

#[test]
fn identical_builtin_json_imports_create_distinct_custom_plans_without_mutating_progress() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let built_in = store.register_four_stream_plan().unwrap();
    let existing = store
        .create_plan_definition(stream_definition("Existing progress"))
        .unwrap();
    let enrollment = store
        .enroll_in_chapter_streams(&existing.id, stream_selections(false))
        .unwrap();
    let active = store.active_plan_assignments(&enrollment.id).unwrap();
    let old_testament = active
        .iter()
        .find(|assignment| assignment.stream_id == "old-testament")
        .unwrap();
    store
        .complete_plan_stream(CompleteStreamRequest {
            enrollment_id: enrollment.id.clone(),
            stream_id: old_testament.stream_id.clone(),
            expected_assignment_id: old_testament.id.clone(),
            expected_progress_id: old_testament.progress_id.clone(),
        })
        .unwrap();
    let progress_before_import = progress_fingerprint(&path);
    let active_before_import = store.active_plan_assignments(&enrollment.id).unwrap();

    let built_in_json = store.export_plan_definition_json(&built_in.id).unwrap();
    let input_definition = parse_plan_definition_json(&built_in_json).unwrap();
    let first_import = store.import_plan_definition_json(&built_in_json).unwrap();
    let second_import = store.import_plan_definition_json(&built_in_json).unwrap();
    assert_ne!(first_import.plan_id, second_import.plan_id);
    assert_ne!(first_import.id, second_import.id);
    assert_ne!(first_import.plan_id, built_in.plan_id);
    assert_ne!(second_import.plan_id, built_in.plan_id);
    assert_eq!(first_import.definition, input_definition);
    assert_eq!(second_import.definition, input_definition);
    assert_eq!(
        parse_plan_definition_json(&store.export_plan_definition_json(&first_import.id).unwrap())
            .unwrap(),
        input_definition
    );
    assert_eq!(store.register_four_stream_plan().unwrap(), built_in);
    assert_eq!(progress_fingerprint(&path), progress_before_import);
    assert_eq!(
        store.active_plan_assignments(&enrollment.id).unwrap(),
        active_before_import
    );
    let plan_registry_after_import = plan_registry_fingerprint(&path);
    drop(store);

    let mut reopened = JournalStore::open(&path).unwrap();
    assert_eq!(reopened.register_four_stream_plan().unwrap(), built_in);
    assert_eq!(plan_registry_fingerprint(&path), plan_registry_after_import);
    assert_eq!(progress_fingerprint(&path), progress_before_import);
    assert_eq!(
        reopened.active_plan_assignments(&enrollment.id).unwrap(),
        active_before_import
    );

    let domain_invalid = valid_explicit_definition_json().replacen("\"day\":1", "\"day\":2", 1);
    let registry_before_rejection = plan_registry_fingerprint(&path);
    let progress_before_rejection = progress_fingerprint(&path);
    assert!(reopened
        .import_plan_definition_json(&domain_invalid)
        .is_err());
    assert_eq!(plan_registry_fingerprint(&path), registry_before_rejection);
    assert_eq!(progress_fingerprint(&path), progress_before_rejection);
}

#[test]
fn failed_json_plan_imports_and_missing_export_leave_existing_rows_unchanged() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    store.register_four_stream_plan().unwrap();
    let existing = store
        .create_plan_definition(stream_definition("Retained before failures"))
        .unwrap();
    let enrollment = store
        .enroll_in_chapter_streams(&existing.id, stream_selections(false))
        .unwrap();
    let assignment = store
        .active_plan_assignments(&enrollment.id)
        .unwrap()
        .into_iter()
        .find(|value| value.stream_id == "old-testament")
        .unwrap();
    store
        .complete_plan_stream(CompleteStreamRequest {
            enrollment_id: enrollment.id,
            stream_id: assignment.stream_id,
            expected_assignment_id: assignment.id,
            expected_progress_id: assignment.progress_id,
        })
        .unwrap();
    let retained = plan_registry_fingerprint(&path);
    let retained_progress = progress_fingerprint(&path);
    let valid = serialize_plan_definition_json(&stream_definition("Valid JSON")).unwrap();
    let unsupported = valid.replacen("\"schemaVersion\":1", "\"schemaVersion\":2", 1);
    let unknown = valid.replacen("{", "{\"unknown\":true,", 1);
    let oversized = " ".repeat(MAX_PLAN_DEFINITION_JSON_BYTES + 1);
    for input in [
        "{",
        unsupported.as_str(),
        unknown.as_str(),
        oversized.as_str(),
    ] {
        assert!(store.import_plan_definition_json(input).is_err());
        assert_eq!(plan_registry_fingerprint(&path), retained);
        assert_eq!(progress_fingerprint(&path), retained_progress);
    }
    assert!(store
        .export_plan_definition_json("00000000-0000-4000-a000-000000000000")
        .is_err());
    assert_eq!(plan_registry_fingerprint(&path), retained);
    assert_eq!(progress_fingerprint(&path), retained_progress);
    drop(store);

    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER inject_json_import_failure BEFORE INSERT ON plan_definition_versions
         BEGIN SELECT RAISE(ABORT,'injected JSON import failure'); END;",
    )
    .unwrap();
    drop(conn);
    let mut store = JournalStore::open(&path).unwrap();
    assert!(store
        .import_plan_definition_json(&valid)
        .unwrap_err()
        .to_string()
        .contains("injected JSON import failure"));
    drop(store);
    assert_eq!(plan_registry_fingerprint(&path), retained);
    assert_eq!(progress_fingerprint(&path), retained_progress);
}

#[test]
fn exporting_stored_domain_valid_oversized_definition_fails_without_writes() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let store = JournalStore::open(&path).unwrap();
    drop(store);
    let definition = PlanDefinition {
        schema_version: 1,
        name: "Stored oversized definition".into(),
        description: None,
        schedule: PlanSchedule::ExplicitSchedule {
            days: (1..=1_000)
                .map(|day| ExplicitScheduleDay {
                    day,
                    passages: vec![
                        Passage {
                            book: 1,
                            chapter: 1,
                            start_verse: None,
                            end_verse: None,
                        };
                        100
                    ],
                })
                .collect(),
        },
    };
    let plan_id = Uuid::new_v4().to_string();
    let version_id = Uuid::new_v4().to_string();
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute(
        "INSERT INTO plans(id,created_at) VALUES(?1,'synthetic')",
        [&plan_id],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO plan_definition_versions(id,plan_id,version,created_at,definition) VALUES(?1,?2,1,'synthetic',?3)",
        rusqlite::params![version_id, plan_id, serde_json::to_string(&definition).unwrap()],
    )
    .unwrap();
    drop(conn);
    let retained = plan_registry_fingerprint(&path);

    let store = JournalStore::open(&path).unwrap();
    assert!(store
        .export_plan_definition_json(&version_id)
        .unwrap_err()
        .to_string()
        .contains("byte limit"));
    drop(store);
    assert_eq!(plan_registry_fingerprint(&path), retained);
}

#[test]
fn built_in_four_stream_definition_covers_every_canonical_chapter_and_enrolls() {
    let definition = four_stream_plan_definition();
    let PlanSchedule::ChapterStreams { streams } = &definition.schedule else {
        unreachable!()
    };
    assert_eq!(
        streams
            .iter()
            .map(|stream| stream.id.as_str())
            .collect::<Vec<_>>(),
        vec!["old-testament", "new-testament", "psalms", "proverbs"]
    );
    assert_eq!(
        streams
            .iter()
            .map(|stream| stream.chapters.len())
            .collect::<Vec<_>>(),
        vec![748, 260, 150, 31]
    );
    assert_eq!(
        streams[0].chapters.first(),
        Some(&ChapterRef {
            book: 1,
            chapter: 1
        })
    );
    assert_eq!(
        streams[0].chapters.last(),
        Some(&ChapterRef {
            book: 39,
            chapter: 4
        })
    );
    assert_eq!(
        streams[1].chapters.first(),
        Some(&ChapterRef {
            book: 40,
            chapter: 1
        })
    );
    assert_eq!(
        streams[1].chapters.last(),
        Some(&ChapterRef {
            book: 66,
            chapter: 22
        })
    );
    assert_eq!(
        streams[2].chapters.first(),
        Some(&ChapterRef {
            book: 19,
            chapter: 1
        })
    );
    assert_eq!(
        streams[2].chapters.last(),
        Some(&ChapterRef {
            book: 19,
            chapter: 150
        })
    );
    assert_eq!(
        streams[3].chapters.first(),
        Some(&ChapterRef {
            book: 20,
            chapter: 1
        })
    );
    assert_eq!(
        streams[3].chapters.last(),
        Some(&ChapterRef {
            book: 20,
            chapter: 31
        })
    );

    let all_chapters = streams
        .iter()
        .flat_map(|stream| stream.chapters.iter())
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(all_chapters.len(), 1_189);
    assert!(!streams[0]
        .chapters
        .iter()
        .any(|chapter| chapter.book == 19 || chapter.book == 20));
    assert_eq!(
        serde_json::from_str::<PlanDefinition>(&serde_json::to_string(&definition).unwrap())
            .unwrap(),
        definition
    );

    let dir = TempDir::new().unwrap();
    let mut store = JournalStore::open(&dir.path().join("j.db")).unwrap();
    let version = store.create_plan_definition(definition).unwrap();
    let enrollment = store
        .enroll_in_chapter_streams(
            &version.id,
            vec![
                StreamEnrollment {
                    stream_id: "old-testament".into(),
                    starting_position: 0,
                    loop_after_end: true,
                },
                StreamEnrollment {
                    stream_id: "new-testament".into(),
                    starting_position: 259,
                    loop_after_end: true,
                },
                StreamEnrollment {
                    stream_id: "psalms".into(),
                    starting_position: 149,
                    loop_after_end: true,
                },
                StreamEnrollment {
                    stream_id: "proverbs".into(),
                    starting_position: 30,
                    loop_after_end: true,
                },
            ],
        )
        .unwrap();
    assert_eq!(
        store
            .active_plan_assignments(&enrollment.id)
            .unwrap()
            .into_iter()
            .map(|assignment| (
                assignment.stream_id,
                assignment.passage.book,
                assignment.passage.chapter
            ))
            .collect::<Vec<_>>(),
        vec![
            ("new-testament".into(), 66, 22),
            ("old-testament".into(), 1, 1),
            ("proverbs".into(), 20, 31),
            ("psalms".into(), 19, 150),
        ]
    );
}

#[test]
fn mcheyne_definition_preserves_the_complete_calendar_and_boundaries() {
    let definition = mcheyne_plan_definition();
    let PlanSchedule::ExplicitSchedule { days } = &definition.schedule else {
        panic!("M’Cheyne must be an explicit daily schedule");
    };

    assert_eq!(days.len(), 365);
    assert_eq!(
        days.iter().map(|day| day.passages.len()).sum::<usize>(),
        1_621
    );
    assert_eq!(days.iter().map(|day| day.passages.len()).min(), Some(4));
    assert_eq!(days.iter().map(|day| day.passages.len()).max(), Some(7));
    assert_eq!(
        days.first().unwrap().passages,
        vec![
            whole_chapter(1, 1),
            whole_chapter(40, 1),
            whole_chapter(15, 1),
            whole_chapter(44, 1),
        ]
    );
    assert_eq!(
        days[58].passages,
        vec![
            whole_chapter(2, 11),
            passage_range(2, 12, 1, 20),
            whole_chapter(42, 14),
            whole_chapter(18, 29),
            whole_chapter(46, 15),
        ]
    );
    assert_eq!(days[59].passages[0], passage_range(2, 12, 21, 51));
    assert_eq!(
        days[129].passages,
        vec![
            whole_chapter(4, 19),
            whole_chapter(19, 56),
            whole_chapter(19, 57),
            whole_chapter(23, 8),
            passage_range(23, 9, 1, 7),
            whole_chapter(59, 2),
        ]
    );
    assert_eq!(
        days.last().unwrap().passages,
        vec![
            whole_chapter(14, 36),
            whole_chapter(66, 22),
            whole_chapter(39, 4),
            whole_chapter(43, 21),
        ]
    );

    let json = serialize_plan_definition_json(&definition).unwrap();
    assert_eq!(parse_plan_definition_json(&json).unwrap(), definition);
}

fn whole_chapter(book: u32, chapter: u32) -> Passage {
    Passage {
        book,
        chapter,
        start_verse: None,
        end_verse: None,
    }
}

fn passage_range(book: u32, chapter: u32, start_verse: u32, end_verse: u32) -> Passage {
    Passage {
        book,
        chapter,
        start_verse: Some(start_verse),
        end_verse: Some(end_verse),
    }
}

#[test]
fn four_stream_registration_is_idempotent_and_ignores_matching_custom_names() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let custom = store
        .create_plan_definition(four_stream_plan_definition())
        .unwrap();
    let registered = store.register_four_stream_plan().unwrap();
    assert_ne!(registered.plan_id, custom.plan_id);
    assert_eq!(registered.definition, four_stream_plan_definition());
    assert_eq!(store.register_four_stream_plan().unwrap(), registered);
    drop(store);

    let mut reopened = JournalStore::open(&path).unwrap();
    assert_eq!(reopened.register_four_stream_plan().unwrap(), registered);
    assert_eq!(
        reopened
            .list_plan_definition_versions(&custom.plan_id)
            .unwrap(),
        vec![custom]
    );
}

#[test]
fn four_stream_registration_rolls_back_after_partial_writes() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let store = JournalStore::open(&path).unwrap();
    drop(store);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER inject_built_in_registration_failure BEFORE INSERT ON built_in_plan_registrations
         BEGIN SELECT RAISE(ABORT,'injected built-in registration failure'); END;",
    )
    .unwrap();
    drop(conn);

    let mut store = JournalStore::open(&path).unwrap();
    assert!(store
        .register_four_stream_plan()
        .unwrap_err()
        .to_string()
        .contains("injected built-in registration failure"));
    drop(store);
    let conn = rusqlite::Connection::open(path).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT (SELECT count(*) FROM plans),(SELECT count(*) FROM plan_definition_versions),(SELECT count(*) FROM built_in_plan_registrations)",
            [],
            |row| Ok((row.get::<_, u32>(0)?, row.get::<_, u32>(1)?, row.get::<_, u32>(2)?)),
        )
        .unwrap(),
        (0, 0, 0)
    );
}

#[test]
fn simultaneous_stores_register_exactly_one_four_stream_plan() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let first = JournalStore::open(&path).unwrap();
    let second = JournalStore::open(&path).unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let registrations = std::thread::scope(|scope| {
        let first_barrier = barrier.clone();
        let first_registration = scope.spawn(move || {
            let mut store = first;
            first_barrier.wait();
            store.register_four_stream_plan().unwrap()
        });
        let second_registration = scope.spawn(move || {
            let mut store = second;
            barrier.wait();
            store.register_four_stream_plan().unwrap()
        });
        [
            first_registration.join().unwrap(),
            second_registration.join().unwrap(),
        ]
    });
    assert_eq!(registrations[0], registrations[1]);
    let conn = rusqlite::Connection::open(path).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT (SELECT count(*) FROM plans),(SELECT count(*) FROM plan_definition_versions),(SELECT count(*) FROM built_in_plan_registrations)",
            [],
            |row| Ok((row.get::<_, u32>(0)?, row.get::<_, u32>(1)?, row.get::<_, u32>(2)?)),
        )
        .unwrap(),
        (1, 1, 1)
    );
}

#[test]
fn mcheyne_registration_is_idempotent_durable_and_preserves_existing_state() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let four_stream = store.register_four_stream_plan().unwrap();
    let matching_custom = store
        .create_plan_definition(mcheyne_plan_definition())
        .unwrap();
    let existing = store
        .create_plan_definition(stream_definition("Existing custom plan"))
        .unwrap();
    let enrollment = store
        .enroll_in_chapter_streams(&existing.id, stream_selections(false))
        .unwrap();
    let before_assignments = store.active_plan_assignments(&enrollment.id).unwrap();
    let before_progress = progress_fingerprint(&path);

    let registered = store.register_mcheyne_plan().unwrap();
    assert_ne!(registered.plan_id, matching_custom.plan_id);
    assert_eq!(registered.definition, mcheyne_plan_definition());
    assert_eq!(store.register_mcheyne_plan().unwrap(), registered);
    assert_eq!(progress_fingerprint(&path), before_progress);
    drop(store);

    let mut reopened = JournalStore::open(&path).unwrap();
    assert_eq!(reopened.register_mcheyne_plan().unwrap(), registered);
    assert_eq!(reopened.register_four_stream_plan().unwrap(), four_stream);
    assert_eq!(
        reopened
            .list_plan_definition_versions(&matching_custom.plan_id)
            .unwrap(),
        vec![matching_custom]
    );
    assert_eq!(
        reopened
            .list_plan_definition_versions(&existing.plan_id)
            .unwrap(),
        vec![existing]
    );
    assert_eq!(
        reopened.active_plan_assignments(&enrollment.id).unwrap(),
        before_assignments
    );
    assert_eq!(progress_fingerprint(&path), before_progress);
}

#[test]
fn mcheyne_registration_rolls_back_after_partial_writes() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    drop(JournalStore::open(&path).unwrap());
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER inject_mcheyne_registration_failure BEFORE INSERT ON built_in_plan_registrations
         WHEN NEW.built_in_id='mcheyne'
         BEGIN SELECT RAISE(ABORT,'injected MCheyne registration failure'); END;",
    )
    .unwrap();
    drop(conn);

    let before = plan_registry_fingerprint(&path);
    let mut store = JournalStore::open(&path).unwrap();
    assert!(store
        .register_mcheyne_plan()
        .unwrap_err()
        .to_string()
        .contains("injected MCheyne registration failure"));
    drop(store);
    assert_eq!(plan_registry_fingerprint(&path), before);
}

#[test]
fn simultaneous_stores_register_exactly_one_mcheyne_plan() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let first = JournalStore::open(&path).unwrap();
    let second = JournalStore::open(&path).unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let registrations = std::thread::scope(|scope| {
        let first_barrier = barrier.clone();
        let first_registration = scope.spawn(move || {
            let mut store = first;
            first_barrier.wait();
            store.register_mcheyne_plan().unwrap()
        });
        let second_registration = scope.spawn(move || {
            let mut store = second;
            barrier.wait();
            store.register_mcheyne_plan().unwrap()
        });
        [
            first_registration.join().unwrap(),
            second_registration.join().unwrap(),
        ]
    });
    assert_eq!(registrations[0], registrations[1]);
    let conn = rusqlite::Connection::open(path).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT (SELECT count(*) FROM plans),(SELECT count(*) FROM plan_definition_versions),(SELECT count(*) FROM built_in_plan_registrations WHERE built_in_id='mcheyne')",
            [],
            |row| Ok((row.get::<_, u32>(0)?, row.get::<_, u32>(1)?, row.get::<_, u32>(2)?)),
        )
        .unwrap(),
        (1, 1, 1)
    );
}

#[test]
fn schema_six_registration_migration_preserves_existing_plan_progress() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let existing = store
        .create_plan_definition(stream_definition("Existing custom plan"))
        .unwrap();
    let enrollment = store
        .enroll_in_chapter_streams(&existing.id, stream_selections(false))
        .unwrap();
    let assignment = store
        .active_plan_assignments(&enrollment.id)
        .unwrap()
        .into_iter()
        .find(|value| value.stream_id == "old-testament")
        .unwrap();
    store
        .complete_plan_stream(CompleteStreamRequest {
            enrollment_id: enrollment.id,
            stream_id: assignment.stream_id,
            expected_assignment_id: assignment.id,
            expected_progress_id: assignment.progress_id,
        })
        .unwrap();
    drop(store);
    let retained_plans = schema_two_retained_fingerprint(&path);
    let retained_progress = progress_fingerprint(&path);

    downgrade_assignment_provenance_to_v11(&path);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute("DROP TABLE built_in_plan_registrations", [])
        .unwrap();
    conn.pragma_update(None, "user_version", 6).unwrap();
    drop(conn);

    let mut migrated = JournalStore::open(&path).unwrap();
    assert_eq!(schema_two_retained_fingerprint(&path), retained_plans);
    assert_eq!(progress_fingerprint(&path), retained_progress);
    assert_eq!(
        rusqlite::Connection::open(&path)
            .unwrap()
            .query_row(
                "SELECT count(*) FROM built_in_plan_registrations",
                [],
                |row| row.get::<_, u32>(0),
            )
            .unwrap(),
        0
    );
    assert_eq!(
        migrated
            .list_plan_definition_versions(&existing.plan_id)
            .unwrap(),
        vec![existing]
    );
    let registered = migrated.register_four_stream_plan().unwrap();
    drop(migrated);
    let mut reopened = JournalStore::open(&path).unwrap();
    assert_eq!(reopened.register_four_stream_plan().unwrap(), registered);
    drop(reopened);
    let conn = rusqlite::Connection::open(path).unwrap();
    assert_eq!(
        conn.pragma_query_value::<u32, _>(None, "user_version", |row| row.get(0))
            .unwrap(),
        journal_core::CURRENT_SCHEMA
    );
}

fn plan_registry_fingerprint(path: &std::path::Path) -> Vec<String> {
    let conn = rusqlite::Connection::open(path).unwrap();
    [
        "SELECT group_concat(id||':'||created_at,'|') FROM (SELECT * FROM plans ORDER BY id)",
        "SELECT group_concat(id||':'||plan_id||':'||version||':'||created_at||':'||definition,'|') FROM (SELECT * FROM plan_definition_versions ORDER BY id)",
        "SELECT group_concat(built_in_id||':'||definition_version_id,'|') FROM (SELECT * FROM built_in_plan_registrations ORDER BY built_in_id)",
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
fn built_in_registry_constraints_preserve_registration_exactly() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let registered = store.register_four_stream_plan().unwrap();
    let custom = store
        .create_plan_definition(stream_definition("Constraint target"))
        .unwrap();
    drop(store);
    let retained = plan_registry_fingerprint(&path);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    for (statement, parameters, expected_error) in [
        (
            "UPDATE built_in_plan_registrations SET built_in_id=built_in_id WHERE ?1=?2",
            ("same", "same"),
            "Built-in plan registrations are immutable",
        ),
        (
            "DELETE FROM built_in_plan_registrations WHERE ?1=?2",
            ("same", "same"),
            "Built-in plan registrations are retained",
        ),
        (
            "INSERT INTO built_in_plan_registrations(built_in_id,definition_version_id) VALUES(?1,?2)",
            ("four-stream", custom.id.as_str()),
            "UNIQUE constraint failed: built_in_plan_registrations.built_in_id",
        ),
        (
            "INSERT INTO built_in_plan_registrations(built_in_id,definition_version_id) VALUES(?1,?2)",
            ("other-built-in", registered.id.as_str()),
            "UNIQUE constraint failed: built_in_plan_registrations.definition_version_id",
        ),
        (
            "INSERT INTO built_in_plan_registrations(built_in_id,definition_version_id) VALUES(?1,?2)",
            ("missing-version", "00000000-0000-4000-a000-000000000000"),
            "FOREIGN KEY constraint failed",
        ),
    ] {
        assert!(conn
            .execute(statement, rusqlite::params![parameters.0, parameters.1])
            .unwrap_err()
            .to_string()
            .contains(expected_error));
        assert_eq!(plan_registry_fingerprint(&path), retained);
    }
    drop(conn);

    let mut reopened = JournalStore::open(&path).unwrap();
    assert_eq!(reopened.register_four_stream_plan().unwrap(), registered);
    assert_eq!(plan_registry_fingerprint(&path), retained);
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
fn latest_plan_definition_discovery_is_empty_for_a_new_journal() {
    let dir = TempDir::new().unwrap();
    let store = JournalStore::open(&dir.path().join("j.db")).unwrap();
    assert!(store
        .list_latest_plan_definition_versions()
        .unwrap()
        .is_empty());
}

#[test]
fn latest_plan_definition_discovery_is_ordered_durable_and_read_only() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let portable = serialize_plan_definition_json(&stream_definition("Identical import")).unwrap();
    let first_v1 = store.import_plan_definition_json(&portable).unwrap();
    let second = store.import_plan_definition_json(&portable).unwrap();
    assert_ne!(first_v1.plan_id, second.plan_id);
    let first_v2 = store
        .create_plan_definition_version(
            &first_v1.plan_id,
            PlanDefinition {
                schema_version: 1,
                name: "Latest explicit version".into(),
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
            },
        )
        .unwrap();
    let built_in = store.register_four_stream_plan().unwrap();
    let enrollment = store
        .enroll_in_chapter_streams(
            &second.id,
            vec![
                StreamEnrollment {
                    stream_id: "old-testament".into(),
                    starting_position: 0,
                    loop_after_end: false,
                },
                StreamEnrollment {
                    stream_id: "new-testament".into(),
                    starting_position: 0,
                    loop_after_end: true,
                },
            ],
        )
        .unwrap();
    let assignment = store
        .active_plan_assignments(&enrollment.id)
        .unwrap()
        .remove(0);
    store
        .complete_plan_stream(CompleteStreamRequest {
            enrollment_id: enrollment.id.clone(),
            stream_id: assignment.stream_id.clone(),
            expected_assignment_id: assignment.id,
            expected_progress_id: assignment.progress_id,
        })
        .unwrap();

    let mut expected = vec![
        (
            first_v1.created_at.clone(),
            first_v1.plan_id.clone(),
            first_v2.clone(),
        ),
        (
            second.created_at.clone(),
            second.plan_id.clone(),
            second.clone(),
        ),
        (
            built_in.created_at.clone(),
            built_in.plan_id.clone(),
            built_in.clone(),
        ),
    ];
    expected.sort_by(|left, right| (&left.0, &left.1).cmp(&(&right.0, &right.1)));
    let expected = expected
        .into_iter()
        .map(|(_, _, version)| version)
        .collect::<Vec<_>>();
    let versions_before = [
        first_v1.plan_id.clone(),
        second.plan_id.clone(),
        built_in.plan_id.clone(),
    ]
    .map(|plan_id| store.list_plan_definition_versions(&plan_id).unwrap());
    let enrollments_before = store.list_plan_enrollments().unwrap();
    let assignments_before = store.active_plan_assignments(&enrollment.id).unwrap();
    let history_before = store.plan_completion_history(&enrollment.id).unwrap();

    assert_eq!(
        store.list_latest_plan_definition_versions().unwrap(),
        expected
    );
    assert_eq!(
        [
            first_v1.plan_id.clone(),
            second.plan_id.clone(),
            built_in.plan_id.clone()
        ]
        .map(|plan_id| store.list_plan_definition_versions(&plan_id).unwrap()),
        versions_before
    );
    assert_eq!(store.list_plan_enrollments().unwrap(), enrollments_before);
    assert_eq!(
        store.active_plan_assignments(&enrollment.id).unwrap(),
        assignments_before
    );
    assert_eq!(
        store.plan_completion_history(&enrollment.id).unwrap(),
        history_before
    );
    drop(store);

    let reopened = JournalStore::open(&path).unwrap();
    assert_eq!(
        reopened.list_latest_plan_definition_versions().unwrap(),
        expected
    );
    assert_eq!(
        [
            first_v1.plan_id.clone(),
            second.plan_id.clone(),
            built_in.plan_id.clone()
        ]
        .map(|plan_id| reopened.list_plan_definition_versions(&plan_id).unwrap()),
        versions_before
    );
    assert_eq!(
        reopened.list_plan_enrollments().unwrap(),
        enrollments_before
    );
    assert_eq!(
        reopened.active_plan_assignments(&enrollment.id).unwrap(),
        assignments_before
    );
    assert_eq!(
        reopened.plan_completion_history(&enrollment.id).unwrap(),
        history_before
    );
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

    downgrade_assignment_provenance_to_v11(&path);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "DROP TABLE built_in_plan_registrations;
         DROP TABLE plan_stream_progress_epochs;
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
        journal_core::CURRENT_SCHEMA
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
fn progress_tables_reject_updates_and_deletes_without_changing_retained_rows() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let version = store
        .create_plan_definition(stream_definition("Retained progress"))
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
            enrollment_id: enrollment.id.clone(),
            stream_id: assignment.stream_id.clone(),
            expected_assignment_id: assignment.id.clone(),
            expected_progress_id: assignment.progress_id.clone(),
        })
        .unwrap();
    store.undo_plan_completion(&completion.id).unwrap();
    let active_after_undo = store.active_plan_assignments(&enrollment.id).unwrap();
    drop(store);

    let retained = progress_fingerprint(&path);
    assert!(retained.iter().all(|rows| !rows.is_empty()));
    let conn = rusqlite::Connection::open(&path).unwrap();
    for (statement, expected_error) in [
        (
            "UPDATE plan_enrollments SET created_at=created_at",
            "Plan enrollments are immutable",
        ),
        (
            "UPDATE plan_enrollment_streams SET loop_after_end=loop_after_end",
            "Plan enrollments are immutable",
        ),
        (
            "UPDATE plan_assignments SET passage=passage",
            "Plan assignments are immutable",
        ),
        (
            "UPDATE reading_completions SET completed_at=completed_at",
            "Reading completions are immutable",
        ),
        (
            "UPDATE reading_completion_undos SET undone_at=undone_at",
            "Reading completion undos are immutable",
        ),
        (
            "UPDATE plan_stream_progress_epochs SET created_at=created_at",
            "Plan progress epochs are immutable",
        ),
    ] {
        assert!(conn
            .execute(statement, [])
            .unwrap_err()
            .to_string()
            .contains(expected_error));
        assert_eq!(progress_fingerprint(&path), retained);
    }
    for table in [
        "plan_enrollments",
        "plan_enrollment_streams",
        "plan_assignments",
        "reading_completions",
        "reading_completion_undos",
        "plan_stream_progress_epochs",
    ] {
        assert!(conn
            .execute(&format!("DELETE FROM {table}"), [])
            .unwrap_err()
            .to_string()
            .contains("Plan progress is retained"));
        assert_eq!(progress_fingerprint(&path), retained);
    }
    drop(conn);

    let reopened = JournalStore::open(&path).unwrap();
    assert_eq!(progress_fingerprint(&path), retained);
    assert_eq!(
        reopened.active_plan_assignments(&enrollment.id).unwrap(),
        active_after_undo
    );
}

#[test]
fn progress_epochs_reject_cross_stream_and_cross_enrollment_assignments() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let version = store
        .create_plan_definition(stream_definition("Epoch ownership"))
        .unwrap();
    let first_enrollment = store
        .enroll_in_chapter_streams(&version.id, stream_selections(false))
        .unwrap();
    let second_enrollment = store
        .enroll_in_chapter_streams(&version.id, stream_selections(false))
        .unwrap();
    let first_active = store.active_plan_assignments(&first_enrollment.id).unwrap();
    let second_active = store
        .active_plan_assignments(&second_enrollment.id)
        .unwrap();
    let first_old_assignment = first_active
        .iter()
        .find(|value| value.stream_id == "old-testament")
        .unwrap();
    let second_old_assignment = second_active
        .iter()
        .find(|value| value.stream_id == "old-testament")
        .unwrap();
    drop(store);

    let retained = progress_fingerprint(&path);
    let conn = rusqlite::Connection::open(&path).unwrap();
    for (stream_id, assignment_id) in [
        ("new-testament", first_old_assignment.id.as_str()),
        ("old-testament", second_old_assignment.id.as_str()),
    ] {
        assert!(conn
            .execute(
                "INSERT INTO plan_stream_progress_epochs(id,enrollment_id,stream_id,sequence,assignment_id,created_at) VALUES(?1,?2,?3,99,?4,'synthetic')",
                rusqlite::params![
                    Uuid::new_v4().to_string(),
                    first_enrollment.id,
                    stream_id,
                    assignment_id
                ],
            )
            .unwrap_err()
            .to_string()
            .contains("Progress epoch assignment must belong to its stream"));
        assert_eq!(progress_fingerprint(&path), retained);
    }
    assert_eq!(
        conn.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
            row.get::<_, u32>(0)
        })
        .unwrap(),
        0
    );
    drop(conn);

    let reopened = JournalStore::open(&path).unwrap();
    assert_eq!(progress_fingerprint(&path), retained);
    assert_eq!(
        reopened
            .active_plan_assignments(&first_enrollment.id)
            .unwrap(),
        first_active
    );
    assert_eq!(
        reopened
            .active_plan_assignments(&second_enrollment.id)
            .unwrap(),
        second_active
    );
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
fn stream_assignments_record_owned_provenance_and_retained_successors() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("provenance.db");
    let mut store = JournalStore::open(&path).unwrap();
    let version = store
        .create_plan_definition(stream_definition("Provenance"))
        .unwrap();
    let enrollment = store
        .enroll_in_chapter_streams(&version.id, stream_selections(false))
        .unwrap();
    let first = store
        .active_plan_assignments(&enrollment.id)
        .unwrap()
        .into_iter()
        .find(|item| item.stream_id == "old-testament")
        .unwrap();
    let other = store
        .active_plan_assignments(&enrollment.id)
        .unwrap()
        .into_iter()
        .find(|item| item.stream_id == "new-testament")
        .unwrap();
    assert_eq!(first.definition_version_id, version.id);
    assert_eq!(first.generation_id, enrollment.id);
    store
        .complete_plan_stream(CompleteStreamRequest {
            enrollment_id: enrollment.id.clone(),
            stream_id: first.stream_id.clone(),
            expected_assignment_id: first.id.clone(),
            expected_progress_id: first.progress_id.clone(),
        })
        .unwrap();
    let second = store
        .active_plan_assignments(&enrollment.id)
        .unwrap()
        .into_iter()
        .find(|item| item.stream_id == "old-testament")
        .unwrap();
    assert_eq!(second.definition_version_id, version.id);
    assert_eq!(second.generation_id, enrollment.id);
    drop(store);

    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT successor_assignment_id FROM plan_assignment_successors WHERE predecessor_assignment_id=?1",
            [&first.id], |row| row.get::<_, String>(0),
        ).unwrap(),
        second.id
    );
    let successor_count: i64 = conn
        .query_row(
            "SELECT count(*) FROM plan_assignment_successors",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(conn
        .execute(
            "INSERT INTO plan_assignment_successors(predecessor_assignment_id,successor_assignment_id,enrollment_id,stream_id) VALUES(?1,?2,?3,'new-testament')",
            rusqlite::params![other.id, second.id, enrollment.id],
        )
        .is_err());
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM plan_assignment_successors",
            [],
            |row| { row.get::<_, i64>(0) }
        )
        .unwrap(),
        successor_count
    );
    for sql in [
        "UPDATE plan_assignment_generations SET created_at=created_at",
        "DELETE FROM plan_assignment_generations",
        "UPDATE plan_assignment_successors SET stream_id=stream_id",
        "DELETE FROM plan_assignment_successors",
    ] {
        assert!(conn.execute(sql, []).is_err(), "{sql}");
    }
    let before: i64 = conn
        .query_row("SELECT count(*) FROM plan_assignments", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert!(conn.execute(
        "INSERT INTO plan_assignments(id,enrollment_id,stream_id,ordinal,cycle,passage,stream_position,definition_version_id,generation_id)
         VALUES(?1,?2,'old-testament',99,1,'{\"book\":1,\"chapter\":1}',0,?3,?4)",
        rusqlite::params![Uuid::new_v4().to_string(), enrollment.id, version.id, Uuid::new_v4().to_string()],
    ).unwrap_err().to_string().contains("Assignment provenance must belong"));
    assert_eq!(
        conn.query_row("SELECT count(*) FROM plan_assignments", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        before
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap(),
        0
    );
    drop(conn);

    let reopened = JournalStore::open(&path).unwrap();
    assert_eq!(
        reopened
            .active_plan_assignments(&enrollment.id)
            .unwrap()
            .into_iter()
            .find(|item| item.stream_id == "old-testament")
            .unwrap(),
        second
    );
}

fn downgrade_assignment_provenance_to_v11(path: &std::path::Path) {
    let conn = rusqlite::Connection::open(path).unwrap();
    support::remove_deletion_schema(&conn);
    conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
    conn.execute_batch(
        "DROP TRIGGER plan_assignment_successors_ordered;
         DROP TRIGGER plan_assignment_successors_retained;
         DROP TRIGGER plan_assignment_successors_immutable;
         DROP TABLE plan_assignment_successors;
         DROP TRIGGER plan_assignments_provenance_required;
         DROP TRIGGER plan_assignment_generations_retained;
         DROP TRIGGER plan_assignment_generations_immutable;
         DROP INDEX plan_assignment_owner;
         ALTER TABLE plan_assignments DROP COLUMN generation_id;
         ALTER TABLE plan_assignments DROP COLUMN definition_version_id;
         DROP TABLE plan_assignment_generations;
         PRAGMA user_version=11;",
    )
    .unwrap();
}

#[test]
fn populated_schema_eleven_migration_preserves_stream_history_and_builds_provenance() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("schema-eleven.db");
    let mut store = JournalStore::open(&path).unwrap();
    let version = store
        .create_plan_definition(stream_definition("Historical v11"))
        .unwrap();
    let enrollment = store
        .enroll_in_chapter_streams(&version.id, stream_selections(false))
        .unwrap();
    let first = store
        .active_plan_assignments(&enrollment.id)
        .unwrap()
        .into_iter()
        .find(|item| item.stream_id == "old-testament")
        .unwrap();
    let completion = store
        .complete_plan_stream(CompleteStreamRequest {
            enrollment_id: enrollment.id.clone(),
            stream_id: first.stream_id.clone(),
            expected_assignment_id: first.id.clone(),
            expected_progress_id: first.progress_id.clone(),
        })
        .unwrap();
    let history = store.plan_completion_history(&enrollment.id).unwrap();
    drop(store);
    downgrade_assignment_provenance_to_v11(&path);

    let reopened = JournalStore::open(&path).unwrap();
    assert_eq!(
        reopened.plan_completion_history(&enrollment.id).unwrap(),
        history
    );
    let active = reopened
        .active_plan_assignments(&enrollment.id)
        .unwrap()
        .into_iter()
        .find(|item| item.stream_id == "old-testament")
        .unwrap();
    assert_eq!(active.definition_version_id, version.id);
    assert_eq!(active.generation_id, enrollment.id);
    drop(reopened);
    let conn = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        conn.pragma_query_value::<u32, _>(None, "user_version", |row| row.get(0))
            .unwrap(),
        journal_core::CURRENT_SCHEMA
    );
    assert_eq!(conn.query_row("SELECT successor_assignment_id FROM plan_assignment_successors WHERE predecessor_assignment_id=(SELECT assignment_id FROM reading_completions WHERE id=?1)", [&completion.id], |row| row.get::<_, String>(0)).unwrap(), active.id);
    assert_eq!(
        conn.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap(),
        0
    );
    drop(conn);
    JournalStore::open(&path).unwrap();
}

#[test]
fn ambiguous_schema_eleven_chain_rolls_back_provenance_migration() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("ambiguous-schema-eleven.db");
    let mut store = JournalStore::open(&path).unwrap();
    let version = store
        .create_plan_definition(stream_definition("Ambiguous v11"))
        .unwrap();
    let enrollment = store
        .enroll_in_chapter_streams(&version.id, stream_selections(false))
        .unwrap();
    let first = store
        .active_plan_assignments(&enrollment.id)
        .unwrap()
        .into_iter()
        .find(|item| item.stream_id == "old-testament")
        .unwrap();
    store
        .complete_plan_stream(CompleteStreamRequest {
            enrollment_id: enrollment.id.clone(),
            stream_id: first.stream_id.clone(),
            expected_assignment_id: first.id.clone(),
            expected_progress_id: first.progress_id.clone(),
        })
        .unwrap();
    drop(store);
    downgrade_assignment_provenance_to_v11(&path);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "DROP TRIGGER plan_progress_retained_assignments;
         DROP TRIGGER plan_stream_progress_epochs_retained;
         DROP TRIGGER plan_progress_retained_completions;",
    )
    .unwrap();
    conn.execute(
        "DELETE FROM plan_stream_progress_epochs WHERE assignment_id=?1",
        [&first.id],
    )
    .unwrap();
    conn.execute(
        "DELETE FROM reading_completions WHERE assignment_id=?1",
        [&first.id],
    )
    .unwrap();
    conn.execute("DELETE FROM plan_assignments WHERE id=?1", [&first.id])
        .unwrap();
    drop(conn);
    let error = match JournalStore::open(&path) {
        Ok(_) => panic!("ambiguous chain migration unexpectedly succeeded"),
        Err(error) => error,
    };
    assert!(error
        .to_string()
        .contains("Ambiguous retained assignment chain"));
    let conn = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        conn.pragma_query_value::<u32, _>(None, "user_version", |row| row.get(0))
            .unwrap(),
        11
    );
    assert_eq!(conn.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='plan_assignment_generations'", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
}

#[test]
fn retained_enrollments_are_discoverable_without_changing_history() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    assert!(store.list_plan_enrollments().unwrap().is_empty());

    let first_version = store
        .create_plan_definition(stream_definition("Discovery version one"))
        .unwrap();
    let first_enrollment = store
        .enroll_in_chapter_streams(&first_version.id, stream_selections(false))
        .unwrap();
    let mut edited = stream_definition("Discovery version two");
    let PlanSchedule::ChapterStreams { streams } = &mut edited.schedule else {
        unreachable!();
    };
    streams[0].chapters.push(ChapterRef {
        book: 1,
        chapter: 3,
    });
    let second_version = store
        .create_plan_definition_version(&first_version.plan_id, edited)
        .unwrap();
    let second_enrollment = store
        .enroll_in_chapter_streams(&second_version.id, stream_selections(true))
        .unwrap();

    let active = store
        .active_plan_assignments(&first_enrollment.id)
        .unwrap()
        .into_iter()
        .find(|assignment| assignment.stream_id == "old-testament")
        .unwrap();
    let completion = store
        .complete_plan_stream(CompleteStreamRequest {
            enrollment_id: first_enrollment.id.clone(),
            stream_id: active.stream_id,
            expected_assignment_id: active.id,
            expected_progress_id: active.progress_id,
        })
        .unwrap();
    store.undo_plan_completion(&completion.id).unwrap();

    let retained_definitions = plan_registry_fingerprint(&path);
    let retained_progress = progress_fingerprint(&path);
    let enrollments = store.list_plan_enrollments().unwrap();
    assert_eq!(enrollments.len(), 2);
    assert!(enrollments.contains(&first_enrollment));
    assert!(enrollments.contains(&second_enrollment));
    assert_eq!(
        enrollments
            .iter()
            .map(|enrollment| (&enrollment.created_at, &enrollment.id))
            .collect::<Vec<_>>(),
        {
            let mut ordering = enrollments
                .iter()
                .map(|enrollment| (&enrollment.created_at, &enrollment.id))
                .collect::<Vec<_>>();
            ordering.sort();
            ordering
        }
    );
    assert_eq!(first_enrollment.definition_version_id, first_version.id);
    assert_eq!(second_enrollment.definition_version_id, second_version.id);
    assert_eq!(plan_registry_fingerprint(&path), retained_definitions);
    assert_eq!(progress_fingerprint(&path), retained_progress);
    drop(store);

    let reopened = JournalStore::open(&path).unwrap();
    assert_eq!(reopened.list_plan_enrollments().unwrap(), enrollments);
    assert_eq!(plan_registry_fingerprint(&path), retained_definitions);
    assert_eq!(progress_fingerprint(&path), retained_progress);
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
    downgrade_assignment_provenance_to_v11(&path);
    let conn = rusqlite::Connection::open(&path).unwrap();
    for table in [
        "built_in_plan_registrations",
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
        journal_core::CURRENT_SCHEMA
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

    downgrade_assignment_provenance_to_v11(&path);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "DROP TABLE built_in_plan_registrations;
         DROP TABLE plan_stream_progress_epochs;
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
        journal_core::CURRENT_SCHEMA
    );
}

#[test]
fn exhausted_schema_three_stream_can_undo_and_recomplete_after_migration() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let version = store
        .create_plan_definition(stream_definition("Exhausted schema three"))
        .unwrap();
    let enrollment = store
        .enroll_in_chapter_streams(&version.id, stream_selections(false))
        .unwrap();
    let mut original_completions = Vec::new();
    for _ in 0..2 {
        let assignment = store
            .active_plan_assignments(&enrollment.id)
            .unwrap()
            .into_iter()
            .find(|value| value.stream_id == "old-testament")
            .unwrap();
        original_completions.push(
            store
                .complete_plan_stream(CompleteStreamRequest {
                    enrollment_id: enrollment.id.clone(),
                    stream_id: assignment.stream_id,
                    expected_assignment_id: assignment.id,
                    expected_progress_id: assignment.progress_id,
                })
                .unwrap(),
        );
    }
    let unrelated_before_migration = store
        .active_plan_assignments(&enrollment.id)
        .unwrap()
        .into_iter()
        .find(|value| value.stream_id == "new-testament")
        .unwrap();
    drop(store);

    downgrade_assignment_provenance_to_v11(&path);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "DROP TABLE built_in_plan_registrations;
         DROP TABLE plan_stream_progress_epochs;
         DROP TRIGGER plan_assignments_immutable;
         DROP TRIGGER plan_assignments_position_required;
         ALTER TABLE plan_assignments DROP COLUMN stream_position;
         CREATE TRIGGER plan_assignments_immutable BEFORE UPDATE ON plan_assignments BEGIN SELECT RAISE(ABORT,'Plan assignments are immutable'); END;",
    )
    .unwrap();
    conn.pragma_update(None, "user_version", 3).unwrap();
    drop(conn);

    let mut migrated = JournalStore::open(&path).unwrap();
    let active_after_migration = migrated.active_plan_assignments(&enrollment.id).unwrap();
    assert!(active_after_migration
        .iter()
        .all(|value| value.stream_id != "old-testament"));
    let unrelated_after_migration = active_after_migration
        .iter()
        .find(|value| value.stream_id == "new-testament")
        .unwrap()
        .clone();
    assert_eq!(unrelated_after_migration.id, unrelated_before_migration.id);
    let conn = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM plan_stream_progress_epochs WHERE enrollment_id=?1 AND stream_id='old-testament'",
            [&enrollment.id],
            |row| row.get::<_, u32>(0),
        )
        .unwrap(),
        0
    );
    drop(conn);

    migrated
        .undo_plan_completion(&original_completions[1].id)
        .unwrap();
    let restored = migrated
        .active_plan_assignments(&enrollment.id)
        .unwrap()
        .into_iter()
        .find(|value| value.stream_id == "old-testament")
        .unwrap();
    assert_eq!((restored.ordinal, restored.passage.chapter), (2, 2));
    assert!(Uuid::parse_str(&restored.progress_id).is_ok());
    let conn = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM plan_stream_progress_epochs WHERE enrollment_id=?1 AND stream_id='old-testament'",
            [&enrollment.id],
            |row| row.get::<_, u32>(0),
        )
        .unwrap(),
        1
    );
    drop(conn);
    let recompletion = migrated
        .complete_plan_stream(CompleteStreamRequest {
            enrollment_id: enrollment.id.clone(),
            stream_id: restored.stream_id,
            expected_assignment_id: restored.id,
            expected_progress_id: restored.progress_id,
        })
        .unwrap();
    let active_after_recompletion = migrated.active_plan_assignments(&enrollment.id).unwrap();
    assert_eq!(active_after_recompletion, vec![unrelated_after_migration]);
    let retained = progress_fingerprint(&path);
    assert!(retained[3].contains(&original_completions[0].id));
    assert!(retained[3].contains(&original_completions[1].id));
    assert!(retained[3].contains(&recompletion.id));
    assert!(!retained[4].is_empty());
    drop(migrated);

    let reopened = JournalStore::open(&path).unwrap();
    assert_eq!(progress_fingerprint(&path), retained);
    assert_eq!(
        reopened.active_plan_assignments(&enrollment.id).unwrap(),
        active_after_recompletion
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

#[test]
fn simultaneous_stores_reject_stale_completion_and_retain_recompletion_history() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut first_store = JournalStore::open(&path).unwrap();
    let version = first_store
        .create_plan_definition(stream_definition("Simultaneous stores"))
        .unwrap();
    let enrollment = first_store
        .enroll_in_chapter_streams(&version.id, stream_selections(false))
        .unwrap();
    let mut second_store = JournalStore::open(&path).unwrap();
    let stale_assignment = second_store
        .active_plan_assignments(&enrollment.id)
        .unwrap()
        .into_iter()
        .find(|assignment| assignment.stream_id == "old-testament")
        .unwrap();
    let stale_request = CompleteStreamRequest {
        enrollment_id: enrollment.id.clone(),
        stream_id: stale_assignment.stream_id.clone(),
        expected_assignment_id: stale_assignment.id.clone(),
        expected_progress_id: stale_assignment.progress_id.clone(),
    };

    let first_completion = first_store
        .complete_plan_stream(stale_request.clone())
        .unwrap();
    first_store
        .undo_plan_completion(&first_completion.id)
        .unwrap();
    let before_rejection = progress_fingerprint(&path);
    assert!(second_store
        .complete_plan_stream(stale_request)
        .unwrap_err()
        .to_string()
        .contains("Conflict"));
    assert_eq!(progress_fingerprint(&path), before_rejection);

    let refreshed_assignment = second_store
        .active_plan_assignments(&enrollment.id)
        .unwrap()
        .into_iter()
        .find(|assignment| assignment.stream_id == "old-testament")
        .unwrap();
    assert_eq!(refreshed_assignment.id, stale_assignment.id);
    assert_ne!(
        refreshed_assignment.progress_id,
        stale_assignment.progress_id
    );
    let recompletion = second_store
        .complete_plan_stream(CompleteStreamRequest {
            enrollment_id: enrollment.id.clone(),
            stream_id: refreshed_assignment.stream_id,
            expected_assignment_id: refreshed_assignment.id,
            expected_progress_id: refreshed_assignment.progress_id,
        })
        .unwrap();
    let active_after_recompletion = second_store
        .active_plan_assignments(&enrollment.id)
        .unwrap();
    assert_eq!(
        active_after_recompletion
            .iter()
            .find(|assignment| assignment.stream_id == "old-testament")
            .unwrap()
            .ordinal,
        2
    );
    let retained = progress_fingerprint(&path);
    assert!(retained[3].contains(&first_completion.id));
    assert!(retained[3].contains(&recompletion.id));
    assert!(!retained[4].is_empty());
    drop(second_store);
    drop(first_store);

    let reopened = JournalStore::open(&path).unwrap();
    assert_eq!(progress_fingerprint(&path), retained);
    assert_eq!(
        reopened.active_plan_assignments(&enrollment.id).unwrap(),
        active_after_recompletion
    );
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

fn complete_stream(
    store: &mut JournalStore,
    enrollment_id: &str,
    stream_id: &str,
) -> journal_core::PlanCompletion {
    let assignment = store
        .active_plan_assignments(enrollment_id)
        .unwrap()
        .into_iter()
        .find(|assignment| assignment.stream_id == stream_id)
        .unwrap();
    store
        .complete_plan_stream(CompleteStreamRequest {
            enrollment_id: enrollment_id.into(),
            stream_id: stream_id.into(),
            expected_assignment_id: assignment.id,
            expected_progress_id: assignment.progress_id,
        })
        .unwrap()
}

#[test]
fn retained_completion_history_is_ordered_isolated_and_survives_undo_recompletion_and_reopen() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let version = store
        .create_plan_definition(stream_definition("Completion history"))
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
        ]
    };
    let first = store
        .enroll_in_chapter_streams(&version.id, selections())
        .unwrap();
    let second = store
        .enroll_in_chapter_streams(&version.id, selections())
        .unwrap();
    assert!(store
        .plan_completion_history(&Uuid::new_v4().to_string())
        .unwrap()
        .is_empty());
    assert!(store.plan_completion_history(&first.id).unwrap().is_empty());

    let first_old = complete_stream(&mut store, &first.id, "old-testament");
    let first_new = complete_stream(&mut store, &first.id, "new-testament");
    let first_old_second = complete_stream(&mut store, &first.id, "old-testament");
    let first_old_cycle_two = complete_stream(&mut store, &first.id, "old-testament");
    store.undo_plan_completion(&first_old_cycle_two.id).unwrap();
    store.undo_plan_completion(&first_old_second.id).unwrap();
    let first_old_recompletion = complete_stream(&mut store, &first.id, "old-testament");
    assert_eq!(
        first_old_recompletion.assignment_id,
        first_old_second.assignment_id
    );

    let tied_assignments = store.active_plan_assignments(&second.id).unwrap();
    drop(store);
    let conn = rusqlite::Connection::open(&path).unwrap();
    for (id, assignment) in [
        ("00000000-0000-4000-8000-000000000001", &tied_assignments[0]),
        ("00000000-0000-4000-8000-000000000002", &tied_assignments[1]),
    ] {
        conn.execute(
            "INSERT INTO reading_completions(id,assignment_id,completed_at) VALUES(?1,?2,'2100-01-01T00:00:00Z')",
            [id, assignment.id.as_str()],
        )
        .unwrap();
    }
    let retained_before: (String, String, String, String) = conn
        .query_row(
            "SELECT
                (SELECT group_concat(id||':'||enrollment_id||':'||stream_id||':'||ordinal||':'||cycle||':'||passage,'|') FROM (SELECT id,enrollment_id,stream_id,ordinal,cycle,passage FROM plan_assignments ORDER BY id)),
                (SELECT group_concat(id||':'||assignment_id||':'||completed_at,'|') FROM (SELECT id,assignment_id,completed_at FROM reading_completions ORDER BY id)),
                (SELECT group_concat(completion_id,'|') FROM (SELECT completion_id FROM reading_completion_undos ORDER BY completion_id)),
                (SELECT group_concat(id||':'||assignment_id||':'||sequence,'|') FROM (SELECT id,assignment_id,sequence FROM plan_stream_progress_epochs ORDER BY id))",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    drop(conn);

    let store = JournalStore::open(&path).unwrap();
    let history = store.plan_completion_history(&first.id).unwrap();
    assert_eq!(history.len(), 5);
    assert!(history.windows(2).all(|items| {
        (items[0].completed_at.as_str(), items[0].id.as_str())
            <= (items[1].completed_at.as_str(), items[1].id.as_str())
    }));
    assert_eq!(
        history.iter().map(|item| &item.id).collect::<Vec<_>>(),
        vec![
            &first_old.id,
            &first_new.id,
            &first_old_second.id,
            &first_old_cycle_two.id,
            &first_old_recompletion.id,
        ]
    );
    let old_second = history
        .iter()
        .find(|item| item.id == first_old_second.id)
        .unwrap();
    assert!(old_second.undone);
    assert_eq!(
        (
            old_second.stream_id.as_str(),
            old_second.ordinal,
            old_second.cycle,
            old_second.passage.chapter
        ),
        ("old-testament", 2, 1, 2)
    );
    let cycle_two = history
        .iter()
        .find(|item| item.id == first_old_cycle_two.id)
        .unwrap();
    assert!(cycle_two.undone);
    assert_eq!(
        (
            cycle_two.assignment_id.as_str(),
            cycle_two.ordinal,
            cycle_two.cycle,
            cycle_two.passage.chapter
        ),
        (first_old_cycle_two.assignment_id.as_str(), 3, 2, 1)
    );
    assert!(history
        .iter()
        .any(|item| item.id == first_old_recompletion.id && !item.undone));
    let tied = store.plan_completion_history(&second.id).unwrap();
    assert_eq!(
        tied.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(),
        vec![
            "00000000-0000-4000-8000-000000000001",
            "00000000-0000-4000-8000-000000000002",
        ]
    );
    drop(store);

    downgrade_assignment_provenance_to_v11(&path);
    let conn = rusqlite::Connection::open(&path).unwrap();
    let retained_after: (String, String, String, String) = conn
        .query_row(
            "SELECT
                (SELECT group_concat(id||':'||enrollment_id||':'||stream_id||':'||ordinal||':'||cycle||':'||passage,'|') FROM (SELECT id,enrollment_id,stream_id,ordinal,cycle,passage FROM plan_assignments ORDER BY id)),
                (SELECT group_concat(id||':'||assignment_id||':'||completed_at,'|') FROM (SELECT id,assignment_id,completed_at FROM reading_completions ORDER BY id)),
                (SELECT group_concat(completion_id,'|') FROM (SELECT completion_id FROM reading_completion_undos ORDER BY completion_id)),
                (SELECT group_concat(id||':'||assignment_id||':'||sequence,'|') FROM (SELECT id,assignment_id,sequence FROM plan_stream_progress_epochs ORDER BY id))",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(retained_after, retained_before);
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

    downgrade_assignment_provenance_to_v11(&path);
    let conn = rusqlite::Connection::open(&path).unwrap();
    let snapshots_before: String = conn
        .query_row(
            "SELECT group_concat(id||':'||passage,'|') FROM (SELECT id,passage FROM plan_assignments WHERE enrollment_id=?1 ORDER BY ordinal)",
            [&enrollment.id],
            |row| row.get(0),
        )
        .unwrap();
    conn.execute_batch(
        "DROP TABLE built_in_plan_registrations;
         DROP TRIGGER plan_assignments_immutable;
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

    downgrade_assignment_provenance_to_v11(&path);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "DROP TABLE built_in_plan_registrations;
         DROP TRIGGER plan_assignments_immutable;
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

    downgrade_assignment_provenance_to_v11(&path);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "DROP TABLE built_in_plan_registrations;
         DROP TRIGGER plan_assignments_immutable;
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
    assert!(initial.contains("created_at:"));
    assert!(initial.contains("updated_at:"));
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
    let published = store.save_entry(req.clone()).unwrap();
    assert_eq!(store.export_journal(&out).unwrap().written, 1);
    assert!(fs::read_to_string(&file)
        .unwrap()
        .contains("Unfinished secret edit"));
    fs::write(&file, "External writing").unwrap();
    req.expected_revision_id = Some(published.working_revision_id);
    req.content.body = "A newer published change".into();
    store.save_entry(req.clone()).unwrap();
    assert_eq!(store.export_journal(&out).unwrap().conflicts.len(), 1);
    assert_eq!(fs::read_to_string(&file).unwrap(), "External writing");
}

#[test]
fn incremental_export_updates_link_dependents_and_preserves_unrelated_mtimes() {
    let dir = TempDir::new().unwrap();
    let mut store = JournalStore::open(&dir.path().join("j.db")).unwrap();
    let target_request = request("Linked target", true);
    let target = store.save_entry(target_request.clone()).unwrap();
    let mut source_request = request("Source", true);
    source_request.content.links.push(target.id.clone());
    let source = store.save_entry(source_request.clone()).unwrap();
    let unrelated_request = request("Unrelated", true);
    store.save_entry(unrelated_request.clone()).unwrap();
    let out = export_fixture(&dir, "incremental");
    while store.export_journal(&out).unwrap().pending > 0 {}
    let source_path = out.join(format!("{}.md", source.id));
    let unrelated_path = out.join(format!("{}.md", unrelated_request.entry_id));
    let source_before = fs::metadata(&source_path).unwrap().modified().unwrap();
    let unrelated_before = fs::metadata(&unrelated_path).unwrap().modified().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));

    store
        .set_entry_trashed(&target.id, &target.working_revision_id, true)
        .unwrap();
    let report = store.export_journal(&out).unwrap();

    assert_eq!(report.conflicts, Vec::<String>::new());
    assert!(fs::read_to_string(source_path)
        .unwrap()
        .contains("Unpublished or unavailable"));
    assert!(
        source_before
            < fs::metadata(out.join(format!("{}.md", source.id)))
                .unwrap()
                .modified()
                .unwrap()
    );
    assert_eq!(
        unrelated_before,
        fs::metadata(unrelated_path).unwrap().modified().unwrap()
    );
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
