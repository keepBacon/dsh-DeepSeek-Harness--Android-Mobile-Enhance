#!/usr/bin/env node
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises'
import {spawnSync} from 'node:child_process'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {codeWorkflowTools,codeWorkflowCall} from './dsh-code-engine-workflow.mjs'
import {createTransaction,setTransactionPhase,recoverTransactions,acquirePathLocks,expandTransactionLockPaths} from './dsh-code-engine-journal.mjs'

assert.deepEqual(codeWorkflowTools.map(x=>x.name),[
 'code_edit_verify','code_repair_candidates','code_diagnostics_compare','code_edit_recover','code_change_impact'
])
const root=await mkdtemp(join(tmpdir(),'dsh-code-workflow-'))
const journal=join(root,'journal');process.env.DSH_CODE_ENGINE_STATE_DIR=journal
const js=join(root,'main.js'),extra=join(root,'extra.js'),ts=join(root,'module.ts')
const replace=(path,oldText,newText)=>({path,oldText,newText})
const read=path=>readFile(path,'utf8')
try{
 await mkdir(journal,{recursive:true})
 const held=await acquirePathLocks([js,extra],{timeoutMs:500})
  await assert.rejects(()=>acquirePathLocks([extra,js],{timeoutMs:120}),error=>error.code==='DSH_LOCK_TIMEOUT')
  assert.equal((await held.release()).every(item=>item.released),true)
  const reacquired=await acquirePathLocks([extra,js],{timeoutMs:500})
  assert.equal((await reacquired.release()).every(item=>item.released),true)
  await writeFile(js,'export const answer = 1;\n')
 await writeFile(extra,'export const extra = 1;\n')
 const invalid=replace(js,'answer = 1','answer = =')
 const dry=await codeWorkflowCall('code_edit_verify',{edits:[invalid],dryRun:true})
 assert.equal(dry.ok,true);assert.equal(dry.verificationSkipped,true)
 assert.equal(await read(js),'export const answer = 1;\n')
 const failed=await codeWorkflowCall('code_edit_verify',{edits:[invalid]})
 assert.equal(failed.ok,false);assert.equal(failed.phase,'syntax');assert.equal(failed.rollback.ok,true)
 assert.equal(await read(js),'export const answer = 1;\n')
 assert.equal((await recoverTransactions()).checked,0)
 const testFailed=await codeWorkflowCall('code_edit_verify',{
  edits:[replace(js,'answer = 1','answer = 2')],
  command:process.execPath,args:['-e','process.stderr.write("unit test failed");process.exit(7)']
 })
 assert.equal(testFailed.ok,false);assert.equal(testFailed.phase,'test');assert.equal(testFailed.rollback.ok,true)
 assert.match(testFailed.verification.results[1].stderr,/unit test failed/)
 assert.equal(await read(js),'export const answer = 1;\n')
 const successful=await codeWorkflowCall('code_edit_verify',{
  edits:[replace(js,'answer = 1','answer = 2'),replace(extra,'extra = 1','extra = 2')],
  checkPaths:[js,extra],command:process.execPath,args:['-e','process.exit(0)']
 })
 assert.equal(successful.ok,true);assert.equal(await read(js),'export const answer = 2;\n');assert.equal(await read(extra),'export const extra = 2;\n')
 const alternatives=await codeWorkflowCall('code_repair_candidates',{
  candidates:[
   {label:'broken syntax',edits:[replace(js,'answer = 2','answer = ='),replace(extra,'extra = 2','extra = 3')]},
   {label:'working patch',edits:[replace(js,'answer = 2','answer = 4'),replace(extra,'extra = 2','extra = 4')]},
  ],checkPaths:[js,extra]
 })
 assert.equal(alternatives.ok,true);assert.equal(alternatives.selected,1)
 assert.equal(alternatives.attempts[0].rollback.ok,true);assert.equal(alternatives.attempts[1].ok,true)
 assert.equal(await read(js),'export const answer = 4;\n');assert.equal(await read(extra),'export const extra = 4;\n')
 const dryCandidates=await codeWorkflowCall('code_repair_candidates',{candidates:[{label:'preview',edits:[replace(js,'answer = 4','answer = 5')]}],dryRun:true})
 assert.equal(dryCandidates.ok,true);assert.equal(await read(js),'export const answer = 4;\n')
 await writeFile(ts,'const value: = 1;\n')
 const compared=await codeWorkflowCall('code_diagnostics_compare',{edits:[replace(ts,': =',': number =')],files:[ts],semantic:false})
 assert.equal(compared.restored,true);assert.equal(compared.diff.length,1)
 assert.ok(compared.diff[0].beforeErrors>compared.diff[0].afterErrors)
 assert.equal(await read(ts),'const value: = 1;\n')
 // Simulate a process that died after writing one of two files.
 const crashFile=join(root,'crash.js'),untouched=join(root,'untouched.js')
 const original='const crash = 1;\n',after='const crash = 2;\n'
 await writeFile(crashFile,original);await writeFile(untouched,'const untouched = true;\n')
 const tx=await createTransaction({purpose:'simulated-crash',files:[
  {path:crashFile,original,after,mode:0o644},{path:untouched,original:'const untouched = true;\n',after:'const untouched = false;\n',mode:0o644}
 ]})
 const expanded=await expandTransactionLockPaths([crashFile])
 assert.ok(expanded.includes(crashFile));assert.ok(expanded.includes(untouched))
 await setTransactionPhase(tx,'applying')
 await writeFile(crashFile,after)
 await setTransactionPhase(tx,'applied',{pid:null})
 const dryRecovery=await codeWorkflowCall('code_edit_recover',{transactionId:tx.id,dryRun:true})
 assert.equal(dryRecovery.results[0].status,'recovery-needed')
 assert.equal(await read(crashFile),after)
 const recovered=await codeWorkflowCall('code_edit_recover',{transactionId:tx.id})
 assert.equal(recovered.results[0].status,'recovered')
 assert.equal(await read(crashFile),original)
 assert.equal(await read(untouched),'const untouched = true;\n')
 // Real subprocess crash: recovery must use the dead process PID, not a same-process simulation.
 const crashedFile=join(root,'subprocess-crash.js'),untouchedAfterCrash=join(root,'subprocess-untouched.js')
 await writeFile(crashedFile,'const subprocessCrash = 1;\\n')
 await writeFile(untouchedAfterCrash,'const subprocessUntouched = true;\\n')
 const journalUrl=new URL('./dsh-code-engine-journal.mjs',import.meta.url).href
 const childScript=[
  \"import {writeFile} from 'node:fs/promises'\",
  `const j=await import(${JSON.stringify(journalUrl)})`,
  \"const [target,untouched]=process.argv.slice(1)\",
  \"const original='const subprocessCrash = 1;\\\\n', after='const subprocessCrash = 2;\\\\n'\",
  \"const tx=await j.createTransaction({purpose:'subprocess-crash',files:[{path:target,original,after,mode:0o644},{path:untouched,original:'const subprocessUntouched = true;\\\\n',after:'const subprocessUntouched = false;\\\\n',mode:0o644}]})\",
  \"await j.setTransactionPhase(tx,'applying')\",
  \"await writeFile(target,after)\",
  \"process.exit(71)\"
 ].join('\\n')
 const child=spawnSync(process.execPath,['--input-type=module','-e',childScript,crashedFile,untouchedAfterCrash],{env:process.env,encoding:'utf8',timeout:10000})
 assert.equal(child.status,71,child.stderr||child.error?.message)
 const crashRecovery=await recoverTransactions({onlyPaths:[crashedFile],maxTransactions:10})
 assert.equal(crashRecovery.results.length,1,JSON.stringify(crashRecovery))
 assert.equal(crashRecovery.results[0].status,'recovered',JSON.stringify(crashRecovery.results[0]))
 assert.equal(await read(crashedFile),'const subprocessCrash = 1;\\n')
 assert.equal(await read(untouchedAfterCrash),'const subprocessUntouched = true;\\n')
 // Unknown external output is never overwritten by recovery.
 const conflictTx=await createTransaction({purpose:'conflict-test',files:[{path:crashFile,original,after,mode:0o644}]})
 await setTransactionPhase(conflictTx,'applying')
 await writeFile(crashFile,'const crash = 99;\n')
 await setTransactionPhase(conflictTx,'applied',{pid:null})
 const conflict=await codeWorkflowCall('code_edit_recover',{transactionId:conflictTx.id})
 assert.equal(conflict.results[0].status,'conflict')
 assert.match(await read(crashFile),/99/)
 const later=await codeWorkflowCall('code_edit_verify',{edits:[replace(crashFile,'99','100')]})
 assert.equal(later.ok,false)
 assert.equal(later.phase,'recovery')
 assert.match(await read(crashFile),/99/)
 console.log('[DSH] Durable journal crash recovery, conflict preservation and verified edit workflow: OK')
}finally{await rm(root,{recursive:true,force:true})}
