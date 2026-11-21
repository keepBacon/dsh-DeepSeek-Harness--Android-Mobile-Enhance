#!/usr/bin/env python3
"""Construct current DSH ARM64 runtime on GitHub Ubuntu, without running Termux.

Preserves a known Android Node/DSH ABI baseline. Supplements missing Android
binary packages from checksum-verified APT archives and host-neutral source
from this Git revision. Never executes an Android ELF on the Linux runner.
"""
import argparse
import base64
import gzip
import http.client
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import time
import tarfile
import tempfile
from ci_fix_web_fetch_limits import patch as patch_web_fetch_limits
from ci_modsearch_recovery import stage_modsearch
from ci_termux_abi import apt_abi_packages, should_replace_native, overlay_one, validate_apt_abi, NATIVE_TOOL_PACKAGES
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

REPOS = {
    "main": "https://packages-cf.termux.dev/apt/termux-main",
    "root": "https://packages-cf.termux.dev/apt/termux-root",
}
SEEDS = ("proot", "python", "python-pip", "apt", "dpkg", "termux-tools", "termux-keyring", "libc++")
# The previous GitHub build stopped at SEEDS and packaged no tool-suite
# dependencies, despite the full Termux catalog declaring them. Keep the
# first ARM64 expansion deliberately focused on the tested missing binaries.
TOOL_SEEDS = (
    "jq", "yq", "7zip", "openssl-tool", "file",
    "binutils", "dnsutils", "aapt2", "gzip",
    # Git / GitHub CLI must be real Termux ARM64 packages, not desktop binaries.
    # Pin by the SHA256-bearing Termux package index at build time and include
    # the HTTPS trust store, SSH transport and remote helper dependencies.
    "git", "gh", "openssh", "ca-certificates",
    # Search/navigation: keep the Termux ARM64 pcre2, findutils, ncurses deps.
    "ripgrep", "fd", "fzf",
    # Real Termux/Android ARM64 C/C++ compiler and build/link toolchain.
    "clang", "make", "cmake", "ninja", "lld", "llvm", "pkg-config",
    # Linux x86_64 user-mode emulator, not a Windows DLL loader or KVM.
    "qemu-user-x86-64",
    "lua-language-server",
    # DSH 0.2.2 requires Node >=24.9; refresh the Android ELF, not just JS.
    "nodejs", "npm",
)
TOOL_COMMANDS = (
    "jq", "yq", "7zz", "openssl", "file",
    "dig", "aapt2", "gzip", "git", "gh", "ssh",
    "rg", "fd", "fzf",
    "clang", "clang++", "make", "cmake", "ninja", "ld.lld", "pkg-config",
    "qemu-x86_64", "lua-language-server",
)

SCRIPT_MAP = {
    "dsh-mobile-toolbox-mcp.mjs": "toolbox-mcp.mjs",
    "dsh-inspector-tools.mjs": "dsh-inspector-tools.mjs",
    "dsh-project-language.mjs": "dsh-project-language.mjs",
    "dsh-project-index.mjs": "dsh-project-index.mjs",
    "dsh-workspace-lsp.mjs": "dsh-workspace-lsp.mjs",
    "dsh-lsp-session.mjs": "dsh-lsp-session.mjs",
    "dsh-workspace-files.mjs": "dsh-workspace-files.mjs",
    "dsh-project-build.mjs": "dsh-project-build.mjs",
    "dsh-dev-plan.mjs": "dsh-dev-plan.mjs",
    "dsh-web-page-reader.mjs": "dsh-web-page-reader.mjs",
    "dsh-basic-toolbox-mcp.mjs": "basic-toolbox-mcp.mjs",
    "dsh-android-tool-spawn.mjs": "dsh-android-tool-spawn.mjs",
    "dsh-bounded-spawn.mjs": "dsh-bounded-spawn.mjs",
    "dsh-dev-process.mjs": "dsh-dev-process.mjs",
    "dsh-dev-tasks.mjs": "dsh-dev-tasks.mjs",
    "dsh-code-engine.mjs": "dsh-code-engine.mjs",
    "dsh-code-engine-v3.mjs": "dsh-code-engine-v3.mjs",
    "dsh-code-engine-v4.mjs": "dsh-code-engine-v4.mjs",
    "dsh-code-engine-ast.mjs": "dsh-code-engine-ast.mjs",
    "dsh-code-engine-workflow.mjs": "dsh-code-engine-workflow.mjs",
    "dsh-code-engine-journal.mjs": "dsh-code-engine-journal.mjs",
    "dsh-lua-tools.mjs": "dsh-lua-tools.mjs",
    "dsh-lua-case.mjs": "dsh-lua-case.mjs",
    "dsh-lua-analysis-core.mjs": "dsh-lua-analysis-core.mjs",
    "dsh-luau-runner.mjs": "dsh-luau-runner.mjs",
    "dsh-android-sandbox-runner.sh": "android-sandbox-runner.sh",
    "dsh-android-exec.sh": "android-exec.sh",
    "dsh-android-plugin-git-spawn.cjs": "dsh-android-plugin-git-spawn.cjs",
    "dsh-android-bash-env.sh": "android-bash-env.sh",
}

