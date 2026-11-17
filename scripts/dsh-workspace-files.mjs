// P2 project-level file transactions: create, move, remove, journal and recover.
// Only regular files inside the explicit project root are eligible. Existing
// source-text edits continue to use code_edit_verify and its journal.
import {createHash,randomBytes} from 'node:crypto'
import {mkdir,readFile,writeFile,rename,rm,readdir,lstat,realpath,link,open} from 'node:fs/promises'
import {resolve,join,dirname,basename,sep,isAbsolute,relative} from 'node:path'
import {homedir} from 'node:os'
import {acquirePathLocks} from './dsh-code-engine-journal.mjs'
import {projectBuildCall} from './dsh-project-build.mjs'
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
async function durableWrite(path,data,mode=0o600){
 const fd=await open(path,'wx',mode)
 try{await fd.writeFile(data);await fd.sync()}finally{await fd.close()}
}
async function syncDir(dir){
 let fd
 try{fd=await open(dir,'r');await fd.sync()}
 catch(e){
  // Some Android filesystems do not allow opening directories as FDs.
  if(!['EINVAL','EISDIR','EPERM','EACCES','EOPNOTSUPP'].includes(e.code))throw e
 }finally{await fd?.close()}
}
const obj=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false})
const str={type:'string'}
const operation=obj({type:{type:'string',enum:['create','replace','move','delete']},path:str,to:str,content:str,expectedSha256:str},['type','path'])
export const projectFileTools=[
 {name:'workspace_refactor',description:'Create, replace, move or delete up to 24 regular project files with dry-run and durable transaction recovery. Text edits use code_edit_verify.',inputSchema:obj({root:str,operations:{type:'array',items:operation,minItems:1,maxItems:24},dryRun:{type:'boolean'},verify:{type:'boolean'},runTests:{type:'boolean'},system:str,timeoutMs:{type:'integer',minimum:1000,maximum:3600000},lockTimeoutMs:{type:'integer',minimum:100,maximum:60000}},['root','operations'])},
 {name:'workspace_refactor_recover',description:'Recover incomplete project file transactions without overwriting files changed externally. Reports conflicts.',inputSchema:obj({root:str,dryRun:{type:'boolean'}},['root'])},
]
export const isProjectFileTool=name=>projectFileTools.some(x=>x.name===name)
const inRoot=(path,root)=>path.startsWith(root+sep)
const baseRoot=()=>process.env.DSH_WORKSPACE_JOURNAL_DIR||join(process.env.HOME||homedir(),'.dsh','workspace-refactor')
const journalPath=(root)=>join(baseRoot(),sha(root))
const decode=(x,name)=>{if(typeof x!=='string'||x.includes('\0'))throw Error('invalid '+name);return x}
async function rootPath(value){const root=await realpath(resolve(decode(value,'root')));if(!(await lstat(root)).isDirectory())throw Error('root must be a directory');return root}
function filePath(root,value){
 if(!value||isAbsolute(value)||value.includes('\0')||value.split(/[\\/]/).includes('..'))
  throw Error('file paths must be relative and within the project')
 const path=resolve(root,value)
 if(!inRoot(path,root))throw Error('path escapes workspace: '+value)
 return path
}
async function safeParent(root,path){
 let current=dirname(path)
 while(current!==root){
  if(!inRoot(current,root))throw Error('parent escapes workspace')
  const st=await lstat(current)
  if(st.isSymbolicLink()||!st.isDirectory())throw Error('directory parent must be a real directory: '+current)
  current=dirname(current)
 }
}
async function existing(path){
 try{
  const st=await lstat(path)
  if(st.isSymbolicLink()||!st.isFile())throw Error('only regular, non-symlink project files are supported: '+path)
  if(st.size>8*1024*1024)throw Error('source exceeds 8 MiB transaction limit')
  const bytes=await readFile(path)
  return {hash:sha(bytes),bytes,mode:st.mode&0o7777}
 }catch(e){if(e.code==='ENOENT')return null;throw e}
}
async function validated(root,ops){
 if(!Array.isArray(ops)||ops.length<1||ops.length>24)throw Error('operations require 1..24 actions')
 const used=new Set(),rows=[]
 for(const op of ops){
  if(!op||!['create','replace','move','delete'].includes(op.type))throw Error('unsupported operation')
  const from=filePath(root,decode(op.path,'path')),to=op.type==='move'?filePath(root,decode(op.to,'to')):null
  for(const path of [from,to].filter(Boolean)){
   if(used.has(path))throw Error('each file may occur in only one operation: '+path)
   used.add(path);await safeParent(root,path)
  }
  const old=await existing(from)
  const dest=to?await existing(to):null
  if(op.type==='create'){
   if(old)throw Error('create target already exists: '+from)
  }else if(!old)throw Error('operation source missing: '+from)
  if(['create','replace'].includes(op.type)&&
     (typeof op.content!=='string'||Buffer.byteLength(op.content)>8*1024*1024))
    throw Error('content must be UTF-8 text <= 8 MiB')
  if(dest)throw Error('move target exists: '+to)
  if(op.expectedSha256&&old?.hash!==op.expectedSha256.toLowerCase())throw Error('stale source hash: '+from)
  const after=['create','replace'].includes(op.type)?Buffer.from(op.content,'utf8'):old?.bytes||null
  rows.push({type:op.type,from,to,oldHash:old?.hash||null,afterHash:after?sha(after):null,
   size:after?.length||0,mode:old?.mode||0o600,bytes:old?.bytes||null,content:['create','replace'].includes(op.type)?op.content:null})
 }
 return rows
}
async function atomicJson(file,data){
 const tmp=file+'.'+randomBytes(6).toString('hex')+'.tmp'
 try{await durableWrite(tmp,JSON.stringify(data),0o600);await rename(tmp,file);await syncDir(dirname(file))}
 finally{await rm(tmp,{force:true}).catch(()=>{})}
}
async function stateOf(dir){return JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'))}
async function stage(root,rows){
 const store=journalPath(root)
 await mkdir(store,{recursive:true,mode:0o700})
 const id=Date.now().toString(36)+'-'+randomBytes(8).toString('hex')
 const dir=join(store,id);await mkdir(dir,{mode:0o700});await syncDir(store)
 const manifest={version:1,id,root,phase:'prepared',createdAt:new Date().toISOString(),
  actions:rows.map(({type,from,to,oldHash,afterHash,mode,size},i)=>({type,from,to,oldHash,afterHash,mode,size,backup:'file-'+i+'.bak'}))}
 try{
  for(let i=0;i<rows.length;i++)if(rows[i].bytes)await durableWrite(join(dir,manifest.actions[i].backup),rows[i].bytes,0o600)
  await atomicJson(join(dir,'manifest.json'),manifest)
  await syncDir(dir)
  return {dir,manifest}
 }catch(e){await rm(dir,{recursive:true,force:true});throw e}
}
async function apply(row){
 if(row.type==='replace'){
  const original=await existing(row.from)
  if(original?.hash!==row.oldHash)throw Error('concurrent edit of project source: '+row.from)
  const tmp=join(dirname(row.from),'.'+basename(row.from)+'.dsh-stage-'+randomBytes(6).toString('hex'))
  try{
   await durableWrite(tmp,row.content,row.mode&0o777)
   const recheck=await existing(row.from)
   if(recheck?.hash!==row.oldHash)throw Error('concurrent edit of project source: '+row.from)
   await rename(tmp,row.from)
   await syncDir(dirname(row.from))
  }finally{await rm(tmp,{force:true}).catch(()=>{})}
 }else if(row.type==='delete'){
  const current=await existing(row.from)
  if(current?.hash!==row.oldHash)throw Error('concurrent change before delete: '+row.from)
  await rm(row.from)
  await syncDir(dirname(row.from))
 }else if(row.type==='move'){
  const current=await existing(row.from)
  if(current?.hash!==row.oldHash||await existing(row.to))throw Error('concurrent change before move')
  await rename(row.from,row.to)
  await syncDir(dirname(row.from));await syncDir(dirname(row.to))
 }else{
  if(await existing(row.from))throw Error('concurrent create target: '+row.from)
  const tmp=join(dirname(row.from),'.'+basename(row.from)+'.dsh-stage-'+randomBytes(6).toString('hex'))
  try{
   await durableWrite(tmp,row.content,0o600)
   if(await existing(row.from))throw Error('concurrent create target: '+row.from)
   // link() is exclusive: unlike rename(), it cannot overwrite a
   // concurrently-created target between the last check and commit.
   await link(tmp,row.from)
   await syncDir(dirname(row.from))
  }finally{await rm(tmp,{force:true}).catch(()=>{})}
 }
}
async function restore(dir,manifest,{dryRun=false}={}){
 const results=[]
 // Reverse order; only restore values that still match journal intent.
 for(const action of [...manifest.actions].reverse()){
  const at=await existing(action.from),dest=action.to?await existing(action.to):null
  let status='unchanged',conflict=null
  if(action.type==='create'){
   if(at?.hash===action.afterHash){status='remove-created';if(!dryRun)await rm(action.from)}
   else if(at)conflict='created file was changed externally'
  }else if(action.type==='replace'){
   if(!at)conflict='replaced file is missing'
   else if(at.hash===action.oldHash)status='unchanged'
   else if(at.hash!==action.afterHash)conflict='replaced file changed externally'
   else{
    status='restore-replaced'
    if(!dryRun){
     const bytes=await readFile(join(dir,action.backup))
     if(sha(bytes)!==action.oldHash)throw Error('journal backup hash mismatch')
     const tmp=action.from+'.dsh-restore-'+randomBytes(6).toString('hex')
     try{await writeFile(tmp,bytes,{flag:'wx',mode:action.mode&0o777});await rename(tmp,action.from)}
     finally{await rm(tmp,{force:true}).catch(()=>{})}
    }
   }
  }else if(action.type==='delete'){
   if(!at){
    status='restore-deleted'
    if(!dryRun){
     const bytes=await readFile(join(dir,action.backup))
     if(sha(bytes)!==action.oldHash)throw Error('journal backup hash mismatch')
     await writeFile(action.from,bytes,{flag:'wx',mode:action.mode&0o777})
    }
   }else if(at.hash!==action.oldHash)conflict='deleted source replaced externally'
  }else{
   if(!at&&dest?.hash===action.oldHash){
    status='reverse-move';if(!dryRun)await rename(action.to,action.from)
   }else if(at?.hash===action.oldHash&&!dest){status='unchanged'}
   else conflict='move destination/source changed externally'
  }
  results.push({type:action.type,path:relative(manifest.root,action.from),status:conflict?'conflict':status,error:conflict})
 }
 const conflicts=results.filter(x=>x.error)
 return {ok:conflicts.length===0,results,conflicts}
}
async function recoverUnlocked(root,{dryRun=false}={}){
 const store=journalPath(root)
 let entries
 try{entries=await readdir(store,{withFileTypes:true})}catch(e){if(e.code==='ENOENT')return {ok:true,transactions:[]};throw e}
 const transactions=[]
 for(const ent of entries.filter(x=>x.isDirectory()).slice(0,100)){
  const dir=join(store,ent.name)
  let manifest
  try{manifest=await stateOf(dir)}catch(e){transactions.push({id:ent.name,status:'unreadable-journal',error:String(e)});continue}
  if(manifest.root!==root||manifest.version!==1){transactions.push({id:ent.name,status:'foreign-or-invalid-journal'});continue}
  if(manifest.phase==='committed'){
   if(!dryRun)await rm(dir,{recursive:true,force:true})
   transactions.push({id:ent.name,status:'committed',cleanupPending:dryRun});continue
  }
  if(manifest.phase==='prepared'||manifest.phase==='applying'){
   const result=await restore(dir,manifest,{dryRun})
   if(result.ok&&!dryRun)await rm(dir,{recursive:true,force:true})
   transactions.push({id:ent.name,status:result.ok?(dryRun?'recovery-available':'recovered'):'conflict',...result});continue
  }
  transactions.push({id:ent.name,status:'unknown-phase'})
 }
 return {ok:transactions.every(x=>x.status!=='conflict'&&x.status!=='unreadable-journal'),transactions}
}
async function pendingJournals(root){
 const store=journalPath(root)
 let entries=[]
 try{entries=await readdir(store,{withFileTypes:true})}catch(e){if(e.code!=='ENOENT')throw e}
 return entries.filter(e=>e.isDirectory()).length
}
async function refactor(args){
 const root=await rootPath(args.root),rows=await validated(root,args.operations)
 const summary=rows.map(({type,from,to,oldHash,afterHash})=>({type,path:relative(root,from),to:to?relative(root,to):null,beforeSha256:oldHash,afterSha256:afterHash}))
 if(args.dryRun===true)return {ok:true,dryRun:true,files:summary}
 const paths=rows.flatMap(x=>[x.from,x.to].filter(Boolean))
 const locks=await acquirePathLocks(paths,{timeoutMs:args.lockTimeoutMs})
 try{
  // Do not recover unrelated transactions while holding locks for only
  // this batch. Explicit recovery acquires every journal path first.
  if(await pendingJournals(root))throw Error('pending workspace file journal; use workspace_refactor_recover before starting a new operation')
  // Revalidate AFTER lock acquisition: the preview cannot be a write precondition.
  const current=await validated(root,args.operations)
  if(current.some((r,i)=>r.oldHash!==rows[i].oldHash))throw Error('workspace changed during file transaction')
  const t=await stage(root,current)
  let verification=null
  try{
   t.manifest.phase='applying';await atomicJson(join(t.dir,'manifest.json'),t.manifest)
   for(const row of current)await apply(row)
   if(args.verify===true){
    verification=await projectBuildCall('workspace_verify',{root,system:args.system,
     runTests:args.runTests!==false,timeoutMs:args.timeoutMs||600000})
    if(!verification.ok)throw Error('project verification failed at '+(verification.failedPhase||'unknown')+' phase')
   }
   t.manifest.phase='committed';await atomicJson(join(t.dir,'manifest.json'),t.manifest)
   await rm(t.dir,{recursive:true,force:true}).catch(()=>{})
   return {ok:true,dryRun:false,transactionId:t.manifest.id,files:summary,verification}
  }catch(e){
   const rollback=await restore(t.dir,t.manifest)
   if(rollback.ok)await rm(t.dir,{recursive:true,force:true}).catch(()=>{})
   return {ok:false,error:String(e.message||e),rollback,verification,transactionId:t.manifest.id}
  }
 }finally{await locks.release()}
}
export async function projectFileCall(name,args={}){
 if(name==='workspace_refactor')return refactor(args)
 if(name==='workspace_refactor_recover'){
  const root=await rootPath(args.root)
  // Recovery uses the same path-lock subsystem for the participating files.
  // For manual recovery no unrelated project path is edited.
  const store=journalPath(root),entries=await readdir(store,{withFileTypes:true}).catch(e=>e.code==='ENOENT'?[]:Promise.reject(e))
  const paths=[]
  for(const ent of entries.filter(e=>e.isDirectory()).slice(0,100)){
   try{const manifest=await stateOf(join(store,ent.name));if(manifest.root===root)
    paths.push(...manifest.actions.flatMap(x=>[x.from,x.to].filter(Boolean)))}catch{}
  }
  if(!paths.length)return recoverUnlocked(root,{dryRun:args.dryRun})
  const locks=await acquirePathLocks([...new Set(paths)],{})
  try{return await recoverUnlocked(root,{dryRun:args.dryRun})}finally{await locks.release()}
 }
 throw Error('unknown P2 workspace file tool: '+name)
}
