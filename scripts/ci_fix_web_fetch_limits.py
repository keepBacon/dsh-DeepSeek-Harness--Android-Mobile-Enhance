#!/usr/bin/env python3
"""Fail-closed fix for the published HTTP provider's *actual* default body limit.

The shipped minified/bundled package uses 1e5 (not 100_000) on some versions.
Do not claim the APK is complete unless the embedded provider is patched and
the resulting source is verified. Explicit user overrides are untouched.
"""
from pathlib import Path
import re
import json
import sys
import tempfile
import shutil

DEFAULTS = {
    "maxResponseBytes": ("16777216", {"5000000", "5_000_000", "5e6", "5E6"}),
    "maxBodyChars": ("400000", {"100000", "100_000", "1e5", "1E5", "1e+5", "1E+5", "1000000", "1e6"}),
}
NUMBER = r"(?:\d[\d_]*(?:\.\d+)?(?:[eE][+\-]?\d+)?)"

def replace_default(source, setting, target, old_values):
    expr = re.compile(r"(?P<before>\b" + re.escape(setting) +
                      r"\s*:\s*z\.number\(\)\.default\(\s*)(?P<value>" +
                      NUMBER + r")(?P<after>\s*\))")
    found = list(expr.finditer(source))
    if len(found) != 1:
        raise ValueError(f"{setting}: expected one default, found {len(found)}")
    value = found[0].group("value")
    normalized = value.replace("_", "").lower()
    acceptable = {x.replace("_", "").lower() for x in old_values} | {target}
    if normalized not in acceptable:
        raise ValueError(f"{setting}: unexpected published default {value}")
    return expr.sub(lambda m: m.group("before") + target + m.group("after"), source)

def find_package_files(stage, package):
    """Search the actual npm install graph, including nested hoisted paths.

    Seed APKs can contain packages underneath dsh/node_modules, other
    transitive package node_modules and pnpm's physical store. The original
    scanner checked just two top-level layouts and therefore reported a
    missing provider even when the published package existed.
    """
    root = stage / "usr/lib/node_modules"
    if not root.is_dir():
        return []
    root = root.resolve()
    matches = []
    # Glob does not traverse directory symlinks, preventing escaped targets.
    for child in root.glob("**/@deepseek-ai/" + package + "/lib/index.js"):
        try:
            if (not child.is_file() or child.is_symlink()
                    or not child.resolve().is_relative_to(root)):
                continue
            manifest = child.parent.parent / "package.json"
            if not manifest.is_file():
                continue
            if json.loads(manifest.read_text()).get("name") != "@deepseek-ai/" + package:
                continue
            matches.append(child)
        except (OSError, ValueError, json.JSONDecodeError):
            continue
    return sorted(set(matches))

def patch(stage):
    provider = find_package_files(stage, "dsh-web-fetch-http")
    if not provider:
        raise ValueError("dsh-web-fetch-http published provider not found in APK runtime")
    for file in provider:
        source = file.read_text()
        for name, (target, values) in DEFAULTS.items():
            source = replace_default(source, name, target, values)
        file.write_text(source)
        for name, (target, _) in DEFAULTS.items():
            if not re.search(re.escape(name) + r"\s*:\s*z\.number\(\)\.default\(\s*" + target + r"\s*\)", file.read_text()):
                raise ValueError(f"web_fetch {name} default failed verification")
    render = find_package_files(stage, "dsh-tool-web")
    if not render:
        raise ValueError("dsh-tool-web renderer not found in APK runtime")
    for file in render:
        source = file.read_text()
        pattern = re.compile(r"(?P<prefix>\b(?:const|let|var)\s+DEFAULT_FETCH_MAX_OUTPUT_CHARS\s*=\s*)(?P<value>" + NUMBER + ")")
        matches = list(pattern.finditer(source))
        if len(matches) != 1:
            raise ValueError(f"tool-web render cap anchor changed: {file}")
        old = matches[0].group("value")
        if old.replace("_", "").lower() not in {"200000", "2e5", "2e+5", "400000", "1000000", "1e6"}:
            raise ValueError(f"unexpected tool-web render cap {old}")
        source = pattern.sub(lambda m: m.group("prefix") + "400000", source)
        file.write_text(source)
        if not re.search(r"\bDEFAULT_FETCH_MAX_OUTPUT_CHARS\s*=\s*400000\b", file.read_text()):
            raise ValueError("tool-web render cap failed verification")
    print("[OK] APK web_fetch provider body=400000 chars, bytes=16777216, renderer=400000 chars")

def self_test():
    with tempfile.TemporaryDirectory() as directory:
        stage = Path(directory)
        root = stage / "usr/lib/node_modules/@deepseek-ai"
        for name in ("dsh-web-fetch-http", "dsh-tool-web"):
            (root / name / "lib").mkdir(parents=True)
            (root / name / "package.json").write_text(json.dumps({"name": "@deepseek-ai/" + name}))
        (root / "dsh-web-fetch-http/lib/index.js").write_text(
            "maxResponseBytes: z.number().default(5e6), maxBodyChars: z.number().default(1e5)")
        (root / "dsh-tool-web/lib/index.js").write_text(
            "export const DEFAULT_FETCH_MAX_OUTPUT_CHARS = 200_000;")
        patch(stage)
        patch(stage)
        # Regression: real seed layouts can hoist web packages underneath
        # @deepseek-ai/dsh/node_modules, not directly under the global root.
        nested = stage / "usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai"
        nested.mkdir(parents=True)
        for name in ("dsh-web-fetch-http", "dsh-tool-web"):
            old_path = root / name
            shutil.move(str(old_path), str(nested / name))
        assert len(find_package_files(stage, "dsh-web-fetch-http")) == 1
        assert len(find_package_files(stage, "dsh-tool-web")) == 1
        patch(stage)
        try:
            replace_default("maxBodyChars: z.number().default(12345)", "maxBodyChars", "400000", DEFAULTS["maxBodyChars"][1])
        except ValueError:
            pass
        else:
            raise AssertionError("unexpected upstream limit should fail closed")
        try:
            replace_default("foo", "maxBodyChars", "400000", DEFAULTS["maxBodyChars"][1])
        except ValueError:
            pass
        else:
            raise AssertionError("missing upstream anchor should fail closed")
    print("[OK] web_fetch scientific notation + idempotence + fail-closed tests")

if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        self_test()
    elif len(sys.argv) == 2:
        patch(Path(sys.argv[1]))
    else:
        raise SystemExit("usage: ci_fix_web_fetch_limits.py <stage-root> | --self-test")
