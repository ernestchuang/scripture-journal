# 0001: Local database authority with a maintained Markdown export

Status: product direction confirmed by the user; implementation details proposed.

## Context

The original app grew from reading-plan tracking into journaling backed by files
in an Obsidian vault. The new product must own internal entry connections,
reliable drafts, retained revisions, and passage-based retrieval. Obsidian is for
browsing and deep study after export, not writing journal entries. The initial
release is offline Linux/macOS; sync and sharing are deferred.

## Decision

The app's local database owns journal content and relationships. Store Markdown
bodies and structured metadata with permanent entry identities. Maintain a
one-way Markdown projection into a selected Obsidian folder when the desktop app
runs. SQLite is the proposed database implementation. Published content and
unfinished draft state have distinct heads; all persisted writing revisions are
retained unless explicitly deleted.

Maintain stable exported filenames and detect external modifications before
replacing files. External Obsidian notes can link to those stable paths. The app
does not ingest arbitrary edits to generated files as an implicit second editor.
A conflict is preserved and reported.

## Alternatives

- Authoritative Markdown with a database index remains appropriate for shared
  editing with Obsidian, but that is not the intended workflow here.
- Database-only storage without portable export would weaken data ownership and
  the desired Obsidian study workflow.
- Full two-way database/file synchronization adds conflict semantics that the
  initial product does not need.

## Consequences

Transactions can preserve entry bodies and relationships consistently. Export is
incremental and replaceable; full backup is a separate function containing all
revisions and drafts. A Markdown export of current entries is not a full backup.

Obsidian connections created inside generated files require conflict handling;
connections from separate user-managed notes are the recommended initial workflow.
No automatic synchronization across the couple's devices is implied. Every device
would have its own journal until a future sync or deliberate transfer facility.

The database, draft timing, archive behavior, filename format, and detailed
restore workflow still require design review. Later encryption/sharing work must
address key management, authorization, and deletion across offline copies.
