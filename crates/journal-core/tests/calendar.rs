use chrono::NaiveDate;
use journal_core::{
    expand_calendar_assignments, four_stream_plan_definition, mcheyne_plan_definition,
    CalendarScheduleMode, ChapterRef, ChapterStream, CompleteStreamRequest, EntryContent,
    ExplicitScheduleDay, JournalStore, Passage, PlanDefinition, PlanDefinitionVersion,
    PlanSchedule, SaveRequest, StreamEnrollment,
};
use tempfile::TempDir;

#[test]
fn calendar_alignment_starts_without_backlog_and_ends_on_december_31() {
    let version = retained(mcheyne_plan_definition());
    let start = date(2025, 7, 1);
    let assignments =
        expand_calendar_assignments(&version, start, CalendarScheduleMode::CalendarAligned)
            .unwrap();

    assert_eq!(assignments.len(), 184);
    assert_eq!(assignments.first().unwrap().local_date, start);
    assert_eq!(assignments.first().unwrap().definition_day, 182);
    assert_eq!(
        assignments.first().unwrap().definition_version_id,
        version.id
    );
    assert_eq!(assignments.last().unwrap().local_date, date(2025, 12, 31));
    assert_eq!(assignments.last().unwrap().definition_day, 365);
    assert_eq!(
        assignments.first().unwrap().passages,
        definition_day(&version.definition, 182).passages
    );
}

#[test]
fn leap_day_is_unassigned_without_shifting_march_alignment() {
    let assignments = expand_calendar_assignments(
        &retained(mcheyne_plan_definition()),
        date(2024, 2, 28),
        CalendarScheduleMode::CalendarAligned,
    )
    .unwrap();

    assert_eq!(assignments.first().unwrap().definition_day, 59);
    assert_eq!(assignments.first().unwrap().local_date, date(2024, 2, 28));
    assert!(!assignments
        .iter()
        .any(|assignment| assignment.local_date == date(2024, 2, 29)));
    assert_eq!(assignments[1].local_date, date(2024, 3, 1));
    assert_eq!(assignments[1].definition_day, 60);
    assert_eq!(assignments.last().unwrap().local_date, date(2024, 12, 31));
    assert_eq!(assignments.last().unwrap().definition_day, 365);
}

#[test]
fn day_one_mode_assigns_365_successive_dates_including_leap_day() {
    let version = retained(mcheyne_plan_definition());
    let assignments =
        expand_calendar_assignments(&version, date(2024, 2, 28), CalendarScheduleMode::DayOne)
            .unwrap();

    assert_eq!(assignments.len(), 365);
    assert_eq!(assignments[0].local_date, date(2024, 2, 28));
    assert_eq!(assignments[0].definition_day, 1);
    assert_eq!(assignments[1].local_date, date(2024, 2, 29));
    assert_eq!(assignments[1].definition_day, 2);
    assert_eq!(assignments[2].local_date, date(2024, 3, 1));
    assert_eq!(assignments[2].definition_day, 3);
    assert_eq!(assignments[364].local_date, date(2025, 2, 26));
    assert_eq!(assignments[364].definition_day, 365);
    for assignment in &assignments {
        assert_eq!(
            assignment.passages,
            definition_day(&version.definition, assignment.definition_day).passages
        );
        assert_eq!(assignment.definition_version_id, version.id);
    }
}

#[test]
fn calendar_boundaries_and_invalid_schedule_shapes_are_explicit() {
    let version = retained(mcheyne_plan_definition());
    let last_only = expand_calendar_assignments(
        &version,
        date(2024, 12, 31),
        CalendarScheduleMode::CalendarAligned,
    )
    .unwrap();
    assert_eq!(last_only.len(), 1);
    assert_eq!(last_only[0].definition_day, 365);

    let short = PlanDefinition {
        schema_version: 1,
        name: "Short explicit schedule".into(),
        description: None,
        schedule: PlanSchedule::ExplicitSchedule {
            days: vec![ExplicitScheduleDay {
                day: 1,
                passages: vec![Passage {
                    book: 1,
                    chapter: 1,
                    start_verse: None,
                    end_verse: None,
                }],
            }],
        },
    };
    assert!(expand_calendar_assignments(
        &retained(short),
        date(2025, 1, 1),
        CalendarScheduleMode::CalendarAligned,
    )
    .unwrap_err()
    .to_string()
    .contains("exactly 365"));
    assert!(expand_calendar_assignments(
        &retained(four_stream_plan_definition()),
        date(2025, 1, 1),
        CalendarScheduleMode::DayOne,
    )
    .unwrap_err()
    .to_string()
    .contains("explicit schedule"));
}

