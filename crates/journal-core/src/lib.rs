//! Local journal authority. Every changed save is an immutable full snapshot.
use anyhow::{bail, ensure, Context, Result};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{path::Path, time::Duration};
use uuid::Uuid;

pub mod backup;
mod deletion;
mod export;
pub const CURRENT_SCHEMA: u32 = 15;
#[cfg(unix)]
mod export_directory;
mod legacy_import;
mod plans;
mod verse_counts;
pub use export::ExportReport;
pub use legacy_import::{LegacyImportPreview, LegacyImportRecord, LegacyImportResult};
pub use plans::{
    expand_calendar_assignments, four_stream_plan_definition, mcheyne_plan_definition,
    parse_plan_definition_json, serialize_plan_definition_json, AdoptCalendarPlanRequest,
    AdoptStreamPlanRequest, CalendarAssignment, CalendarAssignmentCompletion,
    CalendarPlanEnrollment, CalendarScheduleMode, ChapterRef, ChapterStream, CompleteStreamRequest,
    DatedPlanAssignment, ExplicitScheduleDay, PlanAdoptionEvent, PlanAssignment, PlanCompletion,
    PlanCompletionHistoryItem, PlanDefinition, PlanDefinitionVersion, PlanEnrollment, PlanSchedule,
    StreamAdoptionBoundary, StreamEnrollment, MAX_PLAN_DEFINITION_JSON_BYTES,
};

