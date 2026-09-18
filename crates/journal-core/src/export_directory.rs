//! Unix export directory acquisition. Operations must stay relative to this handle.
use anyhow::{ensure, Result};
use std::{
    ffi::CString,
    fs::File,
    io::{self, Read},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::ffi::OsStrExt,
    },
    path::{Component, Path},
};

pub(super) struct ExportDirectory(File);

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

    /// Read one managed leaf without resolving the original directory path again.
    pub(super) fn read_optional(&self, name: &str) -> Result<Option<Vec<u8>>> {
        ensure!(
            !name.is_empty() && name != "." && name != ".." && !name.contains('/'),
            "Expected a single managed filename"
        );
        let name = CString::new(name)?;
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
}
