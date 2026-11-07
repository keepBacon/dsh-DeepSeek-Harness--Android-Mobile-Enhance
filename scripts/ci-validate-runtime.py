#!/usr/bin/env python3
"""Fail-closed, read-only archive inspection, not an Android native smoke test."""
import argparse, hashlib, json, pathlib, re, sys, tarfile

REQUIRED = (
 'usr/bin/node','usr/bin/bash','usr/bin/proot',
 'usr/lib/libtermux-exec-ld-preload.so',
 'usr/lib/node_modules/@deepseek-ai/dsh/package.json',
 'usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
 'usr/libexec/dsh-mobile/android-sandbox-runner.sh',
 'usr/libexec/dsh-mobile/toolbox-mcp.mjs',
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
def validate(snapshot, lock):
 if not snapshot.is_file() or snapshot.stat().st_size < 1024*1024:
  raise ValueError('missing or placeholder runtime archive')
 version=json.loads(lock.read_text())['version']
 found=set()
 package=None
 arch=False
 entries=0
 verified_provider=0
 verified_renderer=0
 with tarfile.open(snapshot,'r:xz') as f:
  for member in f:
   entries+=1
   name=member.name
   while name.startswith('./'): name=name[2:]
   if name.startswith('/') or '\\' in name or '..' in pathlib.PurePosixPath(name).parts:
    raise ValueError('unsafe archive entry: '+name)
   if name in REQUIRED and (member.isfile() or member.issym() or member.islnk()): found.add(name)
   if name=='usr/lib/node_modules/@deepseek-ai/dsh/package.json':
    if not member.isfile() or member.size>1024*1024: raise ValueError('bad DSH manifest')
    package=json.load(f.extractfile(member))
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
 if set(REQUIRED)-found: raise ValueError('missing required paths: '+', '.join(sorted(set(REQUIRED)-found)))
 if not arch: raise ValueError('node is not ARM64 ELF')
 if (verified_provider == 0) != (verified_renderer == 0):
  raise ValueError('incomplete provider/renderer package pair in Android snapshot')
 # A Termux native seed can omit Web-profile plugin modules entirely. Those
 # are checked and patched at the real profile's startup path on Android.
 actual=package.get('version') if isinstance(package,dict) else None
 if actual!=version: raise ValueError('runtime DSH version '+str(actual)+' does not match '+version)
 sha=hashlib.sha256()
 with snapshot.open('rb') as f:
  for block in iter(lambda:f.read(1024*1024),b''):sha.update(block)
 return dict(dsh_version=actual,runtime_sha256=sha.hexdigest(),archive_entries=entries,checked_paths=len(REQUIRED),verified_web_fetch_providers=verified_provider,verified_web_fetch_renderers=verified_renderer,verification='archive-only; Android execution not tested')
if __name__=='__main__':
 p=argparse.ArgumentParser()
 p.add_argument('--snapshot',type=pathlib.Path,required=True)
 p.add_argument('--lock',type=pathlib.Path,required=True)
 p.add_argument('--output',type=pathlib.Path)
 a=p.parse_args()
 try:
  v=validate(a.snapshot,a.lock)
  if a.output:a.output.write_text(json.dumps(v,indent=2)+'\n')
  print(json.dumps(v))
 except (ValueError,OSError,tarfile.TarError,json.JSONDecodeError) as e:
  print('Runtime FAIL:',e,file=sys.stderr);sys.exit(2)
