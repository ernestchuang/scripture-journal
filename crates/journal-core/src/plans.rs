use crate::{validate_passage, Passage, CHAPTERS};
use anyhow::{ensure, Context, Result};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use uuid::Uuid;

const DEFINITION_SCHEMA_VERSION: u32 = 1;

/// The built-in completion-driven plan: one independently advancing chapter
/// stream from each canonical category. This is definition data only; callers
/// persist and enroll it like any other immutable plan definition.
pub fn four_stream_plan_definition() -> PlanDefinition {
    PlanDefinition {
        schema_version: DEFINITION_SCHEMA_VERSION,
        name: "Four streams: one chapter each".into(),
        description: Some(
            "One chapter from each of the Old Testament, New Testament, Psalms, and Proverbs."
                .into(),
        ),
        schedule: PlanSchedule::ChapterStreams {
            streams: vec![
                ChapterStream {
                    id: "old-testament".into(),
                    name: "Old Testament".into(),
                    chapters: canonical_chapters(1..=39, |book| book != 19 && book != 20),
                },
                ChapterStream {
                    id: "new-testament".into(),
                    name: "New Testament".into(),
                    chapters: canonical_chapters(40..=66, |_| true),
                },
                ChapterStream {
                    id: "psalms".into(),
                    name: "Psalms".into(),
                    chapters: canonical_chapters(19..=19, |_| true),
                },
                ChapterStream {
                    id: "proverbs".into(),
                    name: "Proverbs".into(),
                    chapters: canonical_chapters(20..=20, |_| true),
                },
            ],
        },
    }
}

