#!/usr/bin/env node
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
const home=await mkdtemp(join(tmpdir(),'dsh-p3-plan-'))
process.env.DSH_DEV_PLAN_DIR=join(home,'plan-state')
process.env.DSH_CODE_ENGINE_STATE_DIR=join(home,'code-journal')
process.env.DSH_WORKSPACE_JOURNAL_DIR=join(home,'file-journal')
const {devPlanTools,devPlanCall}=await import('./dsh-dev-plan.mjs')
const root=join(home,'project')
const run=async(id,maxSteps=4)=>devPlanCall('dev_plan_run',{id,maxSteps,budgetMs:30000})
try{
 await mkdir(root)
 await writeFile(join(root,'pyproject.toml'),'[build-system]\nrequires=[]\n')
 await writeFile(join(root,'value.py'),'def value():\n return 4\n')
 await writeFile(join(root,'test_value.py'),
  'import unittest\nfrom value import value\nclass TestValue(unittest.TestCase):\n def test_value(self):self.assertEqual(value(),4)\n')
 assert.equal(devPlanTools.length,8)
 const plan=await devPlanCall('dev_plan_create',{root,name:'P3 smoke: diagnose, edit, verify',steps:[
  {kind:'detect',label:'detect project'},
  {kind:'edit',args:{system:'python',edits:[{path:'value.py',oldText:'return 4',newText:'return 4 # P3'}]}},
  {kind:'verify',args:{system:'python',runTests:true}},
  {kind:'diagnostics'}
 ]})
 assert.equal(plan.status,'ready')
 assert.equal(plan.total,4)
 assert.equal((await devPlanCall('dev_plan_list',{})).plans[0].id,plan.id)
 const first=await run(plan.id,2)
 assert.equal(first.cursor,2)
 assert.equal(first.status,'paused')
 assert.equal(first.steps[0].status,'passed')
 assert.equal(first.steps[1].status,'passed')
 assert.match(await readFile(join(root,'value.py'),'utf8'),/P3/)
 const last=await run(plan.id)
 assert.equal(last.status,'completed')
 assert.equal(last.steps.every(s=>s.status==='passed'),true)
 const report=await devPlanCall('dev_plan_report',{id:plan.id})
 assert.equal(report.report.passed,4)
 const failedPlan=await devPlanCall('dev_plan_create',{root,steps:[
  {kind:'edit',args:{system:'python',edits:[{path:'value.py',oldText:'return 4 # P3',newText:'return 5'}]}},
  {kind:'verify'},
 ]})
 const failed=await run(failedPlan.id,2)
 assert.equal(failed.status,'failed')
 assert.equal(failed.steps[0].status,'failed')
 assert.match(await readFile(join(root,'value.py'),'utf8'),/return 4 # P3/)
 const corrected=await devPlanCall('dev_plan_resume',{id:failedPlan.id})
 assert.equal(corrected.cursor,0)
 assert.equal(corrected.steps[0].status,'pending')
 const cancelledPlan=await devPlanCall('dev_plan_create',{root,steps:[{kind:'detect'},{kind:'index'}]})
 await devPlanCall('dev_plan_cancel',{id:cancelledPlan.id})
 const cancelled=await run(cancelledPlan.id)
 assert.equal(cancelled.status,'cancelled')
 assert.equal(cancelled.cursor,0)
 await devPlanCall('dev_plan_resume',{id:cancelledPlan.id})
 assert.equal((await run(cancelledPlan.id)).status,'completed')
 const conditional=await devPlanCall('dev_plan_create',{root,steps:[
  {kind:'detect'},
  {kind:'diagnostics',when:'onPreviousFailure'},
  {kind:'detect',when:'onPreviousSuccess'}
 ]})
 const conditionResult=await run(conditional.id)
 assert.equal(conditionResult.steps[1].status,'skipped')
 assert.equal(conditionResult.steps[2].status,'skipped')
 await assert.rejects(devPlanCall('dev_plan_create',{root,steps:[{
  kind:'edit',maxAttempts:2,args:{edits:[{path:'value.py',oldText:'a',newText:'b'}]}
 }]}),/cannot automatically retry/)
 await assert.rejects(devPlanCall('dev_plan_create',{root,steps:[{
  kind:'refactor',args:{operations:[{type:'create',path:'../escape',content:'x'}]}
 }]}),/escapes project root/)
 console.log('[DSH] P3 plan checkpoints, edit verification, cancel/resume, conditions and safe retries: OK')
}finally{await rm(home,{recursive:true,force:true})}
