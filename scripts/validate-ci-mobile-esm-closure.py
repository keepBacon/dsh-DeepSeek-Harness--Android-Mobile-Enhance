#!/usr/bin/env python3
"""Validate every local ESM import shipped by the GitHub ARM64 runtime builder.

Fail before APK assembly if toolbox-mcp.mjs imports a sibling module omitted
from SCRIPT_MAP, runtime archive REQUIRED, or Android extraction health checks.
"""
import ast
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent
source = (ROOT / 'scripts/ci-assemble-github-runtime.py').read_text()
runtime = (ROOT / 'scripts/ci-validate-runtime.py').read_text()
android = (ROOT / 'app/src/main/java/com/dshmobile/shell/EngineManager.kt').read_text()
builder = ast.parse(source)
mapping = next(ast.literal_eval(node.value) for node in builder.body
               if isinstance(node, ast.Assign)
               and any(isinstance(t, ast.Name) and t.id == 'SCRIPT_MAP' for t in node.targets))
shipped = {dst for dst in mapping.values()}
errors = []
for src, dst in mapping.items():
    file = ROOT / 'scripts' / src
    if not file.is_file():
        errors.append(f'missing source {src}')
        continue
    if not src.endswith('.mjs'):
        continue
    text = file.read_text()
    imports = re.findall(r'''(?:from\s*|import\s*\(\s*)['"]\./([^'"\n]+)['"]''', text)
    for item in imports:
        dep = (Path(dst).parent / item).as_posix()
        if dep not in shipped:
            errors.append(f'{dst} imports {dep}, missing from SCRIPT_MAP')
for module in sorted(shipped):
    if not module.endswith('.mjs'):
        continue
    pathname = 'usr/libexec/dsh-mobile/' + module
    if repr(pathname) not in runtime:
        errors.append(f'{pathname} missing from ci-validate-runtime REQUIRED')
    if pathname not in android:
        errors.append(f'{pathname} missing from EngineManager health checks')
if errors:
    raise SystemExit('ARM64 MCP ESM closure failed:\n' + '\n'.join(errors))
print(f'[OK] ARM64 MCP ESM import closure: {len(shipped)} mapped files, all validated')