def get(url):
    # Termux mirrors occasionally close a large .deb response mid-stream.
    # Re-download from byte zero and let the caller verify the full SHA256;
    # never continue from partial bytes or ignore a mismatch.
    req = Request(url, headers={"User-Agent": "DSH-GitHub-Actions-native-assembler/1"})
    for attempt in range(4):
        try:
            with urlopen(req, timeout=150) as result:
                return result.read()
        except (HTTPError, URLError, http.client.IncompleteRead, TimeoutError,
                ConnectionError, OSError) as error:
            if isinstance(error, HTTPError) and 400 <= error.code < 500 and error.code != 429:
                raise
            if attempt == 3:
                raise
            delay = min(6.0, 0.75 * (2 ** attempt))
            print("[native] transient repository download failure, retry",
                  attempt + 1, "of 4:", type(error).__name__, file=sys.stderr)
            time.sleep(delay)

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
    # Refresh the full native ABI cohort for the newly bundled compiler and QEMU.
    # Otherwise stale seed libLLVM / libclang / symlink aliases can mismatch current packages.
    abi_cohort = apt_abi_packages(packages, dependency_names, roots=("apt", "libc++", *sorted(NATIVE_TOOL_PACKAGES)))
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
    abi_replacements = []
    libcxx_sha256 = None
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
        # npm is a separate Termux JS package. Remove the old global npm
        # directory before overlay, so files removed between npm releases
        # do not survive as a mixed-version tool installation. The new .deb
        # has already been SHA256 verified above.
        if name == "npm":
            legacy_npm = stage / "usr/lib/node_modules/npm"
            if legacy_npm.is_symlink():
                raise ValueError("unexpected symlink at legacy npm package root")
            if legacy_npm.is_dir():
                shutil.rmtree(legacy_npm)
        # The seed can contain a stale pip package and entrypoint. Refresh the
        # exact package-owned Python-pip payload from the verified .deb, not
        # arbitrary user-installed site-packages or HOME virtual environments.
        if name == "python-pip":
            for site in (stage / "usr/lib").glob("python*/site-packages"):
                for old_info in site.glob("pip-*.dist-info"):
                    if old_info.is_symlink():
                        raise ValueError("unexpected symlink in staged pip metadata")
                    if old_info.is_dir():
                        shutil.rmtree(old_info)
        if name == "libc++":
            packaged_cpp = prefix / "lib/libc++_shared.so"
            if not packaged_cpp.is_file():
                raise ValueError("libc++ ARM64 package missing libc++_shared.so")
            libcxx_sha256 = hashlib.sha256(packaged_cpp.read_bytes()).hexdigest()
        for root, dirs, files in os.walk(prefix, followlinks=False):
            parent = Path(root)
            rel = parent.relative_to(prefix)
            outdir = stage / "usr" / rel
            outdir.mkdir(parents=True, exist_ok=True)
            for file in files:
                src = parent / file
                dst = outdir / file
                # npm is a separate Termux package. Replace its legacy JS
                # installation and entrypoint scripts, not just the Node ELF.
                npm_file = name == "npm" and (
                    rel.parts[:3] == ("lib", "node_modules", "npm")
                    or (rel.parts[:1] == ("bin",) and file in ("npm", "npx")))
                replace_abi = (should_replace_native(name, abi_cohort, src, rel / file)
                               or name in ("python-pip", "lua-language-server")
                               or npm_file)
                if overlay_one(src, dst, allow_replace=replace_abi) and replace_abi:
                    abi_replacements.append(str((rel / file).as_posix()))
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
    # npm is distributed separately from Node. Require its current files,
    # otherwise plugin scripts may execute the obsolete npm from the seed.
    npm_package = next((p for p in manifest if p["package"] == "npm"), None)
    if not npm_package:
        raise ValueError("Termux npm package absent from upgraded Node runtime")
    for cli in ("npm-cli.js", "npx-cli.js"):
        entry = stage / "usr/lib/node_modules/npm/bin" / cli
        if not entry.is_file() or entry.is_symlink():
            raise ValueError("Termux npm JavaScript CLI incomplete: " + cli)
    for cli in ("npm", "npx"):
        entry = stage / "usr/bin" / cli
        if not (entry.is_file() or entry.is_symlink()):
            raise ValueError("Termux package manager entrypoint missing: " + cli)
    # The published DSH CLI enforces engines.node >=24.9.0. Retaining the
    # signed seed's Node 22 is not an upgrade even with a correct JS graph.
    node_package = next((p for p in manifest if p["package"] == "nodejs"), None)
    if not node_package:
        raise ValueError("DSH 0.2.2 requires refreshed native Termux nodejs")
    node_version = re.match(r"^(\d+)\.(\d+)\.(\d+)", node_package["version"] or "")
    if not node_version or tuple(map(int, node_version.groups())) < (24, 9, 0):
        raise ValueError("Termux nodejs below required 24.9.0: " + str(node_package["version"]))
    node_elf = stage / "usr/bin/node"
    with node_elf.open("rb") as node_file:
        hdr = node_file.read(20)
    if len(hdr) < 20 or hdr[:4] != b"\x7fELF" or int.from_bytes(hdr[18:20], "little") != 183:
        raise ValueError("upgraded native Node executable is not Android ARM64 ELF")
    if not libcxx_sha256:
        raise ValueError("No verified libc++ package was fetched")
    abi_report = validate_apt_abi(stage, libcxx_sha256, abi_replacements)
    print("[native] validated apt/libc++ ABI cohort:", abi_report)
    # No more silent success when a package was downloaded but its executable
    # was missing from the merged runtime. Check both new and inherited files.
    missing = [command for command in TOOL_COMMANDS
               if not (stage / "usr/bin" / command).exists()]
    if missing:
        raise ValueError("Android tool package closure lacks executable(s): " + ", ".join(missing))
    # The 'file' command is unusable without its compiled magic database.
    # The package may install under share/misc or share/file depending on
    # its Termux release. Verify a real resource, not only the ELF launcher.
    magic_candidates = (
        stage / "usr/share/misc/magic.mgc",
        stage / "usr/share/file/magic.mgc",
    )
    if not any(candidate.is_file() for candidate in magic_candidates):
        raise ValueError("file is packaged without the magic.mgc database")
    # New Termux 7zip ships a standalone 7zz; unlike 7z it doesn't dlopen
    # a 7z.so relative to the caller's working directory.
    standalone_7zz = stage / "usr/bin/7zz"
    if not standalone_7zz.is_file():
        raise ValueError("7zip standalone archive codec 7zz missing")
    # git --version alone misses a broken remote HTTP helper. Fail the
    # archive build before signing if HTTPS transport or CA trust is missing.
    git_helpers = (
        stage / "usr/libexec/git-core/git-remote-https",
        stage / "usr/lib/git-core/git-remote-https",
    )
    if not any(helper.is_file() for helper in git_helpers):
        raise ValueError("git HTTPS transport helper missing from native ARM64 runtime")
    if not any((stage / rel).is_file() for rel in (
        "usr/etc/tls/cert.pem",
        "usr/etc/ssl/cert.pem",
        "usr/etc/ssl/certs/ca-certificates.crt",
    )):
        raise ValueError("GitHub HTTPS CA bundle missing from native ARM64 runtime")
    for cmd in ("git", "gh", "ssh"):
        candidate = stage / "usr/bin" / cmd
        if not candidate.is_file():
            raise ValueError("native ARM64 " + cmd + " binary absent from package")
        with candidate.open("rb") as stream:
            header = stream.read(20)
        if len(header) < 20 or header[:4] != bytes((0x7f, 69, 76, 70)) or int.from_bytes(header[18:20], "little") != 183:
            raise ValueError("native ARM64 " + cmd + " is not an AArch64 ELF")
    # Native compiler viability requires headers, C++ library and linkers;
    # merely running clang --version is insufficient.
    toolroot = stage / "usr"
    for name in ("clang", "clang++", "make", "cmake", "ninja", "ld.lld", "pkg-config", "qemu-x86_64"):
        target = toolroot / "bin" / name
        if not target.is_file():
            raise ValueError("ARM64 compiler/build executable missing: " + name)
    if not (toolroot / "include/stdio.h").is_file():
        raise ValueError("C toolchain missing libc development headers (stdio.h)")
    if not any((toolroot / "lib").glob("libclang*")) and not any((toolroot / "lib").glob("libLLVM*")):
        raise ValueError("C toolchain missing Clang/LLVM shared libraries")
    # Search and interactive fuzzy-finder resources must be packaged together,
    # not reduced to three --version-capable ELF binaries.
    for cmd in ("rg", "fd", "fzf"):
        binary = stage / "usr/bin" / cmd
        if not binary.is_file():
            raise ValueError("missing ARM64 search tool " + cmd)
        with binary.open("rb") as stream:
            header = stream.read(20)
        if len(header) < 20 or header[:4] != bytes((0x7f, 69, 76, 70)) or int.from_bytes(header[18:20], "little") != 183:
            raise ValueError("search tool is not ARM64 ELF: " + cmd)
    if not (stage / "usr/share/fzf/key-bindings.bash").is_file():
        raise ValueError("fzf shell key bindings missing from ARM64 package")
    if not (stage / "usr/share/fzf/completion.bash").is_file():
        raise ValueError("fzf bash completion missing from ARM64 package")
    if not (stage / "usr/bin/fzf-tmux").is_file():
        raise ValueError("fzf-tmux integration missing from ARM64 package")
    print("[native] verified", len(TOOL_COMMANDS), "critical tool executable paths and magic data")
    return manifest, abi_report

