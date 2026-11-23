#!/usr/bin/env python3
"""Real packaging fixture for the Android Python noexec adapter."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
import sys

SCRIPTS=Path(__file__).resolve().parent
ROOT=SCRIPTS.parent
spec=importlib.util.spec_from_file_location(
    "android_python_native_builder", SCRIPTS/"ci-assemble-github-runtime.py")
builder=importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class PythonPackageOverlayTests(unittest.TestCase):
    def test_python_site_and_mcp_overlay(self):
        with tempfile.TemporaryDirectory(prefix="dsh-python-overlay-") as temp:
            stage=Path(temp)
            site=stage/"usr/lib/python3.13/site-packages"
            site.mkdir(parents=True)
            (stage/"usr/bin").mkdir(parents=True)
            builder.overlay_sources(stage, ROOT)
            launcher=stage/"usr/libexec/dsh-mobile/dsh-android-python-subprocess.py"
            module=site/"dsh_android_subprocess.py"
            entry=site/"dsh_android_noexec.pth"
            self.assertEqual(launcher.read_bytes(), module.read_bytes())
            self.assertEqual(entry.read_text(),
                "import dsh_android_subprocess; dsh_android_subprocess.install()\n")
            compile(module.read_text(), str(module), "exec")
            self.assertTrue((stage/"usr/libexec/dsh-mobile/android-exec.sh").is_file())
            self.assertTrue((stage/"usr/libexec/dsh/wrappers/python3").is_symlink())


if __name__=="__main__":
    unittest.main()
