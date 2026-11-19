#!/usr/bin/env python3
"""Rebuild the complete published DSH JS dependency tree for Android ARM64.

The old signed APK is used ONLY as the trusted Android native ABI/tool seed.
Never retain the 0.1.5 DSH module graph. Resolve a consistent 0.2.2-rc.5
package-lock and validate every declared DSH/Cordis component before replacing
the staged node_modules directory. No NPM install scripts execute here.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

VERSION = "0.2.2-rc.5"
COMMIT = "9c2670d3bce5275e0d1610272958121af87787bb"
REPO_URL = "https://github.com/deepseek-ai/deepseek-harness.git"
PNPM_VERSION = "11.28.5"

def cmd(args, **kwargs):
    print("[DSH upgrade] running", " ".join(map(str, args[:5])), flush=True)
    return subprocess.run(list(map(str, args)), check=True, **kwargs)

def prepare_checkout(work):
    checkout = work / "deepseek-harness-pinned"
    cmd(["git", "init", checkout])
    cmd(["git", "-C", checkout, "remote", "add", "origin", REPO_URL])
    # Fetch only the immutable commit instead of an unaudited floating branch.
    cmd(["git", "-C", checkout, "fetch", "--depth=1", "origin", COMMIT])
    cmd(["git", "-C", checkout, "checkout", "--detach", COMMIT])
    actual = subprocess.check_output(["git", "-C", checkout, "rev-parse", "HEAD"],text=True).strip()
    if actual != COMMIT:
        raise ValueError("downloaded source commit mismatches the audited release")
    return checkout

def install_release(stage, work, repo):
    checkout = prepare_checkout(work)
    family = work / "dsh-release-family.json"
    cmd(["python3", repo / "scripts/ci-generate-dsh-family.py",
         "--source",checkout,"--output",family])
    manifest = work / "package.json"
    with manifest.open("w") as out:
        cmd(["node",repo / "scripts/dsh-runtime-family.mjs","manifest",
             family,VERSION,PNPM_VERSION],stdout=out)
    assert "@deepseek-ai/dsh-client-ui-plugin-manager" in family.read_text(), "missing modern UI manager"
    registry = os.environ.get("DSH_NPM_REGISTRY","https://registry.npmjs.org/")
    resolver = ["npm","install","--package-lock-only","--ignore-scripts",
                "--no-audit","--no-fund","--include=peer",
                "--strict-peer-deps=false","--registry="+registry,
                "--fetch-retries=3","--fetch-timeout=180000"]
    cmd(resolver,cwd=work)
    cmd(["node",repo / "scripts/dsh-runtime-family.mjs","verify-lock",
         family,work/"package-lock.json",VERSION])
    cmd(["npm","ci","--ignore-scripts","--no-audit","--no-fund",
         "--include=peer","--strict-peer-deps=false"],cwd=work)
    cmd(["node",repo / "scripts/dsh-runtime-family.mjs","verify-installed",
         family,work/"node_modules",VERSION])
    module_root = stage / "usr/lib/node_modules"
    if not (module_root / "@deepseek-ai/dsh/package.json").is_file():
        raise ValueError("Android seed DSH module graph missing")
    new_modules = work / "node_modules"
    required = [
        "@deepseek-ai/dsh/package.json",
        "@deepseek-ai/dsh/lib/bin.js",
        "@deepseek-ai/dsh-client-ui-plugin-manager/package.json",
        "@deepseek-ai/cordis/package.json",
        "@deepseek-ai/dsh-plugin-manager/package.json",
    ]
    if any(not (new_modules/p).is_file() for p in required):
        raise ValueError("Modern Host/client dependencies absent: "+
                         ",".join(p for p in required if not (new_modules/p).is_file()))
    # Preserve bundled Node package-manager binaries, never old DSH/Cordis.
    for manager in ("npm","pnpm"):
        old=module_root/manager
        dest=new_modules/manager
        if not old.is_dir():
            raise ValueError("missing Android package manager from seed: "+manager)
        if dest.exists() and dest.is_dir():
            raise ValueError("upstream graph unexpectedly replaces Android "+manager)
        shutil.copytree(old,dest,symlinks=True)
    # The existing .node add-ons are Android ABI-specific: host npm ci must not
    # silently substitute native host ELF. A version change requires a separate
    # Android cross-build and device acceptance, not a bytewise 0.1.5 graft.
    old_versions={}
    new_versions={}
    for base,output in ((module_root,old_versions),(new_modules,new_versions)):
        for package in base.rglob("package.json"):
            if package.parent.name not in ("node-pty","koffi","sharp"):
                continue
            try:
                meta=json.loads(package.read_text())
                output.setdefault(meta.get("name"),set()).add(meta.get("version"))
            except (ValueError,OSError):
                pass
    for name,versions in new_versions.items():
        if name in old_versions and versions != old_versions[name]:
            print("[DSH upgrade] native module version changed",name,
                  sorted(old_versions[name]),"=>",sorted(versions),
                  "; Android rebuild/smoke required",flush=True)
    backup=work/"android-seed-node-modules"
    module_root.rename(backup)
    try:
        new_modules.rename(module_root)
    except Exception:
        backup.rename(module_root)
        raise
    (stage/"usr/lib/dsh-release-family.json").write_bytes(family.read_bytes())
    (stage/"usr/lib/dsh-release-install-lock.json").write_bytes((work/"package-lock.json").read_bytes())
    # Native helper bundle is not executable on a GitHub runner. This action
    # validates JS coherence only; Android ELF/PTY/API needs a device check.
    return {"version":VERSION,"sourceCommit":COMMIT,
            "nodeModules":"replaced from verified exact NPM release family",
            "nativeSeedPreserved":True,
            "nativeAddonVersionDifferences":{k:{"old":sorted(old_versions[k]),"new":sorted(v)}
                for k,v in new_versions.items() if k in old_versions and v!=old_versions[k]},
            "limits":"Host JS graph verified; Android native runtime/sessions require device signoff"}
