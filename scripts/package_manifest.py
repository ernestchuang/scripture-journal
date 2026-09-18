"""Record the exact build identity and hashes without claiming signing/runtime QA."""
import hashlib
import json
import os
from pathlib import Path
import platform
import sys


def write_manifest(directory: Path) -> None:
    files = []
    for path in sorted(directory.iterdir()):
        if path.is_file() and path.name != "manifest.json":
            with path.open("rb") as source:
                digest = hashlib.file_digest(source, "sha256").hexdigest()
            files.append({"name": path.name, "bytes": path.stat().st_size, "sha256": digest})
    if not any(item["name"].endswith((".deb", ".AppImage", ".dmg", ".app.zip")) for item in files):
        raise ValueError("No desktop packages were produced")
    manifest = {
        "formatVersion": 1,
        "commit": os.environ.get("GITHUB_SHA", "local"),
        "target": os.environ.get("PACKAGE_TARGET", "local"),
        "runnerArchitecture": platform.machine(),
        "distribution": "unsigned test build; not notarized",
        "runtimeAcceptance": "not established by packaging",
        "files": files,
    }
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    write_manifest(Path(sys.argv[1]))
