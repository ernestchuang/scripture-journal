# Quota-aware continuation

The current Pro workflow runs with `--no-quota-monitor`: no quota metadata polling
and no proactive five-hour or weekly pauses. Actual worker/provider failures stop
the runner with logs; this mode does not bypass provider-enforced limits. The
optional quota controls below remain available if explicitly re-enabled.

`scripts/quota_runner.py` is a local supervisor for a bounded Beads issue. It uses
the installed Codex CLI login and an explicitly selected model, or the CLI/session
default when `--model` is omitted. It starts a separate CLI
session; it does not remotely control the current desktop conversation or assume
their accounts/quotas match.

The supervisor reads the documented `account/rateLimits/read` app-server method
between work units. By default, at 80% usage in any reported window it sleeps until
that window's reset, plus a one-minute margin. With `--quota-window primary`, only
the primary (normally five-hour) window triggers this proactive reserve. Weekly
usage remains visible but does not trigger a reserve pause. The user selected this
primary-only policy for the worker team. Actual provider denials still stop work;
this option does not override subscription limits or authorize credit purchases.
Sleeping and quota metadata requests do not invoke a model or generate model
tokens. Actual work, checkpointing, and resuming consume tokens normally.

The reserve is a heuristic, not a token forecast or hard in-flight cap. A single
work unit can still exhaust quota. The runner requests small units, preserves its
session ID, and resumes after a confirmed quota failure. It never kills a working
agent merely because the clock reaches a guessed reset. Unknown quota, login,
process, or output errors stop the runner for inspection. It does not purchase
credits, consume reset credits, or switch accounts/models to bypass limits.

```bash
# Metadata only: no model invocation.
python scripts/quota_runner.py --check --quota-window primary

# Run the full release from an existing dedicated worktree. A zero turn ceiling
# continues until completion, a release-wide external block, STOP, or an error.
python scripts/quota_runner.py --worktree "$PWD" --issue sj-dcr --release-issue sj-5nz \
  --model gpt-5.6-terra --routine-model gpt-5.6-luna \
  --complex-model gpt-5.6-sol --review-model gpt-6-astra \
  --review-every 1 --max-turns 0 --no-quota-monitor
```

Terra is the default coding worker. Sol handles explicitly routed complex coding,
including concurrency, data integrity, migration and difficult debugging. Terra
can assign an explicit bounded routine task
to Luna through the structured `next_kind`/`next_task` handoff; examples include
styling, documentation and fixtures. Core persistence, recovery, filesystem and
architectural work stays with the main coder or reviewer. Workers run sequentially
in the same dedicated worktree, with separate coding/routine session identities.

With `--review-model`, Astra runs an independent fresh-session review initially,
after every implementation unit by default (`--review-every 1`), when a worker
requests milestone review, and before accepting completion. A worker's `done`
becomes a pending completion review. Findings are recorded in Beads and routed
back to coding; only a review can confirm completion. Reviewers inspect actual
code, diffs, tests, and Beads acceptance criteria rather than summaries, and
change only review bookkeeping. A review routes to coding after its result, so
the supervisor does not loop through review bookkeeping.

The coordinator issue and the release epic are separate arguments. The runner
authorizes work on the configured release epic and all of its Beads descendants,
so it can complete independent release work after a feature is externally
blocked. A worker must record that blocker, evidence, and follow-up on the
affected feature's Bead, then return an independent next task with
`release_progress_possible: true`. The runner records the checkpoint and routes
it through Astra before continuing. It stops as `blocked` only when the worker
has inspected the release scope and found no meaningful independent progress,
and Astra has reviewed that terminal claim. Every structured worker result must
state this boolean: it is `true` for ordinary progress and feature-level blocks,
and may be `false` only for the release-wide impasse candidate.
External macOS runtime validation, translation licensing/permissions, and every
other release acceptance requirement remain requirements; a blocker must not be
resolved by weakening or deleting one. Helpful additions must be recorded in
Beads and do not authorize sync, E2EE, accounts, sharing, or mobile scope.
Use `--resume-blocked` to explicitly retry a stopped investigation; this preserves
the prior checkpoint and session IDs. It never reopens completed work. Failed
tests and installable missing tools should route to investigation rather than
being treated as missing user authorization.

The review gate governs supervisor completion; worker adherence to issue status
and code-scope instructions is also checked by the reviewer, not enforced by a
filesystem sandbox. All roles follow the selected monitoring policy.

The user has authorized noninteractive unrestricted development for this project.
The runner therefore passes `approval_policy="never"` and
`sandbox_mode="danger-full-access"` to its worker. This is a development tool, not
part of the journal application. Do not run it concurrently with another agent
editing the same worktree. It uses a repository-wide lock to prevent duplicate
runner instances, but cannot lock out ordinary editors or other Codex sessions.

Worker results are structured as `continue`, `done`, or `blocked`. Every unit is
instructed to update Beads, verify, commit, and push. The default invocation ceiling
is 50 units; it stops earlier on completion, a release-wide missing essential
input/access, or errors. `--max-turns 0` removes that ceiling for a deliberately
supervised full-release run. Only the selected release scope is authorized by a
run; finishing it does not silently start unrelated work.

State and private logs are stored under the Git common directory's `quota-runner/`
folder, outside tracked source. Logs may contain development tool output. To stop
after the active unit, create `STOP` there:

```bash
touch "$(git rev-parse --path-format=absolute --git-common-dir)/quota-runner/STOP"
```

Waiting checks STOP every 30 seconds. An active unit finishes before the stop
takes effect. Keep the machine powered on; a process cannot work while it is
asleep. On restart, the saved reset timestamp and session are reused; quota is
checked again before launching work. A terminal must remain open unless launched
under a process manager. Remove STOP to resume. A terminal `done`/`blocked` state
is deliberately sticky: review and archive `state.json` before a new task.

Protocol references: [Codex app-server](https://learn.chatgpt.com/docs/app-server)
and [noninteractive session resume](https://learn.chatgpt.com/docs/non-interactive-mode).
Tested with installed Codex CLI 0.154.0. The app-server interface is experimental;
incompatible responses fail closed.
