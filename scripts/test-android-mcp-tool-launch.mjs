import test from 'node:test'
import assert from 'node:assert/strict'
import { androidToolLaunch } from './dsh-android-tool-spawn.mjs'

const prefix='/data/data/com.dshmobile.shell/files/usr'
const home='/data/data/com.dshmobile.shell/files/home'
const android={TERMUX__PREFIX:prefix,HOME:home,DSH_ANDROID_STANDALONE:'1'}
const bridge=prefix+'/libexec/dsh-mobile/android-exec.sh'

test('Android app-private ELF uses the system-shell linker bridge',()=>{
 assert.deepEqual(androidToolLaunch(prefix+'/bin/git',['status','--porcelain'],android),
  {command:'/system/bin/sh',args:[bridge,prefix+'/bin/git','status','--porcelain'],bridged:true})
})
test('Android standalone PATH commands and relative executable scripts use bridge',()=>{
 assert.deepEqual(androidToolLaunch('python3',['-c','print(42)'],android),
  {command:'/system/bin/sh',args:[bridge,'python3','-c','print(42)'],bridged:true})
 assert.deepEqual(androidToolLaunch('./gradlew',['tasks'],android),
  {command:'/system/bin/sh',args:[bridge,'./gradlew','tasks'],bridged:true})
})
test('Android system and APEX executables are never rewrapped',()=>{
 for(const name of ['/system/bin/sh','/system/bin/ls','/apex/com.android.runtime/bin/linker64'])
  assert.deepEqual(androidToolLaunch(name,['--help'],android),{command:name,args:['--help'],bridged:false})
})
test('Custom bridge and complex argv preserve boundaries exactly',()=>{
 const args=['space in argument','','-x','; no shell execution','中文']
 const env={...android,DSH_ANDROID_EXEC_BRIDGE:home+'/my bridge.sh'}
 assert.deepEqual(androidToolLaunch(prefix+'/bin/node',args,env),
  {command:'/system/bin/sh',args:[home+'/my bridge.sh',prefix+'/bin/node',...args],bridged:true})
})
test('Pre-standalone private binary fallback remains available',()=>{
 const env={TERMUX__PREFIX:prefix,HOME:home}
 assert.equal(androidToolLaunch(prefix+'/bin/bash',['--version'],env).bridged,true)
 assert.equal(androidToolLaunch(home+'/tools/diagnostic',['--help'],env).bridged,true)
 assert.deepEqual(androidToolLaunch('git',['status'],env),{command:'git',args:['status'],bridged:false})
})
test('No false Android wrapping for other absolute paths, missing HOME or desktop',()=>{
 const env={TERMUX__PREFIX:prefix,HOME:''}
 assert.equal(androidToolLaunch('/tmp/other-tool',[],env).bridged,false)
 assert.equal(androidToolLaunch('/data/unrelated/tool',[],env).bridged,false)
 assert.equal(androidToolLaunch('git',[],{PREFIX:'/usr/local',DSH_ANDROID_STANDALONE:'0'}).bridged,false)
 assert.equal(androidToolLaunch('/usr/local/bin/git',[],{PREFIX:'/usr/local',DSH_ANDROID_STANDALONE:'0'}).bridged,false)
 assert.equal(androidToolLaunch('git',[],{DSH_ANDROID_STANDALONE:'1'}).bridged,false)
})
