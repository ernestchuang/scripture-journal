#!/usr/bin/env python3
"""Exercise native draft close/restart recovery with only synthetic data.

Requires a running Hyprland session and wtype. It opens one isolated Tauri window,
waits for rendered controls, uses keyboard navigation to create John 1 draft text,
waits for its autosave, requests the window close, restarts the same binary, and
checks both the private SQLite journal and visibly reopened editor. The script
never uses the normal application-data directory. This proves autosave recovery;
it does not attempt to race the autosave to prove close-time flushing.
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
from typing import Callable

for site_packages in Path("/usr/lib").glob("python*/site-packages"):
    sys.path.append(str(site_packages))
try:
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi
except (ImportError, ValueError) as error:
    raise RuntimeError("Python GObject AT-SPI bindings are required") from error


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


def prepare_window(window: dict[str, object]) -> dict[str, object]:
    address = window["address"]
    run("hyprctl", "dispatch", f'hl.dsp.focus({{ window = "address:{address}" }})')
    run("hyprctl", "dispatch", f'hl.dsp.window.fullscreen({{ window = "address:{address}", mode = 0 }})')
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        for current in clients():
            if current.get("address") == address and current.get("fullscreen"):
                return current
        time.sleep(0.1)
    raise RuntimeError(f"Window {address} did not enter fullscreen for deterministic input")


def descendants(node: object) -> list[object]:
    found = [node]
    try:
        for index in range(node.get_child_count()):
            found.extend(descendants(node.get_child_at_index(index)))
    except Exception:
        pass
    return found


def wait_for_accessible(
    pid: int, predicate: Callable[[object], bool], description: str, timeout: float = 15,
) -> object:
    deadline = time.monotonic() + timeout
    observed: list[str] = []
    while time.monotonic() < deadline:
        desktop = Atspi.get_desktop(0)
        for index in range(desktop.get_child_count()):
            app = desktop.get_child_at_index(index)
            try:
                if app.get_process_id() != pid:
                    continue
                nodes = descendants(app)
                observed = [node.get_name() for node in nodes if node.get_name()][-20:]
                for node in nodes:
                    if predicate(node):
                        return node
            except Exception:
                continue
        time.sleep(0.1)
    raise RuntimeError(f"Timed out waiting for {description}; accessible names: {observed!r}")


def named(node: object, value: str) -> bool:
    try:
        return value.casefold() in (node.get_name() or "").casefold()
    except Exception:
        return False


def activate(node: object, description: str) -> None:
    try:
        action = node.get_action_iface()
        if action is None or action.get_n_actions() < 1 or not action.do_action(0):
            raise RuntimeError(f"Accessibility action failed for {description}")
    except Exception as error:
        raise RuntimeError(f"Could not activate {description}: {error}") from error


def focus_accessible_with_tabs(pid: int, window: dict[str, object], expected: str) -> object:
    address = window["address"]
    for _ in range(30):
        run("hyprctl", "dispatch", f'hl.dsp.send_shortcut({{ mods = "", key = "TAB", window = "address:{address}" }})')
        try:
            return wait_for_accessible(
                pid,
                lambda node: named(node, expected)
                and node.get_state_set().contains(Atspi.StateType.FOCUSED),
                f"focused {expected}",
                timeout=0.25,
            )
        except RuntimeError:
            continue
    raise RuntimeError(f"Could not focus {expected!r} through the native accessibility order")


def establish_draft(pid: int, window: dict[str, object]) -> None:
    reflect = wait_for_accessible(pid, lambda node: named(node, "Reflect on John 1"), "John 1 Reflect button")
    activate(reflect, "John 1 Reflect button")
    wait_for_accessible(pid, lambda node: named(node, "What stands out to you?"), "reflection editor")
    focus_accessible_with_tabs(pid, window, "What stands out to you?")
    run("hyprctl", "dispatch", f'hl.dsp.focus({{ window = "address:{window["address"]}" }})')
    run("wtype", BODY)
    wait_for_accessible(pid, lambda node: named(node, BODY), "synthetic body in reflection editor")


def close_window(window: dict[str, object]) -> None:
    address = window["address"]
    run("hyprctl", "dispatch", f'hl.dsp.focus({{ window = "address:{address}" }})')
    run("hyprctl", "dispatch", f'hl.dsp.window.close({{ window = "address:{address}" }})')


def wait_for_saved_draft(database: Path) -> str:
    deadline = time.monotonic() + 15
    observed = "database not created"
    while time.monotonic() < deadline:
        if database.exists():
            try:
                with sqlite3.connect(database) as connection:
                    row = connection.execute(
                        "SELECT e.id,e.working_revision_id,e.published_revision_id,r.content "
                        "FROM entries e JOIN revisions r ON r.id=e.working_revision_id"
                    ).fetchone()
                if row is not None:
                    content = json.loads(row[3])
                    observed = repr((row[:3], content))
                    if (content.get("body") == BODY
                            and content.get("passages") == [{"book": 43, "chapter": 1}]
                            and row[2] is None):
                        return str(row[0])
            except sqlite3.Error as error:
                observed = str(error)
        time.sleep(0.1)
    raise RuntimeError(f"Autosaved unfinished working head was not observed: {observed}")


def reopen_saved_entry(pid: int) -> None:
    entry = wait_for_accessible(
        pid,
        lambda node: node.get_role_name() == "button" and named(node, "John 1") and named(node, "Draft"),
        "recovered draft in the journal list",
    )
    activate(entry, "recovered draft")
    body = wait_for_accessible(pid, lambda node: named(node, BODY), "recovered draft body")
    state = body.get_state_set()
    if not state.contains(Atspi.StateType.VISIBLE) or not state.contains(Atspi.StateType.SHOWING):
        raise RuntimeError("Recovered draft body exists but is not visibly showing in the native editor")


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
            window = prepare_window(wait_for_window(first.pid))
            establish_draft(first.pid, window)
            database = root / "data" / "com.ernestchuang.scripture-journal" / "journal.sqlite3"
            entry_id = wait_for_saved_draft(database)
            close_window(window)
            first.wait(timeout=15)
            second = start(environment)
            try:
                second_window = prepare_window(wait_for_window(second.pid))
                with sqlite3.connect(database) as connection:
                    row = connection.execute(
                        "SELECT e.working_revision_id,e.published_revision_id,r.content "
                        "FROM entries e JOIN revisions r ON r.id=e.working_revision_id WHERE e.id=?",
                        (entry_id,),
                    ).fetchone()
                if row is None:
                    raise RuntimeError("Recovered working head was not found")
                content = json.loads(row[2])
                if (not row[0] or row[1] is not None or content.get("body") != BODY
                        or content.get("passages") != [{"book": 43, "chapter": 1}]):
                    raise RuntimeError(f"Recovered unfinished working head mismatch: {row[:2]!r}, {content!r}")
                reopen_saved_entry(second.pid)
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
