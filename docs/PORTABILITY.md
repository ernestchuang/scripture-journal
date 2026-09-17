# Portability, export, migration, and recovery

Status: proposed contracts for the rewrite; no implementation is claimed here.

## Confirmed direction

- The local database owns journal content and entry-to-entry relationships.
- Obsidian is used for browsing and connecting exported notes, not journal authoring.
- Updating the Obsidian export while the desktop app runs is sufficient.
- Linux and Apple Silicon macOS come first; iPad and iPhone remain future targets.
- Network sync and a sync provider are deferred; export is not device synchronization.
- Saved journal versions remain until explicitly deleted; there is no age-based pruning.
- Existing journal migration, portable Markdown export, and backup/restore are required.

The detailed contracts below are proposed implementation choices, not additional
user-confirmed requirements. SQLite is the proposed authoritative database engine.

## Two portable outputs

A Markdown export is a readable representation of current journal entries, passage
references, and entry links. It is useful independently of this app and in Obsidian.
A full backup preserves application state, including drafts and all retained versions.
The interface must distinguish these outputs rather than call both a backup.

Default Markdown export excludes unfinished drafts and old revisions. Optional history
export can be added separately. A full backup includes them from the outset.
Only include scripture text or assets when redistribution permissions allow it;
passage references and journal content do not require bundling a Bible library.

## Maintained Obsidian export

### Ownership and identity

Each destination has a managed subtree and an explicit journal/target identity.
Unrelated vault files are outside the exporter’s scope. Users can write their own
notes elsewhere in the vault and link to the generated entries.

Use immutable entry IDs in stable, case-safe filenames. Titles appear as readable
headings and optional aliases; changing a title never renames its exported file.
Resolve internal entry IDs to those stable paths when rendering Markdown links.
Use a versioned metadata schema for IDs, dates, passage references, tags, and revisions.
Treat paths as destination-relative; reject traversal, unsafe names, and symlink escape.

Maintain an export manifest containing target identity, exporter device identity,
format version, entry IDs, paths, exported revision IDs, and output content hashes.
Permit one designated exporter per destination. A second device or journal requires
explicit reassociation; a shared folder is not a distributed locking mechanism.
Prevent concurrent local exporter processes using a local destination lock.

### Incremental and resumable writes

1. Commit journal changes and their export change records in the same DB transaction.
2. Select pending records through a bounded, monotonically ordered change sequence.
3. Pin the published revision for each item and render only that revision's content,
   metadata, links, and any required attachments. Never render the working head.
4. Verify the existing destination against its last successfully exported hash.
5. Write a temporary file in the same directory, flush it, and replace atomically
   where the supported filesystem allows; report failures instead of claiming success.
6. Persist the successful output hash and revision only after replacement succeeds.
7. Advance the contiguous acknowledgement cursor without skipping unresolved failures;
   per-item receipts let later successful records avoid needless rewriting on retry.

Unfinished-only autosaves are acknowledged as export no-ops so they never block
later finished entries. Finishing creates its own export-relevant event. Pin each
batch's published revisions; edits during export produce later pending events.

If the process stops after replacement but before its receipt commits, compare the
file with both the prior hash and the expected pending output. Matching pending
output is already written and can be acknowledged safely. Unexpected bytes conflict.
Newer journal changes remain pending even if an older batch finishes afterward.
Serialize writes to each target and never let an older revision replace a newer one.

Expose last successful export, pending work, conflicts, and retry controls.
Cancellation and partial success must remain visible; neither means fully current.

### External modifications and deletion

Never silently overwrite a file whose contents differ from its recorded output.
Preserve the external file and the authoritative DB version, then show a conflict.
Resolution may preserve the external copy separately or explicitly regenerate the
managed file. External edits do not automatically create database journal revisions.
Detectable concurrent edits require rechecking immediately before replacement;
ordinary filesystems cannot guarantee compare-and-swap against unrelated editors.
Document managed files as app-owned and retain displaced bytes for recovery.

An existing unowned file at the intended path is a collision, not permission to replace.
A missing or externally renamed file is not evidence of journal deletion. Report it
and offer explicit repair or reassociation after checking entry identity and contents.
Do not silently chase ambiguous duplicates or recreate a renamed file every startup.

Trashing a previously exported entry produces a minimal tombstone at the same path, preserving
incoming Obsidian backlinks. The tombstone omits the journal body and indicates trash
status. Restoring replaces it with published-head content only at the same path.
Never-published entries create neither exported files nor tombstones.
Permanent deletion must explicitly describe whether its exported tombstone remains.
Deleting data here cannot erase independent backups or third-party vault history.

