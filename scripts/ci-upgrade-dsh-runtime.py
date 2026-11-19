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

def is_android_seed_addon_path(relative_path):
    """Ignore irrelevant binaries shipped with multi-platform NPM distributions.

    A Windows .node in the signed seed is legitimate package data, but must
    never be copied into an Android runtime or validated as Android ELF.
    A Linux ARM64 prebuild is not automatically Bionic-compatible.
    """
    parts = tuple(part.lower() for part in Path(relative_path).parts)
    for segment in parts:
        if segment.startswith((
                "win32-", "windows-", "darwin-", "linux-", "freebsd-",
                "openbsd-", "sunos-", "aix-", "musl-")):
            return False
        if segment.startswith("android-") and segment != "android-arm64":
            return False
    if "prebuilds" in parts:
        index = parts.index("prebuilds")
        return index + 1 < len(parts) and parts[index + 1] == "android-arm64"
    return True

def prune_foreign_prebuilds(module_tree):
    """Remove only explicit non-Android prebuild directories before ABI audit.

    Preserve untagged .node files so the provenance verifier can reject any
    unexpected host artifact instead of silently dropping required binaries.
    """
    removed = []
    for binary in module_tree.rglob("*.node"):
        if not binary.is_file() or binary.is_symlink():
            continue
        relative = binary.relative_to(module_tree)
        if not is_android_seed_addon_path(relative):
            binary.unlink()
            removed.append(relative.as_posix())
    return removed

def stage_android_koffi_optional(seed_modules, target_modules, version):
    """Copy the Bionic ARM64 Koffi prebuilt from the signed seed, if exact-version.

    Koffi >=3.2 places its native binding in @koromix/koffi-android-arm64,
    not necessarily inside koffi/build. Preserve the original package-relative
    layout so the published Koffi JS loader can resolve it by package name.
    """
    name = "@koromix/koffi-android-arm64"
    new = target_modules / name
    # The signed seed may have placed the optional package under the nested
    # @deepseek-ai/dsh/node_modules tree. Search by exact manifest identity.
    candidates = []
    for manifest in seed_modules.rglob("package.json"):
        if manifest.is_symlink() or manifest.parent.is_symlink():
            continue
        if manifest.parent.name != "koffi-android-arm64":
            continue
        if manifest.parent.parent.name != "@koromix":
            continue
        try:
            metadata = json.loads(manifest.read_text())
        except (ValueError, OSError, UnicodeError):
            continue
        if metadata.get("name") == name:
            candidates.append((manifest.parent, metadata))
    if not candidates:
        return []
    exact = [(directory, metadata) for directory, metadata in candidates
             if metadata.get("version") == version]
    if not exact:
        raise ValueError(
            "Koffi Android addon version differs from pinned JavaScript: "
            + str(sorted({str(meta.get("version")) for _, meta in candidates}))
            + " vs " + str(version))
    if len(exact) != 1:
        raise ValueError("ambiguous signed Android Koffi optional packages: "
                         + str([str(directory) for directory, _ in exact]))
    old, meta = exact[0]
    if any(entry.is_symlink() for entry in old.rglob("*")):
        raise ValueError("symlink in signed Android Koffi optional package")

    if meta.get("name") != name or meta.get("version") != version:
        raise ValueError(
            "Koffi Android addon version differs from pinned JavaScript: "
            + str(meta.get("version")) + " vs " + str(version))
    if new.exists() or new.is_symlink():
        raise ValueError("unexpected host Android Koffi addon destination " + str(new))
    binaries = list(old.rglob("*.node"))
    if not binaries:
        raise ValueError("signed Android Koffi optional package has no native binding")
    copied = []
    for binary in binaries:
        if binary.is_symlink() or not binary.is_file():
            raise ValueError("unsafe signed Android Koffi addon " + str(binary))
        if not is_android_seed_addon_path(binary.relative_to(old)):
            raise ValueError("non-Android Koffi addon in signed optional package " + str(binary))
        with binary.open("rb") as stream:
            header = stream.read(20)
        if (len(header) < 20 or header[:4] != bytes((127, 69, 76, 70))
                or header[4:6] != bytes((2, 1))
                or int.from_bytes(header[18:20], "little") != 183):
            raise ValueError("invalid Android Koffi ARM64 addon " + str(binary))
        copied.append(binary.relative_to(old))
    shutil.copytree(old, new, symlinks=True)
    for rel in copied:
        destination = new / rel
        if destination.is_symlink() or not destination.is_file():
            raise ValueError("unexpected Koffi staged file " + str(destination))
    return [new / rel for rel in copied]

