use anyhow::{bail, ensure, Context, Result};
use rusqlite::{backup::Backup, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, io::Read, path::Path};

pub type PortablePreferences = BTreeMap<String, String>;
pub const PORTABLE_PREFERENCE_KEYS: [&str; 4] = [
    "scripture-journal.appearance",
    "scripture-journal.custom-themes",
    "scripture-journal.reader-location",
    "scripture-journal.translation",
];

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    format_version: u32,
    database: String,
    sha256: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    preferences: PortablePreferences,
}

pub fn create(source: &Path, destination: &Path, preferences: PortablePreferences) -> Result<()> {
    validate_preferences(&preferences)?;
    let parent = destination
        .parent()
        .context("Backup destination needs a parent")?;
    let temp = tempfile::Builder::new()
        .prefix(".scripture-journal-backup-")
        .tempdir_in(parent)?;
    let db_path = temp.path().join("journal.sqlite3");
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
        preferences,
    };
    fs::write(
        temp.path().join("manifest.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    fs::File::open(&db_path)?.sync_all()?;
    fs::File::open(temp.path().join("manifest.json"))?.sync_all()?;
    sync_directory(temp.path())?;
    if destination.exists() {
        bail!("Backup destination already exists");
    }
    fs::rename(temp.keep(), destination)?;
    sync_directory(parent)?;
    Ok(())
}

pub fn stage_restore(backup: &Path, staged: &Path) -> Result<PortablePreferences> {
    let manifest_path = backup.join("manifest.json");
    ensure!(
        fs::metadata(&manifest_path)?.is_file(),
        "Backup manifest must be a regular file"
    );
    let mut manifest_bytes = Vec::new();
    fs::File::open(&manifest_path)?
        .take(1_048_577)
        .read_to_end(&mut manifest_bytes)?;
    ensure!(
        manifest_bytes.len() <= 1_048_576,
        "Backup manifest exceeds size limit"
    );
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes)?;
    if manifest.format_version != 1 || manifest.database != "journal.sqlite3" {
        bail!("Unsupported backup format");
    }
    validate_preferences(&manifest.preferences)?;
    let source = backup.join(&manifest.database);
    if checksum(&source)? != manifest.sha256 {
        bail!("Backup checksum does not match");
    }
    let parent = staged.parent().context("Restore staging needs a parent")?;
    let temp_dir = tempfile::Builder::new()
        .prefix(".scripture-journal-restore-")
        .tempdir_in(parent)?;
    let temp = temp_dir.path().join("journal.sqlite3");
    fs::copy(&source, &temp)?;
    ensure!(
        checksum(&temp)? == manifest.sha256,
        "Copied backup checksum does not match"
    );
    validate_db(&temp)?;
    if staged.exists() {
        bail!("A restore is already pending");
    }
    fs::rename(&temp, staged)?;
    fs::File::open(staged)?.sync_all()?;
    sync_directory(parent)?;
    Ok(manifest.preferences)
}

pub fn activate_pending(live: &Path, staged: &Path) -> Result<bool> {
    if !staged.exists() {
        return Ok(false);
    }
    if let Err(error) = validate_db(staged) {
        let quarantine = staged.with_extension(format!("invalid-{}.sqlite3", uuid::Uuid::new_v4()));
        fs::rename(staged, quarantine)?;
        return Err(
            error.context("Pending restore was quarantined; current journal remains active")
        );
    }
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
    create(
        live,
        &live.with_extension(format!("pre-restore-{stamp}.sjbackup")),
        PortablePreferences::new(),
    )?;
    // On supported Unix targets rename atomically replaces the live directory entry.
    // The old bytes are already durably retained in the verified pre-restore package.
    fs::File::open(staged)?.sync_all()?;
    let parent = live.parent().context("Journal path needs a parent")?;
    sync_directory(parent)?;
    fs::rename(staged, live)?;
    sync_directory(parent)?;
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
    ensure!(
        fs::metadata(path)?.is_file(),
        "Backup database must be a regular file"
    );
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 65_536];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn sync_directory(path: &Path) -> Result<()> {
    fs::File::open(path)?.sync_all()?;
    Ok(())
}

fn validate_preferences(preferences: &PortablePreferences) -> Result<()> {
    ensure!(
        preferences.len() <= PORTABLE_PREFERENCE_KEYS.len(),
        "Too many portable preferences"
    );
    let mut total = 0usize;
    for (key, value) in preferences {
        ensure!(
            PORTABLE_PREFERENCE_KEYS.contains(&key.as_str()),
            "Unsupported portable preference"
        );
        ensure!(value.len() <= 48 * 1024, "Portable preference is too large");
        total = total.saturating_add(key.len()).saturating_add(value.len());
    }
    ensure!(total <= 64 * 1024, "Portable preferences are too large");
    Ok(())
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
        create(&live, &package, PortablePreferences::new()).unwrap();
        let source_bytes = fs::read(package.join("journal.sqlite3")).unwrap();
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
        assert_eq!(
            fs::read(package.join("journal.sqlite3")).unwrap(),
            source_bytes
        );
        assert!(JournalStore::open(&staged).is_ok());
    }

    #[test]
    fn corrupt_restore_never_changes_existing_or_staged_journal() {
        let root = tempfile::tempdir().unwrap();
        let live = root.path().join("journal.sqlite3");
        drop(JournalStore::open(&live).unwrap());
        let original = fs::read(&live).unwrap();
        let package = root.path().join("journal.sjbackup");
        create(&live, &package, PortablePreferences::new()).unwrap();
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
        create(&source, &package, PortablePreferences::new()).unwrap();
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

    #[test]
    fn invalid_pending_is_quarantined_and_live_journal_remains_openable() {
        let root = tempfile::tempdir().unwrap();
        let live = root.path().join("journal.sqlite3");
        drop(JournalStore::open(&live).unwrap());
        let staged = root.path().join("restore-pending.sqlite3");
        fs::write(&staged, b"broken pending restore").unwrap();
        assert!(activate_pending(&live, &staged).is_err());
        assert!(JournalStore::open(&live).is_ok());
        assert!(!staged.exists());
        assert!(root.path().read_dir().unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("restore-pending.invalid-")));
    }

    #[test]
    fn portable_preferences_round_trip_and_reject_unapproved_keys() {
        let root = tempfile::tempdir().unwrap();
        let live = root.path().join("journal.sqlite3");
        drop(JournalStore::open(&live).unwrap());
        let package = root.path().join("journal.sjbackup");
        let preferences = BTreeMap::from([
            ("scripture-journal.appearance".into(), "theme:quiet".into()),
            (
                "scripture-journal.reader-location".into(),
                r#"{"book":43,"chapter":3}"#.into(),
            ),
        ]);
        create(&live, &package, preferences.clone()).unwrap();
        let restored = stage_restore(&package, &root.path().join("pending.sqlite3")).unwrap();
        assert_eq!(restored, preferences);

        let unapproved =
            BTreeMap::from([("scripture-journal.export-path".into(), "/secret".into())]);
        assert!(create(&live, &root.path().join("invalid.sjbackup"), unapproved).is_err());
    }
}
