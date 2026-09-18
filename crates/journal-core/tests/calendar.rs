use chrono::NaiveDate;
use journal_core::{
    expand_calendar_assignments, four_stream_plan_definition, mcheyne_plan_definition,
    CalendarScheduleMode, ChapterStream, EntryContent, ExplicitScheduleDay, JournalStore, Passage,
    PlanDefinition, PlanDefinitionVersion, PlanSchedule, SaveRequest, StreamEnrollment,
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
    let error = conn
        .execute(
            "INSERT INTO plan_calendar_assignments(id,enrollment_id,definition_version_id,definition_day,local_date,passages) VALUES(?1,?2,?3,366,'2026-01-01',?4)",
            rusqlite::params![
                "00000000-0000-4000-8000-000000000099",
                enrollment.id,
                other.id,
                serde_json::to_string(&assignment.passages).unwrap(),
            ],
        )
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("Calendar assignment must belong to its enrollment version"));
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
    let entry = store
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
    let version = store.create_plan_definition(stream_definition()).unwrap();
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
    let assignments = store.active_plan_assignments(&enrollment.id).unwrap();
    drop(store);

    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "DROP TABLE plan_calendar_assignments;
         DROP TABLE plan_calendar_enrollments;
         PRAGMA user_version=7;",
    )
    .unwrap();
    drop(conn);

    let reopened = JournalStore::open(&path).unwrap();
    assert_eq!(reopened.list_entries().unwrap()[0].id, entry.id);
    assert_eq!(
        reopened
            .list_plan_definition_versions(&version.plan_id)
            .unwrap(),
        vec![version]
    );
    assert_eq!(
        reopened.active_plan_assignments(&enrollment.id).unwrap(),
        assignments
    );
    assert!(reopened
        .calendar_plan_assignments(&enrollment.id)
        .unwrap()
        .is_empty());
    assert_eq!(
        rusqlite::Connection::open(path)
            .unwrap()
            .pragma_query_value::<u32, _>(None, "user_version", |row| row.get(0))
            .unwrap(),
        8
    );
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