### Performance boundary

First export and explicit full reconciliation scale with the complete journal.
Routine export scales with changed entries and affected dependencies, not all files.
Do not rewrite unchanged content or touch unchanged modification times.
Use bounded batches with progress and cancellation for full exports and repairs.
If rendered link labels include target titles, track their dependent files for updates;
stable labels avoid that dependency. Attachments use content identity to avoid recopying.

Obsidian indexing and any external vault synchronization have separate costs.
No fixed latency is promised before measuring representative journals and filesystems.
A useful benchmark is 20,000 entries followed by three edits: unchanged files remain
untouched, while only the three entries and genuinely affected derived files update.

## Read-only legacy migration

Inventory flat `journal/*.md` and legacy nested book/chapter directories without
moving, rewriting, or deleting source files. Never reuse destructive move-and-delete
migration behavior from the old app. Identify chapter notes separately from entries.

Offer a dry-run report showing recognized entries, unsupported files, malformed
metadata, invalid passages/dates, duplicates, unresolved links, and missing attachments.
Use a safe YAML parser with explicit validation, including LF/CRLF and quoted values.
Preserve exact original bytes and unknown properties in import provenance/recovery data.
Keep original date precision and timezone information; do not invent a timezone for
date-only values. Preserve invalid source values alongside any corrected normalized data.

Use an import ledger mapping source-set identity, relative path, content hash, and
assigned entry ID. Reimporting unchanged inputs is idempotent. A changed known source
requires review before creating a new revision. Equal contents at different source
paths are not automatically duplicates because repeated notes may be intentional.
Renamed sources require identity reconciliation rather than content-only guessing.

Import in two passes: create entries and stable IDs, then resolve entry/passage links.
Preserve unresolved wikilinks as text and report them; do not guess ambiguous targets.
Each imported note starts with an initial revision. Missing historical revisions
cannot be reconstructed and must not be presented as recovered.

Translate supported legacy plan progress and preferences from the versioned state
snapshot into validated new records. Never reactivate an imported absolute journal
path, export target, or other device-specific setting. Ask for new path association.
Use transaction boundaries and resumable import receipts so interruptions do not
produce partial entries or duplicate imports. Report imported and skipped counts.

## Full backup contract

A versioned backup contains a coherent SQLite snapshot, every retained journal
revision, drafts and recovery checkpoints, current entries and relationships, plan
definitions/revisions/progress, portable preferences, attachments, and import provenance.
Include a manifest with schema/format versions, journal identity, and checksums.
Exclude rebuildable scripture/search caches, device secrets, and active absolute paths.
Keep provenance paths inert if retained for diagnosis; never use them as capabilities.

Use the [SQLite Online Backup API](https://www.sqlite.org/backup.html) or an equivalent
verified snapshot mechanism. SQLite documents that its backup API can copy an online
database incrementally into a consistent snapshot. Do not copy a live main DB file
while ignoring its write-ahead log.

For external attachments, pin immutable referenced objects from the completed DB
snapshot until packaging finishes. Prevent garbage collection from removing those
objects mid-backup. Verify every referenced object before publishing the archive.
Write to a temporary destination, validate it, and finalize only after success.
Checksums detect corruption; they do not provide confidentiality or authentication.
Backup encryption and key recovery need a separate design before being advertised.

## Restore contract

Initially restore into a new local journal or explicitly replace one; merging is deferred.
Extract safely into staging with path/size limits, validate manifest and supported
versions, verify checksums, run database integrity/foreign-key checks, and verify assets.
Migrate supported old schemas in staging. Unsupported or corrupt backups leave the
live journal unchanged. Replacement first requires a verified pre-restore backup.

Activate the staged journal only after validation and successful replacement.
Keep export disabled until explicit destination reassociation. A restored old snapshot
must not silently overwrite newer exported content or reuse another device’s paths.
Recovery reporting states exactly what was restored and what was excluded.

## Acceptance scenarios

- Interrupt export before/after replacement and before/after receipt commit; retry converges.
- Change titles and trash/restore entries; stable external backlinks continue resolving.
- Externally edit, rename, or collide with a managed file; no silent data loss occurs.
- Repeat import and interrupt either pass; IDs and counts remain stable.
- Import duplicate filenames, unknown fields, CRLF, date-only values, and broken links.
- Back up during writing, restore elsewhere, and compare all retained versions and drafts.
- Reject corrupt or incomplete backups without changing the active journal.
- Restore old data without automatically reconnecting or overwriting an existing export.
