use journal_core::ExportReport;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub directory: Option<String>,
    pub last_success: Option<String>,
    pub pending: usize,
    pub conflicts: Vec<String>,
    pub running: bool,
    pub canceled: bool,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct DeviceConfig {
    version: u32,
    directory: String,
    #[serde(default)]
    last_success: Option<String>,
    #[serde(default)]
    conflicts: Vec<String>,
}

pub struct MaintainedExport {
    config_path: PathBuf,
    status: Mutex<Status>,
    canceled: AtomicBool,
}

impl MaintainedExport {
    pub fn open(root: &Path) -> Self {
        let config_path = root.join("maintained-export-device.json");
        let config = fs::read(&config_path)
            .ok()
            .filter(|bytes| bytes.len() <= 64 * 1024)
            .and_then(|bytes| serde_json::from_slice::<DeviceConfig>(&bytes).ok())
            .filter(|config| config.version == 1);
        let status = config
            .map(|config| Status {
                directory: Some(config.directory),
                last_success: config.last_success,
                conflicts: config.conflicts,
                ..Status::default()
            })
            .unwrap_or_default();
        Self {
            config_path,
            status: Mutex::new(status),
            canceled: AtomicBool::new(false),
        }
    }

    pub fn associate(&self, directory: &Path) -> Result<(), String> {
        let directory = directory.canonicalize().map_err(|e| e.to_string())?;
        let config = DeviceConfig {
            version: 1,
            directory: directory.to_string_lossy().into_owned(),
            last_success: None,
            conflicts: vec![],
        };
        self.persist(&config)?;
        let mut status = self
            .status
            .lock()
            .map_err(|_| "Export status is unavailable.")?;
        status.directory = Some(config.directory);
        status.error = None;
        status.canceled = false;
        self.canceled.store(false, Ordering::Release);
        Ok(())
    }

    pub fn disconnect(&self) -> Result<(), String> {
        if self.config_path.exists() {
            fs::remove_file(&self.config_path).map_err(|e| e.to_string())?;
        }
        *self
            .status
            .lock()
            .map_err(|_| "Export status is unavailable.")? = Status::default();
        self.canceled.store(true, Ordering::Release);
        Ok(())
    }

    pub fn begin(&self) -> Result<Option<PathBuf>, String> {
        let mut status = self
            .status
            .lock()
            .map_err(|_| "Export status is unavailable.")?;
        if status.running || self.canceled.swap(false, Ordering::AcqRel) {
            return Ok(None);
        }
        let Some(directory) = status.directory.clone() else {
            return Ok(None);
        };
        status.running = true;
        status.canceled = false;
        Ok(Some(PathBuf::from(directory)))
    }

    pub fn finish(&self, result: Result<ExportReport, String>) {
        if let Ok(mut status) = self.status.lock() {
            status.running = false;
            match result {
                Ok(report) => {
                    status.pending = report.pending;
                    status.conflicts = report.conflicts;
                    status.error = None;
                    if status.conflicts.is_empty() {
                        status.last_success = Some(chrono::Utc::now().to_rfc3339());
                    }
                }
                Err(error) => status.error = Some(error),
            }
            if let Some(directory) = &status.directory {
                let _ = self.persist(&DeviceConfig {
                    version: 1,
                    directory: directory.clone(),
                    last_success: status.last_success.clone(),
                    conflicts: status.conflicts.clone(),
                });
            }
        }
    }

    pub fn cancel(&self) -> Result<(), String> {
        self.canceled.store(true, Ordering::Release);
        let mut status = self
            .status
            .lock()
            .map_err(|_| "Export status is unavailable.")?;
        status.canceled = true;
        Ok(())
    }

    pub fn status(&self) -> Result<Status, String> {
        self.status
            .lock()
            .map(|status| status.clone())
            .map_err(|_| "Export status is unavailable.".into())
    }

    fn persist(&self, config: &DeviceConfig) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?;
        let temporary = self.config_path.with_extension("json.tmp");
        fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
        fs::File::open(&temporary)
            .and_then(|file| file.sync_all())
            .map_err(|e| e.to_string())?;
        fs::rename(&temporary, &self.config_path).map_err(|e| e.to_string())?;
        if let Some(parent) = self.config_path.parent() {
            fs::File::open(parent)
                .and_then(|file| file.sync_all())
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn association_is_device_local_durable_and_explicitly_removable() {
        let root = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let state = MaintainedExport::open(root.path());
        state.associate(target.path()).unwrap();
        assert_eq!(
            state.status().unwrap().directory.as_deref(),
            Some(
                target
                    .path()
                    .canonicalize()
                    .unwrap()
                    .to_string_lossy()
                    .as_ref()
            )
        );
        let reopened = MaintainedExport::open(root.path());
        assert!(reopened.status().unwrap().directory.is_some());
        reopened.disconnect().unwrap();
        assert!(MaintainedExport::open(root.path())
            .status()
            .unwrap()
            .directory
            .is_none());
    }

    #[test]
    fn cancellation_prevents_the_next_bounded_batch() {
        let root = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let state = MaintainedExport::open(root.path());
        state.associate(target.path()).unwrap();
        state.cancel().unwrap();
        assert!(state.begin().unwrap().is_none());
        assert!(state.status().unwrap().canceled);
    }
}
