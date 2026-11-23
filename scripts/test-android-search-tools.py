#!/usr/bin/env python3
"""Contract checks for Android ARM64 rg/fd/fzf packaging and noexec-safe dispatch."""
import ast
from pathlib import Path

root=Path(__file__).resolve().parent.parent
builder=(root/"scripts/ci-assemble-github-runtime.py").read_text()
validator=(root/"scripts/ci-validate-runtime.py").read_text()
bash_env=(root/"scripts/dsh-android-bash-env.sh").read_text()
bridge=(root/"scripts/dsh-android-exec.sh").read_text()
mobile=(root/"scripts/dsh-android-tool-spawn.mjs").read_text()
engine=(root/"app/src/main/java/com/dshmobile/shell/EngineManager.kt").read_text()
workflow=(root/".github/workflows/validate-arm64-git-gh.yml").read_text()
main=(root/".github/workflows/build-arm64-dsh.yml").read_text()

assign={}
for expr in ast.parse(builder).body:
    if isinstance(expr, ast.Assign):
        for target in expr.targets:
            if isinstance(target, ast.Name) and target.id in ("TOOL_SEEDS","TOOL_COMMANDS"):
                assign[target.id]=ast.literal_eval(expr.value)
for package in ("ripgrep","fd","fzf"):
    assert package in assign["TOOL_SEEDS"], "missing Termux package "+package
for name in ("rg","fd","fzf"):
    assert name in assign["TOOL_COMMANDS"], "missing CLI "+name
    assert "'usr/bin/"+name+"'" in validator, "missing archive contract "+name
    assert 'missing ARM64 search tool' in builder
    assert 'search tool is not ARM64 ELF' in builder
for resource in ("usr/share/fzf/key-bindings.bash","usr/share/fzf/completion.bash","usr/bin/fzf-tmux"):
    assert resource in validator and resource in builder, "missing fzf resource "+resource
assert 'DSH_ANDROID_STANDALONE:-' in bash_env
assert 'command_not_found_handle()' in bash_env
assert 'DSH_WRAPPER_COMMAND="$_dsh_name"' in bash_env
assert '_dsh_mobile_dispatch "$_dsh_cmd" "$@"' in bash_env
assert 'PATH=/system/bin:/system/xbin' in bridge
assert "androidToolLaunch(" in mobile
assert "['rg','fd','fzf'].includes(command)" in mobile
assert "resolve(prefix,'bin',command)" in mobile
assert '"DSH_RG_PATH"' in engine
for name in ("ripgrep","fd","fzf"):
    assert "'"+name+"'" in workflow, "ARM64 native package smoke misses "+name
assert "test-android-search-tools.py" in main
assert "test-android-search-tools.py" in workflow
ast.parse(validator)
print("[DSH] rg/fd/fzf ARM64 package+resources+noexec bridge contracts: OK")
