#!/usr/bin/env python3
"""Contract checks for signed ARM64 Git / GitHub CLI packaging.

This is build-time validation, NOT proof of Android Git HTTPS subprocess
execution. The signed device smoke test must cover clone/fetch/push as well.
"""
from pathlib import Path
import ast
import re

root = Path(__file__).resolve().parent.parent
builder_text = (root / "scripts/ci-assemble-github-runtime.py").read_text()
validator_text = (root / "scripts/ci-validate-runtime.py").read_text()
engine_text = (root / "app/src/main/java/com/dshmobile/shell/EngineManager.kt").read_text()
shell_text = (root / "scripts/dsh-android-bash-env.sh").read_text()
workflow = (root / ".github/workflows/build-arm64-dsh.yml").read_text()

tree = ast.parse(builder_text)
assignments = {name.id: ast.literal_eval(node.value)
               for node in tree.body if isinstance(node, ast.Assign)
               for name in node.targets if isinstance(name, ast.Name)
               and name.id in ("TOOL_SEEDS", "TOOL_COMMANDS")}
for cmd in ("git", "gh", "openssh", "ca-certificates"):
    assert cmd in assignments["TOOL_SEEDS"], "missing Termux package " + cmd
for cmd in ("git", "gh", "ssh"):
    assert cmd in assignments["TOOL_COMMANDS"], "missing required CLI " + cmd
    assert "'usr/bin/" + cmd + "'" in validator_text, "signed archive does not require " + cmd
assert "git-remote-https" in builder_text and "git-remote-https" in validator_text
assert "HTTPS CA bundle missing" in builder_text
assert "HTTPS CA trust bundle" in validator_text
assert "AArch64 ELF" in builder_text
assert "GH_CONFIG_DIR" in engine_text and 'chmod(absolutePath, 448)' in engine_text
assert '"GH_PAGER" to "cat"' in engine_text
assert '"GH_NO_UPDATE_NOTIFIER" to "1"' in engine_text
assert '"GIT_TERMINAL_PROMPT" = "0"' not in engine_text  # do not use incorrect Kotlin env mutation
assert 'env["GIT_TERMINAL_PROMPT"] = "0"' in engine_text
assert '"GIT_SSL_CAINFO"' in engine_text
assert '"GIT_EXEC_PATH"' in engine_text
assert '"GIT_CONFIG_SYSTEM"' in engine_text
assert '"GIT_SSH_COMMAND"' in engine_text
assert 'GH_TOKEN' not in engine_text
assert 'GH_TOKEN' not in builder_text
assert "command_not_found_handle()" in shell_text  # no direct exec of app-private wrappers
assert "ci-assemble-github-runtime.py" in workflow
assert "test-android-git-gh-runtime.py" in workflow
ast.parse(validator_text)
print("[DSH] Git/GitHub CLI ARM64 package, CA, transport, user auth config & noexec route: OK")