/// A passage in canonical Protestant 66-book order using KJV versification.
/// With no verse fields it denotes a whole chapter. `start_verse` alone denotes
/// one verse; when `end_verse` is present the inclusive range requires both.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Passage {
    pub book: u32,
    pub chapter: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_verse: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_verse: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntryContent {
    pub title: String,
    pub body: String,
    pub passages: Vec<Passage>,
    pub tags: Vec<String>,
    pub links: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub created_at: String,
    pub updated_at: String,
    pub working_revision_id: String,
    pub published_revision_id: Option<String>,
    pub content: EntryContent,
    pub trashed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub id: String,
    pub entry_id: String,
    pub parent_id: Option<String>,
    pub restored_from_id: Option<String>,
    pub created_at: String,
    pub content: EntryContent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveRequest {
    pub entry_id: String,
    pub expected_revision_id: Option<String>,
    pub content: EntryContent,
    pub finish: bool,
}

pub struct JournalStore {
    conn: Connection,
}

impl JournalStore {
    pub fn open(path: &Path) -> Result<Self> {
        let mut conn = Connection::open(path)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        ensure!(
            (0..=15).contains(&version),
            "Unsupported journal schema version {version}"
        );
        if version == 0 {
            let tables: i64 = conn.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", [], |r| r.get(0))?;
            ensure!(
                tables == 0,
                "Unrecognized database; refusing to initialize over existing data"
            );
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute_batch(SCHEMA)?;
            tx.execute(
                "INSERT INTO metadata(key,value) VALUES ('journal_id',?1),('installation_id',?2)",
                params![Uuid::new_v4().to_string(), Uuid::new_v4().to_string()],
            )?;
            tx.execute_batch(plans::PLAN_SCHEMA)?;
            tx.execute_batch(plans::PLAN_PROGRESS_SCHEMA)?;
            tx.execute_batch(plans::PLAN_PROGRESS_EPOCH_SCHEMA)?;
            tx.execute_batch(plans::PLAN_ASSIGNMENT_POSITION_SCHEMA)?;
            plans::migrate_assignment_positions(&tx)?;
            tx.execute_batch(plans::BUILT_IN_PLAN_SCHEMA)?;
            tx.execute_batch(plans::PLAN_CALENDAR_SCHEMA)?;
            tx.pragma_update(None, "user_version", 11)?;
            tx.commit()?;
        } else if version == 1 {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute_batch(plans::PLAN_SCHEMA)?;
            tx.execute_batch(plans::PLAN_PROGRESS_SCHEMA)?;
            tx.execute_batch(plans::PLAN_PROGRESS_EPOCH_SCHEMA)?;
            tx.execute_batch(plans::PLAN_ASSIGNMENT_POSITION_SCHEMA)?;
            plans::migrate_assignment_positions(&tx)?;
            tx.execute_batch(plans::BUILT_IN_PLAN_SCHEMA)?;
            tx.execute_batch(plans::PLAN_CALENDAR_SCHEMA)?;
            tx.pragma_update(None, "user_version", 11)?;
            tx.commit()?;
        } else if version == 2 {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute_batch(plans::PLAN_PROGRESS_SCHEMA)?;
            tx.execute_batch(plans::PLAN_PROGRESS_EPOCH_SCHEMA)?;
            tx.execute_batch(plans::PLAN_ASSIGNMENT_POSITION_SCHEMA)?;
            plans::migrate_assignment_positions(&tx)?;
            tx.execute_batch(plans::BUILT_IN_PLAN_SCHEMA)?;
            tx.execute_batch(plans::PLAN_CALENDAR_SCHEMA)?;
            tx.pragma_update(None, "user_version", 11)?;
            tx.commit()?;
        } else if version == 3 {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute_batch(plans::PLAN_PROGRESS_EPOCH_SCHEMA)?;
            tx.execute_batch(plans::PLAN_ASSIGNMENT_POSITION_SCHEMA)?;
            plans::migrate_assignment_positions(&tx)?;
            tx.execute_batch(plans::BUILT_IN_PLAN_SCHEMA)?;
            tx.execute_batch(plans::PLAN_CALENDAR_SCHEMA)?;
            tx.pragma_update(None, "user_version", 11)?;
            tx.commit()?;
        } else if version == 4 {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute_batch(plans::PLAN_ASSIGNMENT_POSITION_SCHEMA)?;
            plans::migrate_assignment_positions(&tx)?;
            tx.execute_batch(plans::BUILT_IN_PLAN_SCHEMA)?;
            tx.execute_batch(plans::PLAN_CALENDAR_SCHEMA)?;
            tx.pragma_update(None, "user_version", 11)?;
            tx.commit()?;
        } else if version == 5 {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute_batch(plans::PLAN_ASSIGNMENT_POSITION_REPAIR_SCHEMA)?;
            plans::migrate_assignment_positions(&tx)?;
            tx.execute_batch(plans::BUILT_IN_PLAN_SCHEMA)?;
            tx.execute_batch(plans::PLAN_CALENDAR_SCHEMA)?;
            tx.pragma_update(None, "user_version", 11)?;
            tx.commit()?;
        } else if version == 6 {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute_batch(plans::BUILT_IN_PLAN_SCHEMA)?;
            tx.execute_batch(plans::PLAN_CALENDAR_SCHEMA)?;
            tx.pragma_update(None, "user_version", 11)?;
            tx.commit()?;
        } else if version == 7 || version == 8 {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute_batch(plans::PLAN_CALENDAR_SCHEMA)?;
            tx.pragma_update(None, "user_version", 11)?;
            tx.commit()?;
        } else if version == 9 {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute_batch(plans::PLAN_CALENDAR_COMPLETION_V10_MIGRATION)?;
            tx.execute_batch(plans::PLAN_CALENDAR_SCHEMA)?;
            tx.pragma_update(None, "user_version", 11)?;
            tx.commit()?;
        } else if version == 10 {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let mismatches: i64 = tx.query_row(
                "SELECT count(*) FROM plan_calendar_completion_undos u WHERE NOT EXISTS(SELECT 1 FROM plan_calendar_completions c WHERE c.id=u.completion_id AND c.assignment_id=u.assignment_id AND c.enrollment_id=u.enrollment_id)",
                [], |row| row.get(0))?;
            ensure!(
                mismatches == 0,
                "Calendar undo ownership mismatch; refusing migration"
            );
            tx.execute_batch(plans::PLAN_CALENDAR_SCHEMA)?;
            tx.pragma_update(None, "user_version", 11)?;
            tx.commit()?;
        }
        let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if version == 11 {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let broken_chains: i64 = tx.query_row(
                "SELECT count(*) FROM plan_assignments a WHERE a.ordinal>1 AND NOT EXISTS(
                   SELECT 1 FROM plan_assignments p WHERE p.enrollment_id=a.enrollment_id
                   AND p.stream_id=a.stream_id AND p.ordinal=a.ordinal-1)",
                [],
                |row| row.get(0),
            )?;
            ensure!(
                broken_chains == 0,
                "Ambiguous retained assignment chain; refusing migration"
            );
            tx.execute_batch(plans::PLAN_ASSIGNMENT_PROVENANCE_SCHEMA)?;
            tx.pragma_update(None, "user_version", 12)?;
            tx.commit()?;
        }
        let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if version == 12 {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute_batch(plans::PLAN_ADOPTION_SCHEMA)?;
            tx.pragma_update(None, "user_version", 13)?;
            tx.commit()?;
        }
        let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if version == 13 {
            deletion::migrate(&mut conn)?;
        }
        let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if version == 14 {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute_batch(legacy_import::LEGACY_IMPORT_SCHEMA)?;
            tx.pragma_update(None, "user_version", 15)?;
            tx.commit()?;
        }
        let store = Self { conn };
        validate_id(&store.identity("journal_id")?)?;
        validate_id(&store.identity("installation_id")?)?;
        let integrity: String = store
            .conn
            .query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        ensure!(integrity == "ok", "Journal integrity check failed");
        let violations: i64 =
            store
                .conn
                .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
                    r.get(0)
                })?;
        ensure!(violations == 0, "Journal has invalid references");
        store.conn.pragma_update(None, "journal_mode", "WAL")?;
        store.conn.pragma_update(None, "synchronous", "FULL")?;
        Ok(store)
    }

    /// Inspects a legacy journal without changing either journal.
    pub fn preview_legacy_import(&self, path: &Path) -> Result<LegacyImportPreview> {
        legacy_import::preview(&self.conn, path)
    }

    /// Imports the exact source set that was previewed in one transaction.
    pub fn import_legacy_journal(
        &mut self,
        path: &Path,
        expected_preview_id: &str,
    ) -> Result<LegacyImportResult> {
        legacy_import::import(&mut self.conn, path, expected_preview_id)
    }

    pub fn list_entries(&self) -> Result<Vec<Entry>> {
        let mut stmt = self.conn.prepare(
            "SELECT id FROM entries WHERE trashed_at IS NULL ORDER BY updated_at DESC,id",
        )?;
        let ids = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.iter()
            .map(|id| entry(&self.conn, id)?.context("Entry disappeared"))
            .collect()
    }

    pub fn save_entry(&mut self, request: SaveRequest) -> Result<Entry> {
        validate_id(&request.entry_id)?;
        validate_content(&request.content)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let old = entry(&tx, &request.entry_id)?;
        ensure!(
            old.as_ref().is_none_or(|e| e.trashed_at.is_none()),
            "Restore this entry from Trash before editing"
        );
        let purged: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM purged_entries WHERE entry_id=?1)",
            [&request.entry_id],
            |r| r.get(0),
        )?;
        ensure!(
            !purged,
            "This entry was permanently deleted; save as a new entry"
        );
        ensure!(
            old.as_ref().map(|e| e.working_revision_id.as_str())
                == request.expected_revision_id.as_deref(),
            "Conflict: entry changed since it was loaded; reload before saving"
        );
        for link in &request.content.links {
            let purged_target: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM purged_entries WHERE entry_id=?1)",
                [link],
                |r| r.get(0),
            )?;
            ensure!(
                link == &request.entry_id
                    || entry(&tx, link)?.is_some()
                    || purged_target
                    || old.as_ref().is_some_and(|e| e.content.links.contains(link)),
                "Linked entry does not exist: {link}"
            );
        }
        let changed = old.as_ref().map(|e| &e.content) != Some(&request.content);
        let now = Utc::now().to_rfc3339();
        let revision_id = if changed {
            Uuid::new_v4().to_string()
        } else {
            old.as_ref().unwrap().working_revision_id.clone()
        };
        if old.is_none() {
            tx.execute("INSERT INTO entries(id,created_at,updated_at,working_revision_id) VALUES(?1,?2,?2,?3)", params![request.entry_id, now, revision_id])?;
        }
        if changed {
            tx.execute("INSERT INTO revisions(id,entry_id,parent_id,parent_ref_id,created_at,content) VALUES(?1,?2,?3,?3,?4,?5)", params![revision_id, request.entry_id, request.expected_revision_id, now, serde_json::to_string(&request.content)?])?;
            tx.execute(
                "UPDATE entries SET working_revision_id=?1,updated_at=?2 WHERE id=?3",
                params![revision_id, now, request.entry_id],
            )?;
            record_change(&tx, &request.entry_id, "save", &revision_id)?;
        }
        if request.finish
            && old
                .as_ref()
                .and_then(|e| e.published_revision_id.as_deref())
                != Some(&revision_id)
        {
            tx.execute(
                "UPDATE entries SET published_revision_id=?1,updated_at=?2 WHERE id=?3",
                params![revision_id, now, request.entry_id],
            )?;
            record_change(&tx, &request.entry_id, "finish", &revision_id)?;
        }
        let result = entry(&tx, &request.entry_id)?.context("Saved entry missing")?;
        tx.commit()?;
        Ok(result)
    }

    pub fn get_history(&self, entry_id: &str) -> Result<Vec<Revision>> {
        validate_id(entry_id)?;
        ensure!(entry(&self.conn, entry_id)?.is_some(), "Entry not found");
        let mut stmt = self.conn.prepare("SELECT id,entry_id,parent_id,restored_from_id,created_at,content FROM revisions WHERE entry_id=?1 ORDER BY rowid DESC")?;
        let rows = stmt
            .query_map([entry_id], revision_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn restore_revision(
        &mut self,
        entry_id: &str,
        revision_id: &str,
        expected_revision_id: Option<&str>,
    ) -> Result<Entry> {
        validate_id(entry_id)?;
        validate_id(revision_id)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = entry(&tx, entry_id)?.context("Entry not found")?;
        ensure!(
            current.trashed_at.is_none(),
            "Restore this entry from Trash before restoring a version"
        );
        ensure!(
            Some(current.working_revision_id.as_str()) == expected_revision_id,
            "Conflict: entry changed since it was loaded; reload before restoring"
        );
        let original = tx.query_row("SELECT id,entry_id,parent_id,restored_from_id,created_at,content FROM revisions WHERE id=?1 AND entry_id=?2", params![revision_id, entry_id], revision_row).optional()?.context("Revision not found for this entry")?;
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        tx.execute("INSERT INTO revisions(id,entry_id,parent_id,restored_from_id,parent_ref_id,restored_from_ref_id,created_at,content) VALUES(?1,?2,?3,?4,?3,?4,?5,?6)", params![id, entry_id, current.working_revision_id, revision_id, now, serde_json::to_string(&original.content)?])?;
        tx.execute(
            "UPDATE entries SET working_revision_id=?1,updated_at=?2 WHERE id=?3",
            params![id, now, entry_id],
        )?;
        record_change(&tx, entry_id, "restore", &id)?;
        let result = entry(&tx, entry_id)?.context("Restored entry missing")?;
        tx.commit()?;
        Ok(result)
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT value FROM settings WHERE key=?1", [key], |r| {
                r.get(0)
            })
            .optional()?)
    }

    pub fn set_setting(&mut self, key: &str, value: &str) -> Result<()> {
        ensure!(
            !key.is_empty() && key.len() <= 100 && value.len() <= 1_000_000,
            "Invalid setting size"
        );
        self.conn.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key,value])?;
        Ok(())
    }

    pub fn create_plan_definition(
        &mut self,
        definition: PlanDefinition,
    ) -> Result<PlanDefinitionVersion> {
        plans::create_definition(&mut self.conn, None, definition)
    }

    /// Imports one bounded portable definition as a new retained custom plan.
    pub fn import_plan_definition_json(&mut self, input: &str) -> Result<PlanDefinitionVersion> {
        let definition = plans::parse_plan_definition_json(input)?;
        plans::create_definition(&mut self.conn, None, definition)
    }

    /// Exports exactly the selected immutable definition version.
    pub fn export_plan_definition_json(&self, version_id: &str) -> Result<String> {
        validate_id(version_id)?;
        let version = plans::definition_version(&self.conn, version_id)?
            .context("Plan definition version not found")?;
        plans::serialize_plan_definition_json(&version.definition)
    }

    pub fn register_four_stream_plan(&mut self) -> Result<PlanDefinitionVersion> {
        plans::register_four_stream(&mut self.conn)
    }

    pub fn register_mcheyne_plan(&mut self) -> Result<PlanDefinitionVersion> {
        plans::register_mcheyne(&mut self.conn)
    }

    pub fn create_plan_definition_version(
        &mut self,
        plan_id: &str,
        definition: PlanDefinition,
    ) -> Result<PlanDefinitionVersion> {
        validate_id(plan_id)?;
        plans::create_definition(&mut self.conn, Some(plan_id), definition)
    }

    pub fn get_plan_definition_version(
        &self,
        version_id: &str,
    ) -> Result<Option<PlanDefinitionVersion>> {
        validate_id(version_id)?;
        plans::definition_version(&self.conn, version_id)
    }

    pub fn list_plan_definition_versions(
        &self,
        plan_id: &str,
    ) -> Result<Vec<PlanDefinitionVersion>> {
        validate_id(plan_id)?;
        plans::definition_versions(&self.conn, plan_id)
    }

    /// Lists the latest immutable version of every retained plan identity,
    /// oldest plan first and breaking plan-creation timestamp ties by plan ID.
    pub fn list_latest_plan_definition_versions(&self) -> Result<Vec<PlanDefinitionVersion>> {
        plans::latest_definition_versions(&self.conn)
    }

    pub fn enroll_in_chapter_streams(
        &mut self,
        definition_version_id: &str,
        streams: Vec<StreamEnrollment>,
    ) -> Result<PlanEnrollment> {
        validate_id(definition_version_id)?;
        plans::enroll(&mut self.conn, definition_version_id, streams)
    }

    pub fn enroll_in_calendar(
        &mut self,
        definition_version_id: &str,
        start_date: chrono::NaiveDate,
        mode: CalendarScheduleMode,
    ) -> Result<CalendarPlanEnrollment> {
        validate_id(definition_version_id)?;
        plans::enroll_calendar(&mut self.conn, definition_version_id, start_date, mode)
    }

    pub fn calendar_plan_assignments(
        &self,
        enrollment_id: &str,
    ) -> Result<Vec<DatedPlanAssignment>> {
        validate_id(enrollment_id)?;
        plans::calendar_assignments(&self.conn, enrollment_id)
    }

    pub fn get_calendar_plan_enrollment(
        &self,
        enrollment_id: &str,
    ) -> Result<Option<CalendarPlanEnrollment>> {
        validate_id(enrollment_id)?;
        plans::calendar_enrollment(&self.conn, enrollment_id)
    }

    pub fn complete_calendar_assignment(
        &mut self,
        enrollment_id: &str,
        assignment_id: &str,
    ) -> Result<CalendarAssignmentCompletion> {
        validate_id(enrollment_id)?;
        validate_id(assignment_id)?;
        plans::complete_calendar_assignment(&mut self.conn, enrollment_id, assignment_id)
    }

    pub fn calendar_completion_history(
        &self,
        enrollment_id: &str,
    ) -> Result<Vec<CalendarAssignmentCompletion>> {
        validate_id(enrollment_id)?;
        plans::calendar_completion_history(&self.conn, enrollment_id)
    }

    pub fn undo_calendar_completion(
        &mut self,
        enrollment_id: &str,
        assignment_id: &str,
        completion_id: &str,
    ) -> Result<()> {
        validate_id(enrollment_id)?;
        validate_id(assignment_id)?;
        validate_id(completion_id)?;
        plans::undo_calendar_completion(&mut self.conn, enrollment_id, assignment_id, completion_id)
    }

    /// Lists retained enrollments oldest first, breaking timestamp ties by enrollment ID.
    pub fn list_plan_enrollments(&self) -> Result<Vec<PlanEnrollment>> {
        plans::enrollments(&self.conn)
    }

    pub fn active_plan_assignments(&self, enrollment_id: &str) -> Result<Vec<PlanAssignment>> {
        validate_id(enrollment_id)?;
        plans::active_assignments(&self.conn, enrollment_id)
    }

    /// Lists immutable completion records oldest first by completion timestamp,
    /// breaking ties by completion ID. Unknown enrollments return no records.
    pub fn plan_completion_history(
        &self,
        enrollment_id: &str,
    ) -> Result<Vec<PlanCompletionHistoryItem>> {
        validate_id(enrollment_id)?;
        plans::completion_history(&self.conn, enrollment_id)
    }

    pub fn complete_plan_stream(
        &mut self,
        request: CompleteStreamRequest,
    ) -> Result<PlanCompletion> {
        validate_id(&request.enrollment_id)?;
        validate_id(&request.expected_assignment_id)?;
        validate_id(&request.expected_progress_id)?;
        plans::complete_stream(&mut self.conn, request)
    }

    pub fn undo_plan_completion(&mut self, completion_id: &str) -> Result<()> {
        validate_id(completion_id)?;
        plans::undo_completion(&mut self.conn, completion_id)
    }

    pub fn adopt_chapter_stream_plan(
        &mut self,
        request: AdoptStreamPlanRequest,
    ) -> Result<PlanAdoptionEvent> {
        validate_id(&request.enrollment_id)?;
        validate_id(&request.expected_definition_version_id)?;
        validate_id(&request.target_definition_version_id)?;
        for boundary in &request.streams {
            validate_id(&boundary.assignment_id)?;
            validate_id(&boundary.progress_id)?;
        }
        plans::adopt_stream_plan(&mut self.conn, request)
    }

    pub fn adopt_calendar_plan(
        &mut self,
        request: AdoptCalendarPlanRequest,
    ) -> Result<PlanAdoptionEvent> {
        validate_id(&request.enrollment_id)?;
        validate_id(&request.expected_definition_version_id)?;
        validate_id(&request.target_definition_version_id)?;
        validate_id(&request.expected_assignment_id)?;
        plans::adopt_calendar_plan(&mut self.conn, request)
    }

    pub fn plan_adoption_history(&self, enrollment_id: &str) -> Result<Vec<PlanAdoptionEvent>> {
        validate_id(enrollment_id)?;
        plans::adoption_history(&self.conn, enrollment_id)
    }

    fn identity(&self, key: &str) -> Result<String> {
        Ok(self
            .conn
            .query_row("SELECT value FROM metadata WHERE key=?1", [key], |r| {
                r.get(0)
            })?)
    }
}

