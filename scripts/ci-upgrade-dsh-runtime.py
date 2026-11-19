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
        if dest.exists():
            if manager != "pnpm":
                raise ValueError("upstream graph unexpectedly replaces Android "+manager)
            version=json.loads((dest/"package.json").read_text()).get("version")
            if version != PNPM_VERSION:
                raise ValueError("published graph resolved incompatible pnpm: "+str(version))
            continue
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
    # npm ci on a Linux host does not create Android Node add-ons.
    # Reuse only VERIFIED AArch64 ELF payloads from identically versioned
    # packages in the signed Android seed. Never copy a different version's
    # binary or a host-side Linux x86_64 .node into the application.
    native_names={"node-pty","koffi","@deepseek-ai/node-addon-system"}
    def index_native_packages(base):
        found={}
        for manifest in base.rglob("package.json"):
            if manifest.is_symlink() or manifest.parent.is_symlink():
                continue
            try:
                meta=json.loads(manifest.read_text())
            except (ValueError,OSError,UnicodeError):
                continue
            name=meta.get("name")
            if name in native_names:
                found.setdefault((name,meta.get("version")),[]).append(manifest.parent)
        return found
    old_native=index_native_packages(module_root)
    new_native=index_native_packages(new_modules)
    retained_addons=[]
    for key,destinations in new_native.items():
        matching_sources=old_native.get(key,[])
        for dst in destinations:
            for src in matching_sources:
                for binary in src.rglob("*.node"):
                    if binary.is_symlink() or not binary.is_file():
                        continue
                    with binary.open("rb") as stream:
                        h=stream.read(20)
                    if len(h)<20 or h[:4]!=bytes.fromhex("7f454c46") or int.from_bytes(h[18:20],"little")!=183:
                        raise ValueError("signed Android seed has non-ARM64 addon "+str(binary))
                    relative=binary.relative_to(src)
                    target=dst/relative
                    if target.is_symlink():
                        raise ValueError("symlink at new addon destination "+str(target))
                    target.parent.mkdir(parents=True,exist_ok=True)
                    shutil.copy2(binary,target)
                    retained_addons.append({"name":key[0],"version":key[1],"path":str(relative)})
                if any(entry["name"]==key[0] and entry["version"]==key[1] for entry in retained_addons):
                    break
    # Audit all .node files, including those delivered via transitive optional
    # packages, before publishing the new module tree.
    for binary in new_modules.rglob("*.node"):
        if binary.is_symlink() or not binary.is_file():
            raise ValueError("unsafe packaged Node addon "+str(binary))
        with binary.open("rb") as stream:
            h=stream.read(20)
        if len(h)<20 or h[:4]!=bytes.fromhex("7f454c46") or int.from_bytes(h[18:20],"little")!=183:
            raise ValueError("non-Android ARM64 Node addon from host npm: "+str(binary))
    print("[DSH upgrade] retained",len(retained_addons),"version-matched Android AArch64 add-ons")
    backup=work/"android-seed-node-modules"
    module_root.rename(backup)
    try:
        new_modules.rename(module_root)
    except Exception:
        backup.rename(module_root)
        raise
    (stage/"usr/lib/dsh-release-family.json").write_bytes(family.read_bytes())
    (stage/"usr/lib/dsh-release-install-lock.json").write_bytes((work/"package-lock.json").read_bytes())
    # The signed seed's runtime metadata still says 0.1.5. Update it from
    # the exact installed graph; preserve the Android toolchain feature flags.
    import hashlib
    compatibility=stage/"usr/etc/dsh-android-compat.json"
    if not compatibility.is_file():
        raise ValueError("missing Android runtime compatibility manifest")
    compat=json.loads(compatibility.read_text())
    if compat.get("dsh") not in ("0.1.5-rc.2",VERSION):
        raise ValueError("unexpected source Android DSH compatibility version")
    compat.update({
        "dsh":VERSION,
        "dshSourceCommit":COMMIT,
        "dshReleaseFamilyLocked":True,
        "cordisVendorLocked":True,
        "cordisSingletonValidated":True,
        "dshNpmLockSha256":hashlib.sha256((work/"package-lock.json").read_bytes()).hexdigest(),
        "nodeMinimumVersion":"24.9.0",
        "upgradeSource":"full-verified-npm-release-family",
    })
    compatibility.write_text(json.dumps(compat,indent=2)+"\n")
    # Native helper bundle is not executable on a GitHub runner. This action
    # validates JS coherence only; Android ELF/PTY/API needs a device check.
    return {"version":VERSION,"sourceCommit":COMMIT,
            "nodeModules":"replaced from verified exact NPM release family",
            "nativeSeedPreserved":True,
            "retainedNativeAddons":retained_addons,
            "nativeAddonVersionDifferences":{k:{"old":sorted(old_versions[k]),"new":sorted(v)}
                for k,v in new_versions.items() if k in old_versions and v!=old_versions[k]},
            "limits":"Host JS graph verified; Android native runtime/sessions require device signoff"}
