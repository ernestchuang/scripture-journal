# Agent Instructions

Read README.md, docs/PRODUCT.md, docs/ARCHITECTURE.md, and the relevant data or
portability contract before implementing. User-confirmed requirements and proposed
policies must remain distinguishable. Current scope is a desktop rewrite; do not
infer approval of proposed architecture from its presence in the repository.

Use Git worktrees for changes. Keep the main checkout clean. Run `git worktree list`
before creating one; never reset/remove another session's branch, worktree, or stash.
Bounded independent agent work is allowed with clear file ownership; use separate
worktrees when implementations might overlap. Review and integrate every result.

Use Beads for ALL task status, dependencies, acceptance criteria, and handoffs.
Do not maintain task checklists in Markdown. Design documents describe contracts.

```bash
bd prime
bd ready
bd show <id>
bd update <id> --status=in_progress
```

Create/claim the issue before writing code. Read docs/DEVELOPMENT.md for worktree
database routing and new-clone recovery. This installation's `bd sync` is a no-op:
explicitly export the issue snapshot in the worktree being committed.

At each meaningful checkpoint, update the issue with decisions, validation,
limitations, and the next concrete step. At session end:

1. Check `git status`; run checks appropriate to the change.
2. Update issues; close only work actually delivered. Record remaining work.
3. Run `bd sync`, then `bd export -o .beads/issues.jsonl` in this worktree.
4. Stage exact intended files and commit; re-export if issue state changed.
5. Pull/rebase where an upstream exists, resolve conflicts, and push.
6. Verify the working tree is clean and the branch is up to date with its remote.
7. Hand off branch, issue IDs, validation, and next step. Never claim a push succeeded
   without checking it; report access failures and preserve the committed work.

No real journals, secrets, or downloaded scripture in source control. Never prune
journal versions automatically. Revisions, entry links, and export safety are
defined in docs/DATA-MODEL.md and docs/PORTABILITY.md.
