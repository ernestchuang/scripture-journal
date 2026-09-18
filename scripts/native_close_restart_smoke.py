#!/usr/bin/env python3
"""Exercise native draft close/restart recovery with only synthetic data.

Requires a running Hyprland session with AT-SPI. It opens one isolated Tauri window,
waits for rendered controls, creates and visibly recovers an autosaved John 1
draft, then edits it again and observes the new body in the UI while SQLite still
contains the prior body. It immediately requests a graceful close and verifies a
second restart recovers that pending generation. The script never uses the normal
application-data directory.
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
BINARY = Path(os.environ.get("CARGO_TARGET_DIR", str(ROOT / "src-tauri" / "target"))) / "debug" / "scripture-journal"
BODY = "Native close restart synthetic draft"
DIRTY_BODY = "Dirty"


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
    current = next((item for item in clients() if item.get("address") == address), window)
    if not current.get("fullscreen"):
        run("hyprctl", "dispatch", f'hl.dsp.window.fullscreen({{ window = "address:{address}", mode = "fullscreen" }})')
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
        if value.casefold() in (node.get_name() or "").casefold():
            return True
        if node.get_state_set().contains(Atspi.StateType.EDITABLE):
            text = node.get_text_iface()
            return text is not None and value.casefold() in text.get_text(0, -1).casefold()
        return False
    except Exception:
        return False


def activate(node: object, description: str) -> None:
    try:
        action = node.get_action_iface()
        if action is None or action.get_n_actions() < 1 or not action.do_action(0):
            raise RuntimeError(f"Accessibility action failed for {description}")
    except Exception as error:
        raise RuntimeError(f"Could not activate {description}: {error}") from error


def send_shortcut(window: dict[str, object], key: str, mods: str = "") -> None:
    run(
        "hyprctl", "dispatch",
        f'hl.dsp.send_shortcut({{ mods = "{mods}", key = "{key}", '
        f'window = "address:{window["address"]}" }})',
        stdout=subprocess.DEVNULL,
    )


def send_text(window: dict[str, object], value: str) -> None:
    for character in value:
        if character == " ":
            send_shortcut(window, "space")
        elif character.isalpha():
            send_shortcut(window, character.lower(), "SHIFT" if character.isupper() else "")
        else:
            raise RuntimeError(f"Unsupported synthetic input character: {character!r}")


def focus_accessible_with_tabs(pid: int, window: dict[str, object], expected: str) -> object:
    try:
        return wait_for_accessible(pid, lambda node: named(node, expected)
                                   and node.get_state_set().contains(Atspi.StateType.FOCUSED),
                                   f"already focused {expected}", timeout=0.1)
    except RuntimeError:
        pass
    for _ in range(30):
        send_shortcut(window, "TAB")
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


def enter_body(pid: int, window: dict[str, object], current_text: str, replacement: str) -> None:
    for _ in range(3):
        focus_accessible_with_tabs(pid, window, current_text)
        send_shortcut(window, "a", "CTRL")
        send_text(window, replacement)
        try:
            wait_for_accessible(pid, lambda node: named(node, replacement), "synthetic body in editor", timeout=1)
            return
        except RuntimeError:
            continue
    raise RuntimeError(f"Could not enter {replacement!r} in the focused native editor")


def establish_draft(pid: int, window: dict[str, object]) -> None:
    reflect = wait_for_accessible(pid, lambda node: named(node, "Reflect on John 1"), "John 1 Reflect button")
    activate(reflect, "John 1 Reflect button")
    wait_for_accessible(pid, lambda node: named(node, "What stands out to you?"), "reflection editor")
    enter_body(pid, window, "What stands out to you?", BODY)


def replace_body_without_waiting_for_autosave(pid: int, window: dict[str, object]) -> None:
    enter_body(pid, window, BODY, DIRTY_BODY)


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


def read_working_head(database: Path, entry_id: str) -> tuple[str, str | None, dict[str, object]]:
    with sqlite3.connect(database) as connection:
        row = connection.execute(
            "SELECT e.working_revision_id,e.published_revision_id,r.content "
            "FROM entries e JOIN revisions r ON r.id=e.working_revision_id WHERE e.id=?",
            (entry_id,),
        ).fetchone()
    if row is None:
        raise RuntimeError("Recovered working head was not found")
    return str(row[0]), row[1], json.loads(row[2])


def assert_working_head(database: Path, entry_id: str, expected_body: str) -> None:
    working_revision_id, published_revision_id, content = read_working_head(database, entry_id)
    if (not working_revision_id or published_revision_id is not None
            or content.get("body") != expected_body
            or content.get("passages") != [{"book": 43, "chapter": 1}]):
        raise RuntimeError(
            f"Recovered unfinished working head mismatch: "
            f"{(working_revision_id, published_revision_id)!r}, {content!r}"
        )


def reopen_saved_entry(pid: int, window: dict[str, object], expected_body: str) -> None:
    entry = wait_for_accessible(
        pid,
        lambda node: node.get_role_name() == "button" and named(node, "John 1") and named(node, "Draft"),
        "recovered draft in the journal list",
    )
    activate(entry, "recovered draft")
    # Additional journal controls can put the body below the fold. Keyboard focus
    # scrolls the real editor into view before asserting rendered recovery.
    focus_accessible_with_tabs(pid, window, expected_body)
    wait_for_accessible(pid, lambda node: named(node, expected_body)
                        and node.get_state_set().contains(Atspi.StateType.FOCUSED)
                        and node.get_state_set().contains(Atspi.StateType.VISIBLE)
                        and node.get_state_set().contains(Atspi.StateType.SHOWING),
                        "visibly focused recovered draft body")


def start(environment: dict[str, str]) -> subprocess.Popen[str]:
    return subprocess.Popen([str(BINARY)], cwd=ROOT, env=environment,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, text=True)


def main() -> int:
    for command in ("hyprctl",):
        if shutil.which(command) is None:
            raise RuntimeError(f"{command} is required")
    run("npm", "run", "tauri", "--", "build", "--debug", "--no-bundle", cwd=ROOT)
    with tempfile.TemporaryDirectory(prefix="scripture-journal-native-smoke-") as temporary:
        root = Path(temporary)
        environment = os.environ | {
            "SCRIPTURE_JOURNAL_SMOKE_DARK": "1",
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
                assert_working_head(database, entry_id, BODY)
                reopen_saved_entry(second.pid, second_window, BODY)
                replace_body_without_waiting_for_autosave(second.pid, second_window)
                # This is state evidence, not an inference from elapsed time: the
                # webview exposes the new body while SQLite still has the prior head.
                assert_working_head(database, entry_id, BODY)
                close_window(second_window)
                second.wait(timeout=15)
                assert_working_head(database, entry_id, DIRTY_BODY)
                third = start(environment)
                try:
                    third_window = prepare_window(wait_for_window(third.pid))
                    assert_working_head(database, entry_id, DIRTY_BODY)
                    reopen_saved_entry(third.pid, third_window, DIRTY_BODY)
                    close_window(third_window)
                    third.wait(timeout=15)
                finally:
                    if third.poll() is None:
                        third.terminate()
                        third.wait(timeout=5)
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
