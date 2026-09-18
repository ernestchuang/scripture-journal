use chrono::NaiveDate;
use journal_core::{
    expand_calendar_assignments, four_stream_plan_definition, mcheyne_plan_definition,
    AdoptCalendarPlanRequest, AdoptStreamPlanRequest, CalendarScheduleMode, ChapterRef,
    ChapterStream, CompleteStreamRequest, EntryContent, ExplicitScheduleDay, JournalStore, Passage,
    PlanDefinition, PlanDefinitionVersion, PlanSchedule, SaveRequest, StreamAdoptionBoundary,
    StreamEnrollment,
};

#[test]
fn stream_adoption_changes_only_new_successors_and_reuses_retained_history() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("adopt-stream.db");
    let mut store = JournalStore::open(&path).unwrap();
    let definition = |chapters: &[u32]| PlanDefinition {
        schema_version: 1,
        name: "Adoption stream".into(),
        description: None,
        schedule: PlanSchedule::ChapterStreams {
            streams: vec![ChapterStream {
                id: "sample".into(),
                name: "Sample".into(),
                chapters: chapters
                    .iter()
                    .map(|chapter| ChapterRef {
                        book: 43,
                        chapter: *chapter,
                    })
                    .collect(),
            }],
        },
    };
    let first = store
        .create_plan_definition(definition(&[1, 2, 3]))
        .unwrap();
    let enrollment = store
        .enroll_in_chapter_streams(
            &first.id,
            vec![StreamEnrollment {
                stream_id: "sample".into(),
                starting_position: 0,
                loop_after_end: false,
            }],
        )
        .unwrap();
    let john1 = store
        .active_plan_assignments(&enrollment.id)
        .unwrap()
        .remove(0);
    let completed1 = store
        .complete_plan_stream(CompleteStreamRequest {
            enrollment_id: enrollment.id.clone(),
            stream_id: "sample".into(),
            expected_assignment_id: john1.id.clone(),
            expected_progress_id: john1.progress_id,
        })
        .unwrap();
    let john2 = store
        .active_plan_assignments(&enrollment.id)
        .unwrap()
        .remove(0);
    let second = store
        .create_plan_definition_version(&first.plan_id, definition(&[9, 2, 4]))
        .unwrap();
    let event = store
        .adopt_chapter_stream_plan(AdoptStreamPlanRequest {
            enrollment_id: enrollment.id.clone(),
            expected_definition_version_id: first.id.clone(),
            target_definition_version_id: second.id.clone(),
            streams: vec![StreamAdoptionBoundary {
                stream_id: "sample".into(),
                assignment_id: john2.id.clone(),
                progress_id: john2.progress_id.clone(),
            }],
        })
        .unwrap();
    store.undo_plan_completion(&completed1.id).unwrap();
    let replay1 = store
        .active_plan_assignments(&enrollment.id)
        .unwrap()
        .remove(0);
    store
        .complete_plan_stream(CompleteStreamRequest {
            enrollment_id: enrollment.id.clone(),
            stream_id: "sample".into(),
            expected_assignment_id: replay1.id,
            expected_progress_id: replay1.progress_id,
        })
        .unwrap();
    assert_eq!(
        store.active_plan_assignments(&enrollment.id).unwrap()[0].id,
        john2.id
    );
    store
        .complete_plan_stream(CompleteStreamRequest {
            enrollment_id: enrollment.id.clone(),
            stream_id: "sample".into(),
            expected_assignment_id: john2.id,
            expected_progress_id: store.active_plan_assignments(&enrollment.id).unwrap()[0]
                .progress_id
                .clone(),
        })
        .unwrap();
    let john4 = store
        .active_plan_assignments(&enrollment.id)
        .unwrap()
        .remove(0);
    assert_eq!(
        (
            john4.passage.chapter,
            john4.definition_version_id,
            john4.generation_id
        ),
        (4, second.id, event.id)
    );
    drop(store);
    let reopened = JournalStore::open(&path).unwrap();
    assert_eq!(
        reopened
            .plan_adoption_history(&enrollment.id)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        reopened.active_plan_assignments(&enrollment.id).unwrap()[0].id,
        john4.id
    );
}

