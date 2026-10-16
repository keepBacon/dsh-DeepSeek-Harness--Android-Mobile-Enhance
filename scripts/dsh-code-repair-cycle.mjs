/**
 * DSH Coding Engine 2.0 - bounded candidate repair and verification cycle.
 *
 * No untrusted code generation, no arbitrary shell and no silent source edits.
 * Caller supplies ordered, SHA-256-guarded patch candidates and explicitly
 * sets dryRun:false. Each failed attempt is compensated with another journaled
 * transaction. External modifications are preserved and stop the cycle.
 *
 * Candidate generation by a model must happen outside this module through the
 * existing DSH agent. This tool executes an approved bounded candidate list.
 */
import {createHash} from 'node:crypto'
import {lstat,readFile,realpath,writeFile,mkdtemp,mkdir,rm} from 'node:fs/promises'
import {resolve,dirname,relative,join} from 'node:path'
import {tmpdir} from 'node:os'
import {runCodeTransaction,codeTransactionStatus} from './dsh-code-transactions.mjs'
import {codeVerifyBatch} from './dsh-code-verify.mjs'

const MAX_CANDIDATES=3,MAX_CHANGES=16,MAX_BYTES=1024*1024
const sha=s=>createHash('sha256').update(s).digest('hex')
const safeRel=s=>typeof s==='string'&&s.length>0&&s.length<=512&&!s.startsWith('/')&&!s.includes('\0')&&!s.includes('\\')&&!s.split('/').some(x=>x===''||x==='.'||x==='..')
async function checkedRoot(root){
 const path=await realpath(resolve(root||'.'))
 if(!(await lstat(path)).isDirectory())throw Error('repair root must be a directory')
 return path
}
async function snapshot(root,change){
 if(!change||typeof change!=='object'||!safeRel(change.path))throw Error('unsafe repair path')
 const path=resolve(root,change.path)
 if(relative(root,path).startsWith('..'))throw Error('path escapes workspace')
 let parent=dirname(path)
 while(parent!==root){
  const st=await lstat(parent)
  if(!st.isDirectory()||st.isSymbolicLink())throw Error('symlink directory forbidden')
  parent=dirname(parent)
 }
 const stat=await lstat(path)
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_BYTES)throw Error('file must be regular and <= 1 MiB')
 const bytes=await readFile(path)
 const text=bytes.toString('utf8')
 if(!Buffer.from(text,'utf8').equals(bytes))throw Error('non-UTF8 file cannot be edited')
 return{text,path,hash:sha(bytes)}
}
function assertOptions(input){
 const attempts=input.candidates
 if(!Array.isArray(attempts)||!attempts.length||attempts.length>MAX_CANDIDATES)throw Error('candidates must contain 1..3 attempts')
 if(!Array.isArray(input.verifications)||!input.verifications.length||input.verifications.length>4)throw Error('verifications must contain 1..4 recipes')
 for(const [i,candidate] of attempts.entries()){
  if(!candidate||typeof candidate!=='object'||!Array.isArray(candidate.changes)||!candidate.changes.length||candidate.changes.length>MAX_CHANGES)throw Error('candidate '+i+' needs 1..16 changes')
  for(const change of candidate.changes){
   if(!safeRel(change.path)||typeof change.expectedSha256!=='string'||!/^[0-9a-f]{64}$/.test(change.expectedSha256)||typeof change.oldText!=='string'||!change.oldText||typeof change.newText!=='string'||!change.newText)throw Error('invalid reversible SHA-256 patch')
  }
 }
}
async function reversible(root,changes){
 const reverse=[],seen=new Set()
 for(const change of changes){
  if(seen.has(change.path))throw Error('duplicate changed path')
  seen.add(change.path)
  const entry=await snapshot(root,change)
  if(entry.hash!==change.expectedSha256)throw Error('CODING_REPAIR_STALE: '+change.path)
  const n=entry.text.split(change.oldText).length-1
  if(n!==1)throw Error('CODING_REPAIR_AMBIGUOUS: '+change.path+' '+n+' matches')
  const after=entry.text.replace(change.oldText,change.newText)
  if(Buffer.byteLength(after)>MAX_BYTES)throw Error('candidate would exceed file limit')
  if(after.split(change.newText).length-1!==1)throw Error('CODING_REPAIR_NON_REVERSIBLE: newText is ambiguous in resulting file')
  reverse.push({path:change.path,expectedSha256:sha(Buffer.from(after)),oldText:change.newText,newText:change.oldText})
 }
 return reverse
}
function conciseVerification(result){
 return{requested:result.requested,executed:result.executed,stoppedEarly:result.stoppedEarly,
  results:result.results.map(r=>({preset:r.preset,ok:r.ok===true,skipped:!!r.skipped,exitCode:r.exitCode??null,
   timedOut:!!r.timedOut,durationMs:r.durationMs??null,diagnostics:r.diagnostics?.diagnostics?.slice(0,8)||[],
   stderrPreview:typeof r.stderr==='string'?r.stderr.slice(-1200):undefined,error:r.error??null}))}
}
export async function codeRepairCycle(input={}){
 assertOptions(input)
 const root=await checkedRoot(input.root)
 const dryRun=input.dryRun!==false
 const budgetMs=Number.isInteger(input.budgetMs)?Math.max(10000,Math.min(300000,input.budgetMs)):90000
 const began=Date.now(),deadline=began+budgetMs
 const unresolved=await codeTransactionStatus({root})
 if(unresolved.unresolved.length)throw Error('CODING_REPAIR_RECOVERY_REQUIRED: resolve outstanding transaction before repair')
 if(dryRun){
  const previews=[]
  for(const candidate of input.candidates){
   await reversible(root,candidate.changes)
   const preview=await runCodeTransaction({root,changes:candidate.changes,dryRun:true})
   previews.push({changes:preview.changes,reversible:true})
  }
  return{dryRun:true,budgetMs,attempts:previews,verificationPreview:{
   presets:input.verifications.map(v=>v.preset),note:'Nothing executed or modified'},ok:null}
 }
 const attempts=[]
 for(const [index,candidate]of input.candidates.entries()){
  if(Date.now()>=deadline)break
  const undo=await reversible(root,candidate.changes)
  let applied
  try{applied=await runCodeTransaction({root,changes:candidate.changes,dryRun:false})}
  catch(error){return{dryRun:false,ok:false,stopped:'edit_failed',attempts,error:String(error.message||error),durationMs:Date.now()-began}}
  let verification=null,error=null
  try{
   const remaining=Math.max(1000,deadline-Date.now())
   const recipes=input.verifications.map(v=>({...v,timeoutMs:Math.min(Number.isInteger(v.timeoutMs)?v.timeoutMs:remaining,Math.max(1000,Math.floor(remaining/input.verifications.length)))}))
   verification=await codeVerifyBatch({root,verifications:recipes,concurrency:1,dryRun:false,stopOnFailure:true})
  }catch(e){error=String(e.message||e)}
  const success=!error&&verification?.executed===verification?.requested&&
   !verification?.stoppedEarly&&verification?.results.every(v=>v.ok===true&&!v.dryRun)
  if(success){
   return{dryRun:false,ok:true,completedAttempt:index+1,transactionId:applied.id,
    attempts:[...attempts,{attempt:index+1,state:'verified',transactionId:applied.id,verification:conciseVerification(verification)}],
    durationMs:Date.now()-began,note:'Tests passed. Full Android/Termux build and device verification remain separate.'}
  }
  const record={attempt:index+1,state:'failed',transactionId:applied.id,
    verification:verification?conciseVerification(verification):null,error}
  try{
   const reverted=await runCodeTransaction({root,changes:undo,dryRun:false})
   record.rollbackTransactionId=reverted.id;record.state='rolled_back'
  }catch(rollbackError){
   record.state='needs_review'
   record.error=(record.error||'')+'; rollback: '+String(rollbackError.message||rollbackError)
   attempts.push(record)
   return{dryRun:false,ok:false,stopped:'rollback_conflict',attempts,durationMs:Date.now()-began,
    note:'External file modifications are preserved. Inspect transaction status and resolve manually.'}
  }
  attempts.push(record)
 }
 return{dryRun:false,ok:false,stopped:Date.now()>=deadline?'budget_exceeded':'candidates_exhausted',
  attempts,durationMs:Date.now()-began}
}
async function selfTest(){
 const folder=await mkdtemp(join(tmpdir(),'dsh-repair-'))
 const prior=process.env.DSH_CODE_TX_HOME
 process.env.DSH_CODE_TX_HOME=join(folder,'transactions')
 try{
  const root=join(folder,'workspace')
  await mkdir(root)
  const path=join(root,'source.mjs')
  const original='export const value = 1;\n'
  await writeFile(path,original)
  const wrong='export const = 2;\n'
  const good='export const value = 2;\n'
  const make=after=>({changes:[{path:'source.mjs',expectedSha256:sha(Buffer.from(original)),
    oldText:original,newText:after}]})
  const args={root,candidates:[make(wrong),make(good)],verifications:[{preset:'node-syntax',path:'source.mjs'}]}
  const dry=await codeRepairCycle(args)
  if(!dry.dryRun||await readFile(path,'utf8')!==original)throw Error('repair preview modified source')
  const res=await codeRepairCycle({...args,dryRun:false})
  if(!res.ok||res.completedAttempt!==2||res.attempts[0].state!=='rolled_back'||await readFile(path,'utf8')!==good)throw Error('bounded retry or restoration failed')
  await writeFile(path,original)
  const fail=await codeRepairCycle({...args,candidates:[make(wrong)],dryRun:false})
  if(fail.ok||fail.attempts[0].state!=='rolled_back'||await readFile(path,'utf8')!==original)throw Error('failed candidate not compensated')
  let stale=false
  try{await codeRepairCycle({...args,candidates:[make(wrong)],dryRun:true})}catch(e){stale=false}
  await writeFile(path,'new external edit\n')
  try{await codeRepairCycle({...args,dryRun:true})}catch(e){stale=/STALE/.test(e.message)}
  if(!stale)throw Error('stale candidate accepted')
  process.stdout.write('[DSH] Coding repair cycle self-test: OK\n')
 }finally{if(prior===undefined)delete process.env.DSH_CODE_TX_HOME;else process.env.DSH_CODE_TX_HOME=prior;await rm(folder,{recursive:true,force:true})}
}
if(process.argv.includes('--self-test'))selfTest().catch(e=>{console.error(e);process.exitCode=1})
