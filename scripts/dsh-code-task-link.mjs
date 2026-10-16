import {fileURLToPath} from 'node:url'
/**
 * Coding Engine 2.0 / native DSH Subagent coordination adapter.
 *
 * It does not spawn agents or grant their identities: agentId is a cooperative
 * label used by the existing coordination board. A checked task can only be
 * finalized from the actual results of allowlisted verification recipes.
 *
 * Dry run is default. An explicit dryRun:false + finalize:true is required to
 * complete a task. Failing tests leave it running for a bounded repair loop.
 */
import {createHash} from 'node:crypto'
import {readFile,lstat,realpath} from 'node:fs/promises'
import {resolve,relative,dirname} from 'node:path'
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createCoordinator} from './dsh-subagent-coordination.mjs'
import {codeVerifyBatch} from './dsh-code-verify.mjs'
import {codeTransactionStatus} from './dsh-code-transactions.mjs'

const MAX_FILES=16,MAX_BYTES=1024*1024
const SHA=b=>createHash('sha256').update(b).digest('hex')
function rel(s){
 if(typeof s!=='string'||!s||s.length>512||s.startsWith('/')||s.includes('\\')||s.includes('\0')||s.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('invalid tracked path')
 return s
}
async function snapshot(root,paths){
 const base=await realpath(resolve(root||'.'))
 if(!(await lstat(base)).isDirectory())throw Error('workspace root is not a directory')
 if(!Array.isArray(paths)||!paths.length||paths.length>MAX_FILES)throw Error('trackedPaths must contain 1..16 files')
 const seen=new Set(),files=[]
 for(const value of paths){
  const path=rel(value)
  if(seen.has(path))throw Error('duplicate tracked path');seen.add(path)
  const target=resolve(base,path)
  if(relative(base,target).startsWith('..'))throw Error('workspace escape')
  let folder=dirname(target)
  while(folder!==base){
   const st=await lstat(folder)
   if(!st.isDirectory()||st.isSymbolicLink())throw Error('symlink directory forbidden')
   folder=dirname(folder)
  }
  const st=await lstat(target)
  if(!st.isFile()||st.isSymbolicLink()||st.size>MAX_BYTES)throw Error('invalid tracked source: '+path)
  files.push({path,sha256:SHA(await readFile(target)),bytes:st.size})
 }
 return {root:base,files}
}
function sameSnapshot(a,b){
 return a.root===b.root&&a.files.length===b.files.length&&a.files.every((f,i)=>f.path===b.files[i].path&&f.sha256===b.files[i].sha256)
}
function guardTask(board,taskId,agentId,revision){
 const task=board.tasks.find(t=>t.id===taskId)
 if(!task)throw Error('coding task not found')
 if(task.status!=='running'||task.owner!==agentId)throw Error('coding task not owned by subagent')
 if(task.revision!==revision)throw Error('TASK_STALE_REVISION: re-read board before verification')
 return task
}
export function createCodingTaskLink(coordinator=createCoordinator()){
 return {
  async verify(input={}){
   const {boardId,taskId,agentId,revision}=input
   if(typeof boardId!=='string'||typeof taskId!=='string'||typeof agentId!=='string'||!Number.isInteger(revision))throw Error('boardId, taskId, agentId and revision required')
   const verifiedPaths=await snapshot(input.root,input.trackedPaths)
   const board=await coordinator.status(boardId)
   guardTask(board,taskId,agentId,revision)
   const existing=await codeTransactionStatus({root:verifiedPaths.root})
   if(existing.unresolved.length)throw Error('CODING_TASK_UNRESOLVED_TRANSACTION: recover before verification')
   const dryRun=input.dryRun!==false
   const finalize=input.finalize===true
   if(finalize&&dryRun)throw Error('finalize requires dryRun:false')
   if(finalize&&(typeof input.summary!=='string'||!input.summary.trim()))throw Error('finalize requires a nonempty summary')
   if(!Array.isArray(input.verifications)||!input.verifications.length||input.verifications.length>4)throw Error('verifications must contain 1..4 recipes')
   if(dryRun){
    const preview=await codeVerifyBatch({root:verifiedPaths.root,verifications:input.verifications,
      concurrency:input.concurrency,dryRun:true,stopOnFailure:true})
    return {dryRun:true,finalized:false,boardId,taskId,revision,trackedFiles:verifiedPaths.files,preview}
   }
   // Renew the lease before potentially long tests. The native task board
   // still owns lifecycle and can reject this update if claim became stale.
   const heartbeat=await coordinator.update({boardId,taskId,agentId,revision,action:'heartbeat',leaseSeconds:1800})
   const nextRevision=heartbeat.task.revision
   const verification=await codeVerifyBatch({root:verifiedPaths.root,verifications:input.verifications,
     concurrency:input.concurrency,dryRun:false,stopOnFailure:input.stopOnFailure!==false})
   const after=await snapshot(verifiedPaths.root,input.trackedPaths)
   if(!sameSnapshot(verifiedPaths,after))return {dryRun:false,finalized:false,ok:false,boardId,taskId,revision:nextRevision,
     error:'CODING_TASK_CHANGED_DURING_VERIFICATION',verification,trackedFiles:after.files}
   const currentTransactions=await codeTransactionStatus({root:verifiedPaths.root})
   if(currentTransactions.unresolved.length)return{dryRun:false,finalized:false,ok:false,boardId,taskId,
     revision:nextRevision,error:'CODING_TASK_UNRESOLVED_TRANSACTION',verification}
   const passed=verification.executed===verification.requested&&!verification.stoppedEarly&&verification.results.every(r=>r.ok===true&&!r.dryRun)
   if(!passed)return{dryRun:false,finalized:false,ok:false,boardId,taskId,revision:nextRevision,
     error:'CODING_TASK_VERIFICATION_FAILED',verification,trackedFiles:after.files}
   if(!finalize)return{dryRun:false,finalized:false,ok:true,boardId,taskId,revision:nextRevision,verification,trackedFiles:after.files,
     note:'Passed verification is not a completed task until finalized.'}
   const evidence=[
    ...verification.results.map(r=>'PASSED '+r.preset+' '+(r.durationMs||0)+'ms'),
    ...after.files.slice(0,4).map(f=>f.path+' sha256:'+f.sha256.slice(0,20))
   ].slice(0,8)
   const updated=await coordinator.update({boardId,taskId,agentId,revision:nextRevision,
     action:'complete',summary:input.summary,evidence})
   return{dryRun:false,finalized:true,ok:true,boardId,taskId,revision:updated.task.revision,
     task:updated.task,verification}
  }
 }
}
async function selfTest(){
 const parent=await mkdtemp(join(tmpdir(),'dsh-coding-task-'))
 try{
  const home=join(parent,'state'),root=join(parent,'project')
  await mkdir(root)
  await writeFile(join(root,'ok.mjs'),'export const ok=1\n')
  await writeFile(join(root,'broken.mjs'),'export const = 2\n')
  const coordinator=createCoordinator(home),link=createCodingTaskLink(coordinator)
  const board=await coordinator.create({tasks:[{id:'impl',title:'Implement',writeScopes:['src']},
    {id:'qa',title:'Review',blockedBy:['impl'],writeScopes:['tests']}]})
  const claimed=await coordinator.claim({boardId:board.boardId,taskId:'impl',agentId:'agent-alpha'})
  const options={boardId:board.boardId,taskId:'impl',agentId:'agent-alpha',revision:claimed.task.revision,
    root,trackedPaths:['ok.mjs'],verifications:[{preset:'node-syntax',path:'ok.mjs'}]}
  const preview=await link.verify(options)
  if(!preview.dryRun||preview.finalized)throw Error('dry-run incorrectly completed task')
  const failing=await link.verify({...options,dryRun:false,verifications:[{preset:'node-syntax',path:'broken.mjs'}],finalize:true,summary:'not yet'})
  if(failing.ok||failing.finalized||failing.error!=='CODING_TASK_VERIFICATION_FAILED')throw Error('failed tests finalized a task')
  const status=await coordinator.status(board.boardId)
  if(status.counts.completed!==0||status.counts.running!==1)throw Error('failed verification changed lifecycle')
  let stale=false
  try{await link.verify({...options,dryRun:false})}catch(e){stale=/TASK_STALE_REVISION/.test(e.message)}
  if(!stale)throw Error('stale revision accepted')
  const complete=await link.verify({...options,revision:failing.revision,dryRun:false,finalize:true,summary:'Implementation passed syntax check'})
  if(!complete.ok||!complete.finalized||!complete.task.evidence.some(x=>x.startsWith('PASSED')))throw Error('passed task did not carry evidence')
  const summary=await coordinator.status(board.boardId)
  if(summary.counts.completed!==1||!summary.ready.some(x=>x.id==='qa'))throw Error('task dependency not released')
  process.stdout.write('[DSH] Coding + subagent task verification self-test: OK\n')
 }finally{await rm(parent,{recursive:true,force:true})}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)&&process.argv.includes('--self-test'))selfTest().catch(e=>{console.error(e);process.exitCode=1})
