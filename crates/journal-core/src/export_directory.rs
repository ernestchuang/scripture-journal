//! Unix export directory acquisition. Operations must stay relative to this handle.
use anyhow::{ensure, Result};
use std::{
    ffi::CString,
    fs::File,
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::ffi::OsStrExt,
    },
    path::{Component, Path},
};

pub(super) struct ExportDirectory(File);

pub(super) struct StagedFile<'a> {
    directory: &'a ExportDirectory,
    name: CString,
}

impl StagedFile<'_> {
    pub(super) fn install_noclobber(self, target: &str) -> Result<()> {
        let target = managed_name(target)?;
        // SAFETY: both names are single C-string leaves and the directory is live.
        // linkat fails if target exists, including a dangling symlink.
        let result = unsafe {
            libc::linkat(
                self.directory.0.as_raw_fd(),
                self.name.as_ptr(),
                self.directory.0.as_raw_fd(),
                target.as_ptr(),
                0,
            )
        };
        if result < 0 {
            return Err(io::Error::last_os_error().into());
        }
        self.directory.0.sync_all()?;
        Ok(())
    }
}

impl Drop for StagedFile<'_> {
    fn drop(&mut self) {
        // SAFETY: the borrowed directory outlives this single-leaf staging name.
        // A crash or cleanup failure may leave a temporary file, never a pruned revision.
        unsafe {
            libc::unlinkat(self.directory.0.as_raw_fd(), self.name.as_ptr(), 0);
        }
    }
}

fn managed_name(name: &str) -> Result<CString> {
    ensure!(
        !name.is_empty() && name != "." && name != ".." && !name.contains('/'),
        "Expected a single managed filename"
    );
    Ok(CString::new(name)?)
}

