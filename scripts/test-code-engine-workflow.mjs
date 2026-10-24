#!/usr/bin/env node
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {codeWorkflowTools,codeWorkflowCall} from './dsh-code-engine-workflow.mjs'

assert.deepEqual(codeWorkflowTools.map(x=>x.name),[
 'code_edit_verify','code_repair_candidates','code_diagnostics_compare','code_edit_recover','code_change_impact'
])
const root=await mkdtemp(join(tmpdir(),'dsh-code-workflow-'))
const js=join(root,'main.js'),ts=join(root,'module.ts'),extra=join(root,'extra.js')
const replace=(path,oldText,newText)=>({path,oldText,newText})
const read=path=>readFile(path,'utf8')
try{
 await writeFile(js,'export const answer = 1;\n')
 await writeFile(extra,'export const extra = 1;\n')
 const invalid=replace(js,'answer = 1','answer = =')
 const dry=await codeWorkflowCall('code_edit_verify',{edits:[invalid],dryRun:true})
 assert.equal(dry.ok,true)
 assert.equal(dry.verificationSkipped,true)
 assert.equal(await read(js),'export const answer = 1;\n')
 const failed=await codeWorkflowCall('code_edit_verify',{edits:[invalid]})
 assert.equal(failed.ok,false)
 assert.equal(failed.phase,'syntax')
 assert.equal(failed.rollback.ok,true)
 assert.equal(await read(js),'export const answer = 1;\n')
 const testFailed=await codeWorkflowCall('code_edit_verify',{
  edits:[replace(js,'answer = 1','answer = 2')],
  command:process.execPath,args:['-e','process.stderr.write("unit test failed");process.exit(7)']
 })
 assert.equal(testFailed.ok,false)
 assert.equal(testFailed.phase,'test')
 assert.equal(testFailed.rollback.ok,true)
 assert.match(testFailed.verification.results[1].stderr,/unit test failed/)
 assert.equal(await read(js),'export const answer = 1;\n')
 const successful=await codeWorkflowCall('code_edit_verify',{
  edits:[replace(js,'answer = 1','answer = 2'),replace(extra,'extra = 1','extra = 2')],
  checkPaths:[js,extra],command:process.execPath,args:['-e','process.exit(0)']
 })
 assert.equal(successful.ok,true)
 assert.equal(await read(js),'export const answer = 2;\n')
 assert.equal(await read(extra),'export const extra = 2;\n')
 // Candidates are independent: the second candidate must use original
 // content because the first candidate must have been fully reverted.
 const alternatives=await codeWorkflowCall('code_repair_candidates',{
  candidates:[
   {label:'broken syntax',edits:[replace(js,'answer = 2','answer = ='),replace(extra,'extra = 2','extra = 3')]},
   {label:'working patch',edits:[replace(js,'answer = 2','answer = 4'),replace(extra,'extra = 2','extra = 4')]},
  ],checkPaths:[js,extra]
 })
 assert.equal(alternatives.ok,true)
 assert.equal(alternatives.selected,1)
 assert.equal(alternatives.attempts[0].rollback.ok,true)
 assert.equal(alternatives.attempts[1].ok,true)
 assert.equal(await read(js),'export const answer = 4;\n')
 assert.equal(await read(extra),'export const extra = 4;\n')
 const dryCandidates=await codeWorkflowCall('code_repair_candidates',{
  candidates:[{label:'preview',edits:[replace(js,'answer = 4','answer = 5')]}],
  dryRun:true
 })
 assert.equal(dryCandidates.ok,true)
 assert.equal(await read(js),'export const answer = 4;\n')
 await writeFile(ts,'const value: = 1;\n')
 const compared=await codeWorkflowCall('code_diagnostics_compare',{
  edits:[replace(ts,': =',': number =')],
  files:[ts],semantic:false
 })
 assert.equal(compared.restored,true)
 assert.equal(compared.diff.length,1)
 assert.ok(compared.diff[0].beforeErrors>compared.diff[0].afterErrors)
 assert.equal(await read(ts),'const value: = 1;\n')
 // Detect a concurrent/post-edit source change and never clobber it
 // during verification-failure rollback.
 const script='const fs=require("fs");fs.writeFileSync(process.argv[1],"export const answer = 99;\\n");process.exit(8)'
 const conflict=await codeWorkflowCall('code_repair_candidates',{
  candidates:[
   {edits:[replace(js,'answer = 4','answer = 6')]},
   {edits:[replace(js,'answer = 4','answer = 7')]},
  ],
  command:process.execPath,args:['-e',script,js]
 })
 assert.equal(conflict.ok,false)
 assert.equal(conflict.stoppedForRollbackConflict,true)
 assert.equal(conflict.attempts.length,1)
 assert.equal(conflict.attempts[0].rollback.ok,false)
 assert.match(await read(js),/answer = 99/)
 console.log('[DSH] Code Engine verified edits, repair candidates and diagnostic delta: OK')
}finally{await rm(root,{recursive:true,force:true})}
