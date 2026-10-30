#!/usr/bin/env python3
"""Positive and negative runtime archive tests, no Android device required."""
import importlib.util
import io
import json
import os
import pathlib
import tarfile
import tempfile

source = pathlib.Path(__file__).with_name('ci-validate-runtime.py')
spec = importlib.util.spec_from_file_location('dsh_runtime_validator', source)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

def archive_file(file, contents):
    with tarfile.open(file, 'w:xz') as archive:
        for name, payload in contents.items():
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            archive.addfile(info, io.BytesIO(payload))

with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    lock = root / 'lock.json'
    lock.write_text(json.dumps({'version': '0.1.5-rc.2'}))
    elf = bytearray(128)
    elf[:4] = b'\x7fELF'
    elf[18:20] = (183).to_bytes(2, 'little')
    data = {path: b'dummy' for path in mod.REQUIRED}
    data['usr/bin/node'] = bytes(elf)
    data['usr/lib/node_modules/@deepseek-ai/dsh/package.json'] = b'{"version":"0.1.5-rc.2"}'
    data['usr/lib/random-fill'] = os.urandom(1024 * 1024 + 1)
    snapshot = root / 'snapshot.tar.xz'
    archive_file(snapshot, data)
    assert mod.validate(snapshot, lock)['checked_paths'] == len(mod.REQUIRED)
    negatives = [
        None,
        {k: v for k,v in data.items() if k != 'usr/libexec/dsh-mobile/toolbox-mcp.mjs'},
        {**data, 'usr/bin/node': bytes(128)},
        {**data, 'usr/lib/node_modules/@deepseek-ai/dsh/package.json': b'{"version":"9.9.9"}'},
        {**data, '../traversal': b'unsafe'},
    ]
    for index, case in enumerate(negatives, 1):
        if case is None:
            snapshot.write_bytes(b'ci-runtime-placeholder\n')
        else:
            archive_file(snapshot, case)
        try:
            mod.validate(snapshot, lock)
        except (ValueError, tarfile.TarError):
            continue
        raise AssertionError('validator unexpectedly accepted negative case ' + str(index))
    print('CI runtime archive verifier: 6/6 PASS')
