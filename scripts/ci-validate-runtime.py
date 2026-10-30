#!/usr/bin/env python3
"""Fail-closed, read-only archive inspection, not an Android native smoke test."""
import argparse, hashlib, json, pathlib, sys, tarfile

REQUIRED = (
 'usr/bin/node','usr/bin/bash','usr/bin/proot',
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
def validate(snapshot, lock):
 if not snapshot.is_file() or snapshot.stat().st_size < 1024*1024:
  raise ValueError('missing or placeholder runtime archive')
 version=json.loads(lock.read_text())['version']
 found=set()
 package=None
 arch=False
 entries=0
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
   if name=='usr/bin/node' and member.isfile():
    h=f.extractfile(member).read(20)
    arch=len(h)>=20 and h[:4]==bytes.fromhex('7f454c46') and int.from_bytes(h[18:20],'little')==183
 if set(REQUIRED)-found: raise ValueError('missing required paths: '+', '.join(sorted(set(REQUIRED)-found)))
 if not arch: raise ValueError('node is not ARM64 ELF')
 actual=package.get('version') if isinstance(package,dict) else None
 if actual!=version: raise ValueError('runtime DSH version '+str(actual)+' does not match '+version)
 sha=hashlib.sha256()
 with snapshot.open('rb') as f:
  for block in iter(lambda:f.read(1024*1024),b''):sha.update(block)
 return dict(dsh_version=actual,runtime_sha256=sha.hexdigest(),archive_entries=entries,checked_paths=len(REQUIRED),verification='archive-only; Android execution not tested')
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
