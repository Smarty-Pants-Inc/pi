#!/usr/bin/env python3
"""Fixture tests for the emitted-package declared-bin mode checker."""
import json
import pathlib
import subprocess
import sys
import tarfile
import tempfile

CHECKER = pathlib.Path(__file__).with_name("check-package-bin-modes.py")

def archive(path, mode):
    with tarfile.open(path, "w:gz") as out:
        manifest = json.dumps({"name": "fixture", "bin": {"fixture": "dist/cli.js"}}).encode()
        info = tarfile.TarInfo("package/package.json"); info.size = len(manifest); info.mode = 0o644
        import io
        out.addfile(info, io.BytesIO(manifest))
        body = b"#!/usr/bin/env node\n"
        info = tarfile.TarInfo("package/dist/cli.js"); info.size = len(body); info.mode = mode
        out.addfile(info, io.BytesIO(body))

def main():
    with tempfile.TemporaryDirectory() as directory:
        good = pathlib.Path(directory) / "good.tgz"; archive(good, 0o755)
        subprocess.run([sys.executable, str(CHECKER), str(good)], check=True)
        for mode in (0o644, 0o775):
            bad = pathlib.Path(directory) / f"bad-{mode:o}.tgz"; archive(bad, mode)
            result = subprocess.run([sys.executable, str(CHECKER), str(bad)], capture_output=True, text=True)
            assert result.returncode != 0 and "expected mode 0755" in result.stderr

if __name__ == "__main__":
    main()
