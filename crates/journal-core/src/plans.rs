use crate::{validate_passage, Passage, CHAPTERS};
use anyhow::{ensure, Context, Result};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use uuid::Uuid;

const DEFINITION_SCHEMA_VERSION: u32 = 1;

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
