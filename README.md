# Scripture Journal

A personal Bible reading and journaling application for a small household.
Read freely, reflect with confidence, and revisit connected writing over time.

**Status: early desktop prototype, not a complete release.** A Tauri/React shell
connects continuous KJV reading, Markdown writing, retained SQLite revisions,
entry connections, history restoration, reading plans, and manual Markdown export. Product
contracts describe the broader release. Linux builds locally; macOS runtime
validation remains outstanding. iPad/iPhone compatibility informs the architecture
but is not a first release deliverable. Synchronization, accounts, sharing, and
end-to-end encryption are deferred.

## Run the prototype

Use Node 24 or newer, Rust stable, and the platform's Tauri development dependencies
(WebKitGTK 4.1/GTK 3 development packages on Linux; Xcode command-line tools on macOS).

```bash
npm ci
npm run desktop
```

`npm run dev` runs a browser preview with separate IndexedDB storage. The desktop
app uses SQLite in its own application-data directory, identified by
`com.ernestchuang.scripture-journal`; it does not open the original application's
journal. Drafts autosave after 600 ms of inactivity. Finish makes the current
version eligible for export. Restoring history creates a new unfinished revision.

Use **Appearance** in the header to select **System**, **Light**, or **Dark**.
System follows a compatible active desktop palette when its bounded palette file
is available; otherwise it follows the device appearance. Explicit choices persist
on this device. Use **Import theme** for a custom [TOML palette](docs/THEMES.md).
The app initializes its colors before showing the native window. Browser tests
run headlessly with a dark default, and the isolated native debug smoke requests
dark mode. Native smoke automation still temporarily focuses its test window;
run it deliberately when it will not interrupt your work.

Use **Download KJV** in the desktop reader to install a validated offline Bible
in a separate Scripture database. Without a download, KJV loads online on demand.
The reader remembers its location and continues beyond plan passage boundaries.
LSB, NASB1995, and ESV appear in the translation selector but require authorized
sources that are not bundled. Use **Import authorized Scripture pack** to install
your own supported [local JSON pack](docs/SCRIPTURE-PACKS.md), including source
attribution. See the
[translation source investigation](docs/TRANSLATION-SOURCES.md).

Reading plans include M’Cheyne and four independent chapter streams. Custom JSON
plans can be edited, imported, exported, and enrolled. Explicit version adoption
preserves earlier assignments and completion history. Journals start from a blank
writing template, with filters for tags, passages, and status. Trash keeps every
version until explicit permanent deletion; working and finished heads cannot be
deleted individually. Previously exported deleted entries become body-free
placeholders on the next export. Backups and export recovery files may retain
earlier copies.

Use **Full backup** to create a verified snapshot containing the complete journal
and revision history. **Restore backup** verifies and stages a selected backup,
then replaces the journal safely on restart after creating a pre-restore recovery
copy. See [full backup and restore](docs/BACKUP-RESTORE.md). The legacy journal
importer is available for a read-only preview and explicit import from the original
application. Maintained automatic incremental export remains under review.

Manual export scans finished entries and preserves conflicting external files;
it is not a complete backup of drafts and history. Export retains displaced
manifests as `.scripture-journal-manifest-recovery-*.json` files in the destination;
these are not automatically deleted. An interruption between displacement and
installation can leave the manifest missing. Export then requires explicit repair
from retained recovery files instead of initializing a new manifest. Concurrent
edits cannot be made atomic with unrelated editors; displaced files are retained
for recovery. Keep the original app in use
until the release and migration checks are complete.

See [changes worth knowing about](docs/CHANGES.md) for delivered behavior and
helpful additions, including recovery of conflicting drafts and saving during
continuous typing.

On Unix, export holds directory handles for the destination and recovery folder;
subsequent reads, staging, installation, and recovery use those handles. Replacing
a directory path with a symlink does not redirect these operations. If a held
directory is renamed, output stays with that directory; the report still displays
the originally selected path. Linux filesystem regression tests cover this behavior.
The Unix implementation also targets macOS, but macOS build/runtime validation
remains outstanding. The non-Unix fallback does not provide this directory-race
protection and is outside the supported desktop targets.

Use an app-owned export folder. The local lock coordinates cooperating exporters;
it does not prevent another program from replacing lock, staging, or recovery
filenames, changing file contents, or relocating a held directory. Export is not
a security boundary against a process that can mutate that folder. Filesystem
power-loss durability and network-filesystem locking are not established by these
tests. Displaced entry files remain in `.scripture-journal-recovery/`; failed or
interrupted replacements may require explicit repair from retained files.

```bash
npm run build
npm test
npm run test:native
npx playwright install chromium
npm run test:e2e
python -m unittest discover -s scripts -p 'test_*.py'
```

The [quota-aware development runner](docs/QUOTA-RUNNER.md) can continue a bounded
Beads issue across quota resets without invoking a model while waiting.

## Design

- [Product specification](docs/PRODUCT.md): confirmed scope, proposed defaults,
  reading/writing flows, and acceptance scenarios.
- [Architecture proposal](docs/ARCHITECTURE.md): modules, technology choices,
  trust boundaries, and validation strategy.
- [Data model](docs/DATA-MODEL.md): identity, history, drafts, relationships, and
  transaction invariants.
- [Portability](docs/PORTABILITY.md): maintained Obsidian export, migration,
  backup, and restoration.
- [Backup and restore](docs/BACKUP-RESTORE.md): complete snapshots, verified
  restart restoration, recovery copies, preferences, and exclusions.
- [Decision record](docs/decisions/0001-local-authority.md): database authority
  and the one-way export boundary.
- [Release defaults](docs/decisions/0002-release-defaults.md): delegated desktop
  implementation policies and their scope.
- [Plan-version adoption](docs/decisions/0003-plan-version-adoption.md): explicit
  compatibility, retained-history, cutover, and concurrency contracts.
- [Development workflow](docs/DEVELOPMENT.md): worktrees, Beads, and resumption.

The local journal database owns entries, revisions, passage associations, and
entry links. Obsidian receives a Markdown view for review
and deep study. All persisted writing versions are retained unless explicitly
deleted. Drafts save after 600 ms idle and at least every five seconds during
continuous typing while storage is responding normally.

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
