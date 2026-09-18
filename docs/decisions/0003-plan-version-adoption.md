# Explicit plan-version adoption

Date: 2026-09-18

This is an implementation policy under the delegated authority recorded in
[0002-release-defaults.md](0002-release-defaults.md), not an individually
confirmed user preference. It refines the existing requirement that an enrollment
adopts an edited definition deliberately for future assignments while retaining the
definition and snapshots that explain earlier work.

## Common command and retained state

Adoption is an explicit native command against one enrollment. Its request carries:

- the enrollment ID;
- the expected currently adopted definition-version ID;
- the target definition-version ID; and
- the schedule-specific boundary described below.

Both versions must exist, belong to the same plan identity, and have the same
schedule kind. The target must be a later version than the expected current version.
An adoption appends an immutable event with its own stable ID and UTC timestamp.
The enrollment's original version reference is not updated. Its effective version is
the target of the latest adoption event, or its original version when no event exists.
Adoption events are retained in backups and expose the version history of the
enrollment.

The command runs in one immediate write transaction. It re-reads the effective
version and boundary state after acquiring the write lock. A stale expected version,
stale boundary, incompatible target, duplicate command, or invalid identity rejects
the entire command without rows or partial assignments. Concurrent stores presenting
the same expected head may produce at most one adoption; the loser reloads before
trying another explicit adoption. Retrying a committed command is reported as stale,
not treated as permission to create another event.

Existing definition versions, enrollment rows, policies, assignments, progress
epochs, completions, and undo rows are never updated or deleted. Every old assignment
continues to identify the definition version, generation, and passage snapshot from
which it was created. Historical stream rows that predate this schema gain their
enrollment's original definition version and an original-generation identity during
migration; this is provenance only and does not rewrite their snapshots. Adoption
never marks an assignment complete, undoes a completion, changes a start date,
changes loop policy, or changes calendar alignment policy.

## Chapter-stream compatibility and boundary

The request carries the complete displayed stream boundary: for every enrolled
stream, its stable stream ID, current assignment ID, and current progress-epoch ID.
The set of stream IDs in the target must exactly match the enrollment. Adding,
removing, or renaming a stable stream ID is incompatible because the command has no
policy or progress choice for a different stream. Display names may change.

For each stream, the current assignment's zero-based `streamPosition` must exist at
the same position in the target and the chapter there must equal the assignment's
retained passage snapshot. This occurrence-position check is required even when the
same chapter appears elsewhere. Earlier definition content may differ because old
assignments retain their own snapshots; later, not-yet-materialized occurrences may
be reordered, added, or removed. The existing per-enrollment loop-or-stop policy
remains unchanged.

Adoption is allowed only at the materialized frontier of every stream. Assignments
form a retained, linear successor chain: each assignment may identify at most one
successor assignment, and a successor records the predecessor from which it was
created. If the displayed active assignment already has a retained successor, the
stream is rewound behind work that was previously materialized. Adoption is rejected
for the whole enrollment until the user recompletes the retained chain back to its
frontier. It never replaces that successor with a different passage or creates a
parallel assignment at the same logical step. This makes "future" mean assignments
that have never existed, not merely assignments that are currently unread.

Every stream assignment stores its immutable originating definition-version ID and
assignment-generation ID. Enrollment creates the original generation. Each adoption
event creates a new generation for successors produced from its target version; a
later adoption creates another generation even when it uses the same boundary. The
assignment's ordinal remains the monotonic logical step within the stream, and cycle
retains its existing loop meaning. There is one retained successor per assignment, so
recompletion does not allocate a competing row or reuse `(stream, ordinal)` for a
different snapshot.

Completion always validates an assignment's occurrence against that assignment's
originating version, never merely the enrollment's latest adopted version. After a
completion, an already-retained successor is selected exactly as stored. This is the
case while replaying history after undo, including across any number of adoption
boundaries. Only a frontier assignment with no retained successor may create one:
the most recent adoption whose boundary is that exact assignment supplies the target
version and generation; otherwise the assignment's own version and generation
continue. A later adoption at the same uncompleted frontier supersedes the earlier
event for successor creation while retaining both events as history.

