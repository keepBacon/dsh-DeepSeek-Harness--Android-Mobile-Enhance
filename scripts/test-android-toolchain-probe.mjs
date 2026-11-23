#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeToolchain, probePythonBuildChild } from './dsh-toolchain-probe.mjs'

const home=await mkdtemp(join(tmpdir(),'dsh-toolchain-probe-'))
try{
  const prefix=join(home,'usr')
  await mkdir(join(prefix,'bin'),{recursive:true})
  for(const name of ['node','python3','git','ssh','clang','qemu-x86_64']){
    await writeFile(join(prefix,'bin',name),'not an executable')
  }
  const calls=[]
  const result=await probeToolchain({
    extended:true,env:{TERMUX__PREFIX:prefix,DSH_ANDROID_STANDALONE:'1'},
    memory:async()=>235*1024,
    run:async(name,args,opts)=>{
      calls.push({name,args,timeout:opts.timeoutMs})
      return {exitCode:name==='python3'?126:0,
        timedOut:false,cancelled:false,stdout:name==='python3'?'':'v1.0\n',
        stderr:name==='python3'?'permission denied':''}
    },
  })
  assert.equal(calls.length,6,'one serial probe per present binary')
  assert.ok(result.probes.every(x=>x.installed===true))
  assert.equal(result.probes.find(x=>x.name==='python3').runnable,false,
    'installed file with exitCode 126 must not be marked runnable')
  assert.equal(result.probes.find(x=>x.name==='python3').reason,
    'loader-or-permission-denied')
  assert.equal(result.probes.find(x=>x.name==='node').runnable,true)
  assert.equal(result.cloudRecommended,true)
  assert.ok(calls.every(x=>x.timeout<=8000))
  const nested=await probePythonBuildChild({
    env:{DSH_ANDROID_STANDALONE:'1',
      TERMUX__PREFIX:'/data/user/0/com.dshmobile.shell/files/usr'},
    run:async(command,args)=>{
      assert.equal(command,'python3')
      assert.deepEqual(args.slice(0,1),['-c'])
      assert.match(args[1],/subprocess\.run\(\[sys\.executable/)
      return {exitCode:0,timedOut:false,cancelled:false,
        stdout:JSON.stringify({python:'3.13',childReturncode:0,
          childOk:true,dshAdapter:true,stderr:''})+'\n'}
    }
  })
  assert.equal(nested.nestedChildOk,true)
  assert.equal(nested.adapterLoaded,true)
  assert.equal(nested.exitCode,0)
  assert.equal((await probePythonBuildChild({
    env:{TERMUX__PREFIX:'/usr',DSH_ANDROID_STANDALONE:'0'}})).supported,false)
  console.log('[DSH] Android real-exit-code capability classification, optional probes, low-memory route: OK')
}finally{await rm(home,{recursive:true,force:true})}
