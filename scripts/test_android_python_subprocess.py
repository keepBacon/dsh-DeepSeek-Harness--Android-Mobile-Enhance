#!/usr/bin/env python3
"""Offline Linux regression for Android pip/PEP517 W^X subprocess routing."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("dsh-android-python-subprocess.py")
spec = importlib.util.spec_from_file_location("dsh_android_subprocess", SCRIPT)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class AndroidPythonNoexec(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="dsh-android-pip-")
        self.addCleanup(self.tmp.cleanup)
        self.prefix = Path(self.tmp.name) / "usr"
        self.bin = self.prefix / "bin"
        self.bin.mkdir(parents=True)
        self.home = Path(self.tmp.name) / "home"
        self.home.mkdir()
        self.shell_script = Path(self.tmp.name) / "mock-android-exec.sh"
        # This mock is Linux-only. Production uses /system/bin/sh + Android
        # linker64; this validates argv, env, cwd and Popen behavior, not ABI.
        self.shell_script.write_text(
            '#!/bin/sh\n'
            'target="$1"; shift\n'
            'case "$target" in\n'
            '  */bin/python3|*/bin/clang|*/bin/clang++) exec '+sys.executable+' "$@" ;;\n'
            '  *) exit 91 ;;\n'
            'esac\n', encoding="utf8")
        for name in ("python3", "clang", "clang++"):
            (self.bin / name).write_text("ANDROID_NOEXEC_ELF", encoding="utf8")
        self.env = {
            "HOME": str(self.home), "PATH": "/usr/bin:/bin",
            "DSH_ANDROID_STANDALONE": "1", "TERMUX__PREFIX": str(self.prefix),
        }

    def test_legacy_absolute_python_and_compiler(self):
        for name, mapped in (("/usr/bin/python3", "python3"),
                             ("/usr/bin/clang", "clang"),
                             ("python3", "python3"),
                             ("clang", "clang")):
            selected = bridge.bridge_argv(
                [name, "--version"], prefix=self.prefix,
                home=self.home, env=self.env, shell="/bin/sh",
                bridge=str(self.shell_script))
            self.assertEqual(selected, [
                "/bin/sh", str(self.shell_script),
                str(self.bin / mapped), "--version"])
    
    def test_unrelated_system_exec_not_intercepted(self):
        self.assertIsNone(bridge.bridge_argv(
            ["/bin/echo", "test"], prefix=self.prefix,
            home=self.home, env=self.env, bridge=str(self.shell_script)))
        self.assertIsNone(bridge.bridge_argv(
            ["echo", "test"], prefix=self.prefix,
            home=self.home, env=self.env, bridge=str(self.shell_script)))
    
    def test_build_script_cwd_and_argv(self):
        build_dir = self.home / "pip-build"
        build_dir.mkdir()
        (build_dir / "configure").write_text("#!/bin/sh\nexit 0\n")
        payload = ["./configure", "space in arg", "", "; literal text"]
        self.assertEqual(bridge.bridge_argv(
            payload, prefix=self.prefix, home=self.home,
            env=self.env, cwd=build_dir, shell="/bin/sh",
            bridge=str(self.shell_script)),
            ["/bin/sh", str(self.shell_script), str(build_dir / "configure"),
             "space in arg", "", "; literal text"])
    
    def test_deny_prefix_symlink_into_system(self):
        (self.bin / "fake").symlink_to("/bin/echo")
        self.assertIsNone(bridge.bridge_argv(
            [str(self.bin / "fake"), "no"], prefix=self.prefix,
            home=self.home, env=self.env, shell="/bin/sh",
            bridge=str(self.shell_script)))
    
    def test_actual_subprocess_popen_traverses_bridge_once(self):
        original = subprocess.Popen.__init__
        previous = {name: os.environ.get(name) for name in ("CC", "CXX", "LDSHARED")}
        with patch.dict(os.environ, self.env, clear=False):
            try:
                self.assertTrue(bridge.install(prefix=self.prefix,
                    shell="/bin/sh", bridge=str(self.shell_script), force=True))
                self.assertTrue(subprocess.Popen._dsh_android_wx_bridge)
                self.assertIn(str(self.bin / "clang"), os.environ["CC"])
                for command in (["/usr/bin/python3", "-c", "print('PIP_BACKEND_OK')"],
                                ["python3", "-c", "print('PIP_BACKEND_OK')"]):
                    result = subprocess.run(command, text=True,
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                        cwd=self.home, env=self.env, timeout=5, check=True)
                    self.assertEqual(result.stdout.strip(), "PIP_BACKEND_OK")
                # Explicit system commands and shell=True must stay untouched.
                self.assertEqual(subprocess.check_output(
                    ["/bin/echo", "SYSTEM_OK"], text=True).strip(), "SYSTEM_OK")
                self.assertEqual(subprocess.check_output(
                    "printf SHELL_OK", shell=True, text=True), "SHELL_OK")
            finally:
                subprocess.Popen.__init__ = original
                if hasattr(subprocess.Popen, "_dsh_android_wx_bridge"):
                    del subprocess.Popen._dsh_android_wx_bridge
                bridge._PATCHED = False
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


if __name__ == "__main__":
    unittest.main()
