#!/usr/bin/env python3
"""Bundle exact npm release bytes needed to repair missing ModSearch CLI.

Git source installs of @liustack/modsearch do NOT contain dist/main.js. Ship
the published JS-only package and its dependencies as optional APK recovery
resources, never as an overwrite of user plugin state.
"""
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile

PACKAGES = {
    "@liustack/modsearch": "5.10.11",
    "commander": "13.1.0",
    "undici": "7.29.0",
}

def extract_npm(tgz, target, expected_name, expected_version):
    if target.exists():
        raise ValueError("recovery destination already populated: " + str(target))
    target.mkdir(parents=True)
    with tarfile.open(tgz, "r:gz") as archive:
        for entry in archive:
            rel = PurePosixPath(entry.name)
            if (not rel.parts or rel.parts[0] != "package" or
                    rel.is_absolute() or ".." in rel.parts or "\\" in entry.name):
                raise ValueError("unsafe npm tar entry " + entry.name)
            sub = rel.parts[1:]
            if not sub:
                continue
            dest = target.joinpath(*sub)
            if entry.isdir():
                dest.mkdir(parents=True, exist_ok=True)
            elif entry.isfile():
                dest.parent.mkdir(parents=True, exist_ok=True)
                if dest.exists():
                    raise ValueError("duplicate tar entry: " + entry.name)
                with archive.extractfile(entry) as source, dest.open("wb") as output:
                    shutil.copyfileobj(source, output)
            else:
                raise ValueError("unsupported npm tar entry " + entry.name)
    meta = json.loads((target / "package.json").read_text())
    if meta.get("name") != expected_name or meta.get("version") != expected_version:
        raise ValueError("npm recovery package identity/version mismatch: " + expected_name)

def stage_modsearch(stage, workspace):
    destination = stage / "usr/share/dsh-modsearch-recovery/node_modules"
    for name, version in PACKAGES.items():
        completed = subprocess.run(
            ["npm", "pack", f"{name}@{version}", "--json", "--ignore-scripts",
             "--pack-destination", str(workspace)],
            check=True, capture_output=True, text=True)
        packs = json.loads(completed.stdout)
        if len(packs) != 1 or packs[0].get("name") != name or packs[0].get("version") != version:
            raise ValueError("npm registry package mismatch: " + name)
        file = workspace / packs[0]["filename"]
        if file.parent != workspace or not file.is_file():
            raise ValueError("unexpected npm tarball path")
        extract_npm(file, destination / name, name, version)
    if not (destination / "@liustack/modsearch/dist/main.js").is_file():
        raise ValueError("published ModSearch recovery CLI dist/main.js missing")
    for name in ("commander", "undici"):
        if not (destination / name / "package.json").is_file():
            raise ValueError("published ModSearch dependency missing: " + name)
    print("[OK] complete published ModSearch 5.10.11 CLI recovery staged for Android")