impl ExportDirectory {
    pub(super) fn open(path: &Path) -> Result<Self> {
        ensure!(path.is_absolute(), "Export destination must be absolute");
        ensure!(
            !path.components().any(|c| matches!(c, Component::ParentDir)),
            "Parent traversal is not allowed"
        );
        let mut directory = File::open("/")?;
        for component in path.components() {
            let Component::Normal(name) = component else {
                continue;
            };
            let name = CString::new(name.as_bytes())?;
            let open = || {
                // SAFETY: directory is live and name is a NUL-terminated component.
                let fd = unsafe {
                    libc::openat(
                        directory.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                if fd < 0 {
                    Err(io::Error::last_os_error())
                }
                // SAFETY: successful openat returns a new, owned descriptor.
                else {
                    Ok(unsafe { File::from_raw_fd(fd) })
                }
            };
            directory = match open() {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    // SAFETY: arguments reference the live parent and one component.
                    let result =
                        unsafe { libc::mkdirat(directory.as_raw_fd(), name.as_ptr(), 0o700) };
                    if result < 0 {
                        let error = io::Error::last_os_error();
                        if error.kind() != io::ErrorKind::AlreadyExists {
                            return Err(error.into());
                        }
                    }
                    // A concurrent symlink substitution is rejected by O_NOFOLLOW.
                    open()?
                }
                Err(error) => return Err(error.into()),
            };
        }
        Ok(Self(directory))
    }

    pub(super) fn open_child(&self, name: &str) -> Result<Self> {
        use rustix::fs::{mkdirat, openat, Mode, OFlags};
        let name = managed_name(name)?;
        let open = || {
            openat(
                &self.0,
                name.as_c_str(),
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
        };
        let fd = match open() {
            Ok(fd) => fd,
            Err(rustix::io::Errno::NOENT) => {
                match mkdirat(
                    &self.0,
                    name.as_c_str(),
                    Mode::RUSR | Mode::WUSR | Mode::XUSR,
                ) {
                    Ok(()) => self.sync()?,
                    Err(rustix::io::Errno::EXIST) => {}
                    Err(error) => return Err(error.into()),
                }
                open()?
            }
            Err(error) => return Err(error.into()),
        };
        Ok(Self(File::from(fd)))
    }

    /// Enumerate names in the held directory without following any entry.
    pub(super) fn contains_name_prefix(&self, prefix: &str) -> Result<bool> {
        for entry in rustix::fs::Dir::read_from(&self.0)? {
            if entry?.file_name().to_bytes().starts_with(prefix.as_bytes()) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Read one managed leaf without resolving the original directory path again.
    pub(super) fn read_optional(&self, name: &str) -> Result<Option<Vec<u8>>> {
        let name = managed_name(name)?;
        // SAFETY: self owns the live directory fd and name is one C-string leaf.
        let fd = unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            let error = io::Error::last_os_error();
            return if error.kind() == io::ErrorKind::NotFound {
                Ok(None)
            } else {
                Err(error.into())
            };
        }
        // SAFETY: successful openat returns a new descriptor owned by this File.
        let file = unsafe { File::from_raw_fd(fd) };
        let metadata = file.metadata()?;
        ensure!(metadata.is_file(), "Managed path is not a regular file");
        ensure!(
            metadata.len() <= 64_000_000,
            "Managed file exceeds size limit"
        );
        let mut bytes = Vec::new();
        file.take(64_000_001).read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= 64_000_000, "Managed file exceeds size limit");
        Ok(Some(bytes))
    }

    pub(super) fn stage(&self, bytes: &[u8]) -> Result<StagedFile<'_>> {
        let name = CString::new(format!(".scripture-journal-stage-{}", uuid::Uuid::new_v4()))?;
        // SAFETY: self owns the directory; name is a generated single C-string leaf.
        let fd = unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error().into());
        }
        // SAFETY: openat returned a new owned descriptor.
        let mut file = unsafe { File::from_raw_fd(fd) };
        let staged = StagedFile {
            directory: self,
            name,
        };
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok(staged)
    }

    pub(super) fn rename(&self, source: &str, target: &str) -> Result<()> {
        self.rename_to(source, self, target)
    }

    pub(super) fn rename_to(&self, source: &str, destination: &Self, target: &str) -> Result<()> {
        let source = managed_name(source)?;
        let target = managed_name(target)?;
        // SAFETY: single-leaf names are relative to their live directory handles.
        let result = unsafe {
            libc::renameat(
                self.0.as_raw_fd(),
                source.as_ptr(),
                destination.0.as_raw_fd(),
                target.as_ptr(),
            )
        };
        if result < 0 {
            return Err(io::Error::last_os_error().into());
        }
        destination.sync()?;
        self.sync()
    }

    pub(super) fn link_noclobber(&self, source: &str, target: &str) -> Result<()> {
        self.link_to_noclobber(source, self, target)
    }

    pub(super) fn link_to_noclobber(
        &self,
        source: &str,
        destination: &Self,
        target: &str,
    ) -> Result<()> {
        let source = managed_name(source)?;
        let target = managed_name(target)?;
        // SAFETY: single-leaf names are relative to their live directory handles.
        let result = unsafe {
            libc::linkat(
                self.0.as_raw_fd(),
                source.as_ptr(),
                destination.0.as_raw_fd(),
                target.as_ptr(),
                0,
            )
        };
        if result < 0 {
            return Err(io::Error::last_os_error().into());
        }
        destination.sync()
    }

    pub(super) fn sync(&self) -> Result<()> {
        Ok(self.0.sync_all()?)
    }

    pub(super) fn open_lock(&self) -> Result<File> {
        let name = c".scripture-journal-export.lock";
        // SAFETY: self owns the directory descriptor; name is a static C string.
        let fd = unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDWR
                    | libc::O_CREAT
                    | libc::O_NOFOLLOW
                    | libc::O_NONBLOCK
                    | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error().into());
        }
        // SAFETY: successful openat returns a new, owned descriptor.
        let file = unsafe { File::from_raw_fd(fd) };
        ensure!(file.metadata()?.is_file(), "Expected a regular lock file");
        Ok(file)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::symlink};

    #[test]
    fn child_acquisition_is_pinned_and_rejects_symlinks_and_unsafe_names() {
        let root = tempfile::tempdir().unwrap();
        let selected = root.path().canonicalize().unwrap().join("selected");
        let parent = ExportDirectory::open(&selected).unwrap();
        let moved = root.path().join("moved");
        let outside = root.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::rename(&selected, &moved).unwrap();
        symlink(&outside, &selected).unwrap();
        let child = parent.open_child("recovery").unwrap();
        child
            .stage(b"retained")
            .unwrap()
            .install_noclobber("entry")
            .unwrap();
        assert_eq!(fs::read(moved.join("recovery/entry")).unwrap(), b"retained");
        assert!(parent
            .open_child("recovery")
            .unwrap()
            .read_optional("entry")
            .unwrap()
            .is_some());
        symlink(&outside, moved.join("link")).unwrap();
        fs::write(moved.join("file"), b"not a directory").unwrap();
        for name in [
            "link",
            "file",
            "../outside",
            "/absolute",
            "nested/child",
            ".",
            "..",
            "",
            "bad\0name",
        ] {
            assert!(parent.open_child(name).is_err(), "accepted {name:?}");
        }
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    }

    #[test]
    fn enumeration_stays_pinned_and_restarts_each_scan() {
        use std::ffi::OsStr;
        let root = tempfile::tempdir().unwrap();
        let selected = root.path().canonicalize().unwrap().join("selected");
        let handle = ExportDirectory::open(&selected).unwrap();
        let moved = root.path().join("moved");
        let outside = root.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("recovery-outside"), b"outside").unwrap();
        fs::rename(&selected, &moved).unwrap();
        symlink(&outside, &selected).unwrap();
        assert!(!handle.contains_name_prefix("recovery-").unwrap());
        // A matching name is enough: no file read, UTF-8 conversion, or symlink following.
        let name = OsStr::from_bytes(b"recovery-\xff");
        symlink(outside.join("missing"), moved.join(name)).unwrap();
        for _ in 0..2 {
            assert!(handle.contains_name_prefix("recovery-").unwrap());
            assert!(!handle.contains_name_prefix("absent-").unwrap());
        }
        fs::remove_file(moved.join(name)).unwrap();
        assert!(!handle.contains_name_prefix("recovery-").unwrap());
        fs::create_dir(moved.join("recovery-directory")).unwrap();
        assert!(handle.contains_name_prefix("recovery-").unwrap());
        assert_eq!(
            fs::read(outside.join("recovery-outside")).unwrap(),
            b"outside"
        );
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
    }

    #[test]
    fn lock_stays_in_opened_directory_after_path_is_replaced() {
        let root = tempfile::tempdir().unwrap();
        let selected = root.path().canonicalize().unwrap().join("selected");
        let handle = ExportDirectory::open(&selected).unwrap();
        let moved = root.path().join("moved");
        let outside = root.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::rename(&selected, &moved).unwrap();
        symlink(&outside, &selected).unwrap();
        let lock = handle.open_lock().unwrap();
        assert!(lock.metadata().unwrap().is_file());
        assert!(moved.join(".scripture-journal-export.lock").exists());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        assert!(ExportDirectory::open(&selected).is_err());
    }

    #[test]
    fn traversal_and_symlink_ancestors_cannot_create_outside_directories() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let outside = base.join("outside");
        fs::create_dir(&outside).unwrap();
        symlink(&outside, base.join("link")).unwrap();
        assert!(ExportDirectory::open(&base.join("link/new")).is_err());
        assert!(!outside.join("new").exists());
        assert!(ExportDirectory::open(&base.join("created/../outside/new")).is_err());
        assert!(!base.join("created").exists());
    }
    #[test]
    fn reads_stay_in_pinned_directory_after_replacement() {
        let root = tempfile::tempdir().unwrap();
        let selected = root.path().canonicalize().unwrap().join("selected");
        let handle = ExportDirectory::open(&selected).unwrap();
        fs::write(selected.join("manifest.json"), b"original manifest").unwrap();
        let outside = root.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("manifest.json"), b"substituted manifest").unwrap();
        fs::write(outside.join("outside-only"), b"outside data").unwrap();
        fs::rename(&selected, root.path().join("moved")).unwrap();
        symlink(&outside, &selected).unwrap();
        assert_eq!(
            handle.read_optional("manifest.json").unwrap().unwrap(),
            b"original manifest"
        );
        assert!(handle.read_optional("outside-only").unwrap().is_none());
        assert_eq!(
            fs::read(outside.join("manifest.json")).unwrap(),
            b"substituted manifest"
        );
    }

    #[test]
    fn managed_reads_reject_symlinks_directories_and_unsafe_names() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let handle = ExportDirectory::open(&base).unwrap();
        fs::write(base.join("real"), b"fixture").unwrap();
        symlink(base.join("real"), base.join("link")).unwrap();
        symlink(base.join("absent"), base.join("dangling")).unwrap();
        fs::create_dir(base.join("directory")).unwrap();
        for name in [
            "link",
            "dangling",
            "directory",
            "",
            ".",
            "..",
            "../real",
            "/real",
            "directory/../real",
            "bad\0name",
        ] {
            assert!(handle.read_optional(name).is_err(), "must reject {name:?}");
        }
        assert!(handle.read_optional("absent").unwrap().is_none());
    }

    #[test]
    fn oversized_managed_read_is_rejected_before_allocation() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let handle = ExportDirectory::open(&base).unwrap();
        File::create(base.join("large"))
            .unwrap()
            .set_len(64_000_001)
            .unwrap();
        assert!(handle
            .read_optional("large")
            .unwrap_err()
            .to_string()
            .contains("size limit"));
    }
    #[test]
    fn staging_installation_and_cleanup_stay_pinned_after_directory_swaps() {
        for swap_before_staging in [true, false] {
            let root = tempfile::tempdir().unwrap();
            let selected = root.path().canonicalize().unwrap().join("selected");
            let handle = ExportDirectory::open(&selected).unwrap();
            let outside = root.path().join("outside");
            fs::create_dir(&outside).unwrap();
            let moved = root.path().join("moved");
            let swap = || {
                fs::rename(&selected, &moved).unwrap();
                symlink(&outside, &selected).unwrap();
            };
            if swap_before_staging {
                swap();
            }
            let staged = handle.stage(b"synthetic private output").unwrap();
            if !swap_before_staging {
                swap();
            }
            staged.install_noclobber("entry.md").unwrap();
            assert_eq!(
                fs::read(moved.join("entry.md")).unwrap(),
                b"synthetic private output"
            );
            assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
            assert_eq!(fs::read_dir(&moved).unwrap().count(), 1);
            drop(handle.stage(b"abandoned output").unwrap());
            assert_eq!(fs::read_dir(&moved).unwrap().count(), 1);
        }
    }

    #[test]
    fn staged_installation_preserves_collisions_and_rejects_escape_names() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let handle = ExportDirectory::open(&base).unwrap();
        fs::write(base.join("entry.md"), b"external bytes").unwrap();
        symlink(base.join("absent"), base.join("link")).unwrap();
        for target in [
            "entry.md",
            "link",
            "../escape",
            "/escape",
            "",
            ".",
            "..",
            "bad\0name",
        ] {
            assert!(handle
                .stage(b"new bytes")
                .unwrap()
                .install_noclobber(target)
                .is_err());
        }
        assert_eq!(fs::read(base.join("entry.md")).unwrap(), b"external bytes");
        assert!(fs::symlink_metadata(base.join("link"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_dir(&base).unwrap().count(), 2);
    }
}