#[test]
fn calendar_adoption_replaces_only_future_generation_and_rejects_stale_rows() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("adopt-calendar.db");
    let mut store = JournalStore::open(&path).unwrap();
    let explicit = |chapters: &[u32]| PlanDefinition {
        schema_version: 1,
        name: "Short calendar".into(),
        description: None,
        schedule: PlanSchedule::ExplicitSchedule {
            days: chapters
                .iter()
                .enumerate()
                .map(|(index, chapter)| ExplicitScheduleDay {
                    day: index as u32 + 1,
                    passages: vec![whole_chapter(43, *chapter)],
                })
                .collect(),
        },
    };
    let first = store.create_plan_definition(explicit(&[1, 2, 3])).unwrap();
    let enrollment = store
        .enroll_in_calendar(&first.id, date(2026, 1, 1), CalendarScheduleMode::DayOne)
        .unwrap();
    let before = store.calendar_plan_assignments(&enrollment.id).unwrap();
    let target = store
        .create_plan_definition_version(&first.plan_id, explicit(&[1, 8, 9]))
        .unwrap();
    store
        .adopt_calendar_plan(AdoptCalendarPlanRequest {
            enrollment_id: enrollment.id.clone(),
            expected_definition_version_id: first.id,
            target_definition_version_id: target.id.clone(),
            effective_from_local_date: date(2026, 1, 2),
            expected_assignment_id: before[1].id.clone(),
        })
        .unwrap();
    let after = store.calendar_plan_assignments(&enrollment.id).unwrap();
    assert_eq!(after[0], before[0]);
    assert_ne!(after[1].id, before[1].id);
    assert_eq!(
        (after[1].passages[0].chapter, after[2].passages[0].chapter),
        (8, 9)
    );
    assert!(store
        .complete_calendar_assignment(&enrollment.id, &before[1].id)
        .unwrap_err()
        .to_string()
        .contains("superseded"));
    let completion = store
        .complete_calendar_assignment(&enrollment.id, &after[1].id)
        .unwrap();
    drop(store);
    let reopened = JournalStore::open(&path).unwrap();
    assert_eq!(
        reopened
            .calendar_completion_history(&enrollment.id)
            .unwrap()[0]
            .id,
        completion.id
    );
    assert_eq!(
        reopened.calendar_plan_assignments(&enrollment.id).unwrap(),
        after
    );
}