pub(crate) fn validate_id(id: &str) -> Result<()> {
    let parsed = Uuid::parse_str(id).context("Invalid entry or revision UUID")?;
    ensure!(
        parsed.to_string() == id,
        "IDs must be canonical lowercase UUIDs"
    );
    Ok(())
}

fn validate_content(content: &EntryContent) -> Result<()> {
    ensure!(
        content.body.len() <= 10_000_000 && content.title.len() <= 10_000,
        "Entry exceeds size limit"
    );
    ensure!(
        content.links.len() <= 10_000
            && content.tags.len() <= 1_000
            && content.passages.len() <= 1_000,
        "Too many entry associations"
    );
    for id in &content.links {
        validate_id(id)?;
    }
    for p in &content.passages {
        validate_passage(p)?;
    }
    Ok(())
}

pub(crate) const CHAPTERS: [u32; 66] = [
    50, 40, 27, 36, 34, 24, 21, 4, 31, 24, 22, 25, 29, 36, 10, 13, 10, 42, 150, 31, 12, 8, 66, 52,
    5, 48, 12, 14, 3, 9, 1, 4, 7, 3, 3, 3, 2, 14, 4, 28, 16, 24, 21, 28, 16, 16, 13, 6, 6, 4, 4, 5,
    3, 6, 4, 3, 1, 13, 5, 5, 3, 5, 1, 1, 1, 22,
];

