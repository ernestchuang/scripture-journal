# Full backup and restore

The desktop app can create a complete local journal backup and restore one after a restart. A backup is a folder ending in `.sjbackup`; keep the folder together because it contains both `journal.sqlite3` and its checksum manifest.

## Create a backup

1. Choose **Full backup** in the app header.
2. Choose a destination folder.
3. Wait for the app to report the new timestamped `.sjbackup` folder.

The app flushes pending writing first, then uses SQLite's online backup operation so committed WAL data is included. It validates the snapshot and writes a SHA-256 checksum before making the backup visible. An existing backup folder is never overwritten.

The journal snapshot includes entries, drafts, finished versions, revision history, links, tags, trash, reading plans, enrollments, and retained progress. Versions that were explicitly and permanently deleted before the backup are absent.

## Restore a backup

1. Choose **Restore backup** and select a `.sjbackup` folder.
2. Review the replacement warning and confirm.
3. The app verifies the manifest, checksum, database integrity, relationships, and supported schema. A failed check leaves the current journal unchanged.
4. Restart Scripture Journal. Restore happens during startup while the app has exclusive ownership of the journal.

Immediately before replacement, the app creates a verified `journal.pre-restore-<timestamp>.sjbackup` recovery copy beside its live journal database. If a staged restore becomes invalid, the app quarantines it and continues opening the current journal.

Appearance, custom themes, reader location, and selected translation are portable preferences in the backup. After restore, the app offers to apply them; they are not applied without that action. Device-specific folder permissions and paths are never restored, so export and import folders must be chosen again.

## What is separate

- The downloaded Scripture library is a disposable cache and is not included. Download or import Scripture again on the restored device.
- Markdown export folders, recovery files in export destinations, and other external files are not included.
- Device-specific export paths, import paths, credentials, and filesystem permissions are not included.
- A maintained Markdown export is a review and portability view of finished entries, not a substitute for full backup. Its release review is still pending.

The legacy journal importer is available separately for bringing in supported Markdown from the original Bible Reading Plans application. It reads the selected source without changing it and is not part of backup restore.
