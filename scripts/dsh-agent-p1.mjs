/** Advisory subagent P1 extension: no impersonation, auto-spawn or unreviewed merges. */
import {createCoordinator} from './dsh-subagent-coordination.mjs'
import {codeIndexSnapshot} from './dsh-code-index.mjs'
import {codePatchConflict} from './dsh-code-p1.mjs'
import {codeTransactionStatus} from './dsh-code-transactions.mjs'
import {realpath,readFile,lstat} from 'node:fs/promises'
import {resolve} from 'node:path'
import {createHash} from 'node:crypto'
const sha=x=>createHash('sha256').update(x).digest('hex')
const text=(x,k)=>{if(typeof x!=='string'||!x.trim()||x.length>2000)throw Error('invalid '+k);return x}
const safe=p=>typeof p==='string'&&p.length>0&&p.length<=512&&!p.startsWith('/')&&!p.includes('\\')&&!p.split('/').includes('..')
const board=()=>createCoordinator()
export async function agentTaskDecompose(a={}){
 if(!Array.isArray(a.tasks)||a.tasks.length<1||a.tasks.length>64)throw Error('tasks required')
 const created=await board().create({tasks:a.tasks,maxParallel:a.maxParallel,maxAttempts:a.maxAttempts})
 return {...created,spawnedAgents:0,advisory:true}
}
export async function agentScopeAllocate(a={}){
 // Scopes are fixed in board tasks: never silently mutate scope of running jobs.
 const b=await board().status(text(a.boardId,'boardId'))
 const t=b.tasks.find(x=>x.id===a.taskId)
 if(!t)throw Error('task not found')
 return {boardId:b.boardId,taskId:t.id,writeScopes:t.writeScopes,owner:t.owner,
  conflicts:b.ready.find(x=>x.id===t.id)?.conflicts||[],revision:t.revision,updated:false,
  note:'Scope assignment is immutable; create a reviewed board for a changed allocation.'}
}
export async function agentSharedContext(a={}){
 const b=await board().status(text(a.boardId,'boardId'))
 return {boardId:b.boardId,version:b.version,tasks:b.tasks.map(x=>({
  id:x.id,status:x.status,blockedBy:x.blockedBy,writeScopes:x.writeScopes,summary:x.summary,
  evidence:x.evidence,revision:x.revision
 })),advisory:true,credentialsShared:false}
}
export async function agentResultReview(a={}){
 const b=await board().status(text(a.boardId,'boardId'))
 const task=b.tasks.find(x=>x.id===a.taskId)
 if(!task)throw Error('task not found')
 const root=await realpath(resolve(a.root||'.')),files=[]
 if(!Array.isArray(a.paths)||!a.paths.length||a.paths.length>16)throw Error('paths required')
 for(const p of a.paths){
  if(!safe(p))throw Error('unsafe file')
  if(task.writeScopes.length&&!task.writeScopes.some(s=>p===s||p.startsWith(s+'/')))throw Error('OUT_OF_SCOPE')
  const path=resolve(root,p)
  if(!path.startsWith(root+'/'))throw Error('outside workspace')
  // Reject symlinks at every path segment, not only the final file.
  let walk=root
  for(const segment of p.split('/')){
   if(!segment||segment==='.'||segment==='..')throw Error('unsafe file segment')
   walk=resolve(walk,segment)
   const st=await lstat(walk)
   if(st.isSymbolicLink())throw Error('SYMLINK_IN_REVIEW_PATH')
  }
  const real=await realpath(path)
  if(!real.startsWith(root+'/'))throw Error('outside workspace')
  const st=await lstat(path)
  if(!st.isFile()||st.size>1024*1024)throw Error('unsafe review file')
  const bytes=await readFile(path)
  if(bytes.length>1024*1024)throw Error('file oversized')
  files.push({path:p,sha256:sha(bytes)})
 }
 const state=await codeTransactionStatus({root})
 return {boardId:b.boardId,taskId:task.id,status:task.status,owner:task.owner,files,
  unresolved:state.unresolved,approved:false,needsIndependentReview:true}
}
export async function agentMergeGuard(a={}){
 const review=await agentResultReview(a)
 const b=await board().status(a.boardId),task=b.tasks.find(t=>t.id===a.taskId)
 const dependencies=task.blockedBy.every(id=>b.tasks.some(t=>t.id===id&&t.status==='completed'))
 const verified=Array.isArray(task.evidence)&&task.evidence.some(e=>typeof e==='string'&&e.startsWith('PASSED '))
 // A PASSED label alone does not bind verification to the current files.
 const evidence=Array.isArray(task.evidence)?task.evidence:[]
 const hashesBound=review.files.length<=4&&review.files.every(file=>evidence.includes(file.path+' sha256:'+file.sha256.slice(0,20)))
 const passed=task.status==='completed'&&verified&&hashesBound&&!review.unresolved.length&&dependencies
 return {...review,dependenciesMet:dependencies,verificationEvidencePresent:verified,trackedHashesMatchEvidence:hashesBound,eligibleForManualMerge:passed,mergePerformed:false,
  note:'No automatic merge, no bypass of code verification or repository protection.'}
}
export async function agentFailureRecovery(a={}){
 const b=await board().status(text(a.boardId,'boardId'))
 return {boardId:b.boardId,version:b.version,failed:b.tasks.filter(t=>t.status==='failed'),
  pending:b.tasks.filter(t=>t.status==='pending').map(t=>t.id),
  ready:b.ready,automaticReassign:false,
  note:'Expired leases are refreshed by coordinator; retries require an explicit claim.'}
}
