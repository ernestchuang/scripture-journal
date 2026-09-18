# Release defaults under delegated implementation authority

Date: 2026-09-18

The owner authorized completing the agreed desktop release, choosing useful
implementation details, and recording additions. These are implementation
decisions under that delegation, **not individually confirmed user preferences**.
They resolve the open defaults in PRODUCT.md and DATA-MODEL.md where those
documents label the same choices proposed or unconfirmed. They describe intended
behavior; Beads records what is implemented and validated.

## Reading schedules

The four-stream plan uses canonical Protestant book order, beginning with Genesis
1, Matthew 1, Psalm 1, and Proverbs 1. The Old Testament stream excludes Psalms
and Proverbs. Each stream advances only through its own explicit completion
action. Missing a day leaves that stream's next unread chapter in place: no
automatic skipping and no accumulating mandatory catch-up queue. Completing a
chapter never completes another stream. One chapter per stream is the daily
suggestion; reading further remains possible without changing the reader limits.

Enrollment offers a starting chapter for each stream and a loop-or-stop choice;
the default is loop. Loops retain cycle identity and previous completions. Users
can undo a completion explicitly rather than editing historical passage snapshots.
A stream completion can be undone only after its later completions have been
undone; explain that dependency instead of silently rewinding later progress.
Changing the device date must not
erase progress or mark anything read.

M'Cheyne retains its established 365 daily sets of readings, including multiple
chapters when assigned. Enrollment offers calendar alignment (default: today's
month/day) or starting the first set on a chosen date. Calendar alignment uses
February 29 as an optional catch-up/rest day, preserving March 1 alignment.
Starting from day one uses successive local dates and includes February 29 as an
ordinary day, yielding 365 sets. Missed calendar assignments remain visible as
unread; the app does not silently shift the calendar or mark them complete.
Calendar enrollment begins on the selected local date and ends December 31;
dates before enrollment are outside its scope, not an unread backlog. Thus a
mid-year enrollment covers part of the full 365-set definition. Day-one enrollment
ends after its 365th set. Starting another year or cycle is explicit.

Store local schedule dates separately from UTC completion timestamps. Device
timezone changes never recalculate historical assignment identities. Show the
scheduling policy at enrollment so the two progression styles are understandable.
Browsing or scrolling never completes an assignment.

Custom plans use versioned, validated JSON with explicit passage lists or chapter
streams. Imported definitions are data, never code. Editing creates a new version;
an existing enrollment adopts it explicitly for future assignments. Historical
assignments, passage snapshots, completions, and the prior definition remain
available. Reject incompatible adoption with an explanation instead of guessing
how to map progress. A new enrollment remains an alternative.

## Writing and recovery

Keep the existing 600 ms idle autosave. Add a bounded maximum dirty interval of
five seconds so continuous typing also persists, without claiming every keystroke
survives a crash. Navigation, Finish, and normal native close flush the applicable
editor generation. Display Saved only after commit; failures leave the draft
recoverable and provide retry. Every persisted changed snapshot is retained.
Saving identical content need not duplicate a revision.

Working and finished heads remain separate. Finish publishes precisely the
requested editor generation locally; it does not share anything. Later edits
remain unfinished until another Finish. Restore creates a new unfinished revision.
The normal Markdown export uses the most recent finished head. The blank starter
template creates ordinary editable Markdown; editing a template never changes
existing entries.

Trash is reversible and preserves all history. Permanent entry deletion and
selected historical revision deletion require explicit, clearly labeled actions
that identify what is being removed. No timed cleanup or automatic pruning.
Neither current head may be purged in isolation. Preserve surviving link snapshots
and ancestry identifiers when their targets have been explicitly removed.

## Export and backup

Maintained export is enabled by explicitly selecting a destination. While the
app runs, process export-relevant changes in bounded batches and expose pending
work, last success, conflicts, and retry. Do not interpret external Obsidian edits
as journal writes. Preserve conflicting files and displaced bytes for recovery.

Trashing a previously exported entry replaces its managed file with a body-free
tombstone after the same conflict checks; its stable path remains linkable.
Restore exports only its finished head. Permanent deletion explains that the
tombstone is retained and cannot erase old backups or third-party vault history.
Never-finished entries do not acquire exported tombstones.

Full backups include all journal revisions, drafts, links, plan definitions and
progress, templates, and portable preferences. They exclude rebuildable scripture
caches, device secrets, and active destination paths. Verify restoration in staging
before activation; replacing existing data first creates a verified recovery
backup. Restored exports remain disabled until explicit destination reassociation.

## Scope and release evidence

Keep the working name Scripture Journal. Use one local journal per installation
for the initial UI; backup restoration may replace it safely. Account/profile
switching, synchronization, sharing, encryption, and mobile delivery remain future
work. No translation is advertised as bundled or offline-ready without verified
rights and a working source. Missing Mac runtime access or publisher permission
blocks that acceptance item, not independent portable implementation.

User-extensible themes are part of first-release usability. Helpful additions
remain small, preserve privacy and retained data, and are logged in Beads with a
user-facing description. Astra reviews each implementation unit and the integrated
release; passing Linux or browser tests does not establish macOS runtime acceptance.
