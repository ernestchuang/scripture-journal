pub fn remove_deletion_schema(conn: &rusqlite::Connection) {
    conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
    conn.execute_batch("\
ALTER TABLE entries DROP COLUMN trashed_at;
DROP TABLE purged_entries;
CREATE TABLE revisions_old(
 id TEXT PRIMARY KEY,entry_id TEXT NOT NULL REFERENCES entries(id),parent_id TEXT,restored_from_id TEXT,
 created_at TEXT NOT NULL,content TEXT NOT NULL CHECK(json_valid(content)),UNIQUE(entry_id,id),
 FOREIGN KEY(entry_id,parent_id) REFERENCES revisions_old(entry_id,id),
 FOREIGN KEY(entry_id,restored_from_id) REFERENCES revisions_old(entry_id,id));
INSERT INTO revisions_old(rowid,id,entry_id,parent_id,restored_from_id,created_at,content)
 SELECT rowid,id,entry_id,parent_id,restored_from_id,created_at,content FROM revisions;
DROP TABLE revisions;
ALTER TABLE revisions_old RENAME TO revisions;
CREATE TRIGGER revisions_immutable BEFORE UPDATE ON revisions BEGIN SELECT RAISE(ABORT,'Revisions are immutable'); END;
CREATE TRIGGER revisions_retained BEFORE DELETE ON revisions BEGIN SELECT RAISE(ABORT,'Revision deletion is not implemented'); END;
CREATE TABLE changes_old(sequence INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL UNIQUE,entry_id TEXT NOT NULL REFERENCES entries(id),kind TEXT NOT NULL,revision_id TEXT NOT NULL REFERENCES revisions(id));
INSERT INTO changes_old SELECT * FROM changes;
DROP TABLE changes;
ALTER TABLE changes_old RENAME TO changes;
PRAGMA user_version=12;
").unwrap();
}
