#!/usr/bin/env node
// Bash noexec-safe inventory, not a claim that each ELF can load on Android.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const temp=mkdtempSync(join(tmpdir(),'dsh-android-wx-bash-'))
try {
  const prefix=join(temp,'usr')
  mkdirSync(join(prefix,'bin'),{recursive:true})
  mkdirSync(join(prefix,'libexec/dsh/wrappers'),{recursive:true})
  for(const name of ['python3','clang','clang++','qemu-x86_64','git','node','npx','not.exec']){
    writeFileSync(join(prefix,'bin',name),'UNEXECUTABLE_PLACEHOLDER',{mode:0o600})
  }
  writeFileSync(join(prefix,'libexec/dsh/termux-wrapper'),'#!/system/bin/sh')
  symlinkSync('../termux-wrapper',join(prefix,'libexec/dsh/wrappers/python3'))
  const bashEnv=resolve('scripts/dsh-android-bash-env.sh')
  const env={...process.env,TERMUX__PREFIX:prefix,PREFIX:prefix,
    DSH_ANDROID_STANDALONE:'1',BASH_ENV:bashEnv}
  const script=[
    "type -t python3", "type -t clang", "type -t clang++",
    "type -t qemu-x86_64", "type -t git", "type -t not.exec",
    "command -v python3", "command -v clang++",
    "type -t printf", "printf '%s\\n' \"$PATH\"",
  ].join('; ')
  const r=spawnSync('bash',['--noprofile','-c',script],{
    env,encoding:'utf8',timeout:10000,
  })
  assert.equal(r.status,0,String(r.stderr)+'\n'+String(r.stdout))
  const lines=r.stdout.trimEnd().split('\n')
  assert.deepEqual(lines.slice(0,6),Array(6).fill('function'))
  assert.equal(lines[6],'python3')
  assert.equal(lines[7],'clang++')
  assert.equal(lines[8],'builtin')
  assert.equal(lines[9],'/system/bin:/system/xbin')
  assert.ok(!r.stdout.includes(prefix+'/bin'), 'app-private bin cannot be in executable PATH')
  console.log('[DSH] Android noexec Bash inventory / command -v / PATH isolation: OK')
} finally {
  rmSync(temp,{recursive:true,force:true})
}
