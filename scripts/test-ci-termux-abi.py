#!/usr/bin/env python3
"""Offline tests for coherent APT/libc++ native overlay, no Android device required."""
from pathlib import Path
import tempfile
import unittest
from ci_termux_abi import apt_abi_packages, is_elf, should_replace_native, overlay_one


class AbiTest(unittest.TestCase):
    def test_apt_dependency_cohort(self):
        index = {
            "apt": ("repo", {"Depends": "libapt-pkg, libc++"}),
            "libapt-pkg": ("repo", {"Depends": "libc++"}),
            "libc++": ("repo", {}),
            "unrelated": ("repo", {}),
        }
        def names(s, lookup):
            return [item.strip() for item in s.strip(",").split(",") if item.strip()]
        self.assertEqual(apt_abi_packages(index, names), {"apt", "libapt-pkg", "libc++"})

    def test_replace_only_cohort_native_members(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            elf = root / "binary"
            elf.write_bytes(b"\x7fELF\x02\x01")
            other = root / "script"
            other.write_text("#!/bin/sh\n")
            self.assertTrue(is_elf(elf))
            self.assertFalse(is_elf(other))
            cohort = {"apt", "libc++"}
            self.assertTrue(should_replace_native("apt", cohort, elf, Path("bin/apt")))
            self.assertTrue(should_replace_native("libc++", cohort, elf, Path("lib/libc++_shared.so")))
            self.assertFalse(should_replace_native("other", cohort, elf, Path("lib/libwhatever.so")))
            self.assertFalse(should_replace_native("apt", cohort, other, Path("etc/apt/sources.list")))
            alias = root / "alias"
            alias.symlink_to("binary")
            self.assertTrue(should_replace_native("libc++", cohort, alias, Path("lib/libc++.so")))
            self.assertFalse(should_replace_native("libc++", cohort, alias, Path("bin/apt")))
            self.assertTrue(should_replace_native("clang", {"clang"}, alias, Path("bin/clang++")))
            self.assertFalse(should_replace_native("noncohort", {"clang"}, alias, Path("bin/clang++")))

    def test_overlay_does_not_follow_seed_symlink(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            src = root / "new"
            src.write_bytes(b"\x7fELFnew")
            old = root / "old"
            old.write_bytes(b"do-not-touch")
            dest = root / "dest"
            dest.symlink_to("old")
            self.assertFalse(overlay_one(src, dest, allow_replace=False))
            self.assertEqual(old.read_bytes(), b"do-not-touch")
            self.assertTrue(overlay_one(src, dest, allow_replace=True))
            self.assertEqual(dest.read_bytes(), src.read_bytes())
            self.assertEqual(old.read_bytes(), b"do-not-touch")

    def test_rebase_absolute_termux_symlink(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            out = root / "stage/usr/bin"
            out.mkdir(parents=True)
            target = out / "clang-21"
            target.write_bytes(b"native-compiler")
            src = root / "src"
            src.symlink_to("/data/data/com.termux/files/usr/bin/clang-21")
            dst = out / "clang"
            self.assertTrue(overlay_one(src, dst, allow_replace=True))
            self.assertTrue(dst.is_symlink())
            self.assertEqual(dst.resolve(), target.resolve())
            self.assertEqual(dst.read_bytes(), b"native-compiler")

    def test_overlay_preserves_non_native_seed(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            src, dest = root / "src", root / "dest"
            src.write_bytes(b"new")
            dest.write_bytes(b"seed")
            self.assertFalse(overlay_one(src, dest))
            self.assertEqual(dest.read_bytes(), b"seed")


if __name__ == "__main__":
    unittest.main()
