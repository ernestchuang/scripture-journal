# Development and resumption

This repository currently contains specifications and task definitions, not an
application scaffold. No install/build command is claimed until the native spike
selects and validates the stack. Read [PRODUCT.md](PRODUCT.md),
[ARCHITECTURE.md](ARCHITECTURE.md), and [DATA-MODEL.md](DATA-MODEL.md) first.

## Worktrees

Keep the main checkout for integration and create a separate branch/worktree for
each bounded implementation task. Inspect existing worktrees before creating one.
Example from the main checkout, substituting an actual Beads issue ID:

```bash
git fetch origin
git worktree list
git worktree add -b feature/sj-ISSUE ../scripture-journal-worktrees/sj-ISSUE origin/main
```

Use explicit working directories for commands. Never run `bd init` from the parent
directory that holds multiple repositories. Do not let multiple agents edit the
same files without coordinating ownership. Separate implementations use separate
worktrees; focused document reviews may share one with disjoint file assignments.

The initial foundation branch is `design/foundation`; its local worktree is
`../scripture-journal-worktrees/foundation` relative to the main checkout.
After foundation integration, it may remain for review, but new work should branch
from current `origin/main`. Keep other sessions' worktrees and stashes intact.

## Beads across worktrees and clones

Run `bd prime` after starting a new session or recovering context. The main
checkout contains the canonical local `.beads` database. A linked worktree uses
an ignored `.beads/redirect` text file containing that directory's absolute path.
Verify `bd show <known-id>` from the worktree before creating issues there.
Do not initialize a separate database for each branch.

`bd sync` on the installed Dolt-backed version is a no-op. Export explicitly into
the worktree where the snapshot will be committed:

```bash
bd export -o .beads/issues.jsonl
```

On a fresh clone without a local database, retain the tracked snapshot and use
`bd init --prefix sj --from-jsonl` from the repository root. Verify `bd list` and
the issue count. If the installed version does not restore the snapshot, inspect
`bd import --dry-run -i .beads/issues.jsonl`, then import the reviewed snapshot.
Never force-reinitialize a live database to resolve a routine import error.

On an existing clone, snapshot imports can replace issue fields. After pulling,
compare a dry-run import with active local issue state and resolve differences
before importing. Coordinate issue snapshot export/commit through the integrating
agent so two worktrees do not repeatedly overwrite one another's newer snapshot.

## Checkpoints and handoff

Before implementation, claim the Bead and read its acceptance criteria and
dependencies. During work record consequential decisions in the specifications or
decision records, and update progress/next actions in the Bead. Do not add a second
Markdown task tracker or rely on a chat summary as the only record.

At checkpoints preserve:

- The active branch/worktree and relevant commit IDs.
- What is actually implemented, remaining failures, and exact reproduction steps.
- Tests run and their result, including platform checks not performed.
- Unresolved user decisions and the next concrete action.

Commit and push small coherent units. Incomplete but useful work can be pushed on
its feature branch with an accurate issue note; do not mark the feature complete.
Update/export Beads before committing. Verify the push and clean branch status.

To resume, read the specifications, run `bd prime`, inspect `bd list --status=in_progress`
and `bd ready`, and compare Git state with the issue handoff. Context compaction and
usage interruptions must not require reconstructing product requirements from
memory. Agents do not continue through exhausted service access.

## Validation boundary

For this documentation foundation, check local links, JSONL validity, issue
dependency references/cycles, and consistency of confirmed/proposed language.
There is no application test suite yet. Future checks are specified in the
architecture and the relevant Bead. Native Linux/macOS behavior cannot be claimed
from a browser-only test or a successful compiler run.

Use synthetic fixtures, not personal journals. Read-only import fixtures should
cover the original application's known formats without copying private content.
Record external source URLs and access dates when selecting translation providers
or verifying distribution permissions.
