#!/usr/bin/env python3
"""Package a verified signed APK with independently checkable direct/ZIP downloads.

The APK is already a ZIP container: store it without another compression layer.
This script performs a real CRC check of the APK, a CRC check of the outer ZIP,
and a SHA-256 comparison of the unpacked APK to the original signed bytes.
"""
import argparse
import hashlib
import shutil
import zipfile
from pathlib import Path

BLOCK = 1024 * 1024


def digest_stream(stream):
    h = hashlib.sha256()
    while chunk := stream.read(BLOCK):
        h.update(chunk)
    return h.hexdigest()


def digest_file(path):
    with path.open("rb") as stream:
        return digest_stream(stream)


def inspect_apk(path):
    if not zipfile.is_zipfile(path):
        raise RuntimeError(f"APK is not a valid ZIP container: {path}")
    with zipfile.ZipFile(path) as archive:
        damaged = archive.testzip()
        if damaged is not None:
            raise RuntimeError(f"APK contains a damaged member: {damaged}")
        names = set(archive.namelist())
        if "AndroidManifest.xml" not in names or not any(
            name.endswith(".dex") for name in names
        ):
            raise RuntimeError("APK lacks AndroidManifest.xml or DEX bytecode")
        return len(names)


def package(apk, output, basename):
    apk = apk.resolve(strict=True)
    output.mkdir(parents=True, exist_ok=True)
    if not basename or "/" in basename or "\\" in basename:
        raise ValueError("basename must be a plain filename")

    direct_apk = output / f"{basename}.apk"
    outer_zip = output / f"{basename}.zip"
    checksum = output / "SHA256SUMS.txt"
    inner_checksum = f"{basename}.apk.sha256"

    print("[package] checking original APK CRC", flush=True)
    members = inspect_apk(apk)
    original_sha = digest_file(apk)
    shutil.copyfile(apk, direct_apk)
    if digest_file(direct_apk) != original_sha:
        raise RuntimeError("APK copy checksum mismatch")

    print("[package] generating ZIP_STORED archive", flush=True)
    with zipfile.ZipFile(outer_zip, "w", allowZip64=True) as archive:
        archive.write(direct_apk, direct_apk.name, compress_type=zipfile.ZIP_STORED)
        archive.writestr(
            inner_checksum, f"{original_sha}  {direct_apk.name}\n",
            compress_type=zipfile.ZIP_STORED,
        )

    print("[package] verifying outer ZIP and its extracted APK", flush=True)
    with zipfile.ZipFile(outer_zip) as archive:
        damaged = archive.testzip()
        if damaged is not None:
            raise RuntimeError(f"Distribution ZIP damaged: {damaged}")
        with archive.open(direct_apk.name) as extracted:
            if digest_stream(extracted) != original_sha:
                raise RuntimeError("Extracted APK checksum differs from signed APK")
        expected_checksum = f"{original_sha}  {direct_apk.name}\n"
        if archive.read(inner_checksum).decode() != expected_checksum:
            raise RuntimeError("Embedded checksum differs from APK")

    zip_sha = digest_file(outer_zip)
    checksum.write_text(
        f"{original_sha}  {direct_apk.name}\n{zip_sha}  {outer_zip.name}\n",
        encoding="utf-8",
    )
    print(f"[package] OK: {members} APK entries; SHA256 APK={original_sha}")
    print(f"[package] OK: ZIP SHA256={zip_sha}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apk", required=True, type=Path)
    ap.add_argument("--output", required=True, type=Path)
    ap.add_argument("--basename", required=True)
    args = ap.parse_args()
    package(args.apk, args.output, args.basename)


if __name__ == "__main__":
    main()
