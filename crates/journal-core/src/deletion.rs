use super::*;

pub(crate) fn migrate(conn: &mut Connection) -> Result<()> {
    let violations: i64 =
        conn.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })?;
    ensure!(
        violations == 0,
        "Invalid journal references; refusing deletion migration"
    );
    // Rebuilding referenced tables requires disabling FK enforcement outside the
    // transaction. Validate the complete replacement before committing anything.
    conn.pragma_update(None, "foreign_keys", "OFF")?;
    let result = (|| -> Result<()> {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch("\
ALTER TABLE entries ADD COLUMN trashed_at TEXT;
CREATE TABLE purged_entries(entry_id TEXT PRIMARY KEY,deleted_at TEXT NOT NULL,last_published_revision_id TEXT);
CREATE TABLE revisions_new(
 id TEXT PRIMARY KEY,entry_id TEXT NOT NULL REFERENCES entries(id),
 parent_id TEXT,restored_from_id TEXT,created_at TEXT NOT NULL,content TEXT NOT NULL CHECK(json_valid(content)),
 parent_ref_id TEXT REFERENCES revisions_new(id) ON DELETE SET NULL,
 restored_from_ref_id TEXT REFERENCES revisions_new(id) ON DELETE SET NULL,
 UNIQUE(entry_id,id)
);
INSERT INTO revisions_new(rowid,id,entry_id,parent_id,restored_from_id,created_at,content,parent_ref_id,restored_from_ref_id)
 SELECT rowid,id,entry_id,parent_id,restored_from_id,created_at,content,parent_id,restored_from_id FROM revisions;
DROP TABLE revisions;
ALTER TABLE revisions_new RENAME TO revisions;
CREATE TRIGGER revisions_immutable BEFORE UPDATE ON revisions
 WHEN NEW.id IS NOT OLD.id OR NEW.entry_id IS NOT OLD.entry_id
 OR NEW.parent_id IS NOT OLD.parent_id OR NEW.restored_from_id IS NOT OLD.restored_from_id
 OR NEW.created_at IS NOT OLD.created_at OR NEW.content IS NOT OLD.content
 OR (NEW.parent_ref_id IS NOT OLD.parent_ref_id AND NEW.parent_ref_id IS NOT NULL)
 OR (NEW.restored_from_ref_id IS NOT OLD.restored_from_ref_id AND NEW.restored_from_ref_id IS NOT NULL)
 BEGIN SELECT RAISE(ABORT,'Revisions are immutable'); END;
CREATE TRIGGER revision_reference_ownership BEFORE INSERT ON revisions
 WHEN NEW.parent_ref_id IS NOT NEW.parent_id OR NEW.restored_from_ref_id IS NOT NEW.restored_from_id
 OR (NEW.parent_ref_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM revisions WHERE id=NEW.parent_ref_id AND entry_id=NEW.entry_id AND id=NEW.parent_id))
 OR (NEW.restored_from_ref_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM revisions WHERE id=NEW.restored_from_ref_id AND entry_id=NEW.entry_id AND id=NEW.restored_from_id))
 BEGIN SELECT RAISE(ABORT,'Invalid revision ancestry'); END;
CREATE TABLE changes_new(sequence INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL UNIQUE,entry_id TEXT NOT NULL,kind TEXT NOT NULL,revision_id TEXT NOT NULL);
INSERT INTO changes_new SELECT * FROM changes;
UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT seq FROM sqlite_sequence WHERE name='changes'),0)) WHERE name='changes_new';
DROP TABLE changes;
ALTER TABLE changes_new RENAME TO changes;
")?;
        let violations: i64 =
            tx.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
                r.get(0)
            })?;
        ensure!(
            violations == 0,
            "Invalid journal references; refusing deletion migration"
        );
        tx.pragma_update(None, "user_version", 14)?;
        tx.commit()?;
        Ok(())
    })();
    conn.pragma_update(None, "foreign_keys", "ON")?;
    result
}

impl JournalStore {
    pub fn list_trash(&self) -> Result<Vec<Entry>> {
        let mut stmt = self.conn.prepare(
            "SELECT id FROM entries WHERE trashed_at IS NOT NULL ORDER BY trashed_at DESC,id",
        )?;
        let ids = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.iter()
            .map(|id| entry(&self.conn, id)?.context("Entry disappeared"))
            .collect()
    }

    pub fn set_entry_trashed(
        &mut self,
        id: &str,
        expected_revision: &str,
        trashed: bool,
    ) -> Result<Entry> {
        validate_id(id)?;
        validate_id(expected_revision)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = entry(&tx, id)?.context("Entry not found")?;
        ensure!(
            current.working_revision_id == expected_revision,
            "Conflict: entry changed; reload before changing Trash"
        );
        if current.trashed_at.is_some() != trashed {
            let now = Utc::now().to_rfc3339();
            tx.execute(
                "UPDATE entries SET trashed_at=?1,updated_at=?2 WHERE id=?3",
                params![if trashed { Some(&now) } else { None }, now, id],
            )?;
            record_change(
                &tx,
                id,
                if trashed { "trash" } else { "untrash" },
                expected_revision,
            )?;
        }
        let result = entry(&tx, id)?.context("Entry disappeared")?;
        tx.commit()?;
        Ok(result)
    }

    pub fn purge_revision(
        &mut self,
        entry_id: &str,
        revision_id: &str,
        expected_revision: &str,
    ) -> Result<()> {
        validate_id(entry_id)?;
        validate_id(revision_id)?;
        validate_id(expected_revision)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = entry(&tx, entry_id)?.context("Entry not found")?;
        ensure!(
            current.working_revision_id == expected_revision,
            "Conflict: entry changed; reload before deleting a version"
        );
        ensure!(
            revision_id != current.working_revision_id
                && current.published_revision_id.as_deref() != Some(revision_id),
            "Cannot delete the working or finished version"
        );
        let removed = tx.execute(
            "DELETE FROM revisions WHERE id=?1 AND entry_id=?2",
            params![revision_id, entry_id],
        )?;
        ensure!(removed == 1, "Revision not found for this entry");
        record_change(&tx, entry_id, "purge_revision", revision_id)?;
        tx.commit()?;
        Ok(())
    }

    pub fn purge_entry(&mut self, id: &str, expected_revision: &str) -> Result<()> {
        validate_id(id)?;
        validate_id(expected_revision)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = entry(&tx, id)?.context("Entry not found")?;
        ensure!(
            current.working_revision_id == expected_revision,
            "Conflict: entry changed; reload before deleting"
        );
        ensure!(
            current.trashed_at.is_some(),
            "Move the entry to Trash before permanent deletion"
        );
        tx.execute("INSERT INTO purged_entries(entry_id,deleted_at,last_published_revision_id) VALUES(?1,?2,?3)",params![id,Utc::now().to_rfc3339(),current.published_revision_id])?;
        record_change(&tx, id, "purge_entry", expected_revision)?;
        tx.execute("DELETE FROM revisions WHERE entry_id=?1", [id])?;
        tx.execute("DELETE FROM entries WHERE id=?1", [id])?;
        tx.commit()?;
        Ok(())
    }
}
