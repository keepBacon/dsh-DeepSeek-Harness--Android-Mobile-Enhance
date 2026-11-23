#!/usr/bin/env python3
"""Fail-closed, read-only archive inspection, not an Android native smoke test."""
import argparse, hashlib, json, pathlib, re, sys, tarfile

# The shipped Web UI and model tool bridge must be present in the actual
# archive, not just in the CI runner's separately-resolved NPM graph.
REQUIRED_RUNTIME_PACKAGES = (
 '@deepseek-ai/dsh',
 '@deepseek-ai/dsh-client-ui-plugin-manager',
 '@deepseek-ai/dsh-mcp-client',
 '@deepseek-ai/dsh-tools',
 '@deepseek-ai/cordis',
 '@deepseek-ai/schemastery',
)


def verify_family_identity(family, bundled_family, installed, compat, install_lock_sha,
                           expected_version=None, expected_commit=None):
 """Read-only release provenance check over the *archived* runtime inventory."""
 if family.get('schema') != 2 or not isinstance(family.get('packages'), list):
  raise ValueError('invalid DSH release-family lock')
 version=family.get('version')
 if not isinstance(version,str) or not version:
  raise ValueError('release-family version missing')
 if expected_version is not None and version!=expected_version:
  raise ValueError('build target DSH version mismatch: '+str(version)+'; expected '+expected_version)
 if bundled_family!=family:
  raise ValueError('packaged DSH release-family lock differs from build input')
 if not isinstance(installed,dict):
  raise ValueError('packaged DSH module manifest inventory missing')
 if not isinstance(compat,dict):
  raise ValueError('packaged Android DSH compatibility manifest missing')
 if not isinstance(install_lock_sha,str) or len(install_lock_sha)!=64:
  raise ValueError('packaged npm install lock missing')
 packages=set(family['packages'])
 vendors=family.get('vendorPackages')
 if not isinstance(vendors,dict) or '@deepseek-ai/cordis' not in vendors:
  raise ValueError('incomplete Cordis vendor release lock')
 for name in REQUIRED_RUNTIME_PACKAGES:
  if name not in installed:
   raise ValueError('packaged runtime missing required plugin package: '+name)
 checked=0
 for name,manifest in installed.items():
  if not isinstance(manifest,dict) or manifest.get('name')!=name:
   raise ValueError('packaged manifest name mismatch: '+name)
  if name=='@deepseek-ai/dsh' or name.startswith('@deepseek-ai/dsh-'):
   if name not in packages:
    raise ValueError('packaged DSH module absent from release family: '+name)
   expected=version
  elif name in vendors:
   expected=vendors[name]
  else:
   continue
  if manifest.get('version')!=expected:
   raise ValueError('packaged module version skew: '+name+'@'+str(manifest.get('version'))+'; expected '+str(expected))
  checked+=1
 # Pin a real published graph, not a leftover handful of old seed modules.
 if checked<200:
  raise ValueError('packaged DSH release graph is incomplete: '+str(checked)+' validated modules')
 if compat.get('dsh')!=version:
  raise ValueError('packaged Android compatibility version does not match DSH')
 if expected_commit is not None and compat.get('dshSourceCommit')!=expected_commit:
  raise ValueError('packaged DSH source commit differs from pinned upstream')
 if compat.get('dshReleaseFamilyLocked') is not True or compat.get('cordisVendorLocked') is not True:
  raise ValueError('packaged Android runtime lacks verified family/vendor flags')
 if compat.get('dshNpmLockSha256')!=install_lock_sha:
  raise ValueError('packaged npm install lock SHA256 differs from Android metadata')
 return checked