def install_lua_language_server_launcher(stage):
    """Rewrite the official Termux launcher for the DSH app-private prefix.

    The .deb launcher embeds /data/data/com.termux and execs an app-private
    ELF directly. Both assumptions are invalid for a non-root DSH Android UID.
    """
    root = stage / "usr"
    program = root / "share/lua-language-server/bin/lua-language-server"
    if not program.is_file() or program.is_symlink():
        raise ValueError("Lua language-server native payload missing")
    with program.open("rb") as inp:
        header = inp.read(20)
    if len(header) < 20 or header[:4] != bytes((127, 69, 76, 70)) or int.from_bytes(header[18:20], "little") != 183:
        raise ValueError("Lua language-server is not AArch64 ELF")
    launcher = root / "bin/lua-language-server"
    if launcher.is_symlink():
        launcher.unlink()
    elif launcher.exists() and not launcher.is_file():
        raise ValueError("invalid Lua language-server launcher")
    launcher.parent.mkdir(parents=True, exist_ok=True)
    launcher.write_text("""#!/system/bin/sh
set -eu
prefix="${TERMUX__PREFIX:-${PREFIX:-}}"
[ -n "$prefix" ] || { echo DSH_LUA_LSP_PREFIX_MISSING >&2; exit 125; }
program="$prefix/share/lua-language-server/bin/lua-language-server"
[ -f "$program" ] || { echo DSH_LUA_LSP_PAYLOAD_MISSING >&2; exit 127; }
tmp="$prefix/tmp"
/system/bin/mkdir -p "$tmp"
workspace="$(/system/bin/mktemp -d "$tmp/dsh-lua-lsp.XXXXXX")" || exit 125
trap '/system/bin/rm -rf "$workspace"' EXIT
/system/bin/mkdir -p "$workspace/log" "$workspace/meta"
/system/bin/linker64 "$program" --logpath="$workspace/log" --metapath="$workspace/meta" "$@"
""")
    launcher.chmod(0o700)

