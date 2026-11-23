#!/usr/bin/env python3
"""DSH GitHub Actions analysis backend. Not executed by the Android app.

Only a checked-out repository file under cloud-inputs/ is eligible. Commands
are fixed by the workflow's choice input; there is no shell/program argument
derived from user input. Tool releases are pinned by SHA-256, and the runner
publishes actual diagnostics/artifacts rather than synthetic tool results.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

JADX_URL = "https://github.com/skylot/jadx/releases/download/v1.5.7/jadx-1.5.7.zip"
JADX_SHA256 = "1755e4242ade71a077438723689f404079592ec7764a3a0572f98fef94ebcbf3"
GHIDRA_URL = "https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.0.4_build/ghidra_12.0.4_PUBLIC_20260303.zip"
GHIDRA_SHA256 = "c3b458661d69e26e203d739c0c82d143cc8a4a29d9e571f099c2cf4bda62a120"
TASKS = ("jadx", "ghidra", "linux-x64", "windows-pe")
MAX_INPUT = 100 * 1024 * 1024
MAX_DOWNLOAD = 600 * 1024 * 1024
MAX_ZIP_BYTES = 2 * 1024 * 1024 * 1024


def validate_input(root, name):
    if not isinstance(name, str) or not re.fullmatch(
        r"cloud-inputs/[A-Za-z0-9._+\-/]{1,220}", name
    ):
        raise ValueError("Input must be a repository-relative cloud-inputs/ path")
    parts = Path(name).parts
    if any(p in (".", "..") for p in parts):
        raise ValueError("Input contains traversal segment")
    directory = Path(root).resolve()
    target = (directory / name).resolve(strict=True)
    root_inputs = (directory / "cloud-inputs").resolve(strict=True)
    if root_inputs not in target.parents or not target.is_file():
        raise ValueError("Input escapes cloud-inputs/ or is not a file")
    if target.stat().st_size > MAX_INPUT:
        raise ValueError("Input is larger than the 100 MiB per-run limit")
    return target


def sha256_file(path):
    sha = hashlib.sha256()
    with Path(path).open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            sha.update(chunk)
    return sha.hexdigest()


def download_verified(url, digest, destination):
    req = urllib.request.Request(url, headers={"User-Agent": "DSH-cloud-analysis/1"})
    downloaded = 0
    sha = hashlib.sha256()
    with urllib.request.urlopen(req, timeout=60) as response, Path(destination).open("wb") as output:
        while chunk := response.read(1024 * 1024):
            downloaded += len(chunk)
            if downloaded > MAX_DOWNLOAD:
                raise ValueError("Pinned tool archive exceeds download limit")
            sha.update(chunk)
            output.write(chunk)
    if sha.hexdigest().lower() != digest.lower():
        raise ValueError("Pinned tool archive SHA-256 mismatch")
    return downloaded


def extract_verified_zip(zip_path, destination):
    root = Path(destination).resolve()
    root.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as archive:
        items = archive.infolist()
        if len(items) > 25000 or sum(x.file_size for x in items) > MAX_ZIP_BYTES:
            raise ValueError("Pinned tool archive exceeds unpack limits")
        for item in items:
            name = item.filename
            # Do not allow preexisting symlinks, absolute paths or traversal.
            if name.startswith("/") or "\\" in name or ".." in Path(name).parts:
                raise ValueError("Unsafe pinned tool archive member")
            # External UNIX symlinks are not needed for pinned CLI archives.
            mode = (item.external_attr >> 16) & 0o170000
            if mode == 0o120000:
                raise ValueError("Pinned tool archive contains a symlink")
            dest = (root / name).resolve()
            if root != dest and root not in dest.parents:
                raise ValueError("Pinned tool archive escapes destination")
        archive.extractall(root)


def run_logged(argv, log_path, timeout=900):
    # Never pass user-provided input to a shell. All program paths are
    # validated within the checked-out repository or pinned tool archives.
    with Path(log_path).open("wb") as log:
        try:
            cp = subprocess.run(argv, stdout=log, stderr=subprocess.STDOUT,
                                timeout=timeout, check=False, shell=False)
        except subprocess.TimeoutExpired:
            log.write(b"\nDSH_CLOUD_TASK_TIMEOUT\n")
            raise RuntimeError("Cloud analysis timed out") from None
    if cp.returncode != 0:
        raise RuntimeError("Cloud analysis exited with code " + str(cp.returncode))


def write_report(target, task, output):
    report = {
        "task": task, "input": str(target.name), "bytes": target.stat().st_size,
        "sha256": sha256_file(target), "platform": platform.platform(),
        "architecture": platform.machine(), "realExecution": True,
        "githubRun": os.getenv("GITHUB_RUN_ID"),
    }
    Path(output).mkdir(parents=True, exist_ok=True)
    (Path(output) / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8"
    )


def analyze(task, target, output):
    if task not in TASKS or task == "windows-pe":
        raise ValueError("Unsupported Linux analysis task")
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    write_report(target, task, output)
    if task == "linux-x64":
        with (output / "file.txt").open("wb") as f:
            subprocess.run(["file", "-b", str(target)], stdout=f, stderr=subprocess.STDOUT,
                           timeout=30, check=True)
        with (output / "readelf.txt").open("wb") as f:
            subprocess.run(["readelf", "-h", str(target)], stdout=f, stderr=subprocess.STDOUT,
                           timeout=30, check=False)
        # Limit actual string output; a crafted executable must not exhaust
        # the runner or artifact storage.
        data = target.read_bytes()[:16 * 1024 * 1024]
        printable = re.findall(rb"[\x20-\x7e]{8,}", data)
        (output / "strings.txt").write_bytes(
            b"\n".join(printable[:2000])[:256 * 1024] + b"\n"
        )
        return
    with tempfile.TemporaryDirectory(prefix="dsh-cloud-tool-") as temp:
        tempdir = Path(temp)
        archive = tempdir / "tool.zip"
        tools = tempdir / "tools"
        if task == "jadx":
            download_verified(JADX_URL, JADX_SHA256, archive)
            extract_verified_zip(archive, tools)
            entry = tools / "bin" / "jadx"
            entry.chmod(entry.stat().st_mode | 0o111)
            run_logged([str(entry), "--threads-count", "2", "--no-res",
                        "-d", str(output / "source"), str(target)],
                       output / "execution.log", timeout=750)
        else:
            download_verified(GHIDRA_URL, GHIDRA_SHA256, archive)
            extract_verified_zip(archive, tools)
            paths = list(tools.glob("ghidra_*/support/analyzeHeadless"))
            if len(paths) != 1:
                raise ValueError("Pinned Ghidra analyzeHeadless entry missing")
            entry = paths[0]
            entry.chmod(entry.stat().st_mode | 0o111)
            project = tempdir / "projects"
            project.mkdir()
            run_logged([str(entry), str(project), "DSHCloud",
                        "-import", str(target),
                        "-analysisTimeoutPerFile", "420",
                        "-deleteProject"], output / "execution.log", timeout=750)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["validate", "analyze"])
    ap.add_argument("--root", default=".")
    ap.add_argument("--input-path", required=True)
    ap.add_argument("--task", choices=TASKS)
    ap.add_argument("--output", default="dsh-cloud-output")
    args = ap.parse_args()
    target = validate_input(args.root, args.input_path)
    if args.command == "validate":
        print("DSH_CLOUD_INPUT_OK", target.relative_to(Path(args.root).resolve()))
        if os.getenv("GITHUB_ENV"):
            with open(os.environ["GITHUB_ENV"], "a", encoding="utf8") as f:
                f.write("DSH_VALID_TARGET=" + str(target) + "\n")
        return
    if not args.task:
        ap.error("--task is required for analyze")
    analyze(args.task, target, args.output)
    print("DSH_CLOUD_TASK_COMPLETE", args.task)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError) as error:
        print("DSH_CLOUD_ANALYSIS_FAILED:", type(error).__name__,
              str(error)[:400], file=sys.stderr)
        sys.exit(1)