#[test]
fn calendar_enrollments_are_atomic_durable_and_version_pinned() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let original = store
        .create_plan_definition(mcheyne_plan_definition())
        .unwrap();
    let aligned = store
        .enroll_in_calendar(
            &original.id,
            date(2024, 2, 28),
            CalendarScheduleMode::CalendarAligned,
        )
        .unwrap();
    let day_one = store
        .enroll_in_calendar(
            &original.id,
            date(2024, 2, 28),
            CalendarScheduleMode::DayOne,
        )
        .unwrap();
    let aligned_assignments = store.calendar_plan_assignments(&aligned.id).unwrap();
    let day_one_assignments = store.calendar_plan_assignments(&day_one.id).unwrap();
    assert_eq!(aligned_assignments.len(), 307);
    assert_eq!(day_one_assignments.len(), 365);
    assert_eq!(aligned_assignments[0].definition_version_id, original.id);
    assert_eq!(aligned_assignments[0].definition_day, 59);
    assert_eq!(aligned_assignments[1].local_date, date(2024, 3, 1));
    assert_eq!(day_one_assignments[1].local_date, date(2024, 2, 29));

    let mut changed = mcheyne_plan_definition();
    changed.name = "Changed future version".into();
    let PlanSchedule::ExplicitSchedule { days } = &mut changed.schedule else {
        unreachable!();
    };
    days[58].passages = vec![whole_chapter(43, 3)];
    let changed = store
        .create_plan_definition_version(&original.plan_id, changed)
        .unwrap();
    assert_ne!(changed.id, original.id);
    assert_eq!(
        store.calendar_plan_assignments(&aligned.id).unwrap(),
        aligned_assignments
    );
    drop(store);

    let reopened = JournalStore::open(&path).unwrap();
    assert_eq!(
        reopened.get_calendar_plan_enrollment(&aligned.id).unwrap(),
        Some(aligned.clone())
    );
    assert_eq!(
        reopened.get_calendar_plan_enrollment(&day_one.id).unwrap(),
        Some(day_one.clone())
    );
    assert_eq!(
        reopened.calendar_plan_assignments(&aligned.id).unwrap(),
        aligned_assignments
    );
    assert_eq!(
        reopened.calendar_plan_assignments(&day_one.id).unwrap(),
        day_one_assignments
    );
}

#[test]
fn calendar_enrollment_failures_leave_exactly_no_partial_state() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let version = store
        .create_plan_definition(mcheyne_plan_definition())
        .unwrap();
    let streams = store.create_plan_definition(stream_definition()).unwrap();
    drop(store);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER inject_calendar_assignment_failure BEFORE INSERT ON plan_calendar_assignments
         WHEN NEW.definition_day=2
         BEGIN SELECT RAISE(ABORT,'injected calendar assignment failure'); END;",
    )
    .unwrap();
    drop(conn);

    let before = calendar_fingerprint(&path);
    let mut store = JournalStore::open(&path).unwrap();
    assert!(store
        .enroll_in_calendar(&version.id, date(2025, 1, 1), CalendarScheduleMode::DayOne,)
        .unwrap_err()
        .to_string()
        .contains("injected calendar assignment failure"));
    assert_eq!(calendar_fingerprint(&path), before);
    assert!(store
        .enroll_in_calendar(&streams.id, date(2025, 1, 1), CalendarScheduleMode::DayOne,)
        .unwrap_err()
        .to_string()
        .contains("explicit schedule"));
    assert!(store
        .enroll_in_calendar(
            "00000000-0000-4000-8000-000000000099",
            date(2025, 1, 1),
            CalendarScheduleMode::DayOne,
        )
        .unwrap_err()
        .to_string()
        .contains("not found"));
    assert!(store
        .enroll_in_calendar(&version.id, NaiveDate::MAX, CalendarScheduleMode::DayOne,)
        .unwrap_err()
        .to_string()
        .contains("out of range"));
    assert_eq!(calendar_fingerprint(&path), before);
}

