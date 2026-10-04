#!/usr/bin/env python3
"""Resolve the complete installed Python runtime closure for required CLI commands.

The resolver intentionally handles both standard Python distributions and
Termux-built Python payloads that do not expose complete dist-info metadata.
It writes NUL-delimited absolute file paths to stdout; diagnostics go to stderr.
"""

from __future__ import annotations

import argparse
import ast
import importlib.metadata as md
import importlib.util
import pathlib
import sys
from collections import deque

try:
    from packaging.requirements import Requirement
    from packaging.utils import canonicalize_name
except ImportError:
    from pip._vendor.packaging.requirements import Requirement
    from pip._vendor.packaging.utils import canonicalize_name


def inside(path: pathlib.Path, root: pathlib.Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def python_script(path: pathlib.Path) -> bool:
    try:
        first = path.open("rb").readline(4096).decode("utf-8", "replace").lower()
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
            # Relative imports stay inside the package currently being copied;
            # only absolute imports can introduce a new top-level dependency.
            if node.level == 0:
                names.add(node.module.split(".", 1)[0])
    return names


def distribution_file_paths(dist: md.Distribution, prefix: pathlib.Path) -> list[pathlib.Path]:
    result: list[pathlib.Path] = []
    for item in dist.files or ():
        try:
            path = pathlib.Path(dist.locate_file(item)).resolve(strict=True)
        except OSError:
            continue
        if inside(path, prefix) and path.is_file():
            result.append(path)
    return result


def site_package_roots(prefix: pathlib.Path) -> list[pathlib.Path]:
    roots: list[pathlib.Path] = []
    for raw in sys.path:
        if not raw:
            continue
        try:
            path = pathlib.Path(raw).resolve()
        except OSError:
            continue
        if not inside(path, prefix):
            continue
        if "site-packages" in path.parts or "dist-packages" in path.parts:
            roots.append(path)
    return roots


def path_in_any(path: pathlib.Path, roots: list[pathlib.Path]) -> bool:
    return any(inside(path, root) for root in roots)


def module_payload(name: str, prefix: pathlib.Path, site_roots: list[pathlib.Path]) -> tuple[list[pathlib.Path], list[pathlib.Path]]:
    """Return (all files to copy, python sources to scan) for a top-level module."""
    try:
        spec = importlib.util.find_spec(name)
    except (ImportError, AttributeError, ValueError):
        return [], []
    if spec is None:
        return [], []

    files: list[pathlib.Path] = []
    python_sources: list[pathlib.Path] = []

    locations = list(spec.submodule_search_locations or ())
    if locations:
        for raw in locations:
            try:
                root = pathlib.Path(raw).resolve(strict=True)
            except OSError:
                continue
            if not inside(root, prefix) or not path_in_any(root, site_roots):
                continue
            for path in root.rglob("*"):
                if not path.is_file():
                    continue
                try:
                    resolved = path.resolve(strict=True)
                except OSError:
                    continue
                if not inside(resolved, prefix):
                    continue
                files.append(resolved)
                if resolved.suffix == ".py":
                    python_sources.append(resolved)

    origin = spec.origin
    if origin and origin not in {"built-in", "frozen"}:
        try:
            path = pathlib.Path(origin).resolve(strict=True)
        except OSError:
            path = None
        if path is not None and inside(path, prefix) and path_in_any(path, site_roots) and path.is_file():
            files.append(path)
            if path.suffix == ".py":
                python_sources.append(path)

    return list(dict.fromkeys(files)), list(dict.fromkeys(python_sources))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prefix", required=True)
    parser.add_argument("commands", nargs="+")
    args = parser.parse_args()

    prefix = pathlib.Path(args.prefix).resolve()
    bin_dir = prefix / "bin"
    site_roots = site_package_roots(prefix)

    python_commands: dict[str, pathlib.Path] = {}
    for command in args.commands:
        raw = bin_dir / command
        try:
            resolved = raw.resolve(strict=True)
        except OSError:
            continue
        if inside(resolved, prefix) and resolved.is_file() and python_script(resolved):
            python_commands[command] = resolved

    if not python_commands:
        print("[DSH] Python CLI discovery: no Python-backed required commands", file=sys.stderr)
        return 0

    distributions = list(md.distributions())
    package_map = md.packages_distributions()

    dist_queue: deque[md.Distribution] = deque()
    module_queue: deque[str] = deque()
    root_dist_names: set[str] = set()
    root_modules: set[str] = set()

    # Standard discovery first: console_scripts and distribution-owned wrappers.
    for dist in distributions:
        dist_name = dist.metadata.get("Name")
        if not dist_name:
            continue
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
                if any(located == path for path in python_commands.values()):
                    matched = True
                    break
        if matched:
            dist_queue.append(dist)
            root_dist_names.add(canonicalize_name(dist_name))

    # Always parse wrapper imports. This is essential for Termux-built payloads
    # like Frida whose CLI scripts import frida_tools directly without standard
    # console_scripts/dist-info ownership.
    for path in python_commands.values():
        for module in imported_top_level_names(path):
            module_queue.append(module)
            root_modules.add(module)

    resolved_dists: dict[str, md.Distribution] = {}
    resolved_modules: set[str] = set()
    files: list[pathlib.Path] = []
    missing: list[str] = []

    while dist_queue or module_queue:
        while dist_queue:
            dist = dist_queue.popleft()
            name = dist.metadata.get("Name")
            if not name:
                continue
            canon = canonicalize_name(name)
            if canon in resolved_dists:
                continue
            resolved_dists[canon] = dist

            dist_files = distribution_file_paths(dist, prefix)
            files.extend(dist_files)

            # Scan Python source owned by the distribution too. This catches
            # undeclared runtime imports in distro-built packages.
            for path in dist_files:
                if path.suffix == ".py":
                    for module in imported_top_level_names(path):
                        module_queue.append(module)

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
                        print(f"[DSH] Cannot evaluate dependency marker for {name}: {raw_req}", file=sys.stderr)
                        return 7
                try:
                    child = md.distribution(req.name)
                except md.PackageNotFoundError:
                    missing.append(f"{name} -> {req.name}")
                    continue
                child_name = child.metadata.get("Name", req.name)
                if canonicalize_name(child_name) not in resolved_dists:
                    dist_queue.append(child)

        while module_queue:
            module = module_queue.popleft()
            if module in resolved_modules:
                continue
            resolved_modules.add(module)

            # Standard distribution mapping when available.
            mapped = package_map.get(module, ())
            mapped_any = False
            for dist_name in mapped:
                try:
                    dist = md.distribution(dist_name)
                except md.PackageNotFoundError:
                    continue
                mapped_any = True
                canon = canonicalize_name(dist.metadata.get("Name", dist_name))
                if canon not in resolved_dists:
                    dist_queue.append(dist)

            # Independently resolve the actual module payload. Do this even if
            # metadata exists because distro-built packages can have incomplete
            # RECORD/top_level metadata.
            module_files, python_sources = module_payload(module, prefix, site_roots)
            if module_files:
                files.extend(module_files)
                for source in python_sources:
                    for imported in imported_top_level_names(source):
                        if imported not in resolved_modules:
                            module_queue.append(imported)
            elif not mapped_any:
                # Ignore stdlib/builtin modules (find_spec outside site-packages),
                # but fail closed only for names that look like third-party roots
                # imported by our CLI/package code and cannot be resolved at all.
                try:
                    spec = importlib.util.find_spec(module)
                except Exception:
                    spec = None
                if spec is None:
                    missing.append(f"unresolved module: {module}")

    if missing:
        print("[DSH] Missing Python runtime dependencies:", file=sys.stderr)
        for item in sorted(set(missing)):
            print(f"[DSH]   {item}", file=sys.stderr)
        return 7

    unique_files = list(dict.fromkeys(files))
    if not unique_files:
        cmds = ", ".join(sorted(python_commands))
        print(f"[DSH] Python CLI closure produced no files for: {cmds}", file=sys.stderr)
        return 7

    root_dist_text = ", ".join(
        sorted(resolved_dists[name].metadata.get("Name", name) for name in root_dist_names if name in resolved_dists)
    )
    root_module_text = ", ".join(sorted(root_modules))
    closure_text = ", ".join(sorted(dist.metadata.get("Name", name) for name, dist in resolved_dists.items()))
    print(f"[DSH] Python CLI distribution roots: {root_dist_text or '(metadata-less)'}", file=sys.stderr)
    print(f"[DSH] Python CLI import roots: {root_module_text}", file=sys.stderr)
    print(f"[DSH] Python distribution closure ({len(resolved_dists)}): {closure_text}", file=sys.stderr)
    print(f"[DSH] Python module closure ({len(resolved_modules)} top-level modules, {len(unique_files)} files)", file=sys.stderr)

    for path in unique_files:
        sys.stdout.buffer.write(str(path).encode("utf-8") + b"\0")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