def overlay_sources(stage, source):
    mobile = stage / "usr/libexec/dsh-mobile"
    mobile.mkdir(parents=True, exist_ok=True)
    for filename, dest in SCRIPT_MAP.items():
        src = source / "scripts" / filename
        if not src.is_file():
            raise ValueError("missing host-neutral source " + filename)
        shutil.copy2(src, mobile / dest)
    (mobile / "android-sandbox-runner.sh").chmod(0o755)
    (mobile / "android-exec.sh").chmod(0o755)
    (mobile / "android-bash-env.sh").chmod(0o644)
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
    # gcc/g++ are compatibility aliases only: Termux uses LLVM/Clang.
    for alias, target in (("cc", "clang"), ("c++", "clang++"), ("gcc", "clang"), ("g++", "clang++")):
        executable = stage / "usr/bin" / alias
        if not executable.exists() and not executable.is_symlink():
            os.symlink(target, executable)
    # Every packaged CLI must resolve through the same SELinux-safe bridge.
    # The earlier 13-command-only list left nested Bash commands unwrapped.
    for command in sorted({path.name for path in (stage / "usr/bin").iterdir()
                           if path.is_file() and re.fullmatch(r"[A-Za-z0-9._+\\-]+", path.name)} |
                          {"bash", "python3", "python", "pip3", "pip",
                           "apt", "apt-get", "apt-cache", "apt-config",
                           "dpkg", "dpkg-query", "dpkg-deb", "pkg"}):
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

