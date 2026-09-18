//! Local journal authority. Every changed save is an immutable full snapshot.
use anyhow::{bail, ensure, Context, Result};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{path::Path, time::Duration};
use uuid::Uuid;

mod export;
#[cfg(unix)]
mod export_directory;
mod plans;
pub use export::ExportReport;
pub use plans::{
    ChapterRef, ChapterStream, ExplicitScheduleDay, PlanDefinition, PlanDefinitionVersion,
    PlanSchedule,
};

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
            (0..=2).contains(&version),
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
            tx.pragma_update(None, "user_version", 2)?;
            tx.commit()?;
        } else if version == 1 {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute_batch(plans::PLAN_SCHEMA)?;
            tx.pragma_update(None, "user_version", 2)?;
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

    pub fn list_entries(&self) -> Result<Vec<Entry>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM entries ORDER BY updated_at DESC,id")?;
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
            old.as_ref().map(|e| e.working_revision_id.as_str())
                == request.expected_revision_id.as_deref(),
            "Conflict: entry changed since it was loaded; reload before saving"
        );
        for link in &request.content.links {
            ensure!(
                link == &request.entry_id || entry(&tx, link)?.is_some(),
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
            tx.execute("INSERT INTO revisions(id,entry_id,parent_id,created_at,content) VALUES(?1,?2,?3,?4,?5)", params![revision_id, request.entry_id, request.expected_revision_id, now, serde_json::to_string(&request.content)?])?;
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
            Some(current.working_revision_id.as_str()) == expected_revision_id,
            "Conflict: entry changed since it was loaded; reload before restoring"
        );
        let original = tx.query_row("SELECT id,entry_id,parent_id,restored_from_id,created_at,content FROM revisions WHERE id=?1 AND entry_id=?2", params![revision_id, entry_id], revision_row).optional()?.context("Revision not found for this entry")?;
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        tx.execute("INSERT INTO revisions(id,entry_id,parent_id,restored_from_id,created_at,content) VALUES(?1,?2,?3,?4,?5,?6)", params![id, entry_id, current.working_revision_id, revision_id, now, serde_json::to_string(&original.content)?])?;
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
    if let Some(end) = p.end_verse {
        ensure!(
            p.start_verse.is_some_and(|start| start <= end),
            "Invalid verse range"
        );
    }
    Ok(())
}

fn entry(conn: &Connection, id: &str) -> Result<Option<Entry>> {
    Ok(conn.query_row("SELECT e.id,e.created_at,e.updated_at,e.working_revision_id,e.published_revision_id,r.content FROM entries e JOIN revisions r ON r.id=e.working_revision_id WHERE e.id=?1", [id], |r| Ok(Entry { id:r.get(0)?, created_at:r.get(1)?, updated_at:r.get(2)?, working_revision_id:r.get(3)?, published_revision_id:r.get(4)?, content:decode(r,5)? })).optional()?)
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
