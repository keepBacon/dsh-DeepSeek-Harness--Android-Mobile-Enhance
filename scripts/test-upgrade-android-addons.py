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

    def test_foreign_platform_prebuilds_excluded(self):
        for candidate in (
                "prebuilds/win32-x64/conpty_console_list.node",
                "prebuilds/linux-arm64/pty.node",
                "prebuilds/darwin-arm64/pty.node",
                "prebuilds/android-arm/pty.node",
                "build/linux-arm64/koffi.node"):
            with self.subTest(candidate=candidate):
                self.assertFalse(mod.is_android_seed_addon_path(candidate))

    def test_android_prebuild_and_build_output_included(self):
        for candidate in (
                "prebuilds/android-arm64/pty.node",
                "build/Release/pty.node",
                "build/Release/koffi.node"):
            with self.subTest(candidate=candidate):
                self.assertTrue(mod.is_android_seed_addon_path(candidate))

    def test_prune_foreign_prebuilds_keeps_android_and_unknown(self):
        filenames = (
            "node-pty/prebuilds/win32-x64/conpty_console_list.node",
            "node-pty/prebuilds/linux-arm64/pty.node",
            "node-pty/prebuilds/android-arm64/pty.node",
            "node-pty/build/Release/pty.node",
        )
        for filename in filenames:
            candidate = self.modules / filename
            candidate.parent.mkdir(parents=True, exist_ok=True)
            candidate.write_bytes(elf())
        removed = mod.prune_foreign_prebuilds(self.modules)
        self.assertEqual(len(removed), 2)
        for filename in filenames[:2]:
            self.assertFalse((self.modules / filename).exists())
        for filename in filenames[2:]:
            self.assertTrue((self.modules / filename).exists())

    def test_exact_android_koffi_optional_package_is_staged(self):
        seed = Path(self.tmp.name) / "seed"
        package = seed / "@koromix/koffi-android-arm64"
        package.mkdir(parents=True)
        (package / "package.json").write_text(
            '{"name":"@koromix/koffi-android-arm64","version":"3.3.0"}')
        addon = package / "build" / "koffi.node"
        addon.parent.mkdir()
        addon.write_bytes(elf())
        staged = mod.stage_android_koffi_optional(seed, self.modules, "3.3.0")
        self.assertEqual(len(staged), 1)
        self.assertEqual(mod.validate_android_addons(self.modules, staged), 1)

    def test_koffi_optional_version_mismatch_rejected(self):
        seed = Path(self.tmp.name) / "seed"
        package = seed / "@koromix/koffi-android-arm64"
        package.mkdir(parents=True)
        (package / "package.json").write_text(
            '{"name":"@koromix/koffi-android-arm64","version":"3.2.0"}')
        with self.assertRaisesRegex(ValueError, "version differs"):
            mod.stage_android_koffi_optional(seed, self.modules, "3.3.0")

    def test_missing_android_koffi_optional_does_not_fake_binding(self):
        seed = Path(self.tmp.name) / "missing-seed"
        self.assertEqual(mod.stage_android_koffi_optional(
            seed, self.modules, "3.3.0"), [])

    def test_symlink_rejected(self):
        source = Path(self.tmp.name) / "external.node"
        source.write_bytes(elf())
        (self.modules / "escape.node").symlink_to(source)
        with self.assertRaisesRegex(ValueError, "unsafe packaged"):
            mod.validate_android_addons(self.modules, set())

if __name__ == "__main__":
    unittest.main()