The current frontier assignments remain active and keep their old provenance.
Adoption affects only successors first created after those assignments complete. A
new successor uses the target sequence after the validated position, with ordinal
incremented once and cycle unchanged; at the target end, the existing loop policy
either stops or uses target position zero with cycle incremented once. An exhausted
stopped stream has no active frontier to map and is incompatible; starting another
enrollment is the safe alternative.

Undo retains ordered-undo rules and appends a progress epoch selecting the exact
historical assignment. It does not reverse or delete adoption. Recompletion follows
the retained successor chain until the frontier, validating each historical
assignment against its own version. Therefore a definition may remove or change a
pre-boundary occurrence without making historical recompletion impossible, while it
still cannot reinterpret that retained occurrence.

## Calendar compatibility and cutover

The request carries an `effectiveFromLocalDate` and the exact assignment ID currently
stored for that date. The date must belong to the enrollment and must be later than
every assignment having any retained completion record, including an undone one.
This makes completed history immutable and prevents adoption from reinterpreting a
reading that was once recorded.

The target must remain an explicit schedule. It must contain every definition-day
number used on or after the cutover in the enrollment's existing date range. For
calendar-aligned enrollment it must also remain a valid 365-day calendar definition;
for day-one enrollment it must cover every remaining assigned day. These constraints
allow passage edits for future dates without silently shortening, extending, or
shifting the enrolled calendar. A different duration, start date, alignment policy,
or additional cycle requires a new enrollment.

Assignments before the cutover remain eligible according to their existing completion
state. Existing assignments on and after the cutover are retained as superseded
snapshots and cannot receive new completions. In the adoption transaction, replacement
assignments are appended for the same local dates and definition-day numbers using the
target passages and target version ID. Active assignment discovery returns the old
rows before the cutover and the replacement generation on or after it. This requires
schema support for assignment generations rather than deleting rows or retaining the
current uniqueness constraints unchanged.

Undoing a pre-cutover completion does not move the cutover or target version. A
completion raced with adoption is serialized by the same write lock: either completion
commits first and makes that proposed cutover stale/ineligible, or adoption commits
first and completion of a superseded assignment is rejected. No wall-clock "today"
is read inside the core command; the UI explicitly supplies the local-date boundary it
displayed.

## Required regression evidence

Database implementation must prove:

- compatible stream adoption changes only successors while retaining old assignments,
  completions, undos, epochs, policies, and definitions across reopen;
- the sequence `[John 1, John 2, John 3]`, after completing John 1 and adopting
  `[John 9, John 2, John 4]` at retained John 2, can undo and recomplete John 1 by
  reusing the exact retained John 2 successor; completing John 2 then creates John 4
  from the adopted generation;
- after completing then undoing John 1, the retained John 2 successor makes adoption
  of `[John 1, John 9, John 3]` at rewound John 1 reject with exact unchanged state;
  recompleting to retained John 2 reaches the frontier where a new compatible
  adoption can be requested;
- repeated chapters use the exact occurrence position, and mismatched position,
  passage, stream set, schedule kind, plan identity, exhausted stop state, or stale
  progress rejects with exact unchanged state;
- multiple adoptions at one frontier retain every event but use only the latest target
  for the first successor; undo across multiple boundaries and recompletion reuse the
  exact retained chain, preserve ordered undo, never fork an ordinal, and validate
  each row against its originating version and generation;
- loop adoption at the last target occurrence increments cycle exactly once, retains
  the generated position-zero successor across undo/recompletion, and a stopped
  exhausted stream remains incompatible;
- compatible calendar adoption appends a replacement generation only at the explicit
  cutover, preserves completed and undone history plus pre-cutover unread assignments,
  and exposes the target passages for future dates across reopen;
- completed-at-or-after-cutover, truncated schedule, invalid 365-day alignment,
  changed date range, stale assignment/head, and cross-plan targets reject without
  writes;
- injected failures roll back the adoption event and all replacement assignments;
  two stores cannot both adopt from the same expected head; and completion/adoption
  races have the serialized outcomes described above; and
- migration of populated stores preserves all prior snapshots and history, assigns
  deterministic original-version/generation provenance and successor links without
  guessing a branch, rejects ambiguous legacy chains, and passes SQLite integrity
  and foreign-key checks.

Native and UI layers must later carry the captured identities unchanged, explain
incompatibility, guard duplicate and stale asynchronous settlement, preserve unsent
editor input, and refresh through read operations without replaying adoption.
