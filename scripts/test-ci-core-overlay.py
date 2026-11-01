#!/usr/bin/env python3
"""Contract tests for replacing the inherited core in a staged Android snapshot."""
import importlib.util
import json
import pathlib
import tempfile

source = pathlib.Path(__file__).with_name("ci-assemble-github-runtime.py")
spec = importlib.util.spec_from_file_location("dsh_runtime_assemble", source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

with tempfile.TemporaryDirectory(prefix="dsh-core-overlay-test-") as root:
    base = pathlib.Path(root)
    stage = base / "stage"
    overlay = base / "overlay"
    old = stage / "usr/lib/node_modules/@deepseek-ai/dsh"
    new = overlay / "node_modules/@deepseek-ai/dsh"
    old.mkdir(parents=True)
    new.mkdir(parents=True)
    (old / "package.json").write_text(json.dumps({"name":"@deepseek-ai/dsh","version":"0.1.5-rc.2"}))
    (new / "package.json").write_text(json.dumps({"name":"@deepseek-ai/dsh","version":"0.2.1-rc.5"}))
    def reject(expected):
        try:
            module.upgrade_dsh_core(stage, overlay, expected)
        except ValueError:
            return
        raise AssertionError("core overlay must reject invalid input")
    reject("0.2.2-alpha.2")
    assert json.loads((old / "package.json").read_text())["version"] == "0.1.5-rc.2"
    addon = new / "host-addon.node"
    addon.write_bytes(b"host-native")
    reject("0.2.1-rc.5")
    assert json.loads((old / "package.json").read_text())["version"] == "0.1.5-rc.2"
    addon.unlink()
    module.upgrade_dsh_core(stage, overlay, "0.2.1-rc.5")
    assert json.loads((old / "package.json").read_text())["version"] == "0.2.1-rc.5"
print("[DSH] core overlay version and native addon regression: OK")
