#!/usr/bin/env python3
"""Construct current DSH ARM64 runtime on GitHub Ubuntu, without running Termux.

Preserves a known Android Node/DSH ABI baseline. Supplements missing Android
binary packages from checksum-verified APT archives and host-neutral source
from this Git revision. Never executes an Android ELF on the Linux runner.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from urllib.request import Request, urlopen

REPOS = {
    "main": "https://packages-cf.termux.dev/apt/termux-main",
    "root": "https://packages-cf.termux.dev/apt/termux-root",
}
SEEDS = ("proot", "python", "python-pip", "apt", "dpkg", "termux-tools", "termux-keyring")
# The previous GitHub build stopped at SEEDS and packaged no tool-suite
# dependencies, despite the full Termux catalog declaring them. Keep the
# first ARM64 expansion deliberately focused on the tested missing binaries.
TOOL_SEEDS = (
    "jq", "yq", "7zip", "openssl-tool", "file",
    "binutils", "dnsutils", "aapt2",
)
TOOL_COMMANDS = (
    "jq", "yq", "7z", "openssl", "file", "objdump", "nm",
    "dig", "aapt2",
)

SCRIPT_MAP = {
    "dsh-mobile-toolbox-mcp.mjs": "toolbox-mcp.mjs",
    "dsh-basic-toolbox-mcp.mjs": "basic-toolbox-mcp.mjs",
    "dsh-code-engine.mjs": "dsh-code-engine.mjs",
    "dsh-code-engine-v3.mjs": "dsh-code-engine-v3.mjs",
    "dsh-code-engine-v4.mjs": "dsh-code-engine-v4.mjs",
    "dsh-code-engine-ast.mjs": "dsh-code-engine-ast.mjs",
    "dsh-code-engine-workflow.mjs": "dsh-code-engine-workflow.mjs",
    "dsh-code-engine-journal.mjs": "dsh-code-engine-journal.mjs",
    "dsh-android-sandbox-runner.sh": "android-sandbox-runner.sh",
}

def get(url):
    req = Request(url, headers={"User-Agent": "DSH-GitHub-Actions-native-assembler/1"})
    with urlopen(req, timeout=150) as result:
        return result.read()

def check_relative(name):
    while name.startswith("./"):
        name = name[2:]
    parts = PurePosixPath(name).parts
    if not name or name.startswith("/") or ".." in parts or "\\" in name:
        raise ValueError("unsafe archive path: " + repr(name))
    return name

def unpack_seed(snapshot, stage):
    deferred = []
    with tarfile.open(snapshot, "r:xz") as archive:
        for entry in archive:
            rel = check_relative(entry.name)
            dest = stage / rel
            if any(p.is_symlink() for p in list(dest.parents) if p != stage and stage in p.parents):
                raise ValueError("archive entry under symlink: " + rel)
            dest.parent.mkdir(parents=True, exist_ok=True)
            if entry.isdir():
                dest.mkdir(exist_ok=True)
                continue
            if entry.issym() or entry.islnk():
                deferred.append((entry, rel))
                continue
            if not entry.isfile():
                raise ValueError("unsupported archive entry type: " + rel)
            if dest.is_symlink():
                raise ValueError("seed file would overwrite symlink: " + rel)
            with archive.extractfile(entry) as inp, dest.open("wb") as out:
                shutil.copyfileobj(inp, out, 1024 * 1024)
            dest.chmod(entry.mode & 0o777)
    for entry, rel in deferred:
        dest = stage / rel
        if dest.exists() or dest.is_symlink():
            raise ValueError("duplicate symlink in seed: " + rel)
        link = entry.linkname
        if entry.islnk():
            target = stage / check_relative(link)
            if not target.is_file():
                raise ValueError("unsafe or missing hardlink: " + rel)
            os.link(target, dest)
            continue
        if link.startswith("/data/data/com.termux/files/usr/"):
            mapped = stage / "usr" / link.split("/files/usr/", 1)[1]
            link = os.path.relpath(mapped, dest.parent)
        elif link.startswith("/") and link != "/system/bin/sh":
            raise ValueError("unsupported absolute seed symlink: " + rel)
        if not link.startswith("/"):
            check_relative(os.path.normpath(os.path.join(os.path.dirname(rel), link)))
        os.symlink(link, dest)

def parse_index(binary):
    fields = {}
    all_entries = {}
    for stanza in gzip.decompress(binary).decode("utf-8").split("\n\n"):
        fields = {}
        for row in stanza.splitlines():
            if not row or row[0].isspace() or ":" not in row:
                continue
            k, v = row.split(":", 1)
            fields[k.strip()] = v.strip()
        if fields.get("Package") and fields.get("Filename") and fields.get("SHA256"):
            all_entries[fields["Package"]] = dict(fields)
    return all_entries

def dependency_names(expression, index):
    for clause in expression.split(","):
        choices = [re.sub(r"\s*\(.*?\)", "", x).strip().split(":")[0].strip()
                   for x in clause.split("|")]
        chosen = next((candidate for candidate in choices if candidate in index), None)
        if chosen:
            yield chosen
        elif choices and choices[0]:
            raise ValueError("unresolvable APT dependency: " + clause)

def fetch_packages(stage, workspace):
    indexes = {}
    packages = {}
    for channel, base in REPOS.items():
        path = "dists/stable/main/binary-aarch64/Packages.gz" if channel == "main" else "dists/root/stable/binary-aarch64/Packages.gz"
        try:
            index = parse_index(get(base + "/" + path))
        except Exception as error:
            if channel == "root":
                print("[native] root repo index unavailable, main-only dependencies", error)
                continue
            raise
        print("[native] indexed", channel, len(index), "Android ARM64 packages")
        for name, value in index.items():
            if name not in packages:
                packages[name] = (base, value)
    needed = []
    done = set()
    def include(name):
        if name in done:
            return
        if name not in packages:
            raise ValueError("required ARM64 package unavailable: " + name)
        done.add(name)
        needed.append(name)
        info = packages[name][1]
        for dep in dependency_names(info.get("Pre-Depends", "") + "," + info.get("Depends", ""), packages):
            include(dep)
    for item in (*SEEDS, *TOOL_SEEDS):
        include(item)
    if len(needed) > 220:
        raise ValueError("unexpectedly large dependency closure (>220 packages)")
    print("[native] dependency closure", len(needed), "packages")
    manifest = []
    for name in needed:
        base, package = packages[name]
        filename = package["Filename"]
        if filename.startswith("/") or ".." in PurePosixPath(filename).parts:
            raise ValueError("invalid APT archive URL")
        url = base + "/" + filename
        data = get(url)
        digest = hashlib.sha256(data).hexdigest()
        if digest.lower() != package["SHA256"].lower():
            raise ValueError("SHA256 mismatch for package " + name)
        downloaded = workspace / (name.replace("/", "_") + ".deb")
        downloaded.write_bytes(data)
        extracted = workspace / ("extract-" + name)
        extracted.mkdir()
        subprocess.run(["dpkg-deb", "-x", str(downloaded), str(extracted)], check=True)
        prefix = extracted / "data/data/com.termux/files/usr"
        if not prefix.is_dir():
            prefix = extracted / "usr"
        if not prefix.is_dir():
            raise ValueError("unrecognized Android package prefix " + name)
        for root, dirs, files in os.walk(prefix, followlinks=False):
            parent = Path(root)
            rel = parent.relative_to(prefix)
            outdir = stage / "usr" / rel
            outdir.mkdir(parents=True, exist_ok=True)
            for file in files:
                src = parent / file
                dst = outdir / file
                if dst.exists() or dst.is_symlink():
                    continue  # Protect the pre-existing validated DSH/Node ABI.
                if src.is_symlink():
                    os.symlink(os.readlink(src), dst)
                else:
                    shutil.copy2(src, dst, follow_symlinks=False)
            for folder in dirs[:]:
                src = parent / folder
                if src.is_symlink():
                    dst = outdir / folder
                    if not dst.exists() and not dst.is_symlink():
                        os.symlink(os.readlink(src), dst)
                    dirs.remove(folder)
        manifest.append({"package": name, "version": package.get("Version"), "sha256": digest})
        downloaded.unlink()
        shutil.rmtree(extracted)
    # No more silent success when a package was downloaded but its executable
    # was missing from the merged runtime. Check both new and inherited files.
    missing = [command for command in TOOL_COMMANDS
               if not (stage / "usr/bin" / command).exists()]
    if missing:
        raise ValueError("Android tool package closure lacks executable(s): " + ", ".join(missing))
    print("[native] verified", len(TOOL_COMMANDS), "critical tool executable paths")
    return manifest

def overlay_sources(stage, source):
    mobile = stage / "usr/libexec/dsh-mobile"
    mobile.mkdir(parents=True, exist_ok=True)
    for filename, dest in SCRIPT_MAP.items():
        src = source / "scripts" / filename
        if not src.is_file():
            raise ValueError("missing host-neutral source " + filename)
        shutil.copy2(src, mobile / dest)
    (mobile / "android-sandbox-runner.sh").chmod(0o755)
    (mobile / "toolbox-mcp.mjs").chmod(0o755)
    (mobile / "basic-toolbox-mcp.mjs").chmod(0o755)
    builder = (source / "scripts/embed-termux-tools.sh").read_text()
    for name in ("termux-run", "termux-wrapper"):
        marker = re.escape('cat > "$stage/usr/libexec/dsh/' + name + '" <<')
        pattern = marker + r"'EOF_([A-Z_]+)'\n(.*?)\nEOF_\1"
        match = re.search(pattern, builder, re.S)
        if not match:
            raise ValueError("unable to recover upstream relocation wrapper " + name)
        wrapper = stage / "usr/libexec/dsh" / name
        wrapper.parent.mkdir(parents=True, exist_ok=True)
        wrapper.write_text(match.group(2) + "\n")
        wrapper.chmod(0o755)
    wrappers = stage / "usr/libexec/dsh/wrappers"
    wrappers.mkdir(parents=True, exist_ok=True)
    for command in ("bash", "python3", "python", "pip3", "pip",
                    "apt", "apt-get", "apt-cache", "apt-config",
                    "dpkg", "dpkg-query", "dpkg-deb", "pkg"):
        alias = wrappers / command
        if alias.is_symlink():
            alias.unlink()
        elif alias.exists():
            raise ValueError("existing non-symlink wrapper " + command)
        os.symlink("../termux-wrapper", alias)

def install_typescript(stage, workspace):
    archive = workspace / "typescript.tgz"
    # This pure-JavaScript dependency is required by the user's Code Engine AST.
    subprocess.run(["npm", "pack", "typescript@5.9.3", "--pack-destination", str(workspace),
                    "--silent"], check=True, stdout=subprocess.PIPE)
    matches = list(workspace.glob("typescript-*.tgz"))
    if len(matches) != 1:
        raise ValueError("TypeScript compiler pack not available")
    target = stage / "usr/lib/dsh-dev-tools/node_modules/typescript"
    target.mkdir(parents=True, exist_ok=True)
    with tarfile.open(matches[0], "r:gz") as archive_obj:
        for member in archive_obj:
            path = check_relative(member.name)
            if not path.startswith("package/"):
                raise ValueError("unexpected TypeScript package entry " + path)
            rel = path.removeprefix("package/")
            if not rel:
                continue
            dst = target / rel
            if member.isdir():
                dst.mkdir(parents=True, exist_ok=True)
                continue
            if not member.isfile():
                raise ValueError("unexpected TypeScript entry type")
            dst.parent.mkdir(parents=True, exist_ok=True)
            with archive_obj.extractfile(member) as inp, dst.open("wb") as out:
                shutil.copyfileobj(inp, out)
    if not (target / "lib/typescript.js").is_file():
        raise ValueError("TypeScript AST runtime failed to stage")

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--seed", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--repo", type=Path, default=Path("."))
    p.add_argument("--audit", type=Path, required=True)
    args = p.parse_args()
    with tempfile.TemporaryDirectory(prefix="dsh-gh-native-") as tmp:
        workspace = Path(tmp)
        stage = workspace / "stage"
        stage.mkdir()
        unpack_seed(args.seed, stage)
        manifest = fetch_packages(stage, workspace)
        overlay_sources(stage, args.repo)
        install_typescript(stage, workspace)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        # Keep symbolic links intact. Never dereference Android-only targets.
        with tarfile.open(args.output, "w:xz", preset=0) as archive:
            for entry in sorted(stage.iterdir()):
                archive.add(entry, arcname=entry.name, recursive=True)
        args.audit.write_text(json.dumps({
            "buildSystem": "GitHub-hosted Ubuntu ARM64, not a Termux build",
            "seedSha256": hashlib.sha256(args.seed.read_bytes()).hexdigest(),
            "sourceOverlay": list(SCRIPT_MAP.values()),
            "androidPackageArchives": manifest,
            "limits": "Native Android ELF loadability / WebUI still require device smoke",
        }, indent=2) + "\n")
        print("[native] generated ARM64 Android archive", args.output, args.output.stat().st_size)

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("[native] BUILD FAIL:", str(e), file=sys.stderr)
        sys.exit(2)
