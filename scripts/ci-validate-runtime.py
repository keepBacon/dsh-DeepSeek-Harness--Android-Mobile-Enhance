#!/usr/bin/env python3
"""Read-only validation of an Android/Termux DSH runtime; never run binaries on Linux."""
import argparse
import hashlib
import json
import pathlib
import sys
import tarfile

REQUIRED = (
    'usr/bin/node',
    'usr/bin/bash',
    'usr/bin/proot',
    'usr/lib/libtermux-exec-ld-preload.so',
    'usr/lib/node_modules/@deepseek-ai/dsh/package.json',
    'usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    'usr/libexec/dsh-mobile/android-sandbox-runner.sh',
    'usr/libexec/dsh-mobile/toolbox-mcp.mjs',
    'usr/libexec/dsh-mobile/dsh-code-engine.mjs',
    'usr/libexec/dsh-mobile/dsh-code-engine-v3.mjs',
    'usr/libexec/dsh-mobile/dsh-code-engine-v4.mjs',
    'usr/libexec/dsh-mobile/dsh-code-engine-ast.mjs',
    'usr/libexec/dsh-mobile/dsh-code-engine-workflow.mjs',
    'usr/libexec/dsh-mobile/dsh-code-engine-journal.mjs',
    'usr/libexec/dsh-mobile/basic-toolbox-mcp.mjs',
    'usr/libexec/dsh/wrappers/python3',
    'usr/libexec/dsh/wrappers/pip3',
    'usr/libexec/dsh/wrappers/pkg',
    'usr/libexec/dsh/wrappers/apt',
    'usr/libexec/dsh/wrappers/dpkg',
)

def validate(snapshot: pathlib.Path, lock: pathlib.Path):
    if not snapshot.is_file() or snapshot.stat().st_size < 1024 * 1024:
        raise ValueError('missing or tiny runtime snapshot; placeholder APK forbidden')
    expected = json.loads(lock.read_text(encoding='utf-8'))['version']
    sha = hashlib.sha256()
    with snapshot.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            sha.update(chunk)
    found, package, node_aarch64, count = set(), None, False, 0
    with tarfile.open(snapshot, 'r:xz') as archive:
        for member in archive:
            count += 1
            name = member.name
            while name.startswith('./'):
                name = name[2:]
            if not name or name.startswith('/') or '\\' in name or '..' in pathlib.PurePosixPath(name).parts:
                raise ValueError('unsafe archive entry: ' + repr(member.name))
            if name in REQUIRED and (member.isfile() or member.issym() or member.islnk()):
                found.add(name)
            if name == 'usr/lib/node_modules/@deepseek-ai/dsh/package.json':
                if not member.isfile() or member.size > 1024 * 1024:
                    raise ValueError('invalid DSH package manifest')
                package = json.load(archive.extractfile(member))
            if name == 'usr/bin/node' and member.isfile():
                header = archive.extractfile(member).read(20)
                node_aarch64 = (len(header) >= 20 and header[:4] == b'\x7fELF'
                                and int.from_bytes(header[18:20], 'little') == 183)
    missing = sorted(set(REQUIRED) - found)
    if missing:
        raise ValueError('missing native runtime files: ' + ', '.join(missing))
    if not node_aarch64:
        raise ValueError('embedded Node must be an AArch64 ELF')
    actual = package.get('version') if isinstance(package, dict) else None
    if actual != expected:
        raise ValueError(f'DSH version mismatch: snapshot {actual}, repository lock {expected}')
    return {'dsh_version': actual, 'runtime_sha256': sha.hexdigest(),
            'snapshot_size': snapshot.stat().st_size, 'archive_entries': count,
            'checked_paths': len(REQUIRED), 'node_abi': 'ELF-AArch64',
            'verification_level': 'host-side archive integrity; native Android smoke still needed'}

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--snapshot', required=True, type=pathlib.Path)
    p.add_argument('--lock', required=True, type=pathlib.Path)
    p.add_argument('--output', type=pathlib.Path)
    a = p.parse_args()
    try:
        result = validate(a.snapshot, a.lock)
        if a.output:
            a.output.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
        print('[DSH runtime] PASS:', json.dumps(result))
        return 0
    except (ValueError, OSError, tarfile.TarError, json.JSONDecodeError) as error:
        print('[DSH runtime] FAIL:', str(error), file=sys.stderr)
        return 2

if __name__ == '__main__':
    sys.exit(main())
