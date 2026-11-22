#!/usr/bin/env python3
"""Release provenance tests using pure metadata, no device or APK fixtures."""
import importlib.util
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent

def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

runtime = load("ci_validate_runtime", "ci-validate-runtime.py")
apk = load("ci_verify_current_apk", "ci-verify-current-apk.py")

VERSION = "0.2.2-rc.5"
COMMIT = "9c2670d3bce5275e0d1610272958121af87787bb"
SHA = "a" * 64

def scenario():
    names = list(runtime.REQUIRED_RUNTIME_PACKAGES)
    names.extend("@deepseek-ai/dsh-regression-" + str(i) for i in range(205))
    vendors = {"@deepseek-ai/cordis": "4.0.2", "@deepseek-ai/schemastery": "3.18.2"}
    family = {
        "schema": 2, "version": VERSION,
        "packages": [name for name in names if name not in vendors],
        "vendorPackages": vendors,
    }
    installed = {
        name: {"name": name, "version": vendors.get(name, VERSION)}
        for name in names
    }
    compat = {
        "dsh": VERSION, "dshSourceCommit": COMMIT,
        "dshReleaseFamilyLocked": True, "cordisVendorLocked": True,
        "dshNpmLockSha256": SHA,
    }
    return family, installed, compat


class ReleaseProvenanceContract(unittest.TestCase):
    def check(self, family, installed, compat, embedded=None, sha=SHA):
        return runtime.verify_family_identity(
            family, family if embedded is None else embedded, installed, compat,
            sha, expected_version=VERSION, expected_commit=COMMIT,
        )

    def test_complete_pinned_family_is_accepted(self):
        family, installed, compat = scenario()
        self.assertEqual(self.check(family, installed, compat), len(installed))

    def test_old_release_target_is_rejected(self):
        family, installed, compat = scenario()
        family["version"] = "0.1.5-rc.2"
        with self.assertRaisesRegex(ValueError, "build target DSH version mismatch"):
            self.check(family, installed, compat)

    def test_packaged_family_lock_must_match_build_input(self):
        family, installed, compat = scenario()
        other = {**family, "version": "0.1.5-rc.2"}
        with self.assertRaisesRegex(ValueError, "packaged DSH release-family lock differs"):
            self.check(family, installed, compat, embedded=other)

    def test_shipped_modules_cannot_mix_release_versions(self):
        family, installed, compat = scenario()
        installed["@deepseek-ai/dsh-mcp-client"]["version"] = "0.1.5-rc.2"
        with self.assertRaisesRegex(ValueError, "packaged module version skew"):
            self.check(family, installed, compat)

    def test_vendor_cordis_mismatch_is_rejected(self):
        family, installed, compat = scenario()
        installed["@deepseek-ai/cordis"]["version"] = "0.0.1"
        with self.assertRaisesRegex(ValueError, "packaged module version skew"):
            self.check(family, installed, compat)

    def test_missing_plugin_ui_is_rejected(self):
        family, installed, compat = scenario()
        del installed["@deepseek-ai/dsh-client-ui-plugin-manager"]
        with self.assertRaisesRegex(ValueError, "missing required plugin package"):
            self.check(family, installed, compat)

    def test_partial_seed_graph_is_rejected(self):
        family, installed, compat = scenario()
        installed = {n: installed[n] for n in runtime.REQUIRED_RUNTIME_PACKAGES}
        with self.assertRaisesRegex(ValueError, "graph is incomplete"):
            self.check(family, installed, compat)

    def test_wrong_install_lock_digest_is_rejected(self):
        family, installed, compat = scenario()
        with self.assertRaisesRegex(ValueError, "npm install lock SHA256 differs"):
            self.check(family, installed, compat, sha="b" * 64)

    def test_source_commit_drift_is_rejected(self):
        family, installed, compat = scenario()
        compat["dshSourceCommit"] = "0" * 40
        with self.assertRaisesRegex(ValueError, "source commit differs"):
            self.check(family, installed, compat)

    def test_apk_marker_uses_version_sha_and_version_name(self):
        marker = "app=0.1.2\ndsh=" + VERSION + "\nsha256=" + SHA + "\n"
        apk.verify_version_marker(marker, SHA, VERSION, "0.1.2")
        for tampered in [
            marker.replace(VERSION, "0.1.5-rc.2"),
            marker.replace("sha256=" + SHA, "sha256=" + "b" * 64),
            marker.replace("app=0.1.2", "app=0.1.3"),
            marker + "dsh=" + VERSION + "\n",
            marker.replace("dsh=" + VERSION + "\n", ""),
        ]:
            with self.subTest(tampered=tampered):
                with self.assertRaises(ValueError):
                    apk.verify_version_marker(tampered, SHA, VERSION, "0.1.2")


if __name__ == "__main__":
    unittest.main()