#[test]
fn stream_adoption_rejects_an_exhausted_enrolled_stream_without_writes() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("adopt-exhausted.db");
    let mut store = JournalStore::open(&path).unwrap();
    let original = PlanDefinition {
        schema_version: 1,
        name: "Two streams".into(),
        description: None,
        schedule: PlanSchedule::ChapterStreams {
            streams: vec![
                ChapterStream {
                    id: "a".into(),
                    name: "A".into(),
                    chapters: vec![
                        ChapterRef {
                            book: 43,
                            chapter: 1,
                        },
                        ChapterRef {
                            book: 43,
                            chapter: 2,
                        },
                    ],
                },
                ChapterStream {
                    id: "b".into(),
                    name: "B".into(),
                    chapters: vec![ChapterRef {
                        book: 19,
                        chapter: 1,
                    }],
                },
            ],
        },
    };
    let first = store.create_plan_definition(original).unwrap();
    let enrollment = store
        .enroll_in_chapter_streams(
            &first.id,
            vec![
                StreamEnrollment {
                    stream_id: "a".into(),
                    starting_position: 0,
                    loop_after_end: false,
                },
                StreamEnrollment {
                    stream_id: "b".into(),
                    starting_position: 0,
                    loop_after_end: false,
                },
            ],
        )
        .unwrap();
    let assignments = store.active_plan_assignments(&enrollment.id).unwrap();
    let b = assignments
        .iter()
        .find(|item| item.stream_id == "b")
        .unwrap();
    store
        .complete_plan_stream(CompleteStreamRequest {
            enrollment_id: enrollment.id.clone(),
            stream_id: "b".into(),
            expected_assignment_id: b.id.clone(),
            expected_progress_id: b.progress_id.clone(),
        })
        .unwrap();
    let a = store
        .active_plan_assignments(&enrollment.id)
        .unwrap()
        .remove(0);
    let target = PlanDefinition {
        schema_version: 1,
        name: "Missing B".into(),
        description: None,
        schedule: PlanSchedule::ChapterStreams {
            streams: vec![ChapterStream {
                id: "a".into(),
                name: "A".into(),
                chapters: vec![
                    ChapterRef {
                        book: 43,
                        chapter: 1,
                    },
                    ChapterRef {
                        book: 43,
                        chapter: 3,
                    },
                ],
            }],
        },
    };
    let target = store
        .create_plan_definition_version(&first.plan_id, target)
        .unwrap();
    let error = store
        .adopt_chapter_stream_plan(AdoptStreamPlanRequest {
            enrollment_id: enrollment.id.clone(),
            expected_definition_version_id: first.id,
            target_definition_version_id: target.id,
            streams: vec![StreamAdoptionBoundary {
                stream_id: "a".into(),
                assignment_id: a.id,
                progress_id: a.progress_id,
            }],
        })
        .unwrap_err();
    assert!(error.to_string().contains("stream set") || error.to_string().contains("exhausted"));
    assert!(store
        .plan_adoption_history(&enrollment.id)
        .unwrap()
        .is_empty());
    assert_eq!(
        store.active_plan_assignments(&enrollment.id).unwrap().len(),
        1
    );
}
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
    let first_assignments = store.calendar_plan_assignments(&first.id).unwrap();
    let assignment = first_assignments[0].clone();
    let wrong_same_enrollment = first_assignments[1].clone();
    let other_assignment = store.calendar_plan_assignments(&second.id).unwrap()[0].clone();
    let completion = store
        .complete_calendar_assignment(&first.id, &assignment.id)
        .unwrap();
    assert!(store
        .undo_calendar_completion(&second.id, &assignment.id, &completion.id)
        .is_err());
    drop(store);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    for (id, enrollment_id, assignment_id) in [
        (
            "00000000-0000-4000-8000-000000000091",
            second.id.as_str(),
            other_assignment.id.as_str(),
        ),
        (
            "00000000-0000-4000-8000-000000000092",
            first.id.as_str(),
            wrong_same_enrollment.id.as_str(),
        ),
    ] {
        assert!(conn.execute(
            "INSERT INTO plan_calendar_completion_undos(id,completion_id,enrollment_id,assignment_id,undone_at) VALUES(?1,?2,?3,?4,'2026-01-01T00:00:00Z')",
            rusqlite::params![id, completion.id, enrollment_id, assignment_id],
        ).unwrap_err().to_string().contains("Calendar undo must match completion ownership"));
    }
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM plan_calendar_completion_undos",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
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
    drop(reopened);
    let conn = rusqlite::Connection::open(&path).unwrap();
    assert!(conn
        .execute(
            "UPDATE plan_calendar_completion_undos SET undone_at=undone_at",
            []
        )
        .unwrap_err()
        .to_string()
        .contains("immutable"));
    assert!(conn
        .execute("DELETE FROM plan_calendar_completion_undos", [])
        .unwrap_err()
        .to_string()
        .contains("retained"));
    drop(conn);
    assert_eq!(
        JournalStore::open(&path)
            .unwrap()
            .calendar_completion_history(&first.id)
            .unwrap(),
        history
    );
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
fn schema_ten_migration_refuses_cross_owned_retained_undo() {
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
    let first_assignment = store.calendar_plan_assignments(&first.id).unwrap()[0].clone();
    let second_assignment = store.calendar_plan_assignments(&second.id).unwrap()[0].clone();
    let completion = store
        .complete_calendar_assignment(&first.id, &first_assignment.id)
        .unwrap();
    drop(store);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "DROP TRIGGER plan_calendar_completion_undos_match; PRAGMA user_version=10;",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO plan_calendar_completion_undos(id,completion_id,enrollment_id,assignment_id,undone_at) VALUES('00000000-0000-4000-8000-000000000093',?1,?2,?3,'2026-01-01T00:00:00Z')",
        rusqlite::params![completion.id, second.id, second_assignment.id],
    ).unwrap();
    drop(conn);
    assert!(JournalStore::open(&path)
        .err()
        .unwrap()
        .to_string()
        .contains("ownership mismatch"));
}

