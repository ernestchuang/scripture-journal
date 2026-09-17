# Journal data model proposal

Status: reviewable design; this document does not implement a schema.

## Confirmed requirements and proposed defaults

The local database is authoritative for journal entries, passage associations,
entry-to-entry connections, and revision history. Obsidian receives an export.
Every version must remain available until explicitly deleted by the user.
The first release is local-only on Linux and Apple Silicon macOS.
Future mobile support, synchronization, sharing, and end-to-end encryption must
remain possible, but none is implemented by this proposal.

SQLite is the proposed database. Stable UUIDs, the tables below, save timing,
draft publication, Trash, and deletion semantics are proposed implementation
choices rather than separately confirmed product requirements.

The conservative retention default is that **every persisted autosave creates
a retained revision**. There is no overwrite-only persisted draft buffer.
Typing may be coalesced before a write; debounce and maximum save delay remain
to be specified. No design can promise recovery of keystrokes not yet persisted.
The interface displays Saved only after the database transaction commits.

## Small relational core

| Entity | Proposed responsibility |
| --- | --- |
| `journals` | Stable journal ID and local ownership boundary; no account required. |
| `entries` | Stable ID, journal ID, creation time, working revision head, optional published revision head, and Trash timestamp. |
| `entry_revisions` | Immutable ID, entry ID, parent reference, Markdown body, title, timestamp, content schema version, installation ID, and optional restoration source. |
| `revision_passages` | Full snapshot of passage associations and optional translation context for each revision. |
| `revision_tags` | Full snapshot of tag labels for each revision. |
| `revision_links` | Full snapshot of outgoing target entry IDs and optional display labels. |
| `change_log` | Transactional local operation ID, sequence, entity ID, and operation kind for incremental consumers. |
| `deletion_records` | Minimal records of explicit purges; retention policy remains to be settled. |
| `export_state` | Destination-specific revision IDs and content hashes last exported; derived integration state. |

Avoid a generic object framework. Add attachment entities only when attachment
behavior is specified. Keep Bible text, plan definitions, plan progress, and
reader session state in separate modules; they reference shared passage IDs.
An installation ID identifies a writer installation, not an authenticated person.

## Entry identity and revision snapshots

1. Entry IDs never depend on title, filename, passage, or installation.
2. Every revision owns a complete body, title, tags, passages, and outgoing-link
   snapshot. Updating one field never produces a mixture of revision states.
3. Snapshot child rows are immutable along with their revision. Renaming a tag
   affects subsequent snapshots; it does not rewrite historical labels.
4. An entry head can reference only a revision belonging to that entry. Enforce
   this through relational constraints and transactional repository operations.
5. Passage references encode a canonical book and verse/chapter range, not a
   translated display string. Translation context is optional separate metadata.
6. Reader navigation never changes a draft's passage associations implicitly.
7. Links target stable entry IDs. The current view resolves to the working head;
   published/export views resolve to the published head. Historical views use
   the selected revision's outgoing associations.
8. Current backlinks are derived from working-head snapshots. Exported backlinks
   derive only from published snapshots. Historical backlinks are explicitly
   scoped rather than mixed into the current view.

## Working head and published head

The working head is the latest persisted edit, including unfinished writing.
The published head is the latest revision the user marked ready for the normal
journal/export view. Published means locally finished, not publicly shared.
A new unfinished entry has a working head and no published head.
An unfinished edit to an existing entry advances only its working head; the
previous published head remains available to the exporter.

Finishing an entry must first flush the exact editor generation requested by the
user. Persist any pending content and advance the published head to that revision
in one transaction; reject stale finish requests rather than publishing older text.
Record a separate export-relevant finish event even if content was already saved.
No revision needs to be duplicated merely to publish it. Resuming edits creates
subsequent retained revisions normally.
The UI must make unfinished changes visible so export behavior is unsurprising.

The default Markdown export includes published heads only. It excludes new
unfinished entries and unfinished changes to existing entries. Links to entries
without a published head render as readable unresolved references rather than
leaking their draft titles or bodies. Full backups retain both heads and every
revision, including unfinished revisions. History export is a separate option.

## Save, recovery, and restoration

Each edit carries a local monotonic generation and expected base revision.
Serialize saves or reject stale generations so a delayed write cannot move the
working head backwards. The generation is a local ordering mechanism, not a
future distributed conflict clock.

One transaction inserts the revision and all snapshot rows, advances the working
head, and appends the change event. A crash must expose either the complete old
state or complete new state. Recovery opens the working head and compares it
with the published head to identify unfinished work.

Restoring an older revision creates a new revision containing its snapshot,
with the current working head as parent and the old revision as restoration
source. Existing history remains. Restoration is initially an unfinished edit;
publication remains explicit. No periodic cleanup expires retained revisions.

## Trash and explicit purge

Trash is a reversible entry state and preserves its heads and all revisions.
Trashed targets remain identifiable as unavailable links; restoring the entry
restores resolution. Trash must not silently trigger irreversible export deletion.

Permanent entry deletion and deletion of selected history are explicit operations.
Reject a revision purge while either head references it; require an explicit head
selection or entry purge first. Purges and head changes execute transactionally.
Use cascading foreign keys only from a purged revision to its owned snapshot
rows, and from an explicitly purged entry to its owned revisions.

Parent and restoration-source references must never cascade-delete descendants.
Use nullable foreign keys with `ON DELETE SET NULL`, plus immutable source UUID
fields if provenance needs to identify an explicitly removed predecessor.
Nulling this structural reference is a documented purge exception to immutability;
surviving content snapshots remain unchanged. Show missing history honestly.

Incoming entry links must not cascade away when their target is purged. Store
target UUIDs as logical references without a required target foreign key, so
surviving snapshots retain a visible unresolved link. A purge does not promise
erasure from old backups or files already exported elsewhere.

## Future synchronization boundary

Keep local transactions independent of transport. Stable revision and operation
IDs support later deduplication; parentage supports detecting divergent edits.
Do not resolve conflicts using wall-clock timestamps or claim the change log is
a synchronization protocol. Later concurrent branches must be retained until
resolved, with explicit merge-parent support if needed.

Keep repositories separate from accounts, transport, and cryptographic services.
Do not put journal content into routine diagnostic logs. Local search indexes
are sensitive, rebuildable data. E2EE still requires a future design for device
enrollment, key recovery, metadata exposure, attachments, and sharing boundaries.
Linking entry A to entry B must never automatically grant access to B.

## Acceptance checks

- Kill the process during saving: recover one complete transactional state.
- Restart after autosave: recover text, metadata, and original passage links.
- Race delayed autosaves: the newer generation remains the working head.
- Finish during a pending autosave: publish exactly the requested editor generation.
- Rename an entry: incoming links remain valid.
- Restore a revision: create a new snapshot while retaining intervening history.
- Export during unfinished edits: export the previous published version only.
- Purge a historical parent: retain descendants and visibly mark missing ancestry.
- Trash, restore, and purge a linked target: preserve source-link snapshots.
- Rebuild search and restore backup: preserve IDs, both heads, links, and history.
- Simulate divergent future edits: retain both revisions without timestamp loss.
