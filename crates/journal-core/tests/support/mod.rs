pub fn remove_deletion_schema(conn: &rusqlite::Connection) {
    conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
    remove_adoption_schema(conn);
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

fn remove_adoption_schema(conn: &rusqlite::Connection) {
    assert_eq!(
        conn.query_row("SELECT count(*) FROM plan_adoption_events", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0,
        "Historical fixtures cannot contain later adoption events"
    );
    conn.execute_batch("\
CREATE TEMP TABLE saved_assignments AS SELECT id,enrollment_id,definition_version_id,definition_day,local_date,passages FROM plan_calendar_assignments;
CREATE TEMP TABLE saved_completions AS SELECT * FROM plan_calendar_completions;
CREATE TEMP TABLE saved_undos AS SELECT * FROM plan_calendar_completion_undos;
DROP TABLE plan_calendar_assignment_supersessions;
DROP TABLE plan_stream_adoption_boundaries;
DROP TABLE plan_adoption_events;
DROP TABLE plan_calendar_completion_undos;
DROP TABLE plan_calendar_completions;
DROP TABLE plan_calendar_assignments;
DROP TABLE plan_calendar_assignment_generations;
").unwrap();
    conn.execute_batch(include_str!("schema12_calendar.sql"))
        .unwrap();
    conn.execute_batch(
        "DROP TRIGGER plan_calendar_completion_active;
INSERT INTO plan_calendar_assignments SELECT * FROM saved_assignments;
INSERT INTO plan_calendar_completions SELECT * FROM saved_completions;
INSERT INTO plan_calendar_completion_undos SELECT * FROM saved_undos;
DROP TABLE saved_assignments; DROP TABLE saved_completions; DROP TABLE saved_undos;",
    )
    .unwrap();
    conn.execute_batch(include_str!("schema12_calendar.sql"))
        .unwrap();
}