def validate_android_addons(module_tree, verified_source_paths):
    """Accept only copied Android seed bindings, never host-provided Linux ARM64 ELF.

    e_machine == EM_AARCH64 does not distinguish Android/Bionic from Linux/glibc.
    A host npm ci may install Linux ARM64 optional prebuilds such as sharp; even
    their ELF headers pass a machine-only check but they cannot run on Android.
    """
    verified = {Path(p).resolve(strict=True) for p in verified_source_paths}
    found = set()
    for binary in module_tree.rglob("*.node"):
        if binary.is_symlink() or not binary.is_file():
            raise ValueError("unsafe packaged Node addon " + str(binary))
        with binary.open("rb") as stream:
            header = stream.read(20)
        if (len(header) < 20 or header[:4] != bytes((0x7f, 69, 76, 70))
                or header[4:6] != bytes((2, 1))
                or int.from_bytes(header[18:20], "little") != 183):
            raise ValueError("non-ARM64 ELF Node addon in Android release " + str(binary))
        canonical = binary.resolve(strict=True)
        if canonical not in verified:
            raise ValueError(
                "unverified host/native Node addon (could be glibc Linux ARM64): "
                + str(binary) + "; Android rebuild or ABI-matched seed required")
        found.add(canonical)
    if found != verified:
        raise ValueError("staged Android addon manifest does not match installed files")
    return len(found)

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
    # Host npm resolves Linux optional packages, never @koromix's Android
    # binding. Restore only the audited, exact-version Android optional tree.
    koffi_manifest = new_modules / "koffi/package.json"
    if not koffi_manifest.is_file():
        raise ValueError("pinned top-level Koffi package unavailable")
    koffi_version = json.loads(koffi_manifest.read_text()).get("version")
    if koffi_version != "3.3.0":
        raise ValueError("unexpected Android Koffi pin " + str(koffi_version))
    optional_koffi_addons = stage_android_koffi_optional(
        module_root, new_modules, koffi_version)
    if optional_koffi_addons:
        print("[DSH upgrade] staged", len(optional_koffi_addons),
              "matching signed Android Koffi optional bindings")

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
    retained_addons=[{
        "name":"@koromix/koffi-android-arm64", "version":koffi_version,
        "path":str(path.relative_to(new_modules / "@koromix/koffi-android-arm64"))
    } for path in optional_koffi_addons]
    verified_android_addon_paths={path.resolve(strict=True) for path in optional_koffi_addons}
    for key,destinations in new_native.items():
        matching_sources=old_native.get(key,[])
        for dst in destinations:
            for src in matching_sources:
                for binary in src.rglob("*.node"):
                    if binary.is_symlink() or not binary.is_file():
                        continue
                    relative=binary.relative_to(src)
                    if not is_android_seed_addon_path(relative):
                        continue
                    with binary.open("rb") as stream:
                        h=stream.read(20)
                    if len(h)<20 or h[:4]!=bytes.fromhex("7f454c46") or int.from_bytes(h[18:20],"little")!=183:
                        raise ValueError("signed Android seed has non-ARM64 addon "+str(binary))
                    target=dst/relative
                    if target.is_symlink():
                        raise ValueError("symlink at new addon destination "+str(target))
                    target.parent.mkdir(parents=True,exist_ok=True)
                    shutil.copy2(binary,target)
                    verified_android_addon_paths.add(target.resolve(strict=True))
                    retained_addons.append({"name":key[0],"version":key[1],"path":str(relative)})
                if any(entry["name"]==key[0] and entry["version"]==key[1] for entry in retained_addons):
                    break
    # node-pty/Koffi need the matching Android binding; silently omitting an
    # extension produces a signed APK that only fails once terminal/UI loads.
    for name, version in new_native:
        if name in ("node-pty", "koffi") and not (
                (name == "koffi" and optional_koffi_addons)
                or any(item["name"] == name and item["version"] == version
                       for item in retained_addons)):
            raise ValueError(
                "required Android native extension unavailable for "
                + str(name) + "@" + str(version)
                + "; rebuild it for Bionic ARM64 before signing")
    # An Ubuntu ARM64 npm package can contain valid AArch64 .node files linked
    # against glibc. Machine architecture alone cannot approve their inclusion.
    removed_foreign_addons=prune_foreign_prebuilds(new_modules)
    print("[DSH upgrade] excluded",len(removed_foreign_addons),
          "foreign-platform .node prebuilds from Android bundle")
    copied_native_count=validate_android_addons(new_modules, verified_android_addon_paths)
    print("[DSH upgrade] retained",copied_native_count,
          "version-matched, seed-origin Android AArch64 add-ons")
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
            "verifiedAndroidAddonCount":copied_native_count,
            "removedForeignPrebuilds":removed_foreign_addons,
            "nativeAddonVersionDifferences":{k:{"old":sorted(old_versions[k]),"new":sorted(v)}
                for k,v in new_versions.items() if k in old_versions and v!=old_versions[k]},
            "limits":"Host JS graph verified; Android native runtime/sessions require device signoff"}
