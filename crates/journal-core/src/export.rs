use super::*;
use fs2::FileExt;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, path::PathBuf};
#[cfg(not(unix))]
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
};
#[cfg(not(unix))]
use tempfile::NamedTempFile;

#[cfg(unix)]
use super::export_directory::{ExportDirectory as ManifestDirectory, StagedFile};
#[cfg(not(unix))]
type ManifestDirectory = Path;

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
        #[cfg(unix)]
        let directory_handle = super::export_directory::ExportDirectory::open(directory)?;
        #[cfg(unix)]
        let lock = directory_handle.open_lock()?;
        #[cfg(not(unix))]
        let lock = {
            fs::create_dir_all(directory)?;
            check_components(directory)?;
            open_regular(&directory.join(".scripture-journal-export.lock"), true)?
        };
        lock.try_lock_exclusive()
            .context("Another exporter is using this destination")?;
        #[cfg(unix)]
        let initial = directory_handle.read_optional(MANIFEST)?;
        #[cfg(not(unix))]
        let initial = read_optional(&directory.join(MANIFEST))?;
        let mut manifest = if let Some(bytes) = &initial {
            serde_json::from_slice::<Manifest>(bytes)
                .context("Invalid export manifest; refusing overwrite")?
        } else {
            #[cfg(unix)]
            let recovery_exists = directory_handle.contains_name_prefix(MANIFEST_RECOVERY)?;
            #[cfg(not(unix))]
            let recovery_exists = fs::read_dir(directory)?.any(|entry| {
                entry
                    .map(|e| {
                        e.file_name()
                            .to_string_lossy()
                            .starts_with(MANIFEST_RECOVERY)
                    })
                    .unwrap_or(true)
            });
            ensure!(
                !recovery_exists,
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
        #[cfg(unix)]
        let manifest_directory = &directory_handle;
        #[cfg(not(unix))]
        let manifest_directory = directory;
        let mut manifest_bytes = initial;
        write_manifest(manifest_directory, &manifest, &mut manifest_bytes)?;
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
                manifest_directory,
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
    #[cfg_attr(unix, allow(unused_variables))] directory: &Path,
    manifest_directory: &ManifestDirectory,
    revision: &Revision,
    published: &[Revision],
    manifest: &mut Manifest,
    manifest_bytes: &mut Option<Vec<u8>>,
) -> Result<bool> {
    validate_id(&revision.entry_id)?;
    let name = format!("{}.md", revision.entry_id);
    #[cfg(not(unix))]
    let target = directory.join(&name);
    let output = render(revision, published)?;
    let expected = digest(output.as_bytes());
    #[cfg(unix)]
    let read_target = || manifest_directory.read_optional(&name);
    #[cfg(not(unix))]
    let read_target = || read_optional(&target);
    let existing = read_target()?;
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
                write_manifest(manifest_directory, manifest, manifest_bytes)?;
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
    write_manifest(manifest_directory, manifest, manifest_bytes)?;
    #[cfg(unix)]
    let temp = manifest_directory.stage(output.as_bytes())?;
    #[cfg(not(unix))]
    let temp = {
        let mut temp = NamedTempFile::new_in(directory)?;
        temp.write_all(output.as_bytes())?;
        temp.as_file().sync_all()?;
        temp
    };
    ensure!(
        read_target()? == existing,
        "Destination changed during export; file preserved"
    );
    #[cfg(unix)]
    if let Some(old_bytes) = &existing {
        let recovery = manifest_directory.open_child(".scripture-journal-recovery")?;
        displace_entry(manifest_directory, &recovery, &name, old_bytes)?;
    }
    #[cfg(not(unix))]
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
    #[cfg(unix)]
    temp.install_noclobber(&name)
        .context("Destination appeared during export; recovery copy preserved")?;
    #[cfg(not(unix))]
    {
        temp.persist_noclobber(&target)
            .map_err(|e| e.error)
            .context("Destination appeared during export; recovery copy preserved")?;
        File::open(directory)?.sync_all()?;
    }
    let receipt = manifest.receipts.get_mut(&revision.entry_id).unwrap();
    receipt.hash = Some(expected);
    receipt.pending_hash = None;
    receipt.revision_id = Some(revision.id.clone());
    write_manifest(manifest_directory, manifest, manifest_bytes)?;
    Ok(true)
}

#[cfg(unix)]
fn displace_entry(
    directory: &ManifestDirectory,
    recovery: &ManifestDirectory,
    name: &str,
    expected: &[u8],
) -> Result<()> {
    let saved = format!("{}-{}.md", name.trim_end_matches(".md"), Uuid::new_v4());
    directory.rename_to(name, recovery, &saved)?;
    let displaced = recovery.read_optional(&saved);
    if !matches!(&displaced, Ok(Some(bytes)) if bytes.as_slice() == expected) {
        // Restore only to a vacant name; always retain the displaced inode.
        let _ = recovery.link_to_noclobber(&saved, directory, name);
        bail!("Concurrent edit detected; displaced file preserved in recovery as {saved}");
    }
    Ok(())
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

#[cfg(not(unix))]
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

#[cfg(not(unix))]
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

#[cfg(unix)]
fn write_manifest(
    directory: &ManifestDirectory,
    manifest: &Manifest,
    previous: &mut Option<Vec<u8>>,
) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(manifest)?;
    if previous.as_ref() == Some(&bytes) {
        return Ok(());
    }
    ensure!(
        directory.read_optional(MANIFEST)? == *previous,
        "Export manifest changed externally"
    );
    let temp = directory.stage(&bytes)?;
    ensure!(
        directory.read_optional(MANIFEST)? == *previous,
        "Export manifest changed externally"
    );
    install_manifest(temp, directory, previous.as_deref())?;
    *previous = Some(bytes);
    Ok(())
}

#[cfg(unix)]
fn install_manifest(
    temp: StagedFile<'_>,
    directory: &ManifestDirectory,
    previous: Option<&[u8]>,
) -> Result<()> {
    let mut recovery = None;
    if let Some(expected) = previous {
        let saved = format!("{MANIFEST_RECOVERY}{}.json", Uuid::new_v4());
        directory.rename(MANIFEST, &saved)?;
        let displaced = directory.read_optional(&saved);
        if !matches!(&displaced, Ok(Some(bytes)) if bytes.as_slice() == expected) {
            let _ = directory.link_noclobber(&saved, MANIFEST);
            directory.sync()?;
            bail!(
                "Export manifest changed during replacement; displaced file preserved as {saved}"
            );
        }
        recovery = Some(saved);
    }
    if let Err(error) = temp.install_noclobber(MANIFEST) {
        if let Some(saved) = &recovery {
            let _ = directory.link_noclobber(saved, MANIFEST);
        }
        directory.sync()?;
        return Err(error)
            .context("Export manifest appeared during replacement; recovery files preserved");
    }
    directory.sync()
}

#[cfg(not(unix))]
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
#[cfg(not(unix))]
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

    #[cfg(not(unix))]
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
        #[cfg(unix)]
        let handle = ManifestDirectory::open(&dir.path().canonicalize().unwrap()).unwrap();
        #[cfg(unix)]
        let directory = &handle;
        #[cfg(not(unix))]
        let directory = dir.path();
        #[cfg(unix)]
        let temp = directory.stage(b"new manifest").unwrap();
        #[cfg(not(unix))]
        let temp = staged(directory);
        // Inject an external replacement after the caller's final precheck.
        fs::write(&path, b"external edit").unwrap();
        let error = install_manifest(temp, directory, Some(b"checked manifest")).unwrap_err();
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
        #[cfg(unix)]
        let handle = ManifestDirectory::open(&dir.path().canonicalize().unwrap()).unwrap();
        #[cfg(unix)]
        let directory = &handle;
        #[cfg(not(unix))]
        let directory = dir.path();
        #[cfg(unix)]
        let temp = directory.stage(b"new manifest").unwrap();
        #[cfg(not(unix))]
        let temp = staged(directory);
        let path = dir.path().join(MANIFEST);
        fs::write(&path, b"external manifest").unwrap();
        assert!(install_manifest(temp, directory, None).is_err());
        assert_eq!(fs::read(path).unwrap(), b"external manifest");
    }

    #[cfg(unix)]
    #[test]
    fn entry_displacement_and_restoration_use_both_pinned_directories() {
        for late_edit in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let base = root.path().canonicalize().unwrap();
            let selected = base.join("selected");
            let moved = base.join("moved");
            let outside = base.join("outside");
            let directory = ManifestDirectory::open(&selected).unwrap();
            let recovery = directory.open_child(".scripture-journal-recovery").unwrap();
            let retained = base.join("retained");
            fs::create_dir(&outside).unwrap();
            fs::write(outside.join("entry.md"), b"outside").unwrap();
            fs::rename(selected.join(".scripture-journal-recovery"), &retained).unwrap();
            std::os::unix::fs::symlink(&outside, selected.join(".scripture-journal-recovery"))
                .unwrap();
            fs::rename(&selected, &moved).unwrap();
            std::os::unix::fs::symlink(&outside, &selected).unwrap();
            let actual: &[u8] = if late_edit { b"late edit" } else { b"original" };
            fs::write(moved.join("entry.md"), actual).unwrap();
            let result = displace_entry(&directory, &recovery, "entry.md", b"original");
            if late_edit {
                assert!(result.unwrap_err().to_string().contains("Concurrent edit"));
                assert_eq!(fs::read(moved.join("entry.md")).unwrap(), actual);
            } else {
                result.unwrap();
                assert!(!moved.join("entry.md").exists());
                directory
                    .stage(b"replacement")
                    .unwrap()
                    .install_noclobber("entry.md")
                    .unwrap();
                assert_eq!(fs::read(moved.join("entry.md")).unwrap(), b"replacement");
            }
            let saved: Vec<_> = fs::read_dir(&retained)
                .unwrap()
                .map(|e| e.unwrap().path())
                .collect();
            assert_eq!(saved.len(), 1);
            assert_eq!(fs::read(&saved[0]).unwrap(), actual);
            // Restoration cannot clobber an independently created target.
            fs::write(moved.join("entry.md"), b"new occupant").unwrap();
            assert!(recovery
                .link_to_noclobber(
                    saved[0].file_name().unwrap().to_str().unwrap(),
                    &directory,
                    "entry.md"
                )
                .is_err());
            assert_eq!(fs::read(moved.join("entry.md")).unwrap(), b"new occupant");
            assert_eq!(fs::read(outside.join("entry.md")).unwrap(), b"outside");
            assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
        }
    }

    #[cfg(unix)]
    #[test]
    fn entry_creation_reads_and_conflicts_stay_pinned_after_directory_swap() {
        for state in ["new", "unchanged", "edited", "updated"] {
            let root = tempfile::tempdir().unwrap();
            let base = root.path().canonicalize().unwrap();
            let selected = base.join("selected");
            let moved = base.join("moved");
            let outside = base.join("outside");
            let handle = ManifestDirectory::open(&selected).unwrap();
            let revision = Revision {
                id: Uuid::new_v4().to_string(),
                entry_id: Uuid::new_v4().to_string(),
                parent_id: None,
                restored_from_id: None,
                created_at: "2026-09-17T00:00:00Z".into(),
                content: EntryContent {
                    body: "Synthetic private reflection".into(),
                    ..Default::default()
                },
            };
            let published = std::slice::from_ref(&revision);
            let name = format!("{}.md", revision.entry_id);
            let output = render(&revision, published).unwrap();
            let mut manifest = Manifest {
                version: 1,
                journal_id: "synthetic journal".into(),
                installation_id: "synthetic installation".into(),
                receipts: BTreeMap::new(),
            };
            let mut previous = None;
            if state != "new" {
                assert!(export_one(
                    &selected,
                    &handle,
                    &revision,
                    published,
                    &mut manifest,
                    &mut previous
                )
                .unwrap());
            }
            if state == "edited" {
                fs::write(selected.join(&name), b"retained external edit").unwrap();
            }
            let original_output = output.clone();
            let mut revision = revision.clone();
            if state == "updated" {
                revision.parent_id = Some(revision.id.clone());
                revision.id = Uuid::new_v4().to_string();
                revision.content.body = "Updated synthetic reflection".into();
            }
            let published = std::slice::from_ref(&revision);
            let output = render(&revision, published).unwrap();
            fs::create_dir(&outside).unwrap();
            fs::write(outside.join(&name), b"outside entry").unwrap();
            fs::write(outside.join(MANIFEST), b"outside manifest").unwrap();
            fs::rename(&selected, &moved).unwrap();
            std::os::unix::fs::symlink(&outside, &selected).unwrap();
            let result = export_one(
                &selected,
                &handle,
                &revision,
                published,
                &mut manifest,
                &mut previous,
            );
            if state == "edited" {
                assert!(result
                    .unwrap_err()
                    .to_string()
                    .contains("changed externally"));
                assert_eq!(
                    fs::read(moved.join(&name)).unwrap(),
                    b"retained external edit"
                );
            } else {
                assert_eq!(result.unwrap(), state == "new" || state == "updated");
                assert_eq!(fs::read(moved.join(&name)).unwrap(), output.as_bytes());
                let saved: Manifest =
                    serde_json::from_slice(&fs::read(moved.join(MANIFEST)).unwrap()).unwrap();
                assert_eq!(
                    saved.receipts[&revision.entry_id].hash.as_deref(),
                    Some(digest(output.as_bytes()).as_str())
                );
                assert!(saved.receipts[&revision.entry_id].pending_hash.is_none());
            }
            if state == "updated" {
                let recovered: Vec<_> = fs::read_dir(moved.join(".scripture-journal-recovery"))
                    .unwrap()
                    .map(|entry| entry.unwrap().path())
                    .collect();
                assert_eq!(recovered.len(), 1);
                assert_eq!(fs::read(&recovered[0]).unwrap(), original_output.as_bytes());
                assert!(!export_one(
                    &selected,
                    &handle,
                    &revision,
                    published,
                    &mut manifest,
                    &mut previous
                )
                .unwrap());
            }
            assert_eq!(fs::read(outside.join(&name)).unwrap(), b"outside entry");
            assert_eq!(
                fs::read(outside.join(MANIFEST)).unwrap(),
                b"outside manifest"
            );
            assert_eq!(fs::read_dir(&outside).unwrap().count(), 2);
            assert!(!fs::read_dir(&moved).unwrap().any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".scripture-journal-stage-")));
        }
    }

    #[cfg(unix)]
    #[test]
    fn manifest_writes_and_recovery_stay_pinned_after_directory_replacement() {
        for existing in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let base = root.path().canonicalize().unwrap();
            let selected = base.join("selected");
            let moved = base.join("moved");
            let outside = base.join("outside");
            let handle = ManifestDirectory::open(&selected).unwrap();
            let mut manifest = Manifest {
                version: 1,
                journal_id: "test journal".into(),
                installation_id: "test installation".into(),
                receipts: BTreeMap::new(),
            };
            let mut previous = None;
            if existing {
                write_manifest(&handle, &manifest, &mut previous).unwrap();
            }
            let old_bytes = previous.clone();
            fs::create_dir(&outside).unwrap();
            fs::write(outside.join(MANIFEST), b"outside manifest").unwrap();
            fs::rename(&selected, &moved).unwrap();
            std::os::unix::fs::symlink(&outside, &selected).unwrap();
            manifest.receipts.insert("entry".into(), Receipt::default());
            write_manifest(&handle, &manifest, &mut previous).unwrap();
            assert_eq!(fs::read(moved.join(MANIFEST)).unwrap(), previous.unwrap());
            assert_eq!(
                fs::read(outside.join(MANIFEST)).unwrap(),
                b"outside manifest"
            );
            assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
            let retained: Vec<_> = fs::read_dir(&moved)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .filter(|path| {
                    path.file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with(MANIFEST_RECOVERY)
                })
                .collect();
            assert_eq!(retained.len(), usize::from(existing));
            if let Some(old_bytes) = old_bytes {
                assert_eq!(fs::read(&retained[0]).unwrap(), old_bytes);
            }
            // Only the installed manifest and, for replacement, its recovery remain.
            assert_eq!(
                fs::read_dir(&moved).unwrap().count(),
                1 + usize::from(existing)
            );
        }
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
