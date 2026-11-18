#!/usr/bin/env node
// P3 crash-recovery drill: kill the MCP worker after a verified edit was
// applied, then reconcile its real P2 transaction journal in a fresh process.
// Run in the same environment as the packaged Android Node runtime.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {devLaunch} from './dsh-dev-process.mjs'

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
if(process.argv[2]==='--worker'){
 const {devPlanCall}=await import('./dsh-dev-plan.mjs')
 await devPlanCall('dev_plan_run',{id:process.argv[3],maxSteps:1,budgetMs:30000})
 process.exit(0)
}
else {
 const home=await mkdtemp(join(tmpdir(),'dsh-p3-crash-'))
 const root=join(home,'root')
 process.env.DSH_DEV_PLAN_DIR=join(home,'plan')
 process.env.DSH_CODE_ENGINE_STATE_DIR=join(home,'journal')
 process.env.DSH_WORKSPACE_JOURNAL_DIR=join(home,'file-journal')
 let child=null
 try{
  await mkdir(root)
  await writeFile(join(root,'pyproject.toml'),'[build-system]\nrequires=[]\n')
  await writeFile(join(root,'value.py'),'def value():\n return 5\n')
  await writeFile(join(root,'test_value.py'),
   'import unittest,time\nfrom value import value\nclass V(unittest.TestCase):\n def test_value(self):\n  time.sleep(8)\n  self.assertEqual(value(),5)\n')
  const {devPlanCall}=await import('./dsh-dev-plan.mjs')
  const created=await devPlanCall('dev_plan_create',{root,steps:[
   {kind:'edit',args:{system:'python',timeoutMs:30000,
    edits:[{path:'value.py',oldText:'return 5',newText:'return 5 # uncommitted'}]}}
  ]})
  const launch=await devLaunch(process.execPath,[fileURLToPath(import.meta.url),'--worker',created.id],{
   cwd:join(import.meta.dirname,'..')})
  child=spawn(launch.command,launch.args,{
   cwd:launch.cwd,env:launch.env,stdio:'ignore',detached:process.platform!=='win32'})
  let mutated=false
  for(let i=0;i<400;i++){
   const state=await devPlanCall('dev_plan_status',{id:created.id})
   const file=await readFile(join(root,'value.py'),'utf8')
   if(state.status==='running'&&file.includes('uncommitted')){mutated=true;break}
   if(child.exitCode!==null)break
   await sleep(25)
  }
  assert.equal(mutated,true,'worker must apply the edit before crash injection')
  // Kill exactly the worker (not another user's process); the separate
  // build/test process group finishes or gets reaped by its own timeouts.
  child.kill('SIGKILL')
  await new Promise(resolve=>child.once('close',resolve))
  child=null
  const interrupted=await devPlanCall('dev_plan_status',{id:created.id})
  assert.equal(interrupted.status,'running')
  const recovered=await devPlanCall('dev_plan_recover',{id:created.id,restore:true})
  assert.equal(recovered.status,'paused',JSON.stringify(recovered.recovery).slice(0,1500))
  assert.equal(recovered.recovery.ok,true)
  assert.equal(await readFile(join(root,'value.py'),'utf8'),'def value():\n return 5\n')
  await writeFile(join(root,'test_value.py'),
   'import unittest\nfrom value import value\nclass V(unittest.TestCase):\n def test_value(self):\n  self.assertEqual(value(),5)\n')
  const after=await devPlanCall('dev_plan_run',{id:created.id,maxSteps:1,budgetMs:30000})
  assert.equal(after.status,'completed',JSON.stringify(after).slice(0,2500))
  console.log('[DSH] P3 process-death journal rollback and resume: OK')
 }finally{
  if(child){child.kill('SIGKILL');await sleep(150)}
  await rm(home,{recursive:true,force:true})
 }
}
