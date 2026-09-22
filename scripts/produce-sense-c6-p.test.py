"""Light source-DATA checks only. No npm, compiler, model hydration or P run."""
import importlib.util
import json
import os
import sys
import stat
import tarfile
import io
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("producer", Path(__file__).with_name("produce-sense-c6-p.py"))
producer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)


class Projection(unittest.TestCase):
    def test_exact_projection_modes_source_guard_and_once(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "source"
            rows = producer.project(target)
            self.assertEqual(len(rows), 1839)
            self.assertEqual(producer.sha((target / "package-lock.json").read_bytes()), producer.LOCK)
            by_path = {row["path"]: row for row in rows}
            for name in ("pi-test.bat", "pi-test.ps1"):
                self.assertEqual(producer.sha((target / name).read_bytes()), by_path[name]["selected"])
            with self.assertRaises(FileExistsError):
                producer.project(target)
            path = target / "package.json"
            path.write_bytes(path.read_bytes() + b" ")
            with self.assertRaisesRegex(ValueError, "selected source changed"):
                producer.guard(target, rows)

    def test_changed_manifest_or_archive_refuses_before_output(self):
        original = producer.ROOT / ".ci-fixtures/sense-c6-source2"
        for mode in ("manifest", "archive"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                fixture = root / ".ci-fixtures/sense-c6-source2"
                fixture.mkdir(parents=True)
                for name in ("SOURCE.json", "source.tar.gz"):
                    body = (original / name).read_bytes()
                    if (mode == "manifest" and name == "SOURCE.json") or (mode == "archive" and name == "source.tar.gz"):
                        body += b"tampered"
                    (fixture / name).write_bytes(body)
                target = root / "output"
                with patch.object(producer, "ROOT", root), self.assertRaises(ValueError):
                    producer.project(target)
                self.assertFalse(target.exists())

    def test_mock_phase_preserves_exit_and_refuses_exhausted_log(self):
        # Inert subprocess result only: no command, timeout or supplier executes.
        for code, body, success in [(0, b"OK", True), (124, b"end", False), (-15, b"end", False), (0, b"1234", False)]:
            with self.subTest(code=code, body=body), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                def mock_run(*args, **kwargs):
                    self.assertEqual(kwargs["umask"], 0o022)
                    kwargs["stdout"].write(body)
                    return SimpleNamespace(returncode=code)
                with patch.object(producer, "FILE_LIMIT", 4), patch.object(producer.subprocess, "run", mock_run):
                    if success:
                        producer.phase("MOCK", 600, ["NO_EXECUTION"], root, {}, root)
                    else:
                        with self.assertRaises(ValueError):
                            producer.phase("MOCK", 600, ["NO_EXECUTION"], root, {}, root)
                result = json.loads((root / "MOCK.json").read_text())
                self.assertEqual(result["returncode"], code)
                self.assertEqual(result["success"], success)
                self.assertEqual((root / "MOCK.log").read_bytes(), body)

    def test_child_creation_modes_without_parent_mask_or_archive_normalization(self):
        # Standard-library child only, no supplier/compiler/package command.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            previous = os.umask(0o077)
            try:
                producer.phase("mode-probe", 10, [sys.executable, "-I", "-B", "-c",
                    "from pathlib import Path; import os; p=Path('emitted'); p.write_bytes(b'DATA'); "
                    "os.chmod(p, p.stat().st_mode | 0o111)"], root, {}, root)
                self.assertEqual((root / "emitted").stat().st_mode & 0o777, 0o755)
                self.assertEqual((root / "mode-probe.log").stat().st_mode & 0o777, 0o600)
                self.assertEqual((root / "mode-probe.json").stat().st_mode & 0o777, 0o600)
                actual = os.umask(0o077)
                self.assertEqual(actual, 0o077)
            finally:
                os.umask(previous)

    def test_package_member_guards_remain_fail_closed(self):
        cases = [("package/dist/api.js", tarfile.REGTYPE, 0o600),
                 ("package/dist/cli.js", tarfile.REGTYPE, 0o711),
                 ("package/../api.js", tarfile.REGTYPE, 0o644),
                 ("package//api.js", tarfile.REGTYPE, 0o644),
                 ("package/api.js", tarfile.SYMTYPE, 0o644),
                 ("package/api.js", tarfile.LNKTYPE, 0o644),
                 ("package/api.js", tarfile.DIRTYPE, 0o755)]
        for name, kind, mode in cases:
            with self.subTest(name=name, kind=kind, mode=mode), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "tarballs").mkdir()
                (root / "pack-results.json").write_text(json.dumps([{"name": str(i)} for i in range(10)]))
                for index in range(10):
                    with tarfile.open(root / "tarballs" / f"{index}.tgz", "w:gz") as archive:
                        member = tarfile.TarInfo(name)
                        member.mode, member.type = mode, kind
                        if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE): member.linkname = "foreign"
                        member.size = 1 if kind == tarfile.REGTYPE else 0
                        archive.addfile(member, io.BytesIO(b"X") if member.size else None)
                with self.assertRaisesRegex(ValueError, "unsafe package member"):
                    producer.package_manifest(root, root / "source")
                self.assertFalse((root / "PI-C6-SOURCE2-MEMBERS.json").exists())

    def test_evidence_quota_is_failure_not_partial_success(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "output").write_bytes(b"1234")
            with patch.object(producer, "EVIDENCE_LIMIT", 3), self.assertRaisesRegex(ValueError, "quota exceeded"):
                producer.quota(path)
            self.assertEqual((path / "output").read_bytes(), b"1234")


if __name__ == "__main__":
    unittest.main()
