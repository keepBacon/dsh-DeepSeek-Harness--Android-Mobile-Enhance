#!/usr/bin/env python3
"""Verify the current DSH APK before uploading its installable artifact.

Enforces the screenshot-verified signing certificate, the unchanged Android
package ID, increased versionCode and exact archived runtime digest. No APK
gets uploaded if any check fails. Does not touch the user's phone/data.
"""
import argparse
import hashlib
import pathlib
import re
import subprocess
import sys
import zipfile

EXPECTED_PACKAGE = "com.dshmobile.shell"
EXPECTED_CERT = "0dfb924793215056c19d413987c9858b8aa9d90604ffb18d60cfd75be0697792"


def command(args):
    proc = subprocess.run(args, text=True, capture_output=True, check=False)
    if proc.returncode:
        detail = (proc.stderr or proc.stdout).strip()
        raise ValueError(f"{pathlib.Path(args[0]).name} failed: {detail[-1400:]}")
    return proc.stdout


def verify(apk, snapshot, aapt, apksigner, version_code):
    if not apk.is_file() or apk.stat().st_size < 1024 * 1024:
        raise ValueError("APK missing or unexpectedly small")
    output = command([str(apksigner), "verify", "--verbose", "--print-certs", str(apk)])
    digests = re.findall(
        r"^Signer #\d+ certificate SHA-256 digest:\s*([0-9a-fA-F]{64})\s*$",
        output, flags=re.MULTILINE,
    )
    if len(digests) != 1:
        raise ValueError(
            "expected one verified APK signer; found "
            f"{len(digests)} signer certificate digests. "
            f"apksigner stdout summary: {output[:1400].strip()}"
        )
    actual_cert = digests[0].lower()
    print("Verified APK signer SHA256:", actual_cert, flush=True)
    if actual_cert != EXPECTED_CERT:
        raise ValueError(
            f"APK signer mismatch: expected {EXPECTED_CERT}, got {actual_cert}. "
            "The APK cannot update the installed DSH."
        )

    badging = command([str(aapt), "dump", "badging", str(apk)])
    package_line = next((line for line in badging.splitlines() if line.startswith("package: ")), "")
    package = re.search(r"\bname='([^']+)'", package_line)
    code = re.search(r"\bversionCode='(\d+)'", package_line)
    if not package or not code:
        raise ValueError(f"aapt could not parse APK package line: {package_line[:300]}")
    print("Verified Android identity:", package.group(1), "versionCode:", code.group(1), flush=True)
    if package.group(1) != EXPECTED_PACKAGE or int(code.group(1)) != version_code:
        raise ValueError(
            f"wrong package/version: {package.group(1)} / {code.group(1)}, "
            f"expected {EXPECTED_PACKAGE} / {version_code}"
        )

    if not snapshot.is_file() or snapshot.stat().st_size < 1024 * 1024:
        raise ValueError("missing full native runtime input")
    sha = hashlib.sha256()
    with snapshot.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            sha.update(block)
    expected_sha = sha.hexdigest()
    archive_sha = hashlib.sha256()
    with zipfile.ZipFile(apk, "r") as archive:
        with archive.open("assets/snapshot.tar.xz", "r") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                archive_sha.update(block)
        marker = archive.read("assets/runtime-version.txt").decode("utf-8")
    print("Verified embedded runtime SHA256:", archive_sha.hexdigest(), flush=True)
    if archive_sha.hexdigest() != expected_sha:
        raise ValueError("embedded APK runtime differs from verified ARM64 archive")
    if f"sha256={expected_sha}" not in marker.splitlines():
        raise ValueError("embedded runtime identity marker missing/mismatched")
    print("DSH APK CERT / PACKAGE / VERSION / RUNTIME: PASS", flush=True)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--apk", type=pathlib.Path, required=True)
    p.add_argument("--snapshot", type=pathlib.Path, required=True)
    p.add_argument("--aapt", type=pathlib.Path, required=True)
    p.add_argument("--apksigner", type=pathlib.Path, required=True)
    p.add_argument("--version-code", type=int, required=True)
    args = p.parse_args()
    try:
        verify(args.apk, args.snapshot, args.aapt, args.apksigner, args.version_code)
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        print("DSH APK verification FAIL:", error, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
