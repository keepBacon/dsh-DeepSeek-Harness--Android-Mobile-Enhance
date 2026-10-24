// DSH Code Engine: durable edit/verify/repair workflows.
import {readFile,lstat} from 'node:fs/promises'
import {resolve,extname} from 'node:path'
import {createHash} from 'node:crypto'
import {TextDecoder} from 'node:util'
import {codeCall} from './dsh-code-engine.mjs'
import {codeV4Call} from './dsh-code-engine-v4.mjs'
import {codeAstCall} from './dsh-code-engine-ast.mjs'
import {createTransaction,setTransactionPhase,rollbackTransaction,removeTransaction,recoverTransactions} from './dsh-code-engine-journal.mjs'

const obj=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false})
const str={type:'string'}
const edit=obj({path:str,oldText:str,newText:str,expectedSha256:str},['path','oldText','newText'])
const edits={type:'array',minItems:1,maxItems:32,items:edit}
const paths={type:'array',minItems:1,maxItems:32,items:str}
const verifyArgs={checkPaths:paths,command:str,args:{type:'array',maxItems:128,items:str},cwd:str,timeoutMs:{type:'integer',minimum:100,maximum:120000}}
export const codeWorkflowTools=[
 {name:'code_edit_verify',description:'Journal exact-context edits durably, run syntax/test verification, commit on success, and recover originals on failure or process crash.',inputSchema:obj({edits,...verifyArgs,dryRun:{type:'boolean'}},['edits'])},
 {name:'code_repair_candidates',description:'Try up to six model-supplied alternative edit batches; durably journal each, verify, recover failed candidates and stop on the first passing candidate or a rollback conflict.',inputSchema:obj({candidates:{type:'array',minItems:1,maxItems:6,items:obj({label:str,edits},['edits'])},...verifyArgs,dryRun:{type:'boolean'}},['candidates'])},
 {name:'code_diagnostics_compare',description:'Durably journal a temporary edit, compare TypeScript diagnostics before/after, and restore original files even after a process crash.',inputSchema:obj({edits,files:paths,projectFiles:{type:'array',maxItems:128,items:str},semantic:{type:'boolean'}},['edits'])},
 {name:'code_edit_recover',description:'Inspect or recover abandoned Code Engine edit transactions after process termination. Unknown external changes are reported as conflicts and never overwritten.',inputSchema:obj({transactionId:str,maxTransactions:{type:'integer',minimum:1,maximum:100},dryRun:{type:'boolean'}},[])},
 {name:'code_change_impact',description:'Combine TypeScript semantic references with reverse module dependency impact for the symbol at a source location.',inputSchema:obj({root:str,file:str,line:{type:'integer',minimum:1},column:{type:'integer',minimum:1},projectFiles:{type:'array',minItems:1,maxItems:128,items:str},maxResults:{type:'integer',minimum:1,maximum:500},maxFiles:{type:'integer',minimum:1,maximum:4000},maxDepth:{type:'integer',minimum:1,maximum:32}},['file','line','column','projectFiles'])},
]
const digest=x=>createHash('sha256').update(x).digest('hex')
const decoder=new TextDecoder('utf-8',{fatal:true})
function normalizePath(path){if(typeof path!=='string'||!path.trim())throw Error('edit path must be a nonempty string');return resolve(path)}
async function readSource(path){
 const meta=await lstat(path)
 if(meta.isSymbolicLink()||!meta.isFile())throw Error('source must be a regular non-symlink file: '+path)
 if(meta.size>16*1024*1024)throw Error('source exceeds 16 MiB: '+path)
 const bytes=await readFile(path),content=decoder.decode(bytes)
 if(content.includes('\u0000'))throw Error('binary source cannot be edited: '+path)
 return {path,content,sha256:digest(bytes),mode:meta.mode&0o7777}
}
async function planEdits(batch){
 if(!Array.isArray(batch)||batch.length<1||batch.length>32)throw Error('edits must contain 1..32 entries')
 const planned=new Map(),normalized=[]
 for(const entry of batch){
  const path=normalizePath(entry.path)
  if(typeof entry.oldText!=='string'||typeof entry.newText!=='string')throw Error('oldText and newText must be strings')
  if(!entry.oldText)throw Error('empty edit context for '+path)
  let row=planned.get(path)
  if(!row){row=await readSource(path);row.original=row.content;row.after=row.content;planned.set(path,row)}
  if(entry.expectedSha256&&entry.expectedSha256.toLowerCase()!==row.sha256)throw Error('stale source hash: '+path)
  const count=row.after.split(entry.oldText).length-1
  if(count!==1)throw Error(path+': edit context must occur exactly once, found '+count)
  row.after=row.after.replace(entry.oldText,entry.newText)
  if(Buffer.byteLength(row.after,'utf8')>16*1024*1024)throw Error('result exceeds 16 MiB: '+path)
  normalized.push({...entry,path,expectedSha256:row.sha256})
 }
 return {rows:[...planned.values()],normalized}
}
function verificationArgs(args,changed){
 if(args.checkPaths!==undefined&&(!Array.isArray(args.checkPaths)||args.checkPaths.length<1||args.checkPaths.length>32))throw Error('checkPaths must contain 1..32 files')
 const supplied=args.checkPaths??changed.filter(p=>['.js','.mjs','.cjs'].includes(extname(p).toLowerCase()))
 if(!supplied.length&&args.command===undefined)throw Error('a verification command or JS checkPaths is required')
 if(args.command!==undefined&&(typeof args.command!=='string'||!args.command.trim()))throw Error('command must be a nonempty executable')
 if(args.args!==undefined&&(!Array.isArray(args.args)||args.args.length>128||args.args.some(x=>typeof x!=='string')))throw Error('args must contain at most 128 strings')
 return supplied.length?{paths:supplied,command:args.command,args:args.args,cwd:args.cwd,timeoutMs:args.timeoutMs}:{command:args.command,args:args.args,cwd:args.cwd,timeoutMs:args.timeoutMs}
}
function compactVerification(value){return {ok:value.ok,failedPhase:value.failedPhase,results:value.results,nextAction:value.nextAction}}
async function recoverBeforeEdit(paths){
 const recovered=await recoverTransactions({maxTransactions:100})
 const targets=new Set(paths.map(resolve))
 const unresolved=recovered.results.filter(item=>
  ['conflict','active-skipped'].includes(item.status)&&item.files?.some(file=>targets.has(resolve(file))))
 if(unresolved.length)throw Object.assign(Error('unresolved edit transaction overlaps target files: '+unresolved.map(x=>x.id).join(', ')),{code:'DSH_RECOVERY_CONFLICT',transactions:unresolved})
 return recovered
}
async function assertExpectedOutput(transaction){
 for(const item of transaction.manifest.files){
  const meta=await lstat(item.path)
  if(meta.isSymbolicLink()||!meta.isFile())throw Error('source changed after edit: '+item.path)
  const bytes=await readFile(item.path)
  if(digest(bytes)!==item.afterSha256)throw Error('source changed after edit: '+item.path)
 }
}
async function finalizeCommitted(transaction){
 await setTransactionPhase(transaction,'verified',{pid:null})
 try{await removeTransaction(transaction);return {cleanupPending:false}}
 catch(error){return {cleanupPending:true,error:String(error.message||error)}}
}
async function execute(batch,args){
 if(!Array.isArray(batch)||batch.length<1||batch.length>32)throw Error('edits must contain 1..32 entries')
 const requestedPaths=[...new Set(batch.map(entry=>normalizePath(entry.path)))]
 let recovery={results:[]}
 if(args.dryRun!==true){try{recovery=await recoverBeforeEdit(requestedPaths)}catch(error){return {ok:false,phase:'recovery',error:String(error.message||error),transactions:error?.transactions}}}
 const prepared=await planEdits(batch),changed=prepared.rows.map(x=>x.path)
 const verify=verificationArgs(args,changed)
 const preview=await codeCall('code_multi_edit',{edits:prepared.normalized,dryRun:true})
 if(args.dryRun===true)return {ok:true,dryRun:true,preview,verificationSkipped:true}
 let transaction
 try{
  transaction=await createTransaction({purpose:'edit-verify',files:prepared.rows.map(x=>({path:x.path,original:x.original,after:x.after,mode:x.mode}))})
  await setTransactionPhase(transaction,'applying')
  await codeCall('code_multi_edit',{edits:prepared.normalized})
  await assertExpectedOutput(transaction)
  await setTransactionPhase(transaction,'applied')
 }catch(error){
  if(!transaction)return {ok:false,phase:'journal-or-edit',error:String(error.message||error),recovery}
  let rollback
  try{rollback=await rollbackTransaction(transaction)}catch(e){rollback={ok:false,id:transaction.id,error:String(e.message||e)}}
  return {ok:false,phase:'edit',error:String(error.message||error),rollback,recovery}
 }
 let result
 try{result=await codeV4Call('code_verify',verify)}
 catch(error){result={ok:false,failedPhase:'verification',results:[],nextAction:String(error.message||error)}}
 if(result.ok){
  try{
   const finalized=await finalizeCommitted(transaction)
   return {ok:true,dryRun:false,preview,verification:compactVerification(result),changedFiles:changed,recovery,cleanupPending:finalized.cleanupPending,transactionId:finalized.cleanupPending?transaction.id:undefined}
  }catch(error){
   let rollback
   try{rollback=await rollbackTransaction(transaction)}catch(cause){rollback={ok:false,id:transaction.id,error:String(cause.message||cause)}}
   return {ok:false,phase:'journal-commit',error:String(error.message||error),rollback,preview,verification:compactVerification(result),recovery}
  }
 }
 let rollback
 try{rollback=await rollbackTransaction(transaction)}catch(error){rollback={ok:false,id:transaction.id,error:String(error.message||error)}}
 return {ok:false,dryRun:false,phase:result.failedPhase,preview,verification:compactVerification(result),rollback,changedFiles:changed,recovery}
}
async function candidates(args){
 if(!Array.isArray(args.candidates)||!args.candidates.length||args.candidates.length>6)throw Error('candidates must contain 1..6 edit batches')
 const attempts=[]
 for(let i=0;i<args.candidates.length;i++){
  const item=args.candidates[i]
  let result
  try{result=await execute(item.edits,args)}
  catch(error){result={ok:false,phase:error?.code==='DSH_RECOVERY_CONFLICT'?'recovery':'prepare',error:String(error.message||error),transactions:error?.transactions}}
  attempts.push({index:i,label:item.label||'candidate-'+(i+1),...result})
  if(args.dryRun===true)continue
  if(result.ok)return {ok:true,selected:i,attempts,nextAction:null}
  if(result.rollback&&!result.rollback.ok)return {ok:false,selected:null,stoppedForRollbackConflict:true,attempts,nextAction:'Resolve the reported rollback conflict before applying another candidate.'}
  if(result.phase==='recovery')return {ok:false,selected:null,stoppedForRecoveryConflict:true,attempts,nextAction:'Run code_edit_recover and inspect the conflicting files before continuing.'}
  if(result.phase==='edit'&&result.rollback?.ok===false)return {ok:false,selected:null,stoppedForRollbackConflict:true,attempts,nextAction:'Inspect the transaction journal; no further candidate was applied.'}
 }
 return {ok:args.dryRun===true?attempts.every(x=>x.ok):false,dryRun:args.dryRun===true,selected:null,attempts,nextAction:args.dryRun===true?'Review previews and choose a candidate.':'All candidates failed; use diagnostics to generate another patch.'}
}
async function collectDiagnostics(files,projectFiles,semantic){
 const out=[]
 for(const file of files){
  const result=await codeAstCall('code_ast_diagnostics',{file,projectFiles,semantic,maxResults:200})
  out.push({file:resolve(file),ok:result.ok,diagnostics:result.diagnostics,total:result.total,truncated:result.truncated})
 }
 return out
}
async function compare(args){
 if(!Array.isArray(args.edits)||args.edits.length<1||args.edits.length>32)throw Error('edits must contain 1..32 entries')
 await recoverBeforeEdit([...new Set(args.edits.map(entry=>normalizePath(entry.path)))])
 const prepared=await planEdits(args.edits),changed=prepared.rows.map(x=>x.path)
 const files=args.files??changed
 if(!Array.isArray(files)||!files.length||files.length>32)throw Error('files must contain 1..32 source files')
 const all=[...new Set(files.map(normalizePath))]
 const before=await collectDiagnostics(all,args.projectFiles,args.semantic)
 await codeCall('code_multi_edit',{edits:prepared.normalized,dryRun:true})
 const transaction=await createTransaction({purpose:'temporary-diagnostics-compare',files:prepared.rows.map(x=>({path:x.path,original:x.original,after:x.after,mode:x.mode}))})
 let after,error
 try{
  await setTransactionPhase(transaction,'applying')
  await codeCall('code_multi_edit',{edits:prepared.normalized})
  await assertExpectedOutput(transaction)
  await setTransactionPhase(transaction,'applied')
  after=await collectDiagnostics(all,args.projectFiles,args.semantic)
 }catch(cause){error=String(cause.message||cause)}
 let rollback
 try{rollback=await rollbackTransaction(transaction)}catch(cause){rollback={ok:false,id:transaction.id,error:String(cause.message||cause)}}
 if(error)return {ok:false,error,restored:rollback.ok,rollback,before,after:after||null}
 const fingerprint=d=>String(d.code)+'|'+d.category+'|'+d.message
 const diff=all.map((file,i)=>{
  const initial=new Set(before[i].diagnostics.map(fingerprint)),final=new Set(after[i].diagnostics.map(fingerprint))
  return {file,beforeErrors:before[i].total,afterErrors:after[i].total,
   resolved:before[i].diagnostics.filter(x=>!final.has(fingerprint(x))),
   introduced:after[i].diagnostics.filter(x=>!initial.has(fingerprint(x)))}
 })
 return {ok:rollback.ok&&!diff.some(x=>x.introduced.length),restored:rollback.ok,rollback,before,after,diff,approximate:true}
}
async function changeImpact(args){
 const file=resolve(args.file),root=resolve(args.root||'.')
 const references=await codeAstCall('code_ast_references',{file,line:args.line,column:args.column,projectFiles:args.projectFiles,maxResults:args.maxResults})
 const dependency=await codeV4Call('code_impact',{root,changedFiles:[file],maxFiles:args.maxFiles,maxDepth:args.maxDepth})
 const refFiles=[...new Set(references.locations.map(x=>x.path))]
 const dependentAbsolute=dependency.affectedFiles.map(p=>resolve(root,p))
 return {strategy:'typescript-symbol-references+static-module-graph',file,referenceCount:references.total,
  references:references.locations,referenceFiles:refFiles,dependencyImpact:dependency,
  candidateFiles:[...new Set([file,...refFiles,...dependentAbsolute])],
  limitations:['Symbol references cover only the supplied projectFiles plus the selected file.','Module impact is a bounded static-import heuristic; inspect scan.complete before relying on completeness.']}
}
export async function codeWorkflowCall(name,args={}){
 switch(name){
  case 'code_edit_verify':return execute(args.edits,args)
  case 'code_repair_candidates':return candidates(args)
  case 'code_diagnostics_compare':return compare(args)
  case 'code_edit_recover':return recoverTransactions({transactionId:args.transactionId,maxTransactions:args.maxTransactions,dryRun:args.dryRun})
  case 'code_change_impact':return changeImpact(args)
  default:throw Error('unknown Code Engine workflow: '+name)
 }
}