REQUIRED = (
 'usr/bin/node','usr/bin/npm','usr/bin/npx','usr/bin/pnpm',
 'usr/lib/node_modules/npm/package.json',
 'usr/lib/node_modules/npm/bin/npm-cli.js',
 'usr/lib/node_modules/npm/bin/npx-cli.js',
 'usr/lib/node_modules/pnpm/package.json',
 'usr/bin/bash','usr/bin/proot',
 'usr/bin/git','usr/bin/gh','usr/bin/ssh',
 'usr/bin/rg','usr/bin/fd','usr/bin/fzf',
 'usr/bin/fzf-tmux', 'usr/share/fzf/key-bindings.bash',
 'usr/share/fzf/completion.bash',
 'usr/lib/libtermux-exec-ld-preload.so',
 'usr/lib/libc++_shared.so',
 'usr/bin/apt','usr/bin/apt-get','usr/bin/apt-cache','usr/bin/apt-config',
 'usr/bin/clang','usr/bin/clang++','usr/bin/make','usr/bin/cmake',
 'usr/bin/ninja','usr/bin/ld.lld','usr/bin/pkg-config',
 'usr/bin/cc','usr/bin/c++','usr/bin/gcc','usr/bin/g++',
 'usr/bin/qemu-x86_64',
 'usr/bin/lua-language-server',
 'usr/lib/node_modules/@deepseek-ai/dsh/package.json',
 'usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
 'usr/lib/node_modules/@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js',
 'usr/lib/dsh-release-family.json',
 'usr/lib/dsh-release-install-lock.json',
 'usr/etc/dsh-android-compat.json',
 'usr/libexec/dsh-mobile/android-sandbox-runner.sh',
 'usr/libexec/dsh-mobile/android-exec.sh',
 'usr/libexec/dsh-mobile/dsh-android-plugin-git-spawn.cjs',
 'usr/libexec/dsh-mobile/android-bash-env.sh',
 'usr/libexec/dsh-mobile/dsh-android-python-subprocess.py',
 'usr/libexec/dsh-mobile/toolbox-mcp.mjs',
 'usr/libexec/dsh-mobile/dsh-inspector-tools.mjs',
 'usr/libexec/dsh-mobile/dsh-project-language.mjs',
 'usr/libexec/dsh-mobile/dsh-project-index.mjs',
 'usr/libexec/dsh-mobile/dsh-workspace-lsp.mjs',
 'usr/libexec/dsh-mobile/dsh-lsp-session.mjs',
 'usr/libexec/dsh-mobile/dsh-workspace-files.mjs',
 'usr/libexec/dsh-mobile/dsh-project-build.mjs',
 'usr/libexec/dsh-mobile/dsh-dev-plan.mjs',
 'usr/libexec/dsh-mobile/dsh-android-tool-spawn.mjs',
 'usr/libexec/dsh-mobile/dsh-toolchain-probe.mjs',
 'usr/libexec/dsh-mobile/dsh-bounded-spawn.mjs',
 'usr/libexec/dsh-mobile/dsh-dev-process.mjs',
 'usr/libexec/dsh-mobile/dsh-dev-tasks.mjs',
 'usr/libexec/dsh-mobile/dsh-web-page-reader.mjs',
 'usr/share/dsh-modsearch-recovery/node_modules/@liustack/modsearch/dist/main.js',
 'usr/share/dsh-modsearch-recovery/node_modules/commander/package.json',
 'usr/share/dsh-modsearch-recovery/node_modules/undici/package.json',
 'usr/libexec/dsh-mobile/dsh-code-engine.mjs',
 'usr/libexec/dsh-mobile/dsh-code-engine-v3.mjs',
 'usr/libexec/dsh-mobile/dsh-code-engine-v4.mjs',
 'usr/libexec/dsh-mobile/dsh-code-engine-ast.mjs',
 'usr/libexec/dsh-mobile/dsh-code-engine-workflow.mjs',
 'usr/libexec/dsh-mobile/dsh-code-engine-journal.mjs',
 'usr/libexec/dsh-mobile/dsh-lua-tools.mjs',
 'usr/libexec/dsh-mobile/dsh-lua-case.mjs',
 'usr/libexec/dsh-mobile/dsh-lua-analysis-core.mjs',
 'usr/libexec/dsh-mobile/dsh-luau-runner.mjs',
 'usr/lib/dsh-dev-tools/node_modules/pyright/langserver.index.js',
 'usr/lib/dsh-dev-tools/node_modules/luau-web/src/index.js',
 'usr/lib/dsh-dev-tools/node_modules/luau-web/src/lib/Luau.Web.Asyncify.js',
 'usr/lib/dsh-dev-tools/node_modules/luau-web/src/lib/Luau.Web.JSPI.js',
 'usr/libexec/dsh-mobile/basic-toolbox-mcp.mjs',
 'usr/libexec/dsh/wrappers/python3',
 'usr/libexec/dsh/wrappers/pip3',
 'usr/libexec/dsh/wrappers/pkg',
 'usr/libexec/dsh/wrappers/apt',
 'usr/libexec/dsh/wrappers/dpkg',
)
def validate(snapshot, lock, expected_version=None, expected_commit=None):
 if not snapshot.is_file() or snapshot.stat().st_size < 1024*1024:
  raise ValueError('missing or placeholder runtime archive')
 family=json.loads(lock.read_text())
 version=family['version']
 found=set()
 pnpm_entrypoint=False
 npm_manifest=None
 package=None
 arch=False
 entries=0
 verified_provider=0
 verified_renderer=0
 packaged_family=None
 installed={}
 compat=None
 install_lock_sha=None
 with tarfile.open(snapshot,'r:xz') as f:
  for member in f:
   entries+=1
   name=member.name
   while name.startswith('./'): name=name[2:]
   if name.startswith('/') or '\\' in name or '..' in pathlib.PurePosixPath(name).parts:
    raise ValueError('unsafe archive entry: '+name)
   if name in REQUIRED and (member.isfile() or member.issym() or member.islnk()): found.add(name)
   if name in (
    'usr/libexec/git-core/git-remote-https','usr/lib/git-core/git-remote-https',
    'usr/etc/tls/cert.pem','usr/etc/ssl/cert.pem','usr/etc/ssl/certs/ca-certificates.crt'
   ) and (member.isfile() or member.issym() or member.islnk()): found.add(name)
   if name in (
    'usr/lib/node_modules/pnpm/bin/pnpm.cjs',
    'usr/lib/node_modules/pnpm/bin/pnpm.mjs',
    'usr/lib/node_modules/pnpm/bin/pnpm.js'
   ) and member.isfile(): pnpm_entrypoint=True
   if name=='usr/lib/node_modules/npm/package.json':
    if not member.isfile() or member.size>1024*1024: raise ValueError('bad npm manifest')
    npm_manifest=json.load(f.extractfile(member))
   if name=='usr/lib/node_modules/@deepseek-ai/dsh/package.json':
    if not member.isfile() or member.size>1024*1024: raise ValueError('bad DSH manifest')
    package=json.load(f.extractfile(member))
   if re.fullmatch(r'usr/lib/node_modules/@deepseek-ai/[^/]+/package\.json',name):
    if not member.isfile() or member.size>1024*1024:
     raise ValueError('invalid archived DSH package manifest: '+name)
    obj=json.load(f.extractfile(member))
    module='@deepseek-ai/'+name.split('/')[4]
    if module in installed: raise ValueError('duplicate archived DSH manifest: '+module)
    installed[module]=obj
   if name=='usr/lib/dsh-release-family.json':
    if not member.isfile() or member.size>8*1024*1024: raise ValueError('invalid embedded family lock')
    packaged_family=json.load(f.extractfile(member))
   if name=='usr/lib/dsh-release-install-lock.json':
    if not member.isfile() or member.size>32*1024*1024: raise ValueError('invalid embedded install lock')
    install_lock_sha=hashlib.sha256(f.extractfile(member).read()).hexdigest()
   if name=='usr/etc/dsh-android-compat.json':
    if not member.isfile() or member.size>1024*1024: raise ValueError('invalid Android compat manifest')
    compat=json.load(f.extractfile(member))
   if member.isfile() and name.endswith('/@deepseek-ai/dsh-web-fetch-http/lib/index.js'):
    if member.size>8*1024*1024:raise ValueError('oversized web_fetch provider bundle')
    source=f.extractfile(member).read().decode('utf-8')
    for setting,expected in (('maxBodyChars','400000'),('maxResponseBytes','16777216')):
     if not re.search(re.escape(setting)+r'\s*:\s*z\.number\(\)\.default\(\s*'+expected+r'\s*\)',source):
      raise ValueError('unpatched provider default '+setting+' in '+name)
    verified_provider+=1
   if member.isfile() and name.endswith('/@deepseek-ai/dsh-tool-web/lib/index.js'):
    if member.size>8*1024*1024:raise ValueError('oversized web_fetch tool bundle')
    source=f.extractfile(member).read().decode('utf-8')
    if not re.search(r'\bDEFAULT_FETCH_MAX_OUTPUT_CHARS\s*=\s*400000\b',source):
     raise ValueError('unpatched web_fetch renderer default in '+name)
    verified_renderer+=1
   if name=='usr/bin/node' and member.isfile():
    h=f.extractfile(member).read(20)
    arch=len(h)>=20 and h[:4]==bytes.fromhex('7f454c46') and int.from_bytes(h[18:20],'little')==183
 if not any(name in found for name in (
  'usr/libexec/git-core/git-remote-https', 'usr/lib/git-core/git-remote-https'
 )):
  raise ValueError('missing Git HTTPS transport helper')
 if not any(name in found for name in (
  'usr/etc/tls/cert.pem', 'usr/etc/ssl/cert.pem', 'usr/etc/ssl/certs/ca-certificates.crt'
  )):
  raise ValueError('missing Git HTTPS CA trust bundle')
 if set(REQUIRED)-found: raise ValueError('missing required paths: '+', '.join(sorted(set(REQUIRED)-found)))
 if not arch: raise ValueError('node is not ARM64 ELF')
 if not pnpm_entrypoint: raise ValueError('pnpm JavaScript CLI entrypoint is missing')
 if not isinstance(npm_manifest,dict) or npm_manifest.get('name')!='npm':
  raise ValueError('npm package manifest missing or incorrect')
 # Native seeds can contain neither or only one of these Web-profile modules.
 # Verify every packaged module independently; the Android startup patch
 # covers separately installed profile modules.
 # A Termux native seed can omit Web-profile plugin modules entirely. Those
 # are checked and patched at the real profile's startup path on Android.
 actual=package.get('version') if isinstance(package,dict) else None
 if actual!=version: raise ValueError('runtime DSH version '+str(actual)+' does not match '+version)
 checked_packages=verify_family_identity(
  family,packaged_family,installed,compat,install_lock_sha,
  expected_version=expected_version,expected_commit=expected_commit)
 sha=hashlib.sha256()
 with snapshot.open('rb') as f:
  for block in iter(lambda:f.read(1024*1024),b''):sha.update(block)
 return dict(dsh_version=actual,runtime_sha256=sha.hexdigest(),archive_entries=entries,checked_paths=len(REQUIRED),verified_family_packages=checked_packages,dsh_source_commit=compat.get('dshSourceCommit'),npm_lock_sha256=install_lock_sha,verified_web_fetch_providers=verified_provider,verified_web_fetch_renderers=verified_renderer,verification='archive-only; Android execution not tested')
if __name__=='__main__':
 p=argparse.ArgumentParser()
 p.add_argument('--snapshot',type=pathlib.Path,required=True)
 p.add_argument('--lock',type=pathlib.Path,required=True)
 p.add_argument('--expected-version')
 p.add_argument('--expected-commit')
 p.add_argument('--output',type=pathlib.Path)
 a=p.parse_args()
 try:
  v=validate(a.snapshot,a.lock,a.expected_version,a.expected_commit)
  if a.output:a.output.write_text(json.dumps(v,indent=2)+'\n')
  print(json.dumps(v))
 except (ValueError,OSError,tarfile.TarError,json.JSONDecodeError) as e:
  print('Runtime FAIL:',e,file=sys.stderr);sys.exit(2)
