// Durable transaction journal for DSH Code Engine.
// Recovery only restores a file when its current hash matches either the
// original or the transaction's intended result. Unknown edits are conflicts.
import {open,readFile,writeFile,rename,unlink,stat,lstat,mkdir,readdir,rm,chmod} from 'node:fs/promises'
import {createHash,randomBytes} from 'node:crypto'
import {join,dirname,basename,resolve} from 'node:path'
import {homedir} from 'node:os'

const digest=data=>createHash('sha256').update(data).digest('hex')
const journalRoot=()=>{
 if(process.env.DSH_CODE_ENGINE_STATE_DIR)return resolve(process.env.DSH_CODE_ENGINE_STATE_DIR)
 const prefix=process.env.TERMUX__PREFIX||process.env.PREFIX
 return prefix?join(prefix,'var','lib','dsh-mobile','code-engine-journal'):join(homedir(),'.dsh-mobile','code-engine-journal')
}
async function syncDir(path){
 const handle=await open(path,'r')
 try{await handle.sync()}finally{await handle.close()}
}
async function durableFile(path,data,mode=0o600){
 const handle=await open(path,'wx',mode)
 try{await handle.writeFile(data);await handle.sync()}finally{await handle.close()}
 await chmod(path,mode)
}
async function writeManifest(dir,manifest){
 const temp=join(dir,'.manifest-'+randomBytes(8).toString('hex')+'.tmp')
 try{
  await durableFile(temp,JSON.stringify(manifest,null,2)+'\n',0o600)
  await rename(temp,join(dir,'manifest.json'))
  await syncDir(dir)
 }finally{await unlink(temp).catch(()=>{})}
}
async function readManifest(dir){
 const value=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'))
 if(value?.version!==1||!Array.isArray(value.files)||typeof value.id!=='string'||typeof value.phase!=='string')throw Error('unsupported or malformed transaction manifest')
 return value
}
function pidAlive(pid){
 if(!Number.isInteger(pid)||pid<=0)return false
 try{process.kill(pid,0);return true}catch(error){return error?.code==='EPERM'}
}
function lockRoot(){
 const root=journalRoot()
 return join(dirname(root),'.'+basename(root)+'.locks')
}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function lockOwner(dir){
 try{return JSON.parse(await readFile(join(dir,'owner.json'),'utf8'))}
 catch(error){if(error?.code==='ENOENT')return null;return {invalid:true}}
}
export async function acquirePathLocks(paths,options={}){
 if(!Array.isArray(paths)||paths.length<1||paths.length>128)throw Error('path locks require 1..128 paths')
 const canonical=[...new Set(paths.map(path=>resolve(path)))].sort()
 const root=lockRoot()
 await mkdir(root,{recursive:true,mode:0o700})
 await chmod(root,0o700)
 const timeoutMs=Math.min(60000,Math.max(100,Number(options.timeoutMs)||10000))
 const staleMs=Math.min(300000,Math.max(1000,Number(options.staleMs)||60000))
 const pollMs=Math.min(200,Math.max(10,Number(options.pollMs)||40))
 const deadline=Date.now()+timeoutMs,token=randomBytes(16).toString('hex'),acquired=[]
 async function release(){
  const results=[]
  for(const item of [...acquired].reverse()){
   try{
    const owner=await lockOwner(item.dir)
    if(owner?.token===token){await rm(item.dir,{recursive:true,force:true});await syncDir(root).catch(()=>{});results.push({path:item.path,released:true})}
    else results.push({path:item.path,released:false,reason:'lock ownership changed'})
   }catch(error){results.push({path:item.path,released:false,error:String(error.message||error)})}
  }
  acquired.length=0
  return results
 }
 try{
  for(const path of canonical){
   const dir=join(root,digest(Buffer.from(path)))
   while(true){
    let created=false
    try{
     await mkdir(dir,{mode:0o700});created=true
     await durableFile(join(dir,'owner.json'),JSON.stringify({version:1,pid:process.pid,token,path,createdAt:new Date().toISOString()})+'\n',0o600)
     await syncDir(dir);await syncDir(root)
     acquired.push({path,dir})
     break
    }catch(error){
     if(created)await rm(dir,{recursive:true,force:true}).catch(()=>{})
     if(error?.code!=='EEXIST')throw error
     let meta
     try{meta=await lstat(dir)}catch(cause){if(cause?.code==='ENOENT')continue;throw cause}
     if(meta.isSymbolicLink()||!meta.isDirectory())throw Error('unsafe path-lock entry: '+dir)
     const owner=await lockOwner(dir)
     const old=Date.now()-meta.mtimeMs>staleMs
     const stale=owner&&!owner.invalid?(!pidAlive(owner.pid)&&old):(!owner&&old)
     if(stale){
      const quarantine=dir+'.stale-'+randomBytes(8).toString('hex')
      try{await rename(dir,quarantine);await rm(quarantine,{recursive:true,force:true});await syncDir(root).catch(()=>{});continue}
      catch(cause){if(cause?.code==='ENOENT'||cause?.code==='EEXIST')continue;throw cause}
     }
     if(Date.now()>=deadline){
      const timeout=Error('timed out waiting for path lock: '+path)
      timeout.code='DSH_LOCK_TIMEOUT'
      throw timeout
     }
     await pause(Math.min(pollMs,Math.max(1,deadline-Date.now())))
    }
   }
  }
  return {paths:canonical,token,release}
 }catch(error){
  await release()
  throw error
 }
}
async function targetHash(path){
 try{
  const meta=await lstat(path)
  if(meta.isSymbolicLink()||!meta.isFile())return {ok:false,error:'target is no longer a regular file: '+path}
  const bytes=await readFile(path)
  return {ok:true,hash:digest(bytes),bytes,meta}
 }catch(error){return {ok:false,error:'cannot read transaction target '+path+': '+String(error.message||error)}}
}
async function restoreOne(dir,entry){
 const current=await targetHash(entry.path)
 if(!current.ok)return {path:entry.path,ok:false,error:current.error}
 if(current.hash===entry.beforeSha256)return {path:entry.path,ok:true,alreadyRestored:true}
 if(current.hash!==entry.afterSha256)return {path:entry.path,ok:false,error:'rollback conflict: file matches neither original nor transaction output'}
 let backup
 try{backup=await readFile(join(dir,entry.backupFile))}catch(error){return {path:entry.path,ok:false,error:'transaction backup unavailable: '+String(error.message||error)}}
 if(digest(backup)!==entry.beforeSha256)return {path:entry.path,ok:false,error:'transaction backup hash mismatch'}
 const parent=dirname(entry.path),temp=join(parent,'.'+basename(entry.path)+'.dsh-journal-restore-'+randomBytes(8).toString('hex'))
 try{
  await durableFile(temp,backup,entry.mode&0o7777)
  const recheck=await targetHash(entry.path)
  if(!recheck.ok||recheck.hash!==entry.afterSha256)throw Error('rollback conflict: target changed during restore')
  await rename(temp,entry.path)
  await syncDir(parent)
  return {path:entry.path,ok:true,restored:true}
 }catch(error){return {path:entry.path,ok:false,error:String(error.message||error)}}
 finally{await unlink(temp).catch(()=>{})}
}
async function cleanup(dir){
 const parent=dirname(dir)
 await rm(dir,{recursive:true,force:true})
 await syncDir(parent).catch(()=>{})
}
function summary(manifest,status,details={}){
 return {id:manifest.id,phase:manifest.phase,purpose:manifest.purpose,files:manifest.files.map(x=>x.path),status,...details}
}
export async function createTransaction({purpose,files}){
 if(!Array.isArray(files)||files.length<1||files.length>32)throw Error('transaction requires 1..32 files')
 const root=journalRoot()
 await mkdir(root,{recursive:true,mode:0o700})
 await chmod(root,0o700)
 const id=Date.now().toString(36)+'-'+process.pid+'-'+randomBytes(8).toString('hex')
 const dir=join(root,id)
 await mkdir(dir,{mode:0o700})
 await syncDir(root)
 const manifest={
  version:1,id,purpose:String(purpose||'code-edit'),phase:'preparing',
  pid:process.pid,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
  files:files.map((file,index)=>({
   path:resolve(file.path),backupFile:'file-'+String(index).padStart(3,'0')+'.bin',
   beforeSha256:digest(Buffer.from(file.original,'utf8')),
   afterSha256:digest(Buffer.from(file.after,'utf8')),
   mode:Number(file.mode)&0o7777,
   size:Buffer.byteLength(file.original,'utf8')
  }))
 }
 try{
  await writeManifest(dir,manifest)
  for(let i=0;i<files.length;i++){
   const entry=manifest.files[i]
   await durableFile(join(dir,entry.backupFile),Buffer.from(files[i].original,'utf8'),0o600)
   await syncDir(dir)
  }
  manifest.phase='prepared';manifest.updatedAt=new Date().toISOString()
  await writeManifest(dir,manifest)
  return {id,dir,manifest}
 }catch(error){
  await cleanup(dir).catch(()=>{})
  throw Error('could not prepare durable edit journal: '+String(error.message||error))
 }
}
export async function setTransactionPhase(transaction,phase,fields={}){
 const manifest=transaction.manifest||await readManifest(transaction.dir)
 Object.assign(manifest,fields,{phase,updatedAt:new Date().toISOString()})
 await writeManifest(transaction.dir,manifest)
 transaction.manifest=manifest
 return transaction
}
export async function removeTransaction(transaction){
 await cleanup(transaction.dir)
}
export async function rollbackTransaction(transaction){
 await setTransactionPhase(transaction,'rollback_pending',{pid:process.pid})
 const results=[]
 for(const entry of transaction.manifest.files)results.push(await restoreOne(transaction.dir,entry))
 const conflicts=results.filter(x=>!x.ok)
 if(conflicts.length){
  await setTransactionPhase(transaction,'rollback_pending',{pid:null,lastRecoveryErrors:conflicts.map(x=>({path:x.path,error:x.error}))})
  return {ok:false,id:transaction.id||transaction.manifest.id,results,conflicts}
 }
 await setTransactionPhase(transaction,'rolled_back',{pid:null})
 await removeTransaction(transaction)
 return {ok:true,id:transaction.id||transaction.manifest.id,results,conflicts:[]}
}
export async function expandTransactionLockPaths(paths,options={}){
 if(!Array.isArray(paths)||paths.length<1||paths.length>32)throw Error('transaction lock expansion requires 1..32 target paths')
 const targets=new Set(paths.map(path=>resolve(path)))
 const root=journalRoot()
 let entries
 try{entries=await readdir(root,{withFileTypes:true})}catch(error){if(error?.code==='ENOENT')return [...targets].sort();throw error}
 const dirs=entries.filter(entry=>entry.isDirectory()).map(entry=>join(root,entry.name)).sort()
 const maxEntries=Math.min(5000,Math.max(100,Number(options.maxEntries)||1000))
 if(dirs.length>maxEntries)throw Error('transaction journal scan limit exceeded while preparing file locks')
 let changed=true,passes=0
 while(changed){
  changed=false
  if(++passes>Math.min(32,dirs.length+1))throw Error('transaction relationship expansion did not converge')
  for(const dir of dirs){
   try{
    const manifest=await readManifest(dir)
    const files=manifest.files.map(entry=>resolve(entry.path))
    if(files.some(path=>targets.has(path)))for(const path of files)if(!targets.has(path)){targets.add(path);changed=true}
   }catch{}
   if(targets.size>128)throw Error('related transaction lock set exceeds 128 paths; recover pending transactions before editing')
  }
 }
 return [...targets].sort()
}
async function recoverOneUnlocked(dir,{dryRun=false}={}){
 const base=basename(dir)
 let manifest
 try{manifest=await readManifest(dir)}catch(error){
  let age=0
  try{age=Date.now()-(await stat(dir)).mtimeMs}catch{}
  if(age>60*60*1000&&!dryRun){await cleanup(dir);return {id:base,status:'removed-orphan-journal',reason:'manifest missing for over one hour'}}
  return {id:base,status:'orphan-incomplete',error:String(error.message||error)}
 }
 const live=pidAlive(manifest.pid)
 if(live)return summary(manifest,'active-skipped',{ownerPid:manifest.pid})
 if(manifest.phase==='verified'){
  if(!dryRun)await cleanup(dir)
  return summary(manifest,dryRun?'verified-cleanup-pending':'verified-committed-cleaned')
 }
 if(manifest.phase==='rolled_back'){
  if(!dryRun)await cleanup(dir)
  return summary(manifest,dryRun?'rollback-cleanup-pending':'rolled-back-cleaned')
 }
 if(manifest.phase==='preparing'){
  if(!dryRun)await cleanup(dir)
  return summary(manifest,dryRun?'incomplete-prepare-cleanup-pending':'incomplete-prepare-discarded')
 }
 if(!['prepared','applying','applied','rollback_pending'].includes(manifest.phase))return summary(manifest,'unknown-phase',{error:'manual inspection required'})
 if(dryRun)return summary(manifest,'recovery-needed',{wouldRestore:manifest.files.map(x=>x.path)})
 const results=[]
 for(const entry of manifest.files)results.push(await restoreOne(dir,entry))
 const conflicts=results.filter(x=>!x.ok)
 if(conflicts.length){
  manifest.phase='rollback_pending';manifest.pid=null;manifest.updatedAt=new Date().toISOString()
  manifest.lastRecoveryErrors=conflicts.map(x=>({path:x.path,error:x.error}))
  await writeManifest(dir,manifest)
  return summary(manifest,'conflict',{results,conflicts})
 }
 manifest.phase='rolled_back';manifest.pid=null;manifest.updatedAt=new Date().toISOString()
 await writeManifest(dir,manifest)
 await cleanup(dir)
 return summary(manifest,'recovered',{results})
}
async function recoverOne(dir,options={}){
 const dryRun=options.dryRun===true
 if(dryRun)return recoverOneUnlocked(dir,options)
 const base=basename(dir)
 let manifest
 try{manifest=await readManifest(dir)}catch{return recoverOneUnlocked(dir,options)}
 if(pidAlive(manifest.pid))return recoverOneUnlocked(dir,options)
 if(!['prepared','applying','applied','rollback_pending'].includes(manifest.phase))return recoverOneUnlocked(dir,options)
 const held=new Set((options.lockPathsHeld||[]).map(path=>resolve(path)))
 const paths=[...new Set(manifest.files.map(entry=>resolve(entry.path)).filter(path=>!held.has(path)))]
 let locks
 try{if(paths.length)locks=await acquirePathLocks(paths,{timeoutMs:options.lockTimeoutMs})}
 catch(error){return summary(manifest,'lock-busy',{error:String(error.message||error)})}
 try{
  let current
  try{current=await readManifest(dir)}catch{return {id:base,status:'already-recovered'}}
  if(pidAlive(current.pid))return summary(current,'active-skipped',{ownerPid:current.pid})
  if(['verified','rolled_back','preparing'].includes(current.phase))return recoverOneUnlocked(dir,options)
  if(!['prepared','applying','applied','rollback_pending'].includes(current.phase))return summary(current,'unknown-phase',{error:'manual inspection required'})
  return await recoverOneUnlocked(dir,options)
 }finally{if(locks)await locks.release()}
}
export async function recoverTransactions(options={}){
 const root=journalRoot(),limit=Math.min(100,Math.max(1,Number(options.maxTransactions)||50))
 let entries
 try{entries=await readdir(root,{withFileTypes:true})}catch(error){
  if(error?.code==='ENOENT')return {root,checked:0,results:[]}
  throw error
 }
 let dirs=entries.filter(x=>x.isDirectory()).map(x=>join(root,x.name)).sort()
 if(options.transactionId)dirs=dirs.filter(x=>basename(x)===options.transactionId)
 if(Array.isArray(options.onlyPaths)&&options.onlyPaths.length){
  const targets=new Set(options.onlyPaths.map(path=>resolve(path)))
  const matching=[]
  for(const dir of dirs){
   try{
    const manifest=await readManifest(dir)
    if(manifest.files.some(entry=>targets.has(resolve(entry.path))))matching.push(dir)
   }catch{}
  }
  dirs=matching
 }
 dirs=dirs.slice(0,limit)
 const results=[]
 for(const dir of dirs)results.push(await recoverOne(dir,{dryRun:options.dryRun===true,lockPathsHeld:options.lockPathsHeld,lockTimeoutMs:options.lockTimeoutMs}))
 return {root,checked:results.length,results}
}
