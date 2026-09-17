# Beads tracking

Beads owns issue status, dependencies, acceptance criteria, and session handoffs.
Run `bd prime`, `bd ready`, and `bd show <id>` before starting work.

The local database uses the Dolt backend. Its runtime files are ignored by Git.
The tracked `issues.jsonl` is an explicit portable snapshot, including dependency
and issue-note data. On this installed Beads version, `bd sync` is a compatibility
no-op; it does not export or push that snapshot automatically.

Before committing issue changes, run:

```bash
bd sync
bd export -o .beads/issues.jsonl
git add .beads/issues.jsonl
```

Commit with the associated work and push. Do not stage the ignored database,
worktree redirect, or lock files. In a linked worktree, the local `redirect` file
points at the main checkout's `.beads` directory; it is never committed.

For new-clone initialization and recovery, read
[the development workflow](../docs/DEVELOPMENT.md). Importing a snapshot into an
already active database can update existing issues; inspect a dry run before
overwriting newer local work. Beads is not automatically synchronized between
different machines by pushing application code alone.