#[test]
fn calendar_completion_is_owned_immutable_and_durable() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let version = store
        .create_plan_definition(mcheyne_plan_definition())
        .unwrap();
    let first = store
        .enroll_in_calendar(&version.id, date(2026, 1, 1), CalendarScheduleMode::DayOne)
        .unwrap();
    let second = store
        .enroll_in_calendar(&version.id, date(2026, 2, 1), CalendarScheduleMode::DayOne)
        .unwrap();
    let assignment = store
        .calendar_plan_assignments(&first.id)
        .unwrap()
        .remove(0);
    let other = store
        .calendar_plan_assignments(&second.id)
        .unwrap()
        .remove(0);

    assert!(store
        .complete_calendar_assignment(&second.id, &assignment.id)
        .unwrap_err()
        .to_string()
        .contains("does not belong"));
    assert!(store
        .complete_calendar_assignment(&first.id, &other.id)
        .unwrap_err()
        .to_string()
        .contains("does not belong"));
    assert!(store
        .calendar_completion_history(&first.id)
        .unwrap()
        .is_empty());
    drop(store);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER inject_calendar_completion_failure BEFORE INSERT ON plan_calendar_completions
         BEGIN SELECT RAISE(ABORT,'injected calendar completion failure'); END;",
    )
    .unwrap();
    drop(conn);
    let mut store = JournalStore::open(&path).unwrap();
    assert!(store
        .complete_calendar_assignment(&first.id, &assignment.id)
        .unwrap_err()
        .to_string()
        .contains("injected calendar completion failure"));
    assert!(store
        .calendar_completion_history(&first.id)
        .unwrap()
        .is_empty());
    drop(store);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("DROP TRIGGER inject_calendar_completion_failure;")
        .unwrap();
    drop(conn);
    let mut store = JournalStore::open(&path).unwrap();
    let completion = store
        .complete_calendar_assignment(&first.id, &assignment.id)
        .unwrap();
    assert_eq!(completion.assignment_id, assignment.id);
    assert_eq!(completion.enrollment_id, first.id);
    assert!(store
        .complete_calendar_assignment(&first.id, &assignment.id)
        .is_err());
    assert_eq!(
        store.calendar_completion_history(&second.id).unwrap(),
        vec![]
    );
    drop(store);

    let reopened = JournalStore::open(&path).unwrap();
    assert_eq!(
        reopened.calendar_completion_history(&first.id).unwrap(),
        vec![completion.clone()]
    );
    drop(reopened);
    let conn = rusqlite::Connection::open(&path).unwrap();
    assert!(conn
        .execute(
            "UPDATE plan_calendar_completions SET completed_at=completed_at",
            []
        )
        .unwrap_err()
        .to_string()
        .contains("immutable"));
    assert!(conn
        .execute("DELETE FROM plan_calendar_completions", [])
        .unwrap_err()
        .to_string()
        .contains("retained"));
}

#[test]
fn simultaneous_stores_create_only_one_calendar_completion() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut setup = JournalStore::open(&path).unwrap();
    let version = setup
        .create_plan_definition(mcheyne_plan_definition())
        .unwrap();
    let enrollment = setup
        .enroll_in_calendar(&version.id, date(2026, 1, 1), CalendarScheduleMode::DayOne)
        .unwrap();
    let assignment = setup
        .calendar_plan_assignments(&enrollment.id)
        .unwrap()
        .remove(0);
    drop(setup);
    let mut first = JournalStore::open(&path).unwrap();
    let mut second = JournalStore::open(&path).unwrap();
    let completion = first
        .complete_calendar_assignment(&enrollment.id, &assignment.id)
        .unwrap();
    assert!(second
        .complete_calendar_assignment(&enrollment.id, &assignment.id)
        .is_err());
    assert_eq!(
        second.calendar_completion_history(&enrollment.id).unwrap(),
        vec![completion]
    );
}

