#!/usr/bin/env python3
"""Regression tests for origin-verified DSH 0.2 Android native add-ons."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("ci-upgrade-dsh-runtime.py")
spec = importlib.util.spec_from_file_location("ci_upgrade_dsh_runtime", SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

def elf(machine=183):
    header = bytearray(20)
    header[:4] = bytes((0x7f, 69, 76, 70))
    header[4:6] = bytes((2, 1))
    header[18:20] = machine.to_bytes(2, "little")
    return bytes(header)

class AndroidAddonOriginTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.modules = Path(self.tmp.name) / "node_modules"
        self.modules.mkdir()

    def test_matched_seed_addon_accepted(self):
        path = self.modules / "node-pty" / "build" / "Release" / "pty.node"
        path.parent.mkdir(parents=True)
        path.write_bytes(elf())
        self.assertEqual(mod.validate_android_addons(self.modules, {path}), 1)

    def test_host_glibc_arm64_addon_rejected(self):
        path = self.modules / "@img" / "sharp-linux-arm64" / "lib" / "sharp.node"
        path.parent.mkdir(parents=True)
        path.write_bytes(elf())
        with self.assertRaisesRegex(ValueError, "unverified host/native"):
            mod.validate_android_addons(self.modules, set())

    def test_wrong_architecture_rejected(self):
        path = self.modules / "test.node"
        path.write_bytes(elf(62))
        with self.assertRaisesRegex(ValueError, "non-ARM64"):
            mod.validate_android_addons(self.modules, {path})

    def test_missing_seed_path_rejected(self):
        path = self.modules / "missing.node"
        with self.assertRaises(FileNotFoundError):
            mod.validate_android_addons(self.modules, {path})

    def test_symlink_rejected(self):
        source = Path(self.tmp.name) / "external.node"
        source.write_bytes(elf())
        (self.modules / "escape.node").symlink_to(source)
        with self.assertRaisesRegex(ValueError, "unsafe packaged"):
            mod.validate_android_addons(self.modules, set())

if __name__ == "__main__":
    unittest.main()