def install_pyright(stage, workspace):
    """Stage pinned pure JS Pyright for real Python semantic navigation on Android."""
    packed = subprocess.run(["npm", "pack", "pyright@1.1.414", "--ignore-scripts",
        "--pack-destination", str(workspace), "--json"], check=True, stdout=subprocess.PIPE, text=True)
    metadata = json.loads(packed.stdout)
    if len(metadata) != 1 or Path(metadata[0]["filename"]).name != metadata[0]["filename"]:
        raise ValueError("unexpected Pyright npm metadata")
    archive_path = workspace / metadata[0]["filename"]
    if not archive_path.is_file():
        raise ValueError("Pyright package missing after npm pack")
    target = stage / "usr/lib/dsh-dev-tools/node_modules/pyright"
    if target.exists() or target.is_symlink():
        raise ValueError("unexpected existing Pyright developer-tools target")
    target.mkdir(parents=True)
    with tarfile.open(archive_path, "r:gz") as package:
        for entry in package:
            name = check_relative(entry.name)
            if not name.startswith("package/"):
                raise ValueError("unexpected Pyright archive entry")
            rel = name.removeprefix("package/")
            if not rel:
                continue
            dest = target / rel
            if entry.isdir():
                dest.mkdir(parents=True, exist_ok=True)
            elif entry.isfile():
                dest.parent.mkdir(parents=True, exist_ok=True)
                with package.extractfile(entry) as source, dest.open("wb") as sink:
                    shutil.copyfileobj(source, sink)
            else:
                raise ValueError("unsupported Pyright archive member type")
    entrypoint = target / "dist/pyright-langserver.js"
    # npm's shim points to langserver.index.js in the npm package root.
    if not entrypoint.is_file():
        entrypoint = target / "langserver.index.js"
    if not entrypoint.is_file():
        raise ValueError("Pyright language-server JS entrypoint missing")
    return {"version": "1.1.414", "sha256": hashlib.sha256(archive_path.read_bytes()).hexdigest()}