#[test]
fn calendar_completion_undo_is_owned_durable_and_allows_recompletion() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let version = store
        .create_plan_definition(mcheyne_plan_definition())
        .unwrap();
    let first = store
        .enroll_in_calendar(&version.id, date(2026, 1, 1), CalendarScheduleMode::DayOne)
        .unwrap();
    let second = store
        .enroll_in_calendar(&version.id, date(2026, 2, 1), CalendarScheduleMode::DayOne)
        .unwrap();
    let assignment = store
        .calendar_plan_assignments(&first.id)
        .unwrap()
        .remove(0);
    let completion = store
        .complete_calendar_assignment(&first.id, &assignment.id)
        .unwrap();
    assert!(store
        .undo_calendar_completion(&second.id, &assignment.id, &completion.id)
        .is_err());
    drop(store);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TRIGGER inject_calendar_undo_failure BEFORE INSERT ON plan_calendar_completion_undos BEGIN SELECT RAISE(ABORT,'injected undo failure'); END;").unwrap();
    drop(conn);
    let mut store = JournalStore::open(&path).unwrap();
    assert!(store
        .undo_calendar_completion(&first.id, &assignment.id, &completion.id)
        .unwrap_err()
        .to_string()
        .contains("injected undo failure"));
    assert!(!store.calendar_completion_history(&first.id).unwrap()[0].undone);
    drop(store);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("DROP TRIGGER inject_calendar_undo_failure;")
        .unwrap();
    drop(conn);
    let mut store = JournalStore::open(&path).unwrap();
    store
        .undo_calendar_completion(&first.id, &assignment.id, &completion.id)
        .unwrap();
    assert!(store.calendar_completion_history(&first.id).unwrap()[0].undone);
    assert!(store
        .undo_calendar_completion(&first.id, &assignment.id, &completion.id)
        .is_err());
    let recompletion = store
        .complete_calendar_assignment(&first.id, &assignment.id)
        .unwrap();
    drop(store);
    let reopened = JournalStore::open(&path).unwrap();
    let history = reopened.calendar_completion_history(&first.id).unwrap();
    assert_eq!(history.len(), 2);
    assert!(history[0].undone);
    assert_eq!(history[1], recompletion);
    assert!(!history[1].undone);
}

#[test]
fn simultaneous_stores_accept_only_one_calendar_undo() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut setup = JournalStore::open(&path).unwrap();
    let version = setup
        .create_plan_definition(mcheyne_plan_definition())
        .unwrap();
    let enrollment = setup
        .enroll_in_calendar(&version.id, date(2026, 1, 1), CalendarScheduleMode::DayOne)
        .unwrap();
    let assignment = setup
        .calendar_plan_assignments(&enrollment.id)
        .unwrap()
        .remove(0);
    let completion = setup
        .complete_calendar_assignment(&enrollment.id, &assignment.id)
        .unwrap();
    drop(setup);
    let mut first = JournalStore::open(&path).unwrap();
    let mut second = JournalStore::open(&path).unwrap();
    first
        .undo_calendar_completion(&enrollment.id, &assignment.id, &completion.id)
        .unwrap();
    assert!(second
        .undo_calendar_completion(&enrollment.id, &assignment.id, &completion.id)
        .is_err());
    assert!(second.calendar_completion_history(&enrollment.id).unwrap()[0].undone);
}

#[test]
fn schema_eight_migration_preserves_populated_calendar_rows() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let version = store
        .create_plan_definition(mcheyne_plan_definition())
        .unwrap();
    let enrollment = store
        .enroll_in_calendar(
            &version.id,
            date(2026, 12, 31),
            CalendarScheduleMode::CalendarAligned,
        )
        .unwrap();
    let assignments = store.calendar_plan_assignments(&enrollment.id).unwrap();
    drop(store);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("DROP TRIGGER plan_calendar_completions_immutable; DROP TRIGGER plan_calendar_completions_retained; DROP TABLE plan_calendar_completions; DROP INDEX plan_calendar_assignment_owner; PRAGMA user_version=8;").unwrap();
    assert!(!schema_object_exists(&conn, "plan_calendar_completions"));
    assert!(!schema_object_exists(
        &conn,
        "plan_calendar_assignment_owner"
    ));
    drop(conn);
    let reopened = JournalStore::open(&path).unwrap();
    assert_eq!(
        reopened
            .get_calendar_plan_enrollment(&enrollment.id)
            .unwrap(),
        Some(enrollment.clone())
    );
    assert_eq!(
        reopened.calendar_plan_assignments(&enrollment.id).unwrap(),
        assignments
    );
    assert!(reopened
        .calendar_completion_history(&enrollment.id)
        .unwrap()
        .is_empty());
    drop(reopened);
    let conn = rusqlite::Connection::open(&path).unwrap();
    assert!(schema_object_exists(&conn, "plan_calendar_completions"));
    assert!(schema_object_exists(
        &conn,
        "plan_calendar_assignment_owner"
    ));
    assert_eq!(
        conn.pragma_query_value::<u32, _>(None, "user_version", |row| row.get(0))
            .unwrap(),
        10
    );
    assert_eq!(
        conn.query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap(),
        0
    );
}

