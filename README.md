# Scripture Journal

A personal Bible reading and journaling application for a small household.
Read freely, reflect with confidence, and revisit connected writing over time.

**Status: design foundation. There is no runnable application yet.** The name is
a working name. Product requirements are recorded; implementation choices remain
proposals until reviewed. Development begins with Linux (Arch) and macOS (Apple
Silicon). iPad/iPhone compatibility informs the architecture but is not a first
release deliverable. Synchronization, accounts, sharing, and end-to-end encryption
are deferred.

## Design

- [Product specification](docs/PRODUCT.md): confirmed scope, proposed defaults,
  reading/writing flows, and acceptance scenarios.
- [Architecture proposal](docs/ARCHITECTURE.md): modules, technology choices,
  trust boundaries, and validation strategy.
- [Data model](docs/DATA-MODEL.md): identity, history, drafts, relationships, and
  transaction invariants.
- [Portability](docs/PORTABILITY.md): maintained Obsidian export, migration,
  backup, and restoration.
- [Decision record](docs/decisions/0001-local-authority.md): database authority
  and the one-way export boundary.
- [Development workflow](docs/DEVELOPMENT.md): worktrees, Beads, and resumption.

The local journal database owns entries, revisions, passage associations, and
entry links. Obsidian receives an incrementally updated Markdown view for review
and deep study. All persisted writing versions are retained unless explicitly
deleted; the precise autosave cadence is a proposed policy in the data model.

The first two plans are M'Cheyne and one chapter per day from each of four streams:
Old Testament excluding Psalms and Proverbs, New Testament, Psalms, and Proverbs.
Custom plans, a starter writing template, LSB/NASB1995/ESV/KJV switching, and
continuous reading beyond any plan assignment are in scope.

## Relationship to the existing app

This is a new repository, not a replacement installation of
[bible-reading-plans](https://github.com/ernestchuang/bible-reading-plans).
The original app remains usable. Its journal and progress will be imported
without modifying the source files. Algorithms, fixtures, and plan definitions
may be reused after review; application state and filesystem code are not copied
wholesale. Existing user journals, credentials, and licensed scripture text must
not be committed to this repository.

## Work tracking

Beads is the task tracker. Run `bd prime`, then `bd ready` and `bd show <id>`.
Design documents describe the product, not task status. The committed
[issue snapshot](.beads/issues.jsonl) preserves dependencies and handoffs across
clones; see the development workflow for importing/exporting it.
