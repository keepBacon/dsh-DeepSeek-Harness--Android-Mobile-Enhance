#!/usr/bin/env python3
"""Generate the exact published DSH release-family pinset from an audited tag.

No wildcard ranges, no hand-maintained renames, and no partial set of packages.
The source repository is checked out at a fixed release commit. The output is
deterministic so a future tag update is a reviewable JSON diff.
"""
import argparse
import json
import pathlib
import subprocess

TARGET_VERSION = "0.2.2-rc.5"
TARGET_COMMIT = "9c2670d3bce5275e0d1610272958121af87787bb"
TAG = "dsh-v" + TARGET_VERSION
REQUIRED_VENDORS = {
    "@deepseek-ai/cordis",
    "@deepseek-ai/cordis-plugin-group",
    "@deepseek-ai/cordis-plugin-hmr",
    "@deepseek-ai/cordis-plugin-include",
    "@deepseek-ai/cordis-plugin-loader",
    "@deepseek-ai/cordis-plugin-logger-console",
    "@deepseek-ai/cordis-plugin-timer",
    "@deepseek-ai/cosmokit",
    "@deepseek-ai/schemastery",
}

def load(path):
    return json.loads(path.read_text(encoding="utf-8"))

def generate(root):
    root = pathlib.Path(root)
    actual = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    if actual != TARGET_COMMIT:
        raise ValueError(f"upstream HEAD is {actual}, expected pinned {TARGET_COMMIT}")
    top = load(root / "package.json")
    if top.get("packageManager") != "pnpm@11.28.5":
        raise ValueError("pinned pnpm release changed")
    manifests = sorted((root / "packages").glob("*/*/package.json"))
    manifests.extend(sorted((root / "apps").glob("*/package.json")))
    manifests.extend(sorted((root / "native/system/packages").glob("*/package.json")))
    packages = set()
    for file in manifests:
        pkg = load(file)
        name = pkg.get("name")
        if not isinstance(name, str) or not (name == "@deepseek-ai/dsh" or name.startswith("@deepseek-ai/dsh-")):
            continue
        if pkg.get("version") != TARGET_VERSION:
            raise ValueError(f"version mismatch in {file}: {pkg.get('version')}")
        if name in packages:
            raise ValueError("duplicate package name: " + name)
        packages.add(name)
    if len(packages) < 200 or "@deepseek-ai/dsh-client-ui-plugin-manager" not in packages:
        raise ValueError("incomplete modern DSH package inventory")
    vendor = {}
    for path in sorted((root / "vendor").glob("*/package.json")):
        pkg = load(path)
        name,version = pkg.get("name"),pkg.get("version")
        if name in vendor or name not in REQUIRED_VENDORS:
            raise ValueError("unknown or duplicate upstream vendor package " + str(name))
        vendor[name] = version
    if set(vendor) != REQUIRED_VENDORS:
        raise ValueError("missing vendors " + str(REQUIRED_VENDORS - set(vendor)))
    return {
        "schema":2,
        "version":TARGET_VERSION,
        "sourceRepository":"deepseek-ai/deepseek-harness",
        "sourceCommit":TARGET_COMMIT,
        "packages":sorted(packages),
        "vendorPackages":dict(sorted(vendor.items())),
    }

if __name__ == "__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--source",type=pathlib.Path,required=True)
    parser.add_argument("--output",type=pathlib.Path,required=True)
    a=parser.parse_args()
    data=generate(a.source)
    a.output.write_text(json.dumps(data,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(f"[DSH] Release family: {len(data['packages'])} packages, {len(data['vendorPackages'])} pinned vendors @ {data['version']}")
