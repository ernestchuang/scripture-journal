use super::*;
use fs2::FileExt;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
};
use tempfile::NamedTempFile;

const MANIFEST: &str = ".scripture-journal-export.json";
const MANIFEST_RECOVERY: &str = ".scripture-journal-manifest-recovery-";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub written: usize,
    pub unchanged: usize,
    pub conflicts: Vec<String>,
    pub directory: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    version: u32,
    journal_id: String,
    installation_id: String,
    receipts: BTreeMap<String, Receipt>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    hash: Option<String>,
    revision_id: Option<String>,
    pending_hash: Option<String>,
}

impl JournalStore {
    /// First slice: scans published heads. Unchanged bytes are never rewritten.
    /// Managed files only; not a distributed lock or an incremental release exporter.
    pub fn export_journal(&self, directory: &Path) -> Result<ExportReport> {
        ensure!(
            directory.is_absolute(),
            "Export destination must be absolute"
        );
        check_components(directory)?;
        fs::create_dir_all(directory)?;
        check_components(directory)?;
        let lock = open_regular(&directory.join(".scripture-journal-export.lock"), true)?;
        lock.try_lock_exclusive()
            .context("Another exporter is using this destination")?;
        let manifest_path = directory.join(MANIFEST);
        let initial = read_optional(&manifest_path)?;
        let mut manifest = if let Some(bytes) = &initial {
            serde_json::from_slice::<Manifest>(bytes)
                .context("Invalid export manifest; refusing overwrite")?
        } else {
            ensure!(
                !fs::read_dir(directory)?.any(|entry| entry
                    .map(|e| e
                        .file_name()
                        .to_string_lossy()
                        .starts_with(MANIFEST_RECOVERY))
                    .unwrap_or(true)),
                "Export manifest is missing but recovery files exist; repair explicitly"
            );
            Manifest {
                version: 1,
                journal_id: self.identity("journal_id")?,
                installation_id: self.identity("installation_id")?,
                receipts: BTreeMap::new(),
            }
        };
        ensure!(manifest.version == 1 && manifest.journal_id == self.identity("journal_id")? && manifest.installation_id == self.identity("installation_id")?, "Export belongs to another journal/device or unsupported format; choose a new destination");
        let mut manifest_bytes = initial;
        write_manifest(directory, &manifest, &mut manifest_bytes)?;
        // One SELECT pins the published snapshot set, including link eligibility.
        let mut stmt = self.conn.prepare("SELECT r.id,r.entry_id,r.parent_id,r.restored_from_id,r.created_at,r.content FROM entries e JOIN revisions r ON e.published_revision_id=r.id ORDER BY e.id")?;
        let revisions = stmt
            .query_map([], revision_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut report = ExportReport {
            written: 0,
            unchanged: 0,
            conflicts: vec![],
            directory: directory.display().to_string(),
        };
        for revision in &revisions {
            let result = export_one(
                directory,
                revision,
                &revisions,
                &mut manifest,
                &mut manifest_bytes,
            );
            match result {
                Ok(true) => report.written += 1,
                Ok(false) => report.unchanged += 1,
                Err(error) => report
                    .conflicts
                    .push(format!("{}: {error:#}", revision.entry_id)),
            }
        }
        Ok(report)
    }
}

fn export_one(
    directory: &Path,
    revision: &Revision,
    published: &[Revision],
    manifest: &mut Manifest,
    manifest_bytes: &mut Option<Vec<u8>>,
) -> Result<bool> {
    validate_id(&revision.entry_id)?;
    let target = directory.join(format!("{}.md", revision.entry_id));
    let output = render(revision, published)?;
    let expected = digest(output.as_bytes());
    let existing = read_optional(&target)?;
    let receipt = manifest.receipts.get(&revision.entry_id);
    match (&existing, receipt) {
        (Some(_), None) => bail!("Unowned file collision; file preserved"),
        (None, Some(r)) if r.hash.is_some() => {
            bail!("Previously exported file is missing; repair explicitly")
        }
        (Some(bytes), Some(r)) => {
            let actual = digest(bytes);
            ensure!(
                r.hash.as_deref() == Some(&actual) || r.pending_hash.as_deref() == Some(&actual),
                "Export changed externally; file preserved"
            );
            if actual == expected {
                let receipt = manifest.receipts.get_mut(&revision.entry_id).unwrap();
                receipt.hash = Some(expected);
                receipt.pending_hash = None;
                receipt.revision_id = Some(revision.id.clone());
                write_manifest(directory, manifest, manifest_bytes)?;
                return Ok(false);
            }
        }
        _ => {}
    }
    manifest
        .receipts
        .entry(revision.entry_id.clone())
        .or_default()
        .pending_hash = Some(expected.clone());
    write_manifest(directory, manifest, manifest_bytes)?;
    let mut temp = NamedTempFile::new_in(directory)?;
    temp.write_all(output.as_bytes())?;
    temp.as_file().sync_all()?;
    ensure!(
        read_optional(&target)? == existing,
        "Destination changed during export; file preserved"
    );
    if let Some(old_bytes) = &existing {
        // Preserve displaced bytes before installing a replacement. A crash can leave
        // the visible file missing; recovery bytes remain, and the next run conflicts.
        // There is no compare-and-swap against editors outside this application.
        let recovery = directory.join(".scripture-journal-recovery");
        check_components(&recovery)?;
        fs::create_dir_all(&recovery)?;
        let saved = recovery.join(format!("{}-{}.md", revision.entry_id, Uuid::new_v4()));
        fs::rename(&target, &saved)?;
        File::open(directory)?.sync_all()?;
        if read_optional(&saved)?.as_ref() != Some(old_bytes) {
            // Do not clobber a new target created by an outside editor.
            let _ = fs::hard_link(&saved, &target);
            bail!(
                "Concurrent edit detected; displaced file preserved at {}",
                saved.display()
            );
        }
    }
    temp.persist_noclobber(&target)
        .map_err(|e| e.error)
        .context("Destination appeared during export; recovery copy preserved")?;
    File::open(directory)?.sync_all()?;
    let receipt = manifest.receipts.get_mut(&revision.entry_id).unwrap();
    receipt.hash = Some(expected);
    receipt.pending_hash = None;
    receipt.revision_id = Some(revision.id.clone());
    write_manifest(directory, manifest, manifest_bytes)?;
    Ok(true)
}

fn render(revision: &Revision, published: &[Revision]) -> Result<String> {
    // JSON strings/arrays are valid YAML values and prevent frontmatter injection.
    let c = &revision.content;
    let mut text = format!("---\nformat: scripture-journal-v1\nentry_id: {}\nrevision_id: {}\ntitle: {}\ntags: {}\npassages: {}\n---\n\n{}\n", revision.entry_id, revision.id, serde_json::to_string(&c.title)?, serde_json::to_string(&c.tags)?, serde_json::to_string(&c.passages)?, c.body);
    if !c.links.is_empty() {
        text.push_str("\n## Related entries\n\n");
        for target in &c.links {
            if published.iter().any(|r| &r.entry_id == target) {
                text.push_str(&format!("- [Related entry]({target}.md)\n"));
            } else {
                text.push_str("- Unpublished or unavailable entry\n");
            }
        }
    }
    Ok(text)
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn check_components(path: &Path) -> Result<()> {
    let mut current = PathBuf::new();
    for part in path.components() {
        ensure!(
            !matches!(part, std::path::Component::ParentDir),
            "Parent traversal is not allowed"
        );
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => ensure!(
                !metadata.file_type().is_symlink(),
                "Symlink export destinations are not allowed"
            ),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

fn open_regular(path: &Path, create: bool) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(create).create(create);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        if create {
            options.mode(0o600);
        }
    }
    let file = options.open(path)?;
    ensure!(file.metadata()?.is_file(), "Expected a regular file");
    Ok(file)
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
        Ok(metadata) => {
            ensure!(
                metadata.is_file() && !metadata.file_type().is_symlink(),
                "Managed path is not a regular file"
            );
            ensure!(
                metadata.len() <= 64_000_000,
                "Managed file exceeds size limit"
            );
            let mut bytes = Vec::new();
            open_regular(path, false)?
                .take(64_000_001)
                .read_to_end(&mut bytes)?;
            ensure!(bytes.len() <= 64_000_000, "Managed file exceeds size limit");
            Ok(Some(bytes))
        }
    }
}

fn write_manifest(
    directory: &Path,
    manifest: &Manifest,
    previous: &mut Option<Vec<u8>>,
) -> Result<()> {
    let path = directory.join(MANIFEST);
    let bytes = serde_json::to_vec_pretty(manifest)?;
    if previous.as_ref() == Some(&bytes) {
        return Ok(());
    }
    ensure!(
        read_optional(&path)? == *previous,
        "Export manifest changed externally"
    );
    let mut temp = NamedTempFile::new_in(directory)?;
    temp.write_all(&bytes)?;
    temp.as_file().sync_all()?;
    ensure!(
        read_optional(&path)? == *previous,
        "Export manifest changed externally"
    );
    install_manifest(temp, directory, previous.as_deref())?;
    *previous = Some(bytes);
    Ok(())
}

// The caller has just checked the path, but an external writer can still race it.
// Move (rather than copy) the displaced inode so even a late edit is retained.
fn install_manifest(temp: NamedTempFile, directory: &Path, previous: Option<&[u8]>) -> Result<()> {
    let path = directory.join(MANIFEST);
    let mut recovery = None;
    if let Some(expected) = previous {
        let saved = directory.join(format!("{MANIFEST_RECOVERY}{}.json", Uuid::new_v4()));
        fs::rename(&path, &saved)?;
        File::open(directory)?.sync_all()?;
        let displaced = read_optional(&saved);
        if !matches!(&displaced, Ok(Some(bytes)) if bytes.as_slice() == expected) {
            let _ = fs::hard_link(&saved, &path);
            File::open(directory)?.sync_all()?;
            bail!(
                "Export manifest changed during replacement; displaced file preserved at {}",
                saved.display()
            );
        }
        recovery = Some(saved);
    }
    if let Err(error) = temp.persist_noclobber(&path) {
        if let Some(saved) = &recovery {
            // Restore only if the name is still vacant; never replace another writer.
            let _ = fs::hard_link(saved, &path);
        }
        File::open(directory)?.sync_all()?;
        return Err(error.error)
            .context("Export manifest appeared during replacement; recovery files preserved");
    }
    File::open(directory)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod manifest_tests {
    use super::*;

    fn staged(directory: &Path) -> NamedTempFile {
        let mut temp = NamedTempFile::new_in(directory).unwrap();
        temp.write_all(b"new manifest").unwrap();
        temp.as_file().sync_all().unwrap();
        temp
    }

    #[test]
    fn late_manifest_edit_is_preserved_and_reported() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(MANIFEST);
        fs::write(&path, b"checked manifest").unwrap();
        let temp = staged(dir.path());
        // Inject an external replacement after the caller's final precheck.
        fs::write(&path, b"external edit").unwrap();
        let error = install_manifest(temp, dir.path(), Some(b"checked manifest")).unwrap_err();
        assert!(error.to_string().contains("changed during replacement"));
        assert_eq!(fs::read(&path).unwrap(), b"external edit");
        let saved = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(MANIFEST_RECOVERY)
            })
            .unwrap();
        assert_eq!(fs::read(saved).unwrap(), b"external edit");
    }

    #[test]
    fn first_manifest_creation_does_not_clobber_a_late_collision() {
        let dir = tempfile::tempdir().unwrap();
        let temp = staged(dir.path());
        let path = dir.path().join(MANIFEST);
        fs::write(&path, b"external manifest").unwrap();
        assert!(install_manifest(temp, dir.path(), None).is_err());
        assert_eq!(fs::read(path).unwrap(), b"external manifest");
    }

    #[test]
    fn missing_manifest_with_displaced_recovery_requires_explicit_repair() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().canonicalize().unwrap().join("out");
        fs::create_dir(&out).unwrap();
        fs::write(
            out.join(format!("{MANIFEST_RECOVERY}interrupted.json")),
            b"retained manifest",
        )
        .unwrap();
        let store = JournalStore::open(&dir.path().join("journal.db")).unwrap();
        let error = store.export_journal(&out).unwrap_err();
        assert!(error.to_string().contains("repair explicitly"));
        assert!(!out.join(MANIFEST).exists());
    }
}