#[test]
fn schema_ten_migration_serializes_with_cross_owned_writer() {
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
    let first_assignment = store.calendar_plan_assignments(&first.id).unwrap()[0].clone();
    let second_assignment = store.calendar_plan_assignments(&second.id).unwrap()[0].clone();
    let completion = store
        .complete_calendar_assignment(&first.id, &first_assignment.id)
        .unwrap();
    drop(store);
    let writer = rusqlite::Connection::open(&path).unwrap();
    writer.execute_batch("DROP TRIGGER plan_calendar_completion_undos_match; PRAGMA user_version=10; BEGIN IMMEDIATE;").unwrap();
    let open_path = path.clone();
    let opener = std::thread::spawn(move || {
        JournalStore::open(&open_path)
            .err()
            .map(|error| error.to_string())
    });
    std::thread::sleep(std::time::Duration::from_millis(200));
    writer.execute(
        "INSERT INTO plan_calendar_completion_undos(id,completion_id,enrollment_id,assignment_id,undone_at) VALUES('00000000-0000-4000-8000-000000000094',?1,?2,?3,'2026-01-01T00:00:00Z')",
        rusqlite::params![completion.id, second.id, second_assignment.id],
    ).unwrap();
    writer.execute_batch("COMMIT;").unwrap();
    assert!(opener
        .join()
        .unwrap()
        .unwrap()
        .contains("ownership mismatch"));
    let conn = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        conn.pragma_query_value::<u32, _>(None, "user_version", |row| row.get(0))
            .unwrap(),
        10
    );
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM plan_calendar_completion_undos",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}

#[test]
fn schema_ten_migration_preserves_valid_populated_undo_history() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("j.db");
    let mut store = JournalStore::open(&path).unwrap();
    let version = store
        .create_plan_definition(mcheyne_plan_definition())
        .unwrap();
    let enrollment = store
        .enroll_in_calendar(&version.id, date(2026, 1, 1), CalendarScheduleMode::DayOne)
        .unwrap();
    let assignment = store.calendar_plan_assignments(&enrollment.id).unwrap()[0].clone();
    let completion = store
        .complete_calendar_assignment(&enrollment.id, &assignment.id)
        .unwrap();
    store
        .undo_calendar_completion(&enrollment.id, &assignment.id, &completion.id)
        .unwrap();
    let retained = store.calendar_completion_history(&enrollment.id).unwrap();
    drop(store);
    downgrade_stream_provenance_to_v11(&path);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "DROP TRIGGER plan_calendar_completion_undos_match; PRAGMA user_version=10;",
    )
    .unwrap();
    drop(conn);
    let reopened = JournalStore::open(&path).unwrap();
    assert_eq!(
        reopened
            .calendar_completion_history(&enrollment.id)
            .unwrap(),
        retained
    );
    drop(reopened);
    let reopened_again = JournalStore::open(&path).unwrap();
    assert_eq!(
        reopened_again
            .calendar_completion_history(&enrollment.id)
            .unwrap(),
        retained
    );
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
    downgrade_stream_provenance_to_v11(&path);
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
        13
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
    downgrade_stream_provenance_to_v11(&path);
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

    downgrade_stream_provenance_to_v11(&path);
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
    assert_database_integrity(&path, 13);

    let mut reopened_again = JournalStore::open(&path).unwrap();
    assert_eq!(schema_seven_fingerprint(&path), retained);
    assert_database_integrity(&path, 13);
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

fn downgrade_stream_provenance_to_v11(path: &std::path::Path) {
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
    conn.execute_batch(
        "DROP TRIGGER plan_calendar_assignment_supersessions_immutable;
         DROP TRIGGER plan_calendar_assignment_supersessions_retained;
         DROP TRIGGER plan_calendar_assignment_generations_immutable;
         DROP TRIGGER plan_calendar_assignment_generations_retained;
         DROP TRIGGER plan_calendar_assignments_match;
         DROP TRIGGER plan_adoption_events_immutable;
         DROP TRIGGER plan_adoption_events_retained;
         DROP TRIGGER plan_stream_adoption_boundaries_immutable;
         DROP TRIGGER plan_stream_adoption_boundaries_retained;
         DROP TABLE plan_calendar_assignment_supersessions;
         DROP TABLE plan_calendar_assignment_generations;
         DROP TABLE plan_stream_adoption_boundaries;
         DROP TABLE plan_adoption_events;
         DROP TRIGGER plan_assignment_successors_ordered;
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
