"""Light source-DATA checks only. No npm, compiler, model hydration or P run."""
import importlib.util
import json
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

    def test_evidence_quota_is_failure_not_partial_success(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "output").write_bytes(b"1234")
            with patch.object(producer, "EVIDENCE_LIMIT", 3), self.assertRaisesRegex(ValueError, "quota exceeded"):
                producer.quota(path)
            self.assertEqual((path / "output").read_bytes(), b"1234")


if __name__ == "__main__":
    unittest.main()
