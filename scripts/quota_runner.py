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


def quota_decision(result, threshold, now):
    """Return safe public window details and earliest safe retry time, or fail closed."""
    buckets = result.get("rateLimitsByLimitId")
    if not buckets:
        bucket = result.get("rateLimits")
        buckets = {"default": bucket} if bucket else {}
    if not buckets:
        raise ValueError("No subscription quota returned. Automatic model calls are disabled.")
    windows, waits = [], []
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
            if used >= threshold:
                if isinstance(reset, bool) or not isinstance(reset, (int, float)) or not math.isfinite(reset):
                    raise ValueError("No usable reset time; refusing a blind retry loop.")
                # Stale snapshots must not result in a tight retry loop.
                waits.append(max(now + 300, reset + 60))
    if not windows:
        raise ValueError("No measurable quota windows returned.")
    if result.get("ordinaryUsageAllowed") is False and not waits:
        raise ValueError("Ordinary usage is unavailable without a known limiting window.")
    return windows, max(waits) if waits else None


def write_json(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def execute_unit(codex, worktree, state_dir, state, issue, model=None):
    output = state_dir / "last-result.json"
    output.unlink(missing_ok=True)
    schema = state_dir / "result-schema.json"
    write_json(schema, {"type": "object", "additionalProperties": False,
                       "required": ["status", "summary"], "properties": {
                           "status": {"type": "string", "enum": ["continue", "done", "blocked"]},
                           "summary": {"type": "string"}}})
    prompt = (
        f"Continue Scripture Journal issue {issue} in {worktree}. Read AGENTS.md, run bd prime, "
        f"and read bd show {issue}, its notes, and relevant product contracts. "
        "Complete ONE small, reviewable unit of authorized work, then return. "
        "Do not attempt the entire release in one turn. Do not spawn agents. "
        "Preserve existing work. Verify changes, record remaining work in Beads, export its snapshot, "
        "commit and push before returning. Work only in this existing Git worktree. "
        "Use the model selected by the supervisor and the current CLI account; do not change models/accounts, buy credits, or change limits. "
        "You are the coding worker. Keep changes focused and tested. If a task needs unresolved architectural "
        "judgment or you cannot resolve a correctness problem, checkpoint the evidence for a separate review "
        "and return blocked rather than repeatedly guessing. "
        "Do not modify or launch the quota runner. If an essential decision/access is missing, checkpoint "
        "and return blocked. Return done only when this issue is actually complete and pushed; "
        "otherwise continue. Before starting another substantial subtask, checkpoint and return so "
        "the external supervisor can check quota. "
        f"Previous checkpoint: {state.get('summary', 'See Beads notes and the working tree.')}"
    )
    command = [codex, "exec"]
    if state.get("thread"):
        command += ["resume", state["thread"]]
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
                    state["thread"] = event["thread_id"]
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
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worktree", type=Path, default=Path.cwd())
    parser.add_argument("--issue", default="sj-kfw", help="Bounded Beads issue to finish")
    parser.add_argument("--threshold", type=float, default=80, help="Pause at this used percentage (default: 80)")
    parser.add_argument("--codex", default="codex")
    parser.add_argument("--model", help="Explicit coding-worker model; omitted uses the CLI/session default")
    parser.add_argument("--check", action="store_true", help="Read quota only; never invoke a model")
    parser.add_argument("--max-turns", type=int, default=50, help="Safety ceiling for this invocation")
    parser.add_argument("--delay", type=float, default=0, help="Initial delay in seconds, without model calls")
    args = parser.parse_args()
    if not 1 <= args.threshold < 100 or args.max_turns < 1 or args.delay < 0:
        parser.error("Use threshold 1–99, positive max-turns, and nonnegative delay.")
    if args.check:
        windows, wake = quota_decision(read_quota(args.codex), args.threshold, time.time())
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
                _, wake = quota_decision(read_quota(args.codex), args.threshold, time.time())
                if wake is None:
                    break
                print(f"Quota reserve reached. Sleeping until {time.ctime(wake)}; no model calls.", flush=True)
                sleep_until(wake)
            if stop.exists():
                print("STOP requested; no further work launched.", flush=True)
                return
            print(f"Starting one checkpoint-sized unit for {args.issue}.", flush=True)
            result = execute_unit(args.codex, worktree, state_dir, state, args.issue, args.model)
            if result is None:
                _, wake = quota_decision(read_quota(args.codex), args.threshold, time.time())
                if wake is None:
                    raise RuntimeError(f"Codex failed without a confirmed quota limit. Inspect logs in {state_dir}.")
                sleep_until(wake)
                continue
            state.update(result)
            write_json(state_path, state)
            print(f"{result['status']}: {result['summary']}", flush=True)
            if result["status"] != "continue":
                return
        print("Reached max-turns safety ceiling. Progress is saved; no further work launched.", flush=True)


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        main()
