#!/usr/bin/env python3
"""Run checkpoint-sized Codex turns; quota checks and sleeping use no model calls."""
import argparse
import contextlib
import fcntl
import json
import math
from pathlib import Path
import queue
import subprocess
import threading
import time


def read_quota(codex="codex"):
    """Use the documented app-server RPC. Never read or print authentication tokens."""
    process = subprocess.Popen([codex, "app-server", "--stdio"], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    messages = queue.Queue()

    def read_lines():
        for line in process.stdout:
            try:
                messages.put(json.loads(line))
            except json.JSONDecodeError:
                continue
        messages.put(None)

    threading.Thread(target=read_lines, daemon=True).start()

    def send(value):
        process.stdin.write(json.dumps(value) + "\n")
        process.stdin.flush()

    def request(identifier, method, params=None):
        payload = {"id": identifier, "method": method}
        if params is not None:
            payload["params"] = params
        send(payload)
        deadline = time.monotonic() + 30
        while True:
            message = messages.get(timeout=max(0, deadline - time.monotonic()))
            if message is None:
                raise RuntimeError("Codex app-server closed before replying.")
            if message.get("id") != identifier:
                continue
            if "error" in message:
                raise RuntimeError(f"Quota RPC {method} failed; check Codex login and CLI compatibility.")
            return message["result"]

    try:
        request(1, "initialize", {"clientInfo": {"name": "scripture_journal_runner", "version": "0.1.0"},
                                  "capabilities": {"experimentalApi": False}})
        send({"method": "initialized"})
        return request(2, "account/rateLimits/read")
    finally:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        process.stdin.close()
        process.stdout.close()


def quota_decision(result, threshold, now, quota_window="all"):
    """Return safe public window details and earliest safe retry time, or fail closed."""
    buckets = result.get("rateLimitsByLimitId")
    if not buckets:
        bucket = result.get("rateLimits")
        buckets = {"default": bucket} if bucket else {}
    if not buckets:
        raise ValueError("No subscription quota returned. Automatic model calls are disabled.")
    windows, waits = [], []
    selected_windows = 0
    for name, bucket in buckets.items():
        if not isinstance(bucket, dict):
            raise ValueError("Invalid quota bucket.")
        if bucket.get("spendControlReached"):
            raise ValueError("Spending control reached; manual review required.")
        for kind in ("primary", "secondary"):
            window = bucket.get(kind)
            if window is None:
                continue
            used, reset = window.get("usedPercent"), window.get("resetsAt")
            if (isinstance(used, bool) or not isinstance(used, (int, float)) or
                    not math.isfinite(used) or not 0 <= used <= 100):
                raise ValueError("Invalid quota usage percentage.")
            windows.append({"bucket": name, "window": kind, "usedPercent": used, "resetsAt": reset})
            if quota_window == "primary" and kind != "primary":
                continue
            selected_windows += 1
            if used >= threshold:
                if isinstance(reset, bool) or not isinstance(reset, (int, float)) or not math.isfinite(reset):
                    raise ValueError("No usable reset time; refusing a blind retry loop.")
                # Stale snapshots must not result in a tight retry loop.
                waits.append(max(now + 300, reset + 60))
    if not selected_windows:
        raise ValueError("No measurable selected quota windows returned.")
    if result.get("ordinaryUsageAllowed") is False and not waits:
        raise ValueError("Ordinary usage is unavailable without a known limiting window.")
    return windows, max(waits) if waits else None


def write_json(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def choose_role(state, review_enabled, routine_enabled, review_every, complex_enabled=False):
    if review_enabled and (not state.get("review_initialized") or state.get("completion_pending")
                           or state.get("next_kind") == "review"
                           or state.get("units_since_review", 0) >= review_every):
        return "review"
    if complex_enabled and state.get("next_kind") == "complex":
        return "complex"
    if routine_enabled and state.get("next_kind") == "routine" and state.get("next_task", "").strip():
        return "routine"
    return "coding"


def record_result(state, result, role, review_enabled):
    state.update(result)
    if role == "review":
        state["review_initialized"] = True
        state["units_since_review"] = 0
        state["completion_pending"] = False
        # Reviewer feedback goes to the main coder; never recursively request reviews.
        if state.get("next_kind") == "review":
            state["next_kind"] = "coding"
    else:
        state["units_since_review"] = state.get("units_since_review", 0) + 1
        if review_enabled and result["status"] == "done":
            state["status"] = "continue"
            state["completion_pending"] = True
            state["next_kind"] = "review"


def execute_unit(codex, worktree, state_dir, state, issue, model=None, role="coding", review_enabled=False):
    output = state_dir / "last-result.json"
    output.unlink(missing_ok=True)
    schema = state_dir / "result-schema.json"
    write_json(schema, {"type": "object", "additionalProperties": False,
                       "required": ["status", "summary", "next_kind", "next_task"], "properties": {
                           "status": {"type": "string", "enum": ["continue", "done", "blocked"]},
                           "summary": {"type": "string"},
                           "next_kind": {"type": "string", "enum": ["coding", "routine", "complex", "review"]},
                           "next_task": {"type": "string"}}})
    prompt = (
        f"Continue Scripture Journal issue {issue} in {worktree}. Read AGENTS.md, run bd prime, "
        f"and read bd show {issue}, its notes, and relevant product contracts. "
        "Complete ONE small, reviewable unit of authorized work, then return. "
        "Do not attempt the entire release in one turn. Do not spawn agents. "
        "Preserve existing work. Verify changes, record remaining work in Beads, export its snapshot, "
        "commit and push before returning. Work only in this existing Git worktree. "
        "Use the model selected by the supervisor and the current CLI account; do not change models/accounts, buy credits, or change limits. "
        "You are the coding worker. Keep changes focused and tested. If a task needs unresolved architectural "
        "judgment or difficult debugging, checkpoint the evidence and return continue with next_kind complex "
        "or review. A failed test or missing installable development tool is work to investigate, not itself "
        "a reason to declare blocked. Reserve blocked for essential user input or inaccessible external resources. "
        "Do not modify or launch the quota runner. If an essential decision/access is missing, checkpoint "
        "and return blocked. Return done only when this issue is actually complete and pushed; "
        "otherwise continue. Before starting another substantial subtask, checkpoint and return so "
        "the external supervisor can route the next task and apply configured execution limits. "
        f"Previous checkpoint: {state.get('summary', 'See Beads notes and the working tree.')}"
    )
    prompt += (
        f"\nAssigned role: {role}. Next bounded task: {state.get('next_task', 'Follow the Beads checkpoint.')}. "
        "Return next_kind and a concrete next_task. Choose routine only for narrowly specified styling, "
        "documentation, fixtures, or mechanical UI work. Database, save ordering, recovery, migration, "
        "filesystem safety and architecture require complex coding or review. Choose complex for concurrency, "
        "data integrity, migrations, difficult debugging and cross-module design. Choose coding for ordinary "
        "feature implementation. Select by task difficulty, not automatically the largest model. Request review after a major "
        "feature milestone or changes to data integrity, saving, recovery, migrations or export safety. "
    )
    if review_enabled and role != "review":
        prompt += "Do not close the milestone issue: a separate reviewer must approve completion. Return done to request that completion review. "
    if role == "routine":
        prompt += "Implement ONLY the assigned routine task. If it reaches core logic, leave it for the coding worker; return continue with next_kind coding and explain the boundary. "
    if role == "review":
        prompt += (
            "You are an independent reviewer, not the coding worker. Inspect actual code, diffs, tests and "
            "Beads acceptance criteria; do not rely on worker summaries as proof. Review data-loss risks, "
            "save races, recovery, portability and untested assumptions relevant to the milestone. "
            "Do not change production code. File actionable findings in Beads and leave/reopen the milestone "
            "as in_progress if incomplete. Commit/push only review bookkeeping. Return continue and a focused "
            "coding task for fixable findings or remaining implementation. Return blocked only for essential "
            "missing user input/access. Return done and close the milestone only after verifying all acceptance "
            "criteria, tests and pushed changes. Your approval gates completion. "
        )
    command = [codex, "exec"]
    thread_key = "thread" if role == "coding" else f"{role}_thread"
    # Reviews start fresh for independence; routine work gets a separate session.
    if role != "review" and state.get(thread_key):
        command += ["resume", state[thread_key]]
    if model:
        command += ["--model", model]
    # Explicitly inherit the user's authorized unrestricted, noninteractive workflow.
    command += ["-c", 'approval_policy="never"', "-c", 'sandbox_mode="danger-full-access"',
                "--json", "--output-schema", str(schema), "-o", str(output), "-"]
    log_path = state_dir / f"turn-{time.time_ns()}.jsonl"
    with log_path.open("w") as log:
        process = subprocess.Popen(command, cwd=worktree, stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=log, text=True)
        try:
            process.stdin.write(prompt)
            process.stdin.close()
            for line in process.stdout:
                log.write(line)
                log.flush()
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if event.get("type") == "thread.started":
                    state[thread_key] = event["thread_id"]
                    write_json(state_dir / "state.json", state)
            returncode = process.wait()
        except BaseException:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            raise
        finally:
            process.stdout.close()
    if returncode:
        return None  # Caller retries only if a fresh quota query confirms exhaustion.
    if not output.exists():
        raise RuntimeError(f"Codex returned no structured checkpoint. Inspect {log_path}.")
    result = json.loads(output.read_text())
    if result.get("status") not in ("continue", "done", "blocked") or not isinstance(result.get("summary"), str):
        raise ValueError("Invalid checkpoint; stopping instead of launching more work.")
    if result.get("next_kind") not in ("coding", "routine", "complex", "review") or not isinstance(result.get("next_task"), str):
        raise ValueError("Invalid task routing; stopping instead of guessing a model.")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worktree", type=Path, default=Path.cwd())
    parser.add_argument("--issue", default="sj-kfw", help="Bounded Beads issue to finish")
    parser.add_argument("--threshold", type=float, default=80, help="Pause at this used percentage (default: 80)")
    parser.add_argument("--codex", default="codex")
    parser.add_argument("--model", help="Explicit coding-worker model; omitted uses the CLI/session default")
    parser.add_argument("--routine-model", help="Smaller worker for explicitly scoped routine tasks")
    parser.add_argument("--complex-model", help="Stronger coder for difficult implementation and debugging")
    parser.add_argument("--review-model", help="Independent reviewer; gates milestone completion")
    parser.add_argument("--review-every", type=int, default=4, help="Review after at most this many coding units")
    parser.add_argument("--quota-window", choices=("all", "primary"), default="all",
                        help="Proactive reserve: all windows or only the primary (normally five-hour) window")
    parser.add_argument("--check", action="store_true", help="Read quota only; never invoke a model")
    parser.add_argument("--no-quota-monitor", action="store_true", help="Do not read quota or proactively pause; stop on worker errors")
    parser.add_argument("--resume-blocked", action="store_true", help="Explicitly retry a blocked checkpoint without erasing its evidence")
    parser.add_argument("--max-turns", type=int, default=50, help="Safety ceiling for this invocation")
    parser.add_argument("--delay", type=float, default=0, help="Initial delay in seconds, without model calls")
    args = parser.parse_args()
    if not 1 <= args.threshold < 100 or args.max_turns < 1 or args.delay < 0 or args.review_every < 1:
        parser.error("Use threshold 1–99, positive max-turns, and nonnegative delay.")
    if args.check:
        windows, wake = quota_decision(read_quota(args.codex), args.threshold, time.time(), args.quota_window)
        print(json.dumps({"windows": windows, "waitUntil": wake}, indent=2))
        return
    worktree = args.worktree.resolve(strict=True)
    git_dir = Path(subprocess.check_output(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=worktree, text=True).strip())
    checkout_git_dir = Path(subprocess.check_output(["git", "rev-parse", "--absolute-git-dir"], cwd=worktree, text=True).strip())
    if checkout_git_dir == git_dir:
        raise ValueError("Use a linked Git worktree, not the main checkout.")
    state_dir = git_dir / "quota-runner"
    state_dir.mkdir(mode=0o700, exist_ok=True)
    with (state_dir / "lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state_path = state_dir / "state.json"
        state = json.loads(state_path.read_text()) if state_path.exists() else {}
        identity = {"worktree": str(worktree), "issue": args.issue}
        if state and any(state.get(key) != value for key, value in identity.items()):
            raise ValueError("Stored runner belongs to another issue/worktree. Archive its state before starting a different task.")
        if state.get("status") == "blocked" and args.resume_blocked:
            state["status"] = "continue"
        if state.get("status") in ("done", "blocked"):
            print(f"Runner is {state['status']}: {state.get('summary', '')}")
            return
        state.update(identity)
        write_json(state_path, state)
        stop = state_dir / "STOP"

        def sleep_until(wake):
            while time.time() < wake and not stop.exists():
                time.sleep(max(0, min(30, wake - time.time())))

        sleep_until(time.time() + args.delay)
        for _ in range(args.max_turns):
            while not stop.exists():
                if args.no_quota_monitor:
                    break
                _, wake = quota_decision(read_quota(args.codex), args.threshold, time.time(), args.quota_window)
                if wake is None:
                    break
                print(f"Quota reserve reached. Sleeping until {time.ctime(wake)}; no model calls.", flush=True)
                sleep_until(wake)
            if stop.exists():
                print("STOP requested; no further work launched.", flush=True)
                return
            role = choose_role(state, bool(args.review_model), bool(args.routine_model), args.review_every, bool(args.complex_model))
            model = {"coding": args.model, "routine": args.routine_model, "complex": args.complex_model, "review": args.review_model}[role]
            print(f"Starting {role} unit for {args.issue} using {model or 'CLI default'}.", flush=True)
            result = execute_unit(args.codex, worktree, state_dir, state, args.issue, model, role, bool(args.review_model))
            if result is None:
                if args.no_quota_monitor:
                    raise RuntimeError(f"Worker failed. Quota monitoring is disabled; inspect logs in {state_dir} before resuming.")
                _, wake = quota_decision(read_quota(args.codex), args.threshold, time.time(), args.quota_window)
                if wake is None:
                    raise RuntimeError(f"Codex failed without a confirmed quota limit. Inspect logs in {state_dir}.")
                sleep_until(wake)
                continue
            record_result(state, result, role, bool(args.review_model))
            write_json(state_path, state)
            print(f"{state['status']}: {result['summary']}", flush=True)
            if state["status"] != "continue":
                return
        print("Reached max-turns safety ceiling. Progress is saved; no further work launched.", flush=True)


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        main()