pub(crate) fn validate_passage(p: &Passage) -> Result<()> {
    ensure!(
        (1..=66).contains(&p.book) && p.chapter > 0 && p.chapter <= CHAPTERS[(p.book - 1) as usize],
        "Invalid book or chapter"
    );
    ensure!(
        p.start_verse != Some(0) && p.end_verse != Some(0),
        "Verse numbers start at one"
    );
    let chapter_offset: usize = CHAPTERS[..(p.book - 1) as usize]
        .iter()
        .map(|chapters| *chapters as usize)
        .sum();
    let max_verse = verse_counts::VERSE_COUNTS[chapter_offset + (p.chapter - 1) as usize] as u32;
    ensure!(
        p.start_verse.is_none_or(|verse| verse <= max_verse)
            && p.end_verse.is_none_or(|verse| verse <= max_verse),
        "Verse exceeds chapter limit"
    );
    if let Some(end) = p.end_verse {
        ensure!(
            p.start_verse.is_some_and(|start| start <= end),
            "Invalid verse range"
        );
    }
    Ok(())
}

fn entry(conn: &Connection, id: &str) -> Result<Option<Entry>> {
    Ok(conn.query_row("SELECT e.id,e.created_at,e.updated_at,e.working_revision_id,e.published_revision_id,r.content,e.trashed_at FROM entries e JOIN revisions r ON r.id=e.working_revision_id WHERE e.id=?1", [id], |r| Ok(Entry { id:r.get(0)?, created_at:r.get(1)?, updated_at:r.get(2)?, working_revision_id:r.get(3)?, published_revision_id:r.get(4)?, content:decode(r,5)?,trashed_at:r.get(6)? })).optional()?)
}

