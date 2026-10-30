#!/usr/bin/env python3
"""Restore the exact existing DSH Android debug signing key from GitHub Actions.

Never print or upload the key. Ignore only copy/paste whitespace in base64;
a truncated or malformed secret must fail, never generate a replacement key.
"""
import argparse
import base64
import binascii
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def decode_secret(raw: str) -> bytes:
    if not raw:
        raise ValueError(
            "GitHub Secret DSH_LEGACY_DEBUG_KEYSTORE_B64 is missing or empty"
        )
    # GitHub's mobile editor may insert line breaks or spaces when pasted.
    compact = "".join(raw.split())
    if not compact:
        raise ValueError("Signing secret contains no Base64 data")
    try:
        data = base64.b64decode(compact, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValueError(
            "Signing secret is not valid Base64. Re-copy the COMPLETE "
            "original ~/.android/debug.keystore as one Base64 string "
            "and replace DSH_LEGACY_DEBUG_KEYSTORE_B64 in GitHub Settings."
        ) from exc
    # A typical Android debug keystore is only a few KiB. This catches
    # accidentally pasted URLs, snippets, and most truncated clipboard data.
    if not 1024 <= len(data) <= 256 * 1024:
        raise ValueError(
            "Decoded keystore size is implausible; check the original "
            "keystore and recopy its entire Base64 representation"
        )
    if base64.b64encode(data).decode("ascii") != compact:
        raise ValueError("Non-canonical or incomplete Base64 secret")
    return data


def verify_certificate(file: Path, expected: str) -> str:
    expected = expected.lower().replace(":", "")
    if len(expected) != 64 or any(x not in "0123456789abcdef" for x in expected):
        raise ValueError("Invalid expected certificate SHA256")
    result = subprocess.run(
        [
            "keytool", "-exportcert",
            "-keystore", str(file),
            "-storepass", "android",
            "-alias", "androiddebugkey",
        ],
        capture_output=True,
        check=False,
    )
    if result.returncode != 0 or not result.stdout:
        raise ValueError(
            "Decoded bytes are not the original Android debug keystore "
            "(expected alias androiddebugkey and store password android)."
        )
    actual = hashlib.sha256(result.stdout).hexdigest()
    if actual != expected:
        raise ValueError(
            "Decoded keystore certificate does not match the installed "
            "DSH APK. Refusing to build an APK that could not update it."
        )
    return actual


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        sample = bytes(range(256)) * 9
        encoded = base64.b64encode(sample).decode("ascii")
        assert decode_secret(encoded) == sample
        assert decode_secret(encoded[:120] + "\n \t" + encoded[120:]) == sample
        for bad in ("", "not a secret", encoded[:-1], encoded + "%"):
            try:
                decode_secret(bad)
            except ValueError:
                pass
            else:
                raise AssertionError("Accepted malformed Base64 fixture")
        print("Signing Base64 strict parser: PASS")
        return 0

    try:
        data = decode_secret(os.getenv("DSH_LEGACY_DEBUG_KEYSTORE_B64", ""))
        key_dir = Path.home() / ".android"
        key_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".dsh-signing-", dir=key_dir)
        candidate = Path(temporary)
        try:
            with os.fdopen(fd, "wb") as stream:
                os.fchmod(stream.fileno(), 0o600)
                stream.write(data)
            cert = verify_certificate(candidate, args.expected_sha256)
            if not args.check_only:
                os.replace(candidate, key_dir / "debug.keystore")
            print(
                "DSH legacy certificate verified: " + cert +
                (" (preflight only)" if args.check_only else " (key installed for Gradle)")
            )
        finally:
            candidate.unlink(missing_ok=True)
        return 0
    except (ValueError, OSError) as error:
        print("[DSH signing] FAIL: " + str(error), file=sys.stderr)
        return 12


if __name__ == "__main__":
    sys.exit(main())