#[test]
fn schema_nine_migration_preserves_completion_and_enables_undo() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let version = store
        .create_plan_definition(mcheyne_plan_definition())
        .unwrap();
    let enrollment = store
        .enroll_in_calendar(&version.id, date(2026, 1, 1), CalendarScheduleMode::DayOne)
        .unwrap();
    let assignment = store
        .calendar_plan_assignments(&enrollment.id)
        .unwrap()
        .remove(0);
    let completion = store
        .complete_calendar_assignment(&enrollment.id, &assignment.id)
        .unwrap();
    drop(store);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("DROP TRIGGER plan_calendar_completion_undos_immutable; DROP TRIGGER plan_calendar_completion_undos_retained; DROP TRIGGER plan_calendar_completion_active; DROP TABLE plan_calendar_completion_undos; CREATE UNIQUE INDEX v9_calendar_completion_assignment ON plan_calendar_completions(assignment_id); PRAGMA user_version=9;").unwrap();
    drop(conn);
    let mut reopened = JournalStore::open(&path).unwrap();
    assert_eq!(
        reopened
            .calendar_completion_history(&enrollment.id)
            .unwrap(),
        vec![completion.clone()]
    );
    reopened
        .undo_calendar_completion(&enrollment.id, &assignment.id, &completion.id)
        .unwrap();
    assert!(
        reopened
            .calendar_completion_history(&enrollment.id)
            .unwrap()[0]
            .undone
    );
}

#[test]
fn calendar_rows_are_immutable_retained_and_version_owned() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let version = store
        .create_plan_definition(mcheyne_plan_definition())
        .unwrap();
    let other = store
        .create_plan_definition(mcheyne_plan_definition())
        .unwrap();
    let enrollment = store
        .enroll_in_calendar(
            &version.id,
            date(2025, 12, 31),
            CalendarScheduleMode::CalendarAligned,
        )
        .unwrap();
    let assignment = store
        .calendar_plan_assignments(&enrollment.id)
        .unwrap()
        .remove(0);
    drop(store);

    let retained = calendar_fingerprint(&path);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    for (sql, expected) in [
        (
            "UPDATE plan_calendar_enrollments SET start_date=start_date",
            "Calendar enrollments are immutable",
        ),
        (
            "DELETE FROM plan_calendar_enrollments",
            "Plan progress is retained",
        ),
        (
            "UPDATE plan_calendar_assignments SET local_date=local_date",
            "Calendar assignments are immutable",
        ),
        (
            "DELETE FROM plan_calendar_assignments",
            "Plan progress is retained",
        ),
    ] {
        assert!(conn
            .execute(sql, [])
            .unwrap_err()
            .to_string()
            .contains(expected));
        assert_eq!(calendar_fingerprint(&path), retained);
    }
    let day_one_passages = definition_day(&version.definition, 1).passages.clone();
    for (id, definition_version_id, definition_day, passages) in [
        (
            "00000000-0000-4000-8000-000000000097",
            other.id.as_str(),
            365,
            assignment.passages.clone(),
        ),
        (
            "00000000-0000-4000-8000-000000000098",
            version.id.as_str(),
            1,
            assignment.passages.clone(),
        ),
        (
            "00000000-0000-4000-8000-000000000099",
            version.id.as_str(),
            365,
            day_one_passages,
        ),
    ] {
        let error = conn
            .execute(
                "INSERT INTO plan_calendar_assignments(id,enrollment_id,definition_version_id,definition_day,local_date,passages) VALUES(?1,?2,?3,?4,'2026-01-01',?5)",
                rusqlite::params![
                    id,
                    enrollment.id,
                    definition_version_id,
                    definition_day,
                    serde_json::to_string(&passages).unwrap(),
                ],
            )
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("Calendar assignment must belong to its enrollment version"));
        assert_eq!(calendar_fingerprint(&path), retained);
    }
    drop(conn);
    assert_eq!(calendar_fingerprint(&path), retained);
    assert_eq!(
        JournalStore::open(&path)
            .unwrap()
            .calendar_plan_assignments(&enrollment.id)
            .unwrap(),
        vec![assignment]
    );
}

