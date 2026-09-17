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
    if previous.is_none() {
        temp.persist_noclobber(&path).map_err(|e| e.error)?;
    } else {
        temp.persist(&path).map_err(|e| e.error)?;
    }
    File::open(directory)?.sync_all()?;
    *previous = Some(bytes);
    Ok(())
}
