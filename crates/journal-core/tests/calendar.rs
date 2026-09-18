use chrono::NaiveDate;
use journal_core::{
    expand_calendar_assignments, four_stream_plan_definition, mcheyne_plan_definition,
    CalendarScheduleMode, ExplicitScheduleDay, Passage, PlanDefinition, PlanDefinitionVersion,
    PlanSchedule,
};

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