#[test]
fn schema_seven_migration_preserves_populated_journal_plan_and_progress() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let published_target = store
        .save_entry(SaveRequest {
            entry_id: "00000000-0000-4000-8000-000000000010".into(),
            expected_revision_id: None,
            content: EntryContent {
                title: "Migration fixture".into(),
                body: "Synthetic content".into(),
                passages: vec![],
                tags: vec![],
                links: vec![],
            },
            finish: true,
        })
        .unwrap();
    let working_target = store
        .save_entry(SaveRequest {
            entry_id: published_target.id.clone(),
            expected_revision_id: Some(published_target.working_revision_id.clone()),
            content: EntryContent {
                title: "Migration fixture draft".into(),
                body: "Retained unfinished edit".into(),
                passages: vec![whole_chapter(43, 3)],
                tags: vec!["retained".into()],
                links: vec![],
            },
            finish: false,
        })
        .unwrap();
    store
        .save_entry(SaveRequest {
            entry_id: "00000000-0000-4000-8000-000000000011".into(),
            expected_revision_id: None,
            content: EntryContent {
                title: "Linked source".into(),
                body: "Retained link".into(),
                passages: vec![],
                tags: vec![],
                links: vec![working_target.id.clone()],
            },
            finish: true,
        })
        .unwrap();
    let version = store.create_plan_definition(stream_definition()).unwrap();
    let mut changed = stream_definition();
    changed.name = "Synthetic stream version two".into();
    let PlanSchedule::ChapterStreams { streams } = &mut changed.schedule else {
        unreachable!();
    };
    streams[0].chapters.push(ChapterRef {
        book: 1,
        chapter: 2,
    });
    let second_version = store
        .create_plan_definition_version(&version.plan_id, changed)
        .unwrap();
    let built_in = store.register_mcheyne_plan().unwrap();
    let enrollment = store
        .enroll_in_chapter_streams(
            &version.id,
            vec![StreamEnrollment {
                stream_id: "sample".into(),
                starting_position: 0,
                loop_after_end: false,
            }],
        )
        .unwrap();
    let assignment = store.active_plan_assignments(&enrollment.id).unwrap()[0].clone();
    let completion = store
        .complete_plan_stream(CompleteStreamRequest {
            enrollment_id: enrollment.id.clone(),
            stream_id: assignment.stream_id,
            expected_assignment_id: assignment.id,
            expected_progress_id: assignment.progress_id,
        })
        .unwrap();
    store.undo_plan_completion(&completion.id).unwrap();
    drop(store);

    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "DROP TRIGGER plan_calendar_completions_immutable;
         DROP TRIGGER plan_calendar_completions_retained;
         DROP TABLE plan_calendar_completions;
         DROP INDEX plan_calendar_assignment_owner;
         DROP TABLE plan_calendar_assignments;
         DROP TABLE plan_calendar_enrollments;
         PRAGMA user_version=7;",
    )
    .unwrap();
    assert!(!schema_object_exists(&conn, "plan_calendar_completions"));
    assert!(!schema_object_exists(
        &conn,
        "plan_calendar_assignment_owner"
    ));
    drop(conn);

    let retained = schema_seven_fingerprint(&path);
    let reopened = JournalStore::open(&path).unwrap();
    assert_eq!(schema_seven_fingerprint(&path), retained);
    assert_eq!(reopened.get_history(&working_target.id).unwrap().len(), 2);
    assert_eq!(
        reopened
            .list_plan_definition_versions(&version.plan_id)
            .unwrap(),
        vec![version, second_version]
    );
    drop(reopened);
    let migrated = rusqlite::Connection::open(&path).unwrap();
    assert!(schema_object_exists(&migrated, "plan_calendar_completions"));
    assert!(schema_object_exists(
        &migrated,
        "plan_calendar_assignment_owner"
    ));
    drop(migrated);
    assert_database_integrity(&path, 10);

    let mut reopened_again = JournalStore::open(&path).unwrap();
    assert_eq!(schema_seven_fingerprint(&path), retained);
    assert_database_integrity(&path, 10);
    let calendar = reopened_again
        .enroll_in_calendar(
            &built_in.id,
            date(2025, 12, 31),
            CalendarScheduleMode::CalendarAligned,
        )
        .unwrap();
    assert_eq!(
        reopened_again
            .calendar_plan_assignments(&calendar.id)
            .unwrap()
            .len(),
        1
    );
}

