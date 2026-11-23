#!/usr/bin/env python3
"""Offline negative tests for the actual cloud-task input/ZIP validation."""
import importlib.util
from pathlib import Path
import tempfile
import zipfile
import unittest

SCRIPT = Path(__file__).resolve().parent / "ci-dsh-cloud-analysis.py"
spec = importlib.util.spec_from_file_location("dsh_cloud_analysis", SCRIPT)
cloud = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cloud)


class CloudAnalysisValidation(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="dsh-cloud-tests-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "cloud-inputs").mkdir()
        self.fixture = self.root / "cloud-inputs" / "sample.apk"
        self.fixture.write_bytes(b"ZIP fixture, no real APK")
        
    def test_repo_relative_file(self):
        self.assertEqual(cloud.validate_input(self.root, "cloud-inputs/sample.apk"), self.fixture)
        
    def test_no_other_repository_files(self):
        (self.root / "credential.txt").write_text("private")
        for path in ("credential.txt", "/etc/passwd", "cloud-inputs/../credential.txt",
                     "cloud-inputs/../../etc/passwd", "cloud-inputs/nonexistent.apk",
                     "cloud-inputs/space name.apk", "cloud-inputs/foo;uname.apk"):
            with self.subTest(path=path):
                with self.assertRaises((ValueError, OSError)):
                    cloud.validate_input(self.root, path)
    
    def test_reject_symlink_outside_inputs(self):
        (self.root / "cloud-inputs" / "indirect").symlink_to(self.root / "credential.txt")
        with self.assertRaises((ValueError, OSError)):
            cloud.validate_input(self.root, "cloud-inputs/indirect")
    
    def test_reject_oversized_input(self):
        with self.fixture.open("wb") as f:
            f.truncate(cloud.MAX_INPUT + 1)
        with self.assertRaisesRegex(ValueError, "100 MiB"):
            cloud.validate_input(self.root, "cloud-inputs/sample.apk")
    
    def test_reject_malicious_zip(self):
        archive = self.root / "evil.zip"
        with zipfile.ZipFile(archive, "w") as z:
            z.writestr("../escape", "not allowed")
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            cloud.extract_verified_zip(archive, self.root / "extract")
        self.assertFalse((self.root / "escape").exists())
    
    def test_pinned_tools(self):
        self.assertEqual(len(cloud.JADX_SHA256), 64)
        self.assertEqual(len(cloud.GHIDRA_SHA256), 64)
        self.assertTrue(cloud.JADX_URL.startswith("https://github.com/skylot/jadx/releases/"))
        self.assertTrue(cloud.GHIDRA_URL.startswith(
            "https://github.com/NationalSecurityAgency/ghidra/releases/"))


if __name__ == "__main__":
    unittest.main()
