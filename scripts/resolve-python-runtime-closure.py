#!/usr/bin/env python3
"""Resolve the complete installed Python distribution closure for CLI commands.

Writes NUL-delimited absolute file paths to stdout. Diagnostics go to stderr.
The resolver is intentionally host-prefix aware so build-termux.sh can copy
pip/post-install payloads that are invisible to dpkg-query -L.
"""

from __future__ import annotations

import argparse
import ast
import importlib.metadata as md
import pathlib
import re
import sys

try:
    from packaging.requirements import Requirement
    from packaging.utils import canonicalize_name
except ImportError:  # Termux pip always carries a vendored packaging fallback.
    from pip._vendor.packaging.requirements import Requirement
    from pip._vendor.packaging.utils import canonicalize_name


def inside(path: pathlib.Path, prefix: pathlib.Path) -> bool:
    try:
        path.relative_to(prefix)
        return True
    except ValueError:
        return False


def python_script(path: pathlib.Path) -> bool:
    try:
        with path.open("rb") as fh:
            first = fh.readline(4096).decode("utf-8", "replace").lower()
    except OSError:
        return False
    return first.startswith("#!") and "python" in first


def imported_top_level_names(path: pathlib.Path) -> set[str]:
    try:
        source = path.read_text(encoding="utf-8", errors="replace")
        tree = ast.parse(source)
    except (OSError, SyntaxError):
        return set()
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                names.add(alias.name.split(".", 1)[0])
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module.split(".", 1)[0])
    return names


def distribution_file_paths(dist: md.Distribution, prefix: pathlib.Path) -> list[pathlib.Path]:
    paths: list[pathlib.Path] = []
    for item in dist.files or ():
        try:
            path = pathlib.Path(dist.locate_file(item)).resolve(strict=True)
        except OSError:
            continue
        if inside(path, prefix) and path.is_file():
            paths.append(path)
    return paths


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prefix", required=True)
    parser.add_argument("commands", nargs="+")
    args = parser.parse_args()

    prefix = pathlib.Path(args.prefix).resolve()
    bin_dir = prefix / "bin"

    command_paths: dict[str, pathlib.Path] = {}
    python_commands: dict[str, pathlib.Path] = {}
    for command in args.commands:
        raw = bin_dir / command
        try:
            resolved = raw.resolve(strict=True)
        except OSError:
            continue
        if not inside(resolved, prefix) or not resolved.is_file():
            continue
        command_paths[command] = resolved
        if python_script(resolved):
            python_commands[command] = resolved

    if not python_commands:
        print("[DSH] Python CLI discovery: no Python-backed required commands", file=sys.stderr)
        return 0

    distributions = list(md.distributions())
    package_map = md.packages_distributions()
    roots: dict[str, md.Distribution] = {}

    # Primary discovery: console_scripts metadata and distribution-owned bin files.
    for dist in distributions:
        dist_name = dist.metadata.get("Name")
        if not dist_name:
            continue
        canon = canonicalize_name(dist_name)
        matched = False

        for ep in dist.entry_points:
            if ep.group == "console_scripts" and ep.name in python_commands:
                matched = True
                break

        if not matched:
            for item in dist.files or ():
                try:
                    located = pathlib.Path(dist.locate_file(item)).resolve(strict=True)
                except OSError:
                    continue
                if any(located == cmd_path for cmd_path in python_commands.values()):
                    matched = True
                    break

        if matched:
            roots[canon] = dist

    # Fallback for distro-generated wrappers whose script ownership metadata is
    # not preserved: map imported top-level modules back to distributions.
    for command, path in python_commands.items():
        covered = False
        for dist in roots.values():
            for ep in dist.entry_points:
                if ep.group == "console_scripts" and ep.name == command:
                    covered = True
                    break
            if covered:
                break
        if covered:
            continue

        for module in imported_top_level_names(path):
            for dist_name in package_map.get(module, ()):
                try:
                    dist = md.distribution(dist_name)
                except md.PackageNotFoundError:
                    continue
                roots[canonicalize_name(dist.metadata.get("Name", dist_name))] = dist

    if not roots:
        cmds = ", ".join(sorted(python_commands))
        print(f"[DSH] Could not resolve Python distributions for required CLI(s): {cmds}", file=sys.stderr)
        return 7

    resolved: dict[str, md.Distribution] = {}
    queue = list(roots.values())
    missing: list[str] = []

    while queue:
        dist = queue.pop(0)
        name = dist.metadata.get("Name")
        if not name:
            continue
        canon = canonicalize_name(name)
        if canon in resolved:
            continue
        resolved[canon] = dist

        for raw_req in dist.requires or ():
            try:
                req = Requirement(raw_req)
            except Exception as exc:
                print(f"[DSH] Cannot parse Requires-Dist for {name}: {raw_req!r}: {exc}", file=sys.stderr)
                return 7

            if req.marker is not None:
                try:
                    if not req.marker.evaluate({"extra": ""}):
                        continue
                except Exception:
                    # Fail closed for malformed active metadata rather than
                    # silently creating a runtime with an unknown dependency.
                    print(f"[DSH] Cannot evaluate dependency marker for {name}: {raw_req}", file=sys.stderr)
                    return 7

            try:
                child = md.distribution(req.name)
            except md.PackageNotFoundError:
                missing.append(f"{name} -> {req.name}")
                continue
            if canonicalize_name(child.metadata.get("Name", req.name)) not in resolved:
                queue.append(child)

    if missing:
        print("[DSH] Missing installed Python runtime dependencies:", file=sys.stderr)
        for item in sorted(set(missing)):
            print(f"[DSH]   {item}", file=sys.stderr)
        return 7

    files: list[pathlib.Path] = []
    empty: list[str] = []
    for canon, dist in sorted(resolved.items()):
        dist_files = distribution_file_paths(dist, prefix)
        if not dist_files:
            empty.append(dist.metadata.get("Name", canon))
        files.extend(dist_files)

    if empty:
        print("[DSH] Python distribution metadata has no copyable files: " + ", ".join(sorted(empty)), file=sys.stderr)
        return 7

    roots_text = ", ".join(sorted(dist.metadata.get("Name", name) for name, dist in roots.items()))
    closure_text = ", ".join(sorted(dist.metadata.get("Name", name) for name, dist in resolved.items()))
    print(f"[DSH] Python CLI roots: {roots_text}", file=sys.stderr)
    print(f"[DSH] Python distribution closure ({len(resolved)}): {closure_text}", file=sys.stderr)

    seen: set[pathlib.Path] = set()
    for path in files:
        if path in seen:
            continue
        seen.add(path)
        sys.stdout.buffer.write(str(path).encode("utf-8") + b"\0")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
