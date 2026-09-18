#!/usr/bin/env python3
"""Exercise native draft close/restart recovery with only synthetic data.

Requires a running Hyprland session and wtype. It opens one isolated Tauri window,
uses keyboard navigation to create John 1 draft text, requests the window close,
restarts the same binary, and checks the private SQLite journal. The script never
uses the normal application-data directory.
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BINARY = ROOT / "src-tauri" / "target" / "debug" / "scripture-journal"
BODY = "Native close restart synthetic draft"


def run(*args: str, **kwargs: object) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, check=True, text=True, **kwargs)


def clients() -> list[dict[str, object]]:
    return json.loads(run("hyprctl", "clients", "-j", capture_output=True).stdout)


def wait_for_window(pid: int) -> dict[str, object]:
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        for client in clients():
            if client.get("pid") == pid:
                return client
        time.sleep(0.1)
    raise RuntimeError("Timed out waiting for the Scripture Journal window")


def focus_and_type(window: dict[str, object]) -> None:
    # Hyprland 0.56 dispatchers use Lua expressions rather than legacy names.
    run("hyprctl", "dispatch", f'hl.dsp.focus({{ window = "address:{window["address"]}" }})')
    # Focus order: brand, reader controls, reader boundary/link, then New entry.
    run("wtype", "-k", "TAB", "-k", "TAB", "-k", "TAB", "-k", "TAB", "-k", "TAB",
        "-k", "TAB", "-k", "TAB", "-k", "TAB", "-k", "TAB", "-k", "TAB", "-k", "RETURN")
    time.sleep(0.4)
    # From New blank entry: Finish, title, Add current passage. Activate that
    # John 1 association, then advance to the Markdown textarea.
    run("wtype", "-k", "TAB", "-k", "TAB", "-k", "TAB", "-k", "RETURN", "-k", "TAB")
    run("wtype", BODY)


def close_window(window: dict[str, object]) -> None:
    run("hyprctl", "dispatch", f'hl.dsp.focus({{ window = "address:{window["address"]}" }})')
    # Alt+F4 is handled by the compositor as a normal client close request,
    # exercising Tauri's close-request listener instead of terminating the PID.
    run("wtype", "-M", "alt", "-k", "F4", "-m", "alt")


def start(environment: dict[str, str]) -> subprocess.Popen[str]:
    return subprocess.Popen([str(BINARY)], cwd=ROOT, env=environment,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, text=True)


def main() -> int:
    for command in ("hyprctl", "wtype"):
        if shutil.which(command) is None:
            raise RuntimeError(f"{command} is required")
    run("npm", "run", "tauri", "--", "build", "--debug", "--no-bundle", cwd=ROOT)
    with tempfile.TemporaryDirectory(prefix="scripture-journal-native-smoke-") as temporary:
        root = Path(temporary)
        environment = os.environ | {
            "XDG_DATA_HOME": str(root / "data"),
            "XDG_CONFIG_HOME": str(root / "config"),
            "XDG_CACHE_HOME": str(root / "cache"),
        }
        first = start(environment)
        try:
            window = wait_for_window(first.pid)
            focus_and_type(window)
            close_window(window)
            first.wait(timeout=15)
            second = start(environment)
            try:
                second_window = wait_for_window(second.pid)
                database = root / "data" / "com.ernestchuang.scripture-journal" / "journal.sqlite3"
                deadline = time.monotonic() + 10
                while not database.exists() and time.monotonic() < deadline:
                    time.sleep(0.1)
                with sqlite3.connect(database) as connection:
                    row = connection.execute(
                        "SELECT content FROM revisions ORDER BY rowid DESC LIMIT 1"
                    ).fetchone()
                if row is None:
                    raise RuntimeError("No recovered revision was written")
                content = json.loads(row[0])
                if content.get("body") != BODY or content.get("passages") != [{"book": 43, "chapter": 1}]:
                    raise RuntimeError(f"Recovered content mismatch: {content!r}")
                close_window(second_window)
                second.wait(timeout=15)
            finally:
                if second.poll() is None:
                    second.terminate()
                    second.wait(timeout=5)
        finally:
            if first.poll() is None:
                first.terminate()
                first.wait(timeout=5)
    print("native close/restart recovery smoke passed")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, subprocess.CalledProcessError, subprocess.TimeoutExpired, sqlite3.Error) as error:
        print(f"native close/restart recovery smoke failed: {error}", file=sys.stderr)
        raise SystemExit(1)