fn decode<T: serde::de::DeserializeOwned>(
    row: &rusqlite::Row<'_>,
    index: usize,
) -> rusqlite::Result<T> {
    let text: String = row.get(index)?;
    serde_json::from_str(&text).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(index, rusqlite::types::Type::Text, Box::new(e))
    })
}

fn revision_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Revision> {
    Ok(Revision {
        id: r.get(0)?,
        entry_id: r.get(1)?,
        parent_id: r.get(2)?,
        restored_from_id: r.get(3)?,
        created_at: r.get(4)?,
        content: decode(r, 5)?,
    })
}

fn record_change(conn: &Connection, entry_id: &str, kind: &str, revision: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO changes(operation_id,entry_id,kind,revision_id) VALUES(?1,?2,?3,?4)",
        params![Uuid::new_v4().to_string(), entry_id, kind, revision],
    )?;
    Ok(())
}

const SCHEMA: &str = "
CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE entries(
 id TEXT PRIMARY KEY,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 working_revision_id TEXT NOT NULL,published_revision_id TEXT,
 FOREIGN KEY(id,working_revision_id) REFERENCES revisions(entry_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(id,published_revision_id) REFERENCES revisions(entry_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE revisions(
 id TEXT PRIMARY KEY,entry_id TEXT NOT NULL REFERENCES entries(id),
 parent_id TEXT,restored_from_id TEXT,created_at TEXT NOT NULL,content TEXT NOT NULL CHECK(json_valid(content)),
 UNIQUE(entry_id,id),
 FOREIGN KEY(entry_id,parent_id) REFERENCES revisions(entry_id,id),
 FOREIGN KEY(entry_id,restored_from_id) REFERENCES revisions(entry_id,id)
);
CREATE TRIGGER revisions_immutable BEFORE UPDATE ON revisions BEGIN SELECT RAISE(ABORT,'Revisions are immutable'); END;
CREATE TRIGGER revisions_retained BEFORE DELETE ON revisions BEGIN SELECT RAISE(ABORT,'Revision deletion is not implemented'); END;
CREATE TABLE changes(sequence INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL UNIQUE,entry_id TEXT NOT NULL REFERENCES entries(id),kind TEXT NOT NULL,revision_id TEXT NOT NULL REFERENCES revisions(id));
";