fn assert_database_integrity(path: &std::path::Path, version: u32) {
    let conn = rusqlite::Connection::open(path).unwrap();
    assert_eq!(
        conn.pragma_query_value::<u32, _>(None, "user_version", |row| row.get(0))
            .unwrap(),
        version
    );
    assert_eq!(
        conn.pragma_query_value::<String, _>(None, "quick_check", |row| row.get(0))
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

fn schema_seven_fingerprint(path: &std::path::Path) -> Vec<String> {
    let conn = rusqlite::Connection::open(path).unwrap();
    [
        "SELECT group_concat(id||':'||created_at||':'||updated_at||':'||working_revision_id||':'||COALESCE(published_revision_id,'null'),'|') FROM (SELECT * FROM entries ORDER BY id)",
        "SELECT group_concat(id||':'||entry_id||':'||COALESCE(parent_id,'null')||':'||COALESCE(restored_from_id,'null')||':'||created_at||':'||content,'|') FROM (SELECT * FROM revisions ORDER BY id)",
        "SELECT group_concat(sequence||':'||operation_id||':'||entry_id||':'||kind||':'||revision_id,'|') FROM (SELECT * FROM changes ORDER BY sequence)",
        "SELECT group_concat(id||':'||created_at,'|') FROM (SELECT * FROM plans ORDER BY id)",
        "SELECT group_concat(id||':'||plan_id||':'||version||':'||created_at||':'||definition,'|') FROM (SELECT * FROM plan_definition_versions ORDER BY plan_id,version)",
        "SELECT group_concat(built_in_id||':'||definition_version_id,'|') FROM (SELECT * FROM built_in_plan_registrations ORDER BY built_in_id)",
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

fn schema_object_exists(conn: &rusqlite::Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name=?1)",
        [name],
        |row| row.get(0),
    )
    .unwrap()
}

fn calendar_fingerprint(path: &std::path::Path) -> Vec<String> {
    let conn = rusqlite::Connection::open(path).unwrap();
    [
        "SELECT group_concat(id||':'||definition_version_id||':'||created_at,'|') FROM (SELECT * FROM plan_enrollments ORDER BY id)",
        "SELECT group_concat(enrollment_id||':'||start_date||':'||schedule_mode,'|') FROM (SELECT * FROM plan_calendar_enrollments ORDER BY enrollment_id)",
        "SELECT group_concat(id||':'||enrollment_id||':'||definition_version_id||':'||definition_day||':'||local_date||':'||passages,'|') FROM (SELECT * FROM plan_calendar_assignments ORDER BY id)",
    ]
    .into_iter()
    .map(|query| {
        conn.query_row(query, [], |row| row.get::<_, Option<String>>(0))
            .unwrap()
            .unwrap_or_default()
    })
    .collect()
}

fn stream_definition() -> PlanDefinition {
    PlanDefinition {
        schema_version: 1,
        name: "Synthetic stream".into(),
        description: None,
        schedule: PlanSchedule::ChapterStreams {
            streams: vec![ChapterStream {
                id: "sample".into(),
                name: "Sample".into(),
                chapters: vec![journal_core::ChapterRef {
                    book: 1,
                    chapter: 1,
                }],
            }],
        },
    }
}

fn whole_chapter(book: u32, chapter: u32) -> Passage {
    Passage {
        book,
        chapter,
        start_verse: None,
        end_verse: None,
    }
}

fn definition_day(definition: &PlanDefinition, day: u32) -> &ExplicitScheduleDay {
    let PlanSchedule::ExplicitSchedule { days } = &definition.schedule else {
        panic!("expected explicit schedule");
    };
    &days[(day - 1) as usize]
}

fn retained(definition: PlanDefinition) -> PlanDefinitionVersion {
    PlanDefinitionVersion {
        id: "00000000-0000-4000-8000-000000000001".into(),
        plan_id: "00000000-0000-4000-8000-000000000002".into(),
        version: 1,
        created_at: "2025-01-01T00:00:00Z".into(),
        definition,
    }
}

fn date(year: i32, month: u32, day: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(year, month, day).unwrap()
}
