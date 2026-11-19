#!/usr/bin/env node
// Ensure Node's pnpm/DSH child-process Git invocations are bridged on Android.
// Host CI validates exact command/argv routing, not physical Android execve.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const preload=fileURLToPath(new URL('./dsh-android-plugin-git-spawn.cjs',import.meta.url))
const prefix='/data/data/com.dshmobile.shell/files/usr'
const testCode=`
const assert=require('node:assert/strict')
const cp=require('node:child_process')
const mod=require(process.argv[1])
const p=process.env.TERMUX__PREFIX
const shell='/system/bin/sh'
const expected=[p+'/libexec/dsh-mobile/android-exec.sh',p+'/bin/git']
for(const [name,args] of [
 ['git',['ls-remote','https://github.com/iJetLi/dsh-providers-hub.git','HEAD']],
 [p+'/bin/git',['--version']],
 [p+'/libexec/dsh/wrappers/git',['status']]
]){
 const routed=mod.adaptGitCommand(name,args)
 assert.equal(routed.command,shell)
 assert.deepEqual(routed.args,[...expected,...args])
}
// Non-Git binaries and app-private workspace programs must also go through
// the system-shell linker bridge, preserving exact arguments and child cwd.
for(const [name,args,target] of [
 ['node',['-e','console.log("ok")'],p+'/bin/node'],
 ['npm',['--version'],p+'/bin/npm'],
 ['python3',['-c','print(123)'],p+'/bin/python3'],
 ['rg',['--version'],p+'/bin/rg'],
 [p+'/bin/node',['--check','script.js'],p+'/bin/node'],
 [p+'/libexec/dsh/wrappers/python3',['--version'],p+'/libexec/dsh/wrappers/python3'],
 [p+'/../home/workspace/execute',['argument with spaces',';echo unsafe'],
  require('node:path').normalize(p+'/../home/workspace/execute')]
]){
 const result=mod.adaptAndroidCommand(name,args)
 assert.equal(result.command,shell,name)
 assert.deepEqual(result.args,[p+'/libexec/dsh-mobile/android-exec.sh',target,...args],name)
}
assert.deepEqual(
 mod.adaptAndroidCommand('./task.js',['foo'],{cwd:p+'/../home/workspace'}).args,
 [p+'/libexec/dsh-mobile/android-exec.sh',p+'/../home/workspace/task.js','foo'].map(
  (value,index)=>index===1?require('node:path').normalize(value):value))
for(const name of ['sh','echo','getprop','logcat','unknown','github',
 '/system/bin/sh','/apex/com.android.runtime/bin/linker64','/usr/bin/false',
 '/data/data/another.app/files/usr/bin/node']){
 assert.equal(mod.adaptAndroidCommand(name,['argument']),null,name)
}
// The high-level exec APIs default to /bin/sh, which Android does not
// provide for the embedded app. Ensure a model's original shell command is
// passed unchanged, with BASH_ENV dispatch and inherited caller options.
const shellCommand='node -e "console.log(42)" && git --version'
const adaptedShell=mod.adaptShellCommand(shellCommand,{cwd:'/tmp',encoding:'utf8'})
assert.equal(adaptedShell.command,shell)
assert.deepEqual(adaptedShell.args,[p+'/libexec/dsh-mobile/android-exec.sh',
 p+'/bin/bash','-c',shellCommand])
assert.equal(adaptedShell.options.cwd,'/tmp')
assert.equal(adaptedShell.options.shell,false)
assert.equal(adaptedShell.options.env.BASH_ENV,p+'/libexec/dsh-mobile/android-bash-env.sh')
assert.equal(adaptedShell.options.env.LD_PRELOAD,undefined)
assert.equal(mod.adaptShellCommand('echo ok',{shell:'/custom/bash'}),null)
assert.equal(mod.adaptShellCommand('echo ok',{shell:'/system/bin/sh'}),null)
assert.equal(mod.adaptShellCommand('echo ok',{shell:false}),null)
assert.throws(()=>cp.execSync(shellCommand,{encoding:'utf8'}), error =>
  error.code==='ENOENT' || error.errno===-2)
let execCallback=false
cp.exec(shellCommand,{cwd:'/tmp'},error=>{
 execCallback=true
 assert.equal(error.path,shell)
})
assert.equal(mod.adaptGitCommand('node',['--version']),null)
assert.equal(mod.adaptGitCommand('github',['foo']),null)
assert.equal(mod.adaptGitCommand('/system/bin/git',['status']),null)
assert.equal(mod.adaptGitCommand(p+'/bin/git-extra',['status']),null)
assert.deepEqual(mod.adaptGitCommand('git',['arg with spaces',';echo unsafe']).args.slice(2),
 ['arg with spaces',';echo unsafe'])
// A true Node child-process call must fail trying the *system shell* on a
// non-Android runner, not a direct Git ENOENT.
const result=cp.spawnSync('git',['--version'],{encoding:'utf8'})
assert.equal(result.error?.path,shell)

// Child process functions must route calls to the *system shell* even though
// /system/bin/sh is absent on host Linux CI. This tests the real wrappers.
for(const executable of ['git','node','python3']){
 const result=cp.spawnSync(executable,['--version'],{encoding:'utf8'})
 assert.equal(result.error?.path,shell,executable)
}
const workspace=cp.spawnSync(p+'/../home/workspace/mytool',['arg'],{encoding:'utf8'})
assert.equal(workspace.error?.path,shell)

// fork() bypasses the exported spawn binding internally. Verify its real
// execPath/execArgv mapping, not just that the ESM export was refreshed.
const forked=cp.fork('/tmp/dsh-unreachable-fixture.js',[],{
 execPath:p+'/bin/node',execArgv:[],silent:true
})
assert.equal(forked.spawnfile,shell)
assert.deepEqual(forked.spawnargs.slice(0,3),[
 shell,p+'/libexec/dsh-mobile/android-exec.sh',p+'/bin/node'])
forked.on('error',(error)=>{
 assert.equal(error.path,shell)
})

const ignored=cp.spawnSync('node',['--version'],{shell:true,encoding:'utf8'})
assert.equal(ignored.status,0)
assert.match(ignored.stdout,/^v[0-9]+/m)
let callbackCalled=false
cp.execFile('node',['--version'],(error)=>{
 callbackCalled=true
 assert.equal(error.path,shell)
})

;(async()=>{
 const named=await import('node:child_process')
 assert.equal(named.spawn,cp.spawn)
 assert.equal(named.spawnSync,cp.spawnSync)
 assert.equal(named.execFile,cp.execFile)
 assert.equal(named.execFileSync,cp.execFileSync)
 assert.equal(named.exec,cp.exec)
 assert.equal(named.execSync,cp.execSync)
 assert.equal(named.fork,cp.fork)
 console.log('Git bridge: spawn/sync/execFile/ESM mapping OK')
})().catch(e=>{console.error(e);process.exitCode=1})
`
const base={...process.env,DSH_ANDROID_STANDALONE:'1',
 TERMUX__PREFIX:prefix,PREFIX:prefix}
const on=spawnSync(process.execPath,['-e',testCode,preload],{
 env:base,encoding:'utf8',timeout:12000})
assert.equal(on.status,0,on.stderr+'\n'+on.stdout)
assert.match(on.stdout,/Git bridge:/)
const off=spawnSync(process.execPath,['-e',`
const assert=require('node:assert/strict')
const m=require(process.argv[1])
assert.equal(m.adaptGitCommand('git',['version']),null)
`,preload],{env:{...base,DSH_ANDROID_STANDALONE:'0'},encoding:'utf8',timeout:12000})
assert.equal(off.status,0,off.stderr)
console.log('[DSH] Android pnpm Git child-process (spawn, execFile, ESM and argv) compatibility: OK')
