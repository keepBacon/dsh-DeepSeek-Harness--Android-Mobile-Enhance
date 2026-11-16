#!/usr/bin/env python3
"""Coherent native APT/libc++ overlay for the GitHub Android ARM64 builder.

The signed legacy seed may contain older Termux ELF files. Keeping these files
while adding packages from a rolling repository creates incompatible C++ ABI
combinations. Preserve the DSH/Node application graph, but atomically replace
native files belonging to the dependency closure of APT and libc++.
"""
from pathlib import Path
import hashlib
import os
import re
import shutil
import subprocess

ABI_ROOTS = ("apt", "libc++")
NATIVE_TOOL_PACKAGES = frozenset(("clang", "lld", "llvm", "make", "cmake", "ninja", "pkg-config", "qemu-user-x86-64"))
ELF = b"\x7fELF"
SYSTEM_SONAMES = {
    "libc.so", "libm.so", "libdl.so", "liblog.so", "libandroid.so",
    "libbinder_ndk.so", "libz.so", "libEGL.so", "libGLESv2.so",
}


def apt_abi_packages(index, dependency_names, roots=ABI_ROOTS):
    closure = set()
    def visit(name):
        if name in closure:
            return
        if name not in index:
            raise ValueError("APT ABI root/dependency unavailable: " + name)
        closure.add(name)
        record = index[name][1]
        for dep in dependency_names(",".join(
                part for part in (record.get("Pre-Depends", ""), record.get("Depends", "")) if part), index):
            visit(dep)
    for root in roots:
        visit(root)
    return closure


def is_elf(path):
    if path.is_symlink() or not path.is_file():
        return False
    with path.open("rb") as handle:
        return handle.read(4) == ELF


def should_replace_native(package, cohort, source, relative_path):
    if package not in cohort:
        return False
    parts = relative_path.parts
    if not parts or parts[0] not in ("bin", "lib", "libexec"):
        return False
    if source.is_symlink():
        # SONAME/linker aliases must come from the same package as their ELF.
        return (relative_path.name.endswith(".so") or ".so." in relative_path.name
                or (package in NATIVE_TOOL_PACKAGES and parts[0] == "bin"))
    return is_elf(source)


def overlay_one(source, destination, allow_replace=False):
    """Install an archive member, never follow a pre-existing destination link."""
    if destination.is_symlink() or destination.exists():
        if not allow_replace:
            return False
        if destination.is_dir() and not destination.is_symlink():
            raise ValueError("refusing ABI overlay onto directory " + str(destination))
        destination.unlink()
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source.is_symlink():
        os.symlink(os.readlink(source), destination)
    else:
        shutil.copy2(source, destination, follow_symlinks=False)
    return True


def elf_details(path):
    if not is_elf(path):
        raise ValueError("required native ABI payload is not an ELF: " + str(path))
    with path.open("rb") as handle:
        hdr = handle.read(20)
    if len(hdr) < 20 or hdr[4] != 2 or hdr[5] != 1 or int.from_bytes(hdr[18:20], "little") != 183:
        raise ValueError("required native ABI payload is not ELF64/AArch64: " + str(path))
    result = subprocess.run(["readelf", "-W", "-d", str(path)], capture_output=True, text=True, check=True)
    return re.findall(r"\(NEEDED\)\s+Shared library:\s+\[([^\]]+)\]", result.stdout)


def validate_apt_abi(stage, expected_cpp_sha256, replacements):
    """Fail before signing when the libc++ library is inherited from the old seed."""
    root = stage / "usr"
    cpp = root / "lib/libc++_shared.so"
    if not cpp.is_file() or cpp.is_symlink():
        raise ValueError("verified libc++ package library missing from staged Runtime")
    actual_sha = hashlib.sha256(cpp.read_bytes()).hexdigest()
    if actual_sha != expected_cpp_sha256:
        raise ValueError("stale libc++_shared.so in APK seed; ABI overlay was not applied")
    needed_by = {}
    binaries = ("bin/apt", "bin/apt-get", "bin/apt-cache", "bin/apt-config")
    libraries = tuple(sorted(path for path in (root / "lib").glob("libapt-*.so*")
                             if path.is_file() and not path.is_symlink()))
    for suffix in ("lib/libc++_shared.so", *binaries):
        path = root / suffix
        needed_by[suffix] = elf_details(path)
    for path in libraries:
        needed_by[path.relative_to(root).as_posix()] = elf_details(path)
    if not libraries:
        raise ValueError("libapt-pkg/libapt-private native library missing")
    # APT can load libapt successfully yet fail on an indirect libcurl,
    # libssl, libc++ or compression dependency. Resolve the complete local
    # DT_NEEDED graph, not just the first tier from the apt executables.
    missing = []
    examined = set(needed_by)
    pending = list(needed_by.items())
    while pending:
        rel, deps = pending.pop()
        for soname in deps:
            if "/" in soname or "\x00" in soname:
                raise ValueError("invalid DT_NEEDED SONAME in " + rel)
            if soname in SYSTEM_SONAMES:
                continue
            child = root / "lib" / soname
            if not child.is_file():
                missing.append(rel + " -> " + soname)
                continue
            # Follow relative symlinks within the staging lib directory only.
            resolved = child.resolve()
            if not resolved.is_relative_to((root / "lib").resolve()):
                raise ValueError("APT DT_NEEDED path escapes local library tree: " + soname)
            canonical = resolved.relative_to(root).as_posix()
            if canonical not in examined:
                if len(examined) >= 192:
                    raise ValueError("APT native dependency graph unexpectedly large")
                examined.add(canonical)
                child_deps = elf_details(resolved)
                pending.append((canonical, child_deps))
    if missing:
        raise ValueError("APT transitive DT_NEEDED closure incomplete: " + ", ".join(sorted(set(missing))[:16]))
    if not any(name.endswith("/libc++_shared.so") for name in replacements):
        raise ValueError("libc++_shared.so was not refreshed from verified package archive")
    return {
        "libcxx_sha256": actual_sha,
        "checked_elf": len(needed_by),
        "transitive_elf": len(examined),
        "refreshed_abi_files": len(replacements),
        "apt_native_libraries": len(libraries),
    }
