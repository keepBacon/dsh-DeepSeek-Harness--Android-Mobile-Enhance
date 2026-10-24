// DSH Code Engine: staged test-and-repair workflows.
// Candidate edits are supplied explicitly by the calling model. This engine
// does not generate source code or use an external agent / security gate.
import {readFile, writeFile, rename, unlink, stat} from 'node:fs/promises'
import {dirname, basename, resolve, extname} from 'node:path'
import {randomBytes, createHash} from 'node:crypto'
import {TextDecoder} from 'node:util'
import {codeCall} from './dsh-code-engine.mjs'
import {codeV4Call} from './dsh-code-engine-v4.mjs'
import {codeAstCall} from './dsh-code-engine-ast.mjs'

const obj=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false})
const str={type:'string'}
const edit=obj({path:str,oldText:str,newText:str,expectedSha256:str},['path','oldText','newText'])
const edits={type:'array',minItems:1,maxItems:32,items:edit}
const paths={type:'array',minItems:1,maxItems:32,items:str}
const verifyArgs={checkPaths:paths,command:str,args:{type:'array',maxItems:128,items:str},cwd:str,timeoutMs:{type:'integer',minimum:100,maximum:120000}}
export const codeWorkflowTools=[
 {name:'code_edit_verify',description:'Apply exact-context edits, run syntax/test verification, then restore original files on verification failure. This is an opt-in verified edit, not a crash-safe journal.',inputSchema:obj({edits,...verifyArgs,dryRun:{type:'boolean'}},['edits'])},
 {name:'code_repair_candidates',description:'Try up to six model-supplied alternative edit batches; verify each candidate and roll back failures. Stop on first passing candidate or unsafe rollback.',inputSchema:obj({candidates:{type:'array',minItems:1,maxItems:6,items:obj({label:str,edits},['edits'])},...verifyArgs,dryRun:{type:'boolean'}},['candidates'])},
 {name:'code_diagnostics_compare',description:'Temporarily apply exact-context edits to compare TypeScript language-service diagnostics before/after. Restore the original source after comparison.',inputSchema:obj({edits,files:paths,projectFiles:{type:'array',maxItems:128,items:str},semantic:{type:'boolean'}},['edits'])},
]
const digest=x=>createHash('sha256').update(x).digest('hex')
const decoder=new TextDecoder('utf-8',{fatal:true})
function fileList(batch){
 if(!Array.isArray(batch)||batch.length<1||batch.length>32)throw Error('edits must contain 1..32 entries')
 return [...new Set(batch.map(e=>resolve(e.path)))]
}
async function snapshot(paths){
 const result=new Map()
 for(const path of paths){
  const info=await stat(path)
  if(!info.isFile()||info.size>16*1024*1024)throw Error('source missing or too large: '+path)
  const raw=await readFile(path),content=decoder.decode(raw)
  if(content.includes('\u0000'))throw Error('binary content cannot be edited: '+path)
  result.set(path,{path,content,sha256:digest(content),mode:info.mode})
 }
 return result
}
async function restore(files){
 const stages=[],installed=[],errors=[]
 try{
  // Stage all snapshots before changing any target. Concurrent modifications
  // are never silently overwritten: refuse a rollback if the current file
  // differs from the bytes installed by the candidate editor.
  for(const item of files.values()){
   const now=decoder.decode(await readFile(item.path))
   if(digest(now)!==item.appliedSha256)throw Error('rollback conflict (source changed after edit): '+item.path)
   const tmp=resolve(dirname(item.path),'.'+basename(item.path)+'.dsh-restore-'+randomBytes(8).toString('hex'))
   await writeFile(tmp,item.content,{flag:'wx',mode:item.mode})
   stages.push({item,tmp})
  }
  for(const {item,tmp} of stages){
   const now=decoder.decode(await readFile(item.path))
   if(digest(now)!==item.appliedSha256)throw Error('rollback conflict at commit: '+item.path)
   await rename(tmp,item.path)
   installed.push(item.path)
  }
 }catch(error){errors.push(String(error.message||error))}
 finally{
  for(const {tmp} of stages)await unlink(tmp).catch(()=>{})
 }
 return {ok:errors.length===0,errors,restoredFiles:installed,partial:installed.length>0&&installed.length<files.size}
}
function checkedVerification(a,changed){
 const checkPaths=a.checkPaths
 if(checkPaths!==undefined&&(!Array.isArray(checkPaths)||!checkPaths.length||checkPaths.length>32))throw Error('checkPaths must contain 1..32 files')
 const supplied=checkPaths??changed.filter(p=>['.js','.mjs','.cjs'].includes(extname(p).toLowerCase()))
 if(!supplied.length&&a.command===undefined)throw Error('a verification command or JS checkPaths is required')
 if(a.command!==undefined&&(typeof a.command!=='string'||!a.command.trim()))throw Error('command must be a nonempty executable')
 return supplied.length?{paths:supplied,command:a.command,args:a.args,cwd:a.cwd,timeoutMs:a.timeoutMs}:{command:a.command,args:a.args,cwd:a.cwd,timeoutMs:a.timeoutMs}
}
function compactVerification(verification){
 return {ok:verification.ok,failedPhase:verification.failedPhase,results:verification.results,nextAction:verification.nextAction}
}
async function applyCandidate(batch){
 const changed=fileList(batch),originals=await snapshot(changed)
 const preview=await codeCall('code_multi_edit',{edits:batch,dryRun:true})
 await codeCall('code_multi_edit',{edits:batch})
 const files=new Map()
 for(const [path,item] of originals){
  const now=decoder.decode(await readFile(path))
  files.set(path,{...item,appliedSha256:digest(now)})
 }
 return {files,preview}
}
async function attempt(batch,verifyOptions){
 const changed=fileList(batch),verificationArgs=checkedVerification(verifyOptions,changed)
 // Validate edit anchors and stale-hash preconditions before writing.
 const preview=await codeCall('code_multi_edit',{edits:batch,dryRun:true})
 if(verifyOptions.dryRun===true)return {ok:true,dryRun:true,preview,verificationSkipped:true}
 let pending
 try{pending=await applyCandidate(batch)}
 catch(error){return {ok:false,phase:'edit',error:String(error.message||error),rolledBackByEditor:true}}
 let verify
 try{verify=await codeV4Call('code_verify',verificationArgs)}
 catch(error){verify={ok:false,failedPhase:'verification',results:[],nextAction:String(error.message||error)}}
 if(verify.ok)return {ok:true,dryRun:false,preview,verification:compactVerification(verify),changedFiles:changed}
 const rollback=await restore(pending.files)
 return {ok:false,dryRun:false,phase:verify.failedPhase,verification:compactVerification(verify),rollback,changedFiles:changed}
}
async function candidates(args){
 if(!Array.isArray(args.candidates)||!args.candidates.length||args.candidates.length>6)throw Error('candidates must contain 1..6 edit batches')
 const attempts=[]
 for(let i=0;i<args.candidates.length;i++){
  const item=args.candidates[i]
  let result
  try{result=await attempt(item.edits,args)}
  catch(error){result={ok:false,phase:'prepare',error:String(error.message||error)}}
  attempts.push({index:i,label:item.label||'candidate-'+(i+1),...result})
  if(args.dryRun===true)continue
  if(result.ok)return {ok:true,selected:i,attempts}
  if(result.rollback&&!result.rollback.ok)return {ok:false,selected:null,stoppedForRollbackConflict:true,attempts}
  if(result.phase==='edit'&&!result.rolledBackByEditor)return {ok:false,selected:null,stoppedForEditFailure:true,attempts}
 }
 return {ok:args.dryRun===true?attempts.every(x=>x.ok):false,dryRun:args.dryRun===true,selected:null,attempts}
}
async function compare(args){
 const changed=fileList(args.edits)
 const files=args.files??changed
 if(!Array.isArray(files)||!files.length||files.length>32)throw Error('files must contain 1..32 source files')
 const all=[...new Set(files.map(p=>resolve(p)))]
 const collect=async()=>{
  const out=[]
  for(const file of all){
   const result=await codeAstCall('code_ast_diagnostics',{file,projectFiles:args.projectFiles,semantic:args.semantic,maxResults:200})
   out.push({file,ok:result.ok,diagnostics:result.diagnostics,total:result.total,truncated:result.truncated})
  }
  return out
 }
 const before=await collect()
 // Only compare sources while staged changes are applied. All failure paths
 // attempt rollback; failures are surfaced and never reported as success.
 await codeCall('code_multi_edit',{edits:args.edits,dryRun:true})
 const pending=await applyCandidate(args.edits)
 let after,error
 try{after=await collect()}
 catch(cause){error=String(cause.message||cause)}
 const rollback=await restore(pending.files)
 if(error)throw Error('diagnostics comparison failed: '+error+'; rollback='+JSON.stringify(rollback))
 const fingerprint=d=>String(d.code)+'|'+d.category+'|'+d.message
 const diff=all.map((file,i)=>{
  const initial=new Set(before[i].diagnostics.map(fingerprint))
  const final=new Set(after[i].diagnostics.map(fingerprint))
  return {file,beforeErrors:before[i].total,afterErrors:after[i].total,
   resolved:before[i].diagnostics.filter(x=>!final.has(fingerprint(x))),
   introduced:after[i].diagnostics.filter(x=>!initial.has(fingerprint(x)))}
 })
 return {ok:rollback.ok&&!diff.some(x=>x.introduced.length),restored:rollback.ok,rollback,before,after,diff,approximate:true}
}
export async function codeWorkflowCall(name,args={}){
 switch(name){
  case 'code_edit_verify':return attempt(args.edits,args)
  case 'code_repair_candidates':return candidates(args)
  case 'code_diagnostics_compare':return compare(args)
  default:throw Error('unknown Code Engine workflow: '+name)
 }
}
