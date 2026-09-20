#!/usr/bin/env python3
"""Check declared executable modes in an emitted npm archive without extraction."""
import json
import sys
import tarfile
from pathlib import PurePosixPath


def check_package_bin_modes(path):
    with tarfile.open(path, "r:gz") as archive:
        members = archive.getmembers()
        manifests = [member for member in members if member.name == "package/package.json"]
        if len(manifests) != 1 or not manifests[0].isfile() or manifests[0].size > 1024 * 1024:
            raise ValueError("Expected one regular bounded package/package.json")
        with archive.extractfile(manifests[0]) as source:
            manifest = json.load(source)
        bins = manifest.get("bin", {})
        if isinstance(bins, str):
            bins = {manifest["name"]: bins}
        if not isinstance(bins, dict):
            raise ValueError("Invalid package bin declaration")
        for target in bins.values():
            if not isinstance(target, str) or not target or "\\" in target:
                raise ValueError("Invalid package bin target")
            relative = PurePosixPath(target)
            if relative.is_absolute() or ".." in relative.parts or str(relative) in ("", "."):
                raise ValueError("Package bin target escapes archive")
            name = "package/" + str(relative)
            selected = [member for member in members if member.name == name]
            if len(selected) != 1 or not selected[0].isfile():
                raise ValueError(f"Expected one regular declared bin: {name}")
            if selected[0].mode != 0o755:
                raise ValueError(f"Declared bin {name}: expected mode 0755, actual {selected[0].mode:04o}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: check-package-bin-modes.py EMITTED_TARBALL")
    check_package_bin_modes(sys.argv[1])