def install_luau_analysis_runtime(stage, workspace):
    """Stage the pinned portable Luau WASM backend without lifecycle scripts."""
    packed = subprocess.run(["npm", "pack", "luau-web@1.5.1", "--ignore-scripts",
        "--pack-destination", str(workspace), "--json"], check=True, stdout=subprocess.PIPE, text=True)
    filename = json.loads(packed.stdout)[0]["filename"]
    if Path(filename).name != filename:
        raise ValueError("invalid Luau package filename")
    archive = workspace / filename
    expected = "/PINL46SDMR7ezqnVxxjR66+k8+JH8U7VH/ct+tY53jXfQvTMwcgGzF0jW3MFYWaY5MnGtj0wlYKSAf3L/2Slw=="
    if base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode() != expected:
        raise ValueError("Luau WASM integrity mismatch")
    target = stage / "usr/lib/dsh-dev-tools/node_modules/luau-web"
    if any(p.is_symlink() for p in [target, *target.parents] if p == stage or stage in p.parents):
        raise ValueError("symlink in Luau target")
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)
    with tarfile.open(archive, "r:gz") as bundle:
        for member in bundle:
            path = check_relative(member.name)
            if not path.startswith("package/"):
                raise ValueError("unexpected Luau entry")
            dest = target / path.removeprefix("package/")
            if member.isdir():
                dest.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                dest.parent.mkdir(parents=True, exist_ok=True)
                with bundle.extractfile(member) as inp, dest.open("wb") as out:
                    shutil.copyfileobj(inp, out)
            else:
                raise ValueError("unexpected Luau entry type")

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
        manifest, abi_report = fetch_packages(stage, workspace)
        install_lua_language_server_launcher(stage)
        overlay_sources(stage, args.repo)
        # Upgrade the complete JS package family; the seed is only an Android
        # ABI/toolchain carrier, not a source of 0.1.5 DSH modules.
        from runpy import run_path
        install_release=run_path(str(args.repo / 'scripts/ci-upgrade-dsh-runtime.py'))['install_release']
        family_audit=install_release(stage, workspace, args.repo)
        shutil.copyfile(stage / "usr/lib/dsh-release-family.json",
                        args.repo / "runtime-release-family.json")
        # Older validation workflows still point at the checked-in 0.1.5
        # family lock. During this ephemeral builder job they must validate
        # against the *generated 0.2.2* lock, not the legacy source baseline.
        # Both paths are copied from the exact same pinned upstream manifest;
        # no package/version checks are disabled.
        shutil.copyfile(stage / "usr/lib/dsh-release-family.json",
                        args.repo / "scripts/dsh-release-family-lock.json")
        # The GitHub native builder reuses an already-patched DSH seed.
        # Apply current core's session-storage publication compatibility too. The seed's
        # subprocess-local bundle does not contain the upstream containment
        # anchor used by the full fresh-install patch; rerunning that rewrite
        # aborts signed assembly. Keep the original patched module intact and
        # rely on the Termux execution bridge for nested CLI commands.
        subprocess.run(
            ["node", str(args.repo / "scripts/android-runtime-patch.mjs"), str(stage / "usr")],
            check=True, env={**os.environ, "DSH_TARGET_VERSION": "0.2.2-rc.5",
                             "DSH_COMPAT_ONLY_PACKAGES": "@deepseek-ai/dsh-terminal-bash,@deepseek-ai/dsh-sandbox-local,@deepseek-ai/dsh-bash-local,@deepseek-ai/dsh-subprocess-local,node-addon-require-builtin,@deepseek-ai/node-addon-system,@deepseek-ai/dsh-session-persistence-jsonl"})
        patch_web_fetch_limits(stage)
        stage_modsearch(stage, workspace)
        install_typescript(stage, workspace)
        pyright_audit = install_pyright(stage, workspace)
        install_luau_analysis_runtime(stage, workspace)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        # Keep symbolic links intact. Never dereference Android-only targets.
        with tarfile.open(args.output, "w:xz", preset=0) as archive:
            for entry in sorted(stage.iterdir()):
                archive.add(entry, arcname=entry.name, recursive=True)
        args.audit.write_text(json.dumps({
            "buildSystem": "GitHub-hosted Ubuntu ARM64, not a Termux build",
            "seedSha256": hashlib.sha256(args.seed.read_bytes()).hexdigest(),
            "sourceOverlay": list(SCRIPT_MAP.values()),
            "upgradedDshFamily": family_audit,
            "androidPackageArchives": manifest,
            "pyright": pyright_audit,
            "aptAbi": abi_report,
            "limits": "Native Android ELF loadability / WebUI still require device smoke",
        }, indent=2) + "\n")
        print("[native] generated ARM64 Android archive", args.output, args.output.stat().st_size)

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("[native] BUILD FAIL:", str(e), file=sys.stderr)
        sys.exit(2)