fn canonical_chapters(
    books: std::ops::RangeInclusive<u32>,
    include: impl Fn(u32) -> bool,
) -> Vec<ChapterRef> {
    books
        .filter(|book| include(*book))
        .flat_map(|book| {
            (1..=CHAPTERS[(book - 1) as usize]).map(move |chapter| ChapterRef { book, chapter })
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChapterRef {
    pub book: u32,
    pub chapter: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExplicitScheduleDay {
    pub day: u32,
    pub passages: Vec<Passage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChapterStream {
    pub id: String,
    pub name: String,
    pub chapters: Vec<ChapterRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum PlanSchedule {
    ExplicitSchedule { days: Vec<ExplicitScheduleDay> },
    ChapterStreams { streams: Vec<ChapterStream> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanDefinition {
    pub schema_version: u32,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub schedule: PlanSchedule,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanDefinitionVersion {
    pub id: String,
    pub plan_id: String,
    pub version: u32,
    pub created_at: String,
    pub definition: PlanDefinition,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamEnrollment {
    pub stream_id: String,
    pub starting_position: u32,
    pub loop_after_end: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanEnrollment {
    pub id: String,
    pub definition_version_id: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanAssignment {
    pub id: String,
    pub enrollment_id: String,
    pub stream_id: String,
    pub ordinal: u32,
    pub cycle: u32,
    pub passage: Passage,
    pub stream_position: Option<u32>,
    pub progress_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompleteStreamRequest {
    pub enrollment_id: String,
    pub stream_id: String,
    pub expected_assignment_id: String,
    pub expected_progress_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanCompletion {
    pub id: String,
    pub assignment_id: String,
    pub completed_at: String,
}

pub(crate) fn enroll(
    conn: &mut Connection,
    version_id: &str,
    selections: Vec<StreamEnrollment>,
) -> Result<PlanEnrollment> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let version =
        definition_version(&tx, version_id)?.context("Plan definition version not found")?;
    let PlanSchedule::ChapterStreams { streams } = &version.definition.schedule else {
        anyhow::bail!("Only chapter-stream definitions can use stream enrollment");
    };
    ensure!(
        selections.len() == streams.len(),
        "Select one starting chapter for every stream"
    );
    let mut selected_ids = HashSet::new();
    for selection in &selections {
        ensure!(
            selected_ids.insert(&selection.stream_id),
            "Stream selections must be unique"
        );
        let stream = streams
            .iter()
            .find(|stream| stream.id == selection.stream_id)
            .context("Selected stream is not in this definition")?;
        ensure!(
            (selection.starting_position as usize) < stream.chapters.len(),
            "Starting position is not in the selected stream"
        );
    }
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    tx.execute(
        "INSERT INTO plan_enrollments(id,definition_version_id,created_at) VALUES(?1,?2,?3)",
        params![id, version_id, now],
    )?;
    for selection in selections {
        let stream = streams
            .iter()
            .find(|stream| stream.id == selection.stream_id)
            .unwrap();
        tx.execute("INSERT INTO plan_enrollment_streams(enrollment_id,stream_id,loop_after_end) VALUES(?1,?2,?3)", params![id, selection.stream_id, selection.loop_after_end])?;
        let assignment_id = insert_assignment(&tx, &id, stream, 1, 1, selection.starting_position)?;
        insert_progress_epoch(&tx, &id, &stream.id, &assignment_id)?;
    }
    let result = PlanEnrollment {
        id,
        definition_version_id: version_id.to_owned(),
        created_at: now,
    };
    tx.commit()?;
    Ok(result)
}

pub(crate) fn active_assignments(
    conn: &Connection,
    enrollment_id: &str,
) -> Result<Vec<PlanAssignment>> {
    let mut statement = conn.prepare(
        "SELECT a.id,a.enrollment_id,a.stream_id,a.ordinal,a.cycle,a.passage,e.id,a.stream_position
         FROM plan_stream_progress_epochs e JOIN plan_assignments a ON a.id=e.assignment_id
         WHERE a.enrollment_id=?1
         AND e.sequence=(SELECT MAX(e2.sequence) FROM plan_stream_progress_epochs e2 WHERE e2.enrollment_id=e.enrollment_id AND e2.stream_id=e.stream_id)
         AND NOT EXISTS (
           SELECT 1 FROM reading_completions c WHERE c.assignment_id=a.id
           AND NOT EXISTS (SELECT 1 FROM reading_completion_undos u WHERE u.completion_id=c.id)
         )
         ORDER BY a.stream_id")?;
    let assignments = statement
        .query_map([enrollment_id], assignment_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(assignments)
}

pub(crate) fn complete_stream(
    conn: &mut Connection,
    request: CompleteStreamRequest,
) -> Result<PlanCompletion> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let active = active_assignments(&tx, &request.enrollment_id)?
        .into_iter()
        .find(|assignment| assignment.stream_id == request.stream_id)
        .context("No active assignment for this stream")?;
    ensure!(
        active.id == request.expected_assignment_id
            && active.progress_id == request.expected_progress_id,
        "Conflict: assignment changed since it was loaded; reload before completing"
    );
    let completion = PlanCompletion {
        id: Uuid::new_v4().to_string(),
        assignment_id: active.id.clone(),
        completed_at: Utc::now().to_rfc3339(),
    };
    tx.execute(
        "INSERT INTO reading_completions(id,assignment_id,completed_at) VALUES(?1,?2,?3)",
        params![
            completion.id,
            completion.assignment_id,
            completion.completed_at
        ],
    )?;
    let (definition_text, loop_after_end): (String, bool) = tx.query_row(
        "SELECT v.definition,s.loop_after_end FROM plan_enrollments e JOIN plan_definition_versions v ON v.id=e.definition_version_id JOIN plan_enrollment_streams s ON s.enrollment_id=e.id AND s.stream_id=?2 WHERE e.id=?1",
        params![request.enrollment_id, request.stream_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
    let definition: PlanDefinition = serde_json::from_str(&definition_text)?;
    let PlanSchedule::ChapterStreams { streams } = definition.schedule else {
        anyhow::bail!("Enrollment no longer references a chapter-stream definition")
    };
    let stream = streams
        .into_iter()
        .find(|stream| stream.id == request.stream_id)
        .context("Enrolled stream missing from definition")?;
    let current = active
        .stream_position
        .context("Legacy assignment has ambiguous occurrence identity; start a new enrollment")?
        as usize;
    ensure!(
        stream.chapters.get(current).is_some_and(|chapter| {
            chapter.book == active.passage.book && chapter.chapter == active.passage.chapter
        }),
        "Assignment occurrence does not match its retained passage snapshot"
    );
    if current + 1 < stream.chapters.len() {
        let next_id = insert_assignment(
            &tx,
            &request.enrollment_id,
            &stream,
            active.ordinal + 1,
            active.cycle,
            (current + 1) as u32,
        )?;
        insert_progress_epoch(&tx, &request.enrollment_id, &stream.id, &next_id)?;
    } else if loop_after_end {
        let next_id = insert_assignment(
            &tx,
            &request.enrollment_id,
            &stream,
            active.ordinal + 1,
            active.cycle + 1,
            0,
        )?;
        insert_progress_epoch(&tx, &request.enrollment_id, &stream.id, &next_id)?;
    }
    tx.commit()?;
    Ok(completion)
}

pub(crate) fn undo_completion(conn: &mut Connection, completion_id: &str) -> Result<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let (enrollment_id, stream_id, ordinal): (String, String, u32) = tx.query_row(
        "SELECT a.enrollment_id,a.stream_id,a.ordinal FROM reading_completions c JOIN plan_assignments a ON a.id=c.assignment_id WHERE c.id=?1 AND NOT EXISTS (SELECT 1 FROM reading_completion_undos u WHERE u.completion_id=c.id)",
        [completion_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional()?.context("Completion is missing or already undone")?;
    let later: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM reading_completions c JOIN plan_assignments a ON a.id=c.assignment_id WHERE a.enrollment_id=?1 AND a.stream_id=?2 AND a.ordinal>?3 AND NOT EXISTS (SELECT 1 FROM reading_completion_undos u WHERE u.completion_id=c.id))",
        params![enrollment_id, stream_id, ordinal], |row| row.get(0))?;
    ensure!(!later, "Undo later active completions in this stream first");
    tx.execute(
        "INSERT INTO reading_completion_undos(id,completion_id,undone_at) VALUES(?1,?2,?3)",
        params![
            Uuid::new_v4().to_string(),
            completion_id,
            Utc::now().to_rfc3339()
        ],
    )?;
    let assignment_id: String = tx.query_row(
        "SELECT assignment_id FROM reading_completions WHERE id=?1",
        [completion_id],
        |row| row.get(0),
    )?;
    insert_progress_epoch(&tx, &enrollment_id, &stream_id, &assignment_id)?;
    tx.commit()?;
    Ok(())
}

fn insert_assignment(
    conn: &Connection,
    enrollment_id: &str,
    stream: &ChapterStream,
    ordinal: u32,
    cycle: u32,
    position: u32,
) -> Result<String> {
    let chapter = &stream.chapters[position as usize];
    let passage = Passage {
        book: chapter.book,
        chapter: chapter.chapter,
        start_verse: None,
        end_verse: None,
    };
    let content = serde_json::to_string(&passage)?;
    let existing: Option<(String, u32, String, Option<u32>)> = conn
        .query_row(
            "SELECT id,cycle,passage,stream_position FROM plan_assignments WHERE enrollment_id=?1 AND stream_id=?2 AND ordinal=?3",
            params![enrollment_id, stream.id, ordinal],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    if let Some((id, existing_cycle, existing_content, existing_position)) = existing {
        ensure!(
            existing_cycle == cycle
                && existing_content == content
                && existing_position == Some(position),
            "Existing assignment conflicts with pinned plan progress"
        );
        Ok(id)
    } else {
        let id = Uuid::new_v4().to_string();
        conn.execute("INSERT INTO plan_assignments(id,enrollment_id,stream_id,ordinal,cycle,passage,stream_position) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![id, enrollment_id, stream.id, ordinal, cycle, content, position])?;
        Ok(id)
    }
}

fn insert_progress_epoch(
    conn: &Connection,
    enrollment_id: &str,
    stream_id: &str,
    assignment_id: &str,
) -> Result<String> {
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO plan_stream_progress_epochs(id,enrollment_id,stream_id,sequence,assignment_id,created_at)
         VALUES(?1,?2,?3,(SELECT COALESCE(MAX(sequence),0)+1 FROM plan_stream_progress_epochs WHERE enrollment_id=?2 AND stream_id=?3),?4,?5)",
        params![id, enrollment_id, stream_id, assignment_id, Utc::now().to_rfc3339()],
    )?;
    Ok(id)
}

fn assignment_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PlanAssignment> {
    let text: String = row.get(5)?;
    let passage = serde_json::from_str(&text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(PlanAssignment {
        id: row.get(0)?,
        enrollment_id: row.get(1)?,
        stream_id: row.get(2)?,
        ordinal: row.get(3)?,
        cycle: row.get(4)?,
        passage,
        progress_id: row.get(6)?,
        stream_position: row.get(7)?,
    })
}

pub(crate) fn migrate_assignment_positions(conn: &Connection) -> Result<()> {
    let streams = {
        let mut statement = conn.prepare(
            "SELECT s.enrollment_id,s.stream_id,s.loop_after_end,v.definition
             FROM plan_enrollment_streams s
             JOIN plan_enrollments e ON e.id=s.enrollment_id
             JOIN plan_definition_versions v ON v.id=e.definition_version_id",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for (enrollment_id, stream_id, loop_after_end, definition_text) in streams {
        let definition: PlanDefinition = serde_json::from_str(&definition_text)?;
        let PlanSchedule::ChapterStreams { streams } = definition.schedule else {
            continue;
        };
        let stream = streams
            .into_iter()
            .find(|candidate| candidate.id == stream_id)
            .context("Enrolled stream missing from retained definition")?;
        let assignments = {
            let mut statement = conn.prepare(
                "SELECT id,ordinal,cycle,passage,stream_position FROM plan_assignments
                 WHERE enrollment_id=?1 AND stream_id=?2 ORDER BY ordinal",
            )?;
            let rows = statement
                .query_map(params![enrollment_id, stream_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, u32>(1)?,
                        row.get::<_, u32>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<u32>>(4)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        let Some((_, _, _, first_text, first_position)) = assignments.first() else {
            continue;
        };
        let first: Passage = serde_json::from_str(first_text)?;
        let start = first_position
            .and_then(|position| {
                stream
                    .chapters
                    .get(position as usize)
                    .map(|_| position as usize)
            })
            .or_else(|| {
                stream.chapters.iter().position(|chapter| {
                    chapter.book == first.book && chapter.chapter == first.chapter
                })
            });
        let mut coherent = start.is_some();
        let start = start.unwrap_or(0);
        let mut previous_ordinal = 0;
        for (id, ordinal, cycle, passage_text, existing_position) in assignments {
            let offset = start + (ordinal - 1) as usize;
            let position = offset % stream.chapters.len();
            let expected_cycle = 1 + (offset / stream.chapters.len()) as u32;
            let passage: Passage = serde_json::from_str(&passage_text)?;
            let chapter = &stream.chapters[position];
            coherent = coherent
                && ordinal == previous_ordinal + 1
                && (loop_after_end || offset < stream.chapters.len())
                && cycle == expected_cycle
                && passage.book == chapter.book
                && passage.chapter == chapter.chapter
                && existing_position.is_none_or(|value| value == position as u32);
            let repaired_position = coherent.then_some(position as u32);
            if existing_position != repaired_position {
                conn.execute(
                    "UPDATE plan_assignments SET stream_position=?1 WHERE id=?2",
                    params![repaired_position, id],
                )?;
            }
            previous_ordinal = ordinal;
        }
    }
    conn.execute_batch(
        "CREATE TRIGGER plan_assignments_immutable BEFORE UPDATE ON plan_assignments BEGIN SELECT RAISE(ABORT,'Plan assignments are immutable'); END;
         CREATE TRIGGER plan_assignments_position_required BEFORE INSERT ON plan_assignments WHEN NEW.stream_position IS NULL BEGIN SELECT RAISE(ABORT,'New plan assignments require occurrence identity'); END;",
    )?;
    Ok(())
}

pub(crate) fn create_definition(
    conn: &mut Connection,
    existing_plan_id: Option<&str>,
    definition: PlanDefinition,
) -> Result<PlanDefinitionVersion> {
    validate_definition(&definition)?;
    let content = serde_json::to_string(&definition)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let plan_id = existing_plan_id
        .map(str::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let now = Utc::now().to_rfc3339();
    if existing_plan_id.is_none() {
        tx.execute(
            "INSERT INTO plans(id,created_at) VALUES(?1,?2)",
            params![plan_id, now],
        )?;
    } else {
        ensure!(
            tx.query_row("SELECT 1 FROM plans WHERE id=?1", [&plan_id], |_| Ok(()))
                .optional()?
                .is_some(),
            "Plan not found"
        );
    }
    let version: u32 = tx.query_row(
        "SELECT COALESCE(MAX(version),0)+1 FROM plan_definition_versions WHERE plan_id=?1",
        [&plan_id],
        |row| row.get(0),
    )?;
    let id = Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO plan_definition_versions(id,plan_id,version,created_at,definition) VALUES(?1,?2,?3,?4,?5)",
        params![id, plan_id, version, now, content],
    )?;
    let result = definition_version(&tx, &id)?.context("Saved plan definition missing")?;
    tx.commit()?;
    Ok(result)
}

pub(crate) fn definition_version(
    conn: &Connection,
    version_id: &str,
) -> Result<Option<PlanDefinitionVersion>> {
    Ok(conn
        .query_row(
            "SELECT id,plan_id,version,created_at,definition FROM plan_definition_versions WHERE id=?1",
            [version_id],
            row,
        )
        .optional()?)
}

pub(crate) fn definition_versions(
    conn: &Connection,
    plan_id: &str,
) -> Result<Vec<PlanDefinitionVersion>> {
    let mut statement = conn.prepare(
        "SELECT id,plan_id,version,created_at,definition FROM plan_definition_versions WHERE plan_id=?1 ORDER BY version",
    )?;
    let versions = statement
        .query_map([plan_id], row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(versions)
}

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PlanDefinitionVersion> {
    let text: String = row.get(4)?;
    let definition = serde_json::from_str(&text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(PlanDefinitionVersion {
        id: row.get(0)?,
        plan_id: row.get(1)?,
        version: row.get(2)?,
        created_at: row.get(3)?,
        definition,
    })
}

fn validate_definition(definition: &PlanDefinition) -> Result<()> {
    ensure!(
        definition.schema_version == DEFINITION_SCHEMA_VERSION,
        "Unsupported plan definition schema version {}",
        definition.schema_version
    );
    let name = definition.name.trim();
    ensure!(!name.is_empty() && name.len() <= 200, "Invalid plan name");
    ensure!(
        definition
            .description
            .as_ref()
            .is_none_or(|value| value.len() <= 10_000),
        "Plan description is too long"
    );
    match &definition.schedule {
        PlanSchedule::ExplicitSchedule { days } => {
            ensure!(
                !days.is_empty() && days.len() <= 10_000,
                "Invalid schedule length"
            );
            let mut passages = 0usize;
            for (index, day) in days.iter().enumerate() {
                ensure!(
                    day.day == index as u32 + 1,
                    "Schedule days must be consecutive starting at one"
                );
                ensure!(
                    !day.passages.is_empty() && day.passages.len() <= 100,
                    "Each schedule day needs one to 100 passages"
                );
                passages += day.passages.len();
                for passage in &day.passages {
                    validate_passage(passage)?;
                }
            }
            ensure!(passages <= 100_000, "Plan contains too many passages");
        }
        PlanSchedule::ChapterStreams { streams } => {
            ensure!(
                !streams.is_empty() && streams.len() <= 100,
                "Invalid stream count"
            );
            let mut ids = HashSet::new();
            for stream in streams {
                ensure!(
                    !stream.id.is_empty()
                        && stream.id.len() <= 100
                        && stream.id.bytes().all(|byte| byte.is_ascii_lowercase()
                            || byte.is_ascii_digit()
                            || byte == b'-'),
                    "Stream IDs use lowercase letters, digits, and hyphens"
                );
                ensure!(ids.insert(&stream.id), "Stream IDs must be unique");
                ensure!(
                    !stream.name.trim().is_empty() && stream.name.len() <= 200,
                    "Invalid stream name"
                );
                ensure!(
                    !stream.chapters.is_empty() && stream.chapters.len() <= 1_189,
                    "Invalid stream length"
                );
                for chapter in &stream.chapters {
                    ensure!(
                        (1..=66).contains(&chapter.book)
                            && (1..=CHAPTERS[(chapter.book - 1) as usize])
                                .contains(&chapter.chapter),
                        "Invalid book or chapter"
                    );
                }
            }
        }
    }
    Ok(())
}

pub(crate) const PLAN_SCHEMA: &str = "
CREATE TABLE plans(
 id TEXT PRIMARY KEY,
 created_at TEXT NOT NULL
);
CREATE TABLE plan_definition_versions(
 id TEXT PRIMARY KEY,
 plan_id TEXT NOT NULL REFERENCES plans(id),
 version INTEGER NOT NULL CHECK(version > 0),
 created_at TEXT NOT NULL,
 definition TEXT NOT NULL CHECK(json_valid(definition)),
 UNIQUE(plan_id,version)
);
CREATE TRIGGER plan_definition_versions_immutable BEFORE UPDATE ON plan_definition_versions
BEGIN SELECT RAISE(ABORT,'Plan definition versions are immutable'); END;
CREATE TRIGGER plan_definition_versions_retained BEFORE DELETE ON plan_definition_versions
BEGIN SELECT RAISE(ABORT,'Plan definition versions are retained'); END;
CREATE TRIGGER plans_retained BEFORE DELETE ON plans
BEGIN SELECT RAISE(ABORT,'Plans are retained'); END;
";

pub(crate) const PLAN_PROGRESS_SCHEMA: &str = "
CREATE TABLE plan_enrollments(id TEXT PRIMARY KEY,definition_version_id TEXT NOT NULL REFERENCES plan_definition_versions(id),created_at TEXT NOT NULL);
CREATE TABLE plan_enrollment_streams(enrollment_id TEXT NOT NULL REFERENCES plan_enrollments(id),stream_id TEXT NOT NULL,loop_after_end INTEGER NOT NULL CHECK(loop_after_end IN (0,1)),PRIMARY KEY(enrollment_id,stream_id));
CREATE TABLE plan_assignments(id TEXT PRIMARY KEY,enrollment_id TEXT NOT NULL,stream_id TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal>0),cycle INTEGER NOT NULL CHECK(cycle>0),passage TEXT NOT NULL CHECK(json_valid(passage)),UNIQUE(enrollment_id,stream_id,ordinal),FOREIGN KEY(enrollment_id,stream_id) REFERENCES plan_enrollment_streams(enrollment_id,stream_id));
CREATE TABLE reading_completions(id TEXT PRIMARY KEY,assignment_id TEXT NOT NULL REFERENCES plan_assignments(id),completed_at TEXT NOT NULL);
CREATE TABLE reading_completion_undos(id TEXT PRIMARY KEY,completion_id TEXT NOT NULL UNIQUE REFERENCES reading_completions(id),undone_at TEXT NOT NULL);
CREATE TRIGGER plan_enrollments_immutable BEFORE UPDATE ON plan_enrollments BEGIN SELECT RAISE(ABORT,'Plan enrollments are immutable'); END;
CREATE TRIGGER plan_enrollment_streams_immutable BEFORE UPDATE ON plan_enrollment_streams BEGIN SELECT RAISE(ABORT,'Plan enrollments are immutable'); END;
CREATE TRIGGER plan_assignments_immutable BEFORE UPDATE ON plan_assignments BEGIN SELECT RAISE(ABORT,'Plan assignments are immutable'); END;
CREATE TRIGGER reading_completions_immutable BEFORE UPDATE ON reading_completions BEGIN SELECT RAISE(ABORT,'Reading completions are immutable'); END;
CREATE TRIGGER reading_completion_undos_immutable BEFORE UPDATE ON reading_completion_undos BEGIN SELECT RAISE(ABORT,'Reading completion undos are immutable'); END;
CREATE TRIGGER plan_progress_retained_enrollments BEFORE DELETE ON plan_enrollments BEGIN SELECT RAISE(ABORT,'Plan progress is retained'); END;
CREATE TRIGGER plan_progress_retained_streams BEFORE DELETE ON plan_enrollment_streams BEGIN SELECT RAISE(ABORT,'Plan progress is retained'); END;
CREATE TRIGGER plan_progress_retained_assignments BEFORE DELETE ON plan_assignments BEGIN SELECT RAISE(ABORT,'Plan progress is retained'); END;
CREATE TRIGGER plan_progress_retained_completions BEFORE DELETE ON reading_completions BEGIN SELECT RAISE(ABORT,'Plan progress is retained'); END;
CREATE TRIGGER plan_progress_retained_undos BEFORE DELETE ON reading_completion_undos BEGIN SELECT RAISE(ABORT,'Plan progress is retained'); END;
";

pub(crate) const PLAN_PROGRESS_EPOCH_SCHEMA: &str = "
CREATE TABLE plan_stream_progress_epochs(
 id TEXT PRIMARY KEY,
 enrollment_id TEXT NOT NULL,
 stream_id TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence>0),
 assignment_id TEXT NOT NULL REFERENCES plan_assignments(id),
 created_at TEXT NOT NULL,
 UNIQUE(enrollment_id,stream_id,sequence),
 FOREIGN KEY(enrollment_id,stream_id) REFERENCES plan_enrollment_streams(enrollment_id,stream_id)
);
INSERT INTO plan_stream_progress_epochs(id,enrollment_id,stream_id,sequence,assignment_id,created_at)
SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),
       s.enrollment_id,s.stream_id,1,a.id,datetime('now')
FROM plan_enrollment_streams s JOIN plan_assignments a ON a.enrollment_id=s.enrollment_id AND a.stream_id=s.stream_id
WHERE a.ordinal=(SELECT MIN(a2.ordinal) FROM plan_assignments a2 WHERE a2.enrollment_id=s.enrollment_id AND a2.stream_id=s.stream_id AND NOT EXISTS (
 SELECT 1 FROM reading_completions c WHERE c.assignment_id=a2.id AND NOT EXISTS (SELECT 1 FROM reading_completion_undos u WHERE u.completion_id=c.id)));
CREATE TRIGGER plan_stream_progress_epochs_immutable BEFORE UPDATE ON plan_stream_progress_epochs BEGIN SELECT RAISE(ABORT,'Plan progress epochs are immutable'); END;
CREATE TRIGGER plan_stream_progress_epochs_retained BEFORE DELETE ON plan_stream_progress_epochs BEGIN SELECT RAISE(ABORT,'Plan progress is retained'); END;
CREATE TRIGGER plan_stream_progress_epochs_match BEFORE INSERT ON plan_stream_progress_epochs
WHEN NOT EXISTS(SELECT 1 FROM plan_assignments a WHERE a.id=NEW.assignment_id AND a.enrollment_id=NEW.enrollment_id AND a.stream_id=NEW.stream_id)
BEGIN SELECT RAISE(ABORT,'Progress epoch assignment must belong to its stream'); END;
";

pub(crate) const PLAN_ASSIGNMENT_POSITION_SCHEMA: &str = "
DROP TRIGGER plan_assignments_immutable;
ALTER TABLE plan_assignments ADD COLUMN stream_position INTEGER CHECK(stream_position>=0);
";

pub(crate) const PLAN_ASSIGNMENT_POSITION_REPAIR_SCHEMA: &str = "
DROP TRIGGER plan_assignments_immutable;
DROP TRIGGER plan_assignments_position_required;
";
