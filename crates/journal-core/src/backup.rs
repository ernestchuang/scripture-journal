use anyhow::{bail, Context, Result};
use rusqlite::{backup::Backup, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    format_version: u32,
    database: String,
    sha256: String,
}

pub fn create(source: &Path, destination: &Path) -> Result<()> {
    let temp = destination.with_extension("sjbackup.tmp");
    if temp.exists() {
        fs::remove_dir_all(&temp)?;
    }
    fs::create_dir(&temp)?;
    let db_path = temp.join("journal.sqlite3");
    let source = Connection::open(source)?;
    let mut target = Connection::open(&db_path)?;
    Backup::new(&source, &mut target)?.run_to_completion(
        128,
        std::time::Duration::from_millis(5),
        None,
    )?;
    drop(target);
    validate_db(&db_path)?;
    let manifest = Manifest {
        format_version: 1,
        database: "journal.sqlite3".into(),
        sha256: checksum(&db_path)?,
    };
    fs::write(
        temp.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    if destination.exists() {
        bail!("Backup destination already exists");
    }
    fs::rename(temp, destination)?;
    Ok(())
}

pub fn stage_restore(backup: &Path, staged: &Path) -> Result<()> {
    let manifest: Manifest = serde_json::from_slice(&fs::read(backup.join("manifest.json"))?)?;
    if manifest.format_version != 1 || manifest.database != "journal.sqlite3" {
        bail!("Unsupported backup format");
    }
    let source = backup.join(&manifest.database);
    if checksum(&source)? != manifest.sha256 {
        bail!("Backup checksum does not match");
    }
    validate_db(&source)?;
    let temp = staged.with_extension("tmp");
    fs::copy(&source, &temp)?;
    validate_db(&temp)?;
    fs::rename(temp, staged)?;
    Ok(())
}

pub fn activate_pending(live: &Path, staged: &Path) -> Result<bool> {
    if !staged.exists() {
        return Ok(false);
    }
    validate_db(staged)?;
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
    let recovery = live.with_extension(format!("pre-restore-{stamp}.sqlite3"));
    create(
        live,
        &live.with_extension(format!("pre-restore-{stamp}.sjbackup")),
    )?;
    fs::rename(live, &recovery)?;
    if let Err(error) = fs::rename(staged, live) {
        fs::rename(recovery, live)?;
        return Err(error.into());
    }
    fs::remove_file(recovery)?;
    Ok(true)
}

fn validate_db(path: &Path) -> Result<()> {
    let connection = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let integrity: String = connection.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if integrity != "ok" {
        bail!("Backup database failed integrity check");
    }
    connection.pragma_update(None, "foreign_keys", true)?;
    let violations: i64 =
        connection.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })?;
    if violations != 0 {
        bail!("Backup database has invalid relationships");
    }
    drop(connection);
    super::JournalStore::open(path).context("Backup journal schema is unsupported")?;
    Ok(())
}
fn checksum(path: &Path) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(fs::read(path)?)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::JournalStore;

    #[test]
    fn online_backup_includes_wal_and_valid_restore_stages() {
        let root = tempfile::tempdir().unwrap();
        let live = root.path().join("journal.sqlite3");
        let _store = JournalStore::open(&live).unwrap();
        let writer = Connection::open(&live).unwrap();
        writer.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE backup_probe(value TEXT); INSERT INTO backup_probe VALUES('retained');").unwrap();
        let package = root.path().join("journal.sjbackup");
        create(&live, &package).unwrap();
        let snapshot = Connection::open(package.join("journal.sqlite3")).unwrap();
        assert_eq!(
            snapshot
                .query_row("SELECT value FROM backup_probe", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "retained"
        );
        let staged = root.path().join("restore-pending.sqlite3");
        stage_restore(&package, &staged).unwrap();
        assert!(JournalStore::open(&staged).is_ok());
    }

    #[test]
    fn corrupt_restore_never_changes_existing_or_staged_journal() {
        let root = tempfile::tempdir().unwrap();
        let live = root.path().join("journal.sqlite3");
        drop(JournalStore::open(&live).unwrap());
        let original = fs::read(&live).unwrap();
        let package = root.path().join("journal.sjbackup");
        create(&live, &package).unwrap();
        fs::write(package.join("journal.sqlite3"), b"corrupt").unwrap();
        let staged = root.path().join("restore-pending.sqlite3");
        assert!(stage_restore(&package, &staged).is_err());
        assert!(!staged.exists());
        assert_eq!(fs::read(live).unwrap(), original);
    }

    #[test]
    fn valid_restore_activates_with_a_verified_pre_replace_backup() {
        let root = tempfile::tempdir().unwrap();
        let live = root.path().join("journal.sqlite3");
        drop(JournalStore::open(&live).unwrap());
        let source = root.path().join("incoming.sqlite3");
        drop(JournalStore::open(&source).unwrap());
        Connection::open(&source).unwrap().execute_batch("CREATE TABLE restore_probe(value TEXT); INSERT INTO restore_probe VALUES('restored');").unwrap();
        let package = root.path().join("incoming.sjbackup");
        create(&source, &package).unwrap();
        let staged = root.path().join("restore-pending.sqlite3");
        stage_restore(&package, &staged).unwrap();
        assert!(activate_pending(&live, &staged).unwrap());
        assert_eq!(
            Connection::open(&live)
                .unwrap()
                .query_row("SELECT value FROM restore_probe", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "restored"
        );
        assert!(root.path().read_dir().unwrap().any(|entry| {
            let path = entry.unwrap().path();
            path.file_name()
                .is_some_and(|name| name.to_string_lossy().contains("pre-restore"))
                && path.extension().is_some_and(|e| e == "sjbackup")
        }));
    }
}
