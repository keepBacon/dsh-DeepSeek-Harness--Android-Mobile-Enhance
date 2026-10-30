#!/usr/bin/env python3
import importlib.util, io, json, os, pathlib, tarfile, tempfile
spec=importlib.util.spec_from_file_location('validate_runtime',pathlib.Path(__file__).with_name('ci-validate-runtime.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def pack(dst,contents):
 with tarfile.open(dst,'w:xz') as f:
  for name,contents in contents.items():
   entry=tarfile.TarInfo(name);entry.size=len(contents);f.addfile(entry,io.BytesIO(contents))
with tempfile.TemporaryDirectory() as tmp:
 d=pathlib.Path(tmp);lock=d/'lock.json';lock.write_text(json.dumps({'version':'0.1.5-rc.2'}))
 elf=bytearray(20);elf[:4]=bytes.fromhex('7f454c46');elf[18:20]=(183).to_bytes(2,'little')
 data={n:b'dummy' for n in m.REQUIRED}
 data['usr/bin/node']=bytes(elf)
 data['usr/lib/node_modules/@deepseek-ai/dsh/package.json']=b'{"version":"0.1.5-rc.2"}'
 data['large-fill']=os.urandom(1024*1024+64)
 snap=d/'snapshot.tar.xz';pack(snap,data)
 assert m.validate(snap,lock)['checked_paths']==len(m.REQUIRED)
 cases=[{k:v for k,v in data.items() if k!='usr/bin/bash'},dict(data,**{'usr/bin/node':b'bad'}),dict(data,**{'usr/lib/node_modules/@deepseek-ai/dsh/package.json':b'{"version":"9"}'}),dict(data,**{'../unsafe':b'x'})]
 for n,case in enumerate(cases):
  pack(snap,case)
  try:m.validate(snap,lock)
  except (ValueError,tarfile.TarError):continue
  raise AssertionError('accepted invalid runtime case '+str(n))
 snap.write_bytes(b'ci-runtime-placeholder\n')
 try:m.validate(snap,lock)
 except ValueError:pass
 else:raise AssertionError('accepted placeholder')
 print('runtime validator: 6/6 PASS')
