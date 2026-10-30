#!/usr/bin/env python3
"""Fail closed unless a newly built APK has the identical signer and an intact DSH runtime."""
import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import zipfile

def cmd(*args):
    p = subprocess.run(args, capture_output=True, text=True)
    if p.returncode:
        raise ValueError(f'{args[0]} failed: {p.stderr[-500:]}')
    return p.stdout

def identity(apk):
    data = next((x for x in cmd('aapt','dump','badging',str(apk)).splitlines() if x.startswith('package: ')), '')
    name = re.search(r"\bname='([^']+)'",data)
    code = re.search(r"\bversionCode='(\d+)'",data)
    if not name or not code: raise ValueError('Cannot parse package identity')
    return name.group(1),int(code.group(1))

def signer(apk):
    data = cmd('apksigner','verify','--verbose','--print-certs',str(apk))
    certs = re.findall(r'^Signer #\d+ certificate SHA-256 digest: ([0-9A-Fa-f]{64})$',data,re.M)
    if len(certs)!=1: raise ValueError('Expected one APK signer')
    return certs[0].lower()

def sha256(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''): h.update(block)
    return h.hexdigest()

def verify(old,new,snapshot):
    name1,code1=identity(old)
    name2,code2=identity(new)
    if name1!='com.dshmobile.shell' or name2!=name1: raise ValueError('ApplicationId mismatch')
    if code2<=code1: raise ValueError('VersionCode did not increase')
    certificate=signer(old)
    if signer(new)!=certificate: raise ValueError('Signing key mismatch: upgrade not safe')
    h=hashlib.sha256()
    with zipfile.ZipFile(new) as z:
        with z.open('assets/snapshot.tar.xz') as f:
            for block in iter(lambda:f.read(1024*1024),b''): h.update(block)
        marker=z.read('assets/runtime-version.txt').decode('utf-8')
    if h.hexdigest()!=sha256(snapshot) or 'sha256='+h.hexdigest() not in marker.splitlines():
        raise ValueError('APK does not contain exact validated runtime')
    return {'result':'eligible-for-in-place-upgrade','applicationId':name2,'oldVersionCode':code1,
        'newVersionCode':code2,'signerSHA256':certificate,'runtimeSHA256':h.hexdigest(),
        'baselineSHA256':sha256(old),'apkSHA256':sha256(new),
        'deviceDataAcceptance':'pending real-device backup and on-device session verification'}

def main():
    p=argparse.ArgumentParser()
    for n in ('baseline','built','snapshot','report'):p.add_argument('--'+n,type=pathlib.Path,required=True)
    a=p.parse_args()
    try:
        result=verify(a.baseline,a.built,a.snapshot)
        a.report.write_text(json.dumps(result,indent=2)+'\n')
        print('APK upgrade compatibility: PASS')
        return 0
    except (OSError,ValueError,zipfile.BadZipFile,KeyError) as e:
        print('APK upgrade compatibility: FAIL: '+str(e),file=sys.stderr)
        return 3
if __name__=='__main__':sys.exit(main())
