# Quota-aware continuation

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
primary-only policy for the Luna worker. Actual provider denials still stop work;
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

# Run from an existing dedicated worktree, until this issue is done or blocked.
python scripts/quota_runner.py --worktree "$PWD" --issue sj-kfw --model gpt-5.6-luna --quota-window primary
```

The user has authorized noninteractive unrestricted development for this project.
The runner therefore passes `approval_policy="never"` and
`sandbox_mode="danger-full-access"` to its worker. This is a development tool, not
part of the journal application. Do not run it concurrently with another agent
editing the same worktree. It uses a repository-wide lock to prevent duplicate
runner instances, but cannot lock out ordinary editors or other Codex sessions.

Worker results are structured as `continue`, `done`, or `blocked`. Every unit is
instructed to update Beads, verify, commit, and push. The default invocation ceiling
is 50 units; it stops earlier on completion, missing essential input, or errors.
Only the selected issue is authorized by a run; finishing it does not silently
start unrelated work. Change the issue deliberately for a broader objective.

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
