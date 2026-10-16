/**
 * DSH Coding Engine 2.0: recoverable, opt-in, multi-file text transactions.
 *
 * Journal and backups live in app-private HOME, not in the user's repo.
 * Each target replacement is atomic on the target filesystem. The whole batch
 * is NOT a filesystem-wide atomic commit; an interrupted batch is recoverable.
 * External writers that disregard this module's advisory lock remain possible.
 * Recovery NEVER overwrites a file with an unknown (third-party) hash.
 */
import {createHash,randomBytes} from 'node:crypto'
import {open,readFile,readdir,lstat,realpath,mkdir,rename,rm,stat} from 'node:fs/promises'
import {resolve,relative,dirname,join,basename} from 'node:path'
import {tmpdir} from 'node:os'
import {TextDecoder} from 'node:util'
import {spawnSync} from 'node:child_process'

const MAX_FILES=16,MAX_FILE=1024*1024,MAX_TOTAL=8*1024*1024,MAX_HISTORY=24
const LOCK_WAIT=6000,MAX_JOURNAL=65536,SCHEMA=1
const sha=b=>createHash('sha256').update(b).digest('hex')
const now=()=>Date.now()
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const uuid=()=>randomBytes(12).toString('hex')
function safeRelative(p){
 if(typeof p!=='string'||!p||p.length>512||p.includes('\0')||p.includes('\\')||p.startsWith('/')||p.split('/').some(s=>!s||s==='.'||s==='..'))throw Error('unsafe relative path')
 return p
}
async function rootDir(root){const p=await realpath(resolve(root||'.'));if(!(await lstat(p)).isDirectory())throw Error('workspace root is not directory');return p}
async function targetPath(root,rel){
 safeRelative(rel)
 const target=resolve(root,rel)
 if(target===root||relative(root,target).startsWith('..'))throw Error('workspace traversal rejected')
 let current=dirname(target)
 while(current!==root){
  const st=await lstat(current)
  if(st.isSymbolicLink()||!st.isDirectory())throw Error('workspace parent is not real directory')
  current=dirname(current)
 }
 const st=await lstat(target)
 if(st.isSymbolicLink()||!st.isFile())throw Error('workspace file must be regular and not symlink')
 if(st.size>MAX_FILE)throw Error('file exceeds 1 MiB: '+rel)
 return {target,stat:st}
}
function textBytes(b){
 try {new TextDecoder('utf-8',{fatal:true}).decode(b)}
 catch {throw Error('non-UTF-8 source refused')}
}
async function syncFile(path,data,mode=0o600){
 const handle=await open(path,'wx',mode)
 try {await handle.writeFile(data);await handle.sync()}
 finally {await handle.close()}
}
async function syncDir(path){
 try {const h=await open(path,'r');try{await h.sync()}finally{await h.close()}}
 catch {/* Some Android/virtual filesystems cannot sync directory handles. */}
}
async function replaceJournal(path,obj){
 const tmp=path+'.tmp-'+uuid()
 try{
  const data=JSON.stringify(obj)
  if(Buffer.byteLength(data)>MAX_JOURNAL)throw Error('transaction journal oversized')
  await syncFile(tmp,data,0o600)
  await rename(tmp,path);await syncDir(dirname(path))
 }catch(e){await rm(tmp,{force:true}).catch(()=>{});throw e}
}
function transactionHome(){
 return resolve(process.env.DSH_CODE_TX_HOME||join(process.env.HOME||tmpdir(),'.dsh','mobile','coding-transactions'))
}
async function transactionSpace(root){
 const home=transactionHome()
 await mkdir(home,{recursive:true,mode:0o700})
 const folder=join(home,sha(root))
 await mkdir(folder,{recursive:true,mode:0o700})
 const st=await lstat(folder)
 if(!st.isDirectory()||st.isSymbolicLink())throw Error('unsafe transaction directory')
 return folder
}
async function lockWorkspace(folder,operation){
 const lock=join(folder,'.lock'),started=now()
 let handle
 for(;;){
  try{
   handle=await open(lock,'wx',0o600)
   await handle.writeFile(JSON.stringify({pid:process.pid,created:now()}))
   await handle.sync()
   break
  }catch(e){
   if(e.code!=='EEXIST')throw e
   let stale=false
   try{
    const st=await stat(lock)
    if(now()-st.mtimeMs>1500){
     let owner
     try{owner=JSON.parse(await readFile(lock,'utf8'))}catch{}
     const pid=owner?.pid
     if(Number.isInteger(pid)&&pid>0){
      try{process.kill(pid,0)}
      catch(err){if(err.code==='ESRCH')stale=true}
     }else if(now()-st.mtimeMs>30000)stale=true
    }
    if(stale){await rm(lock,{force:true});continue}
   }catch(err){if(err.code!=='ENOENT')throw err}
   if(now()-started>LOCK_WAIT)throw Error('CODING_TX_BUSY: workspace has another transaction')
   await sleep(40)
  }
 }
 try{return await operation()}
 finally{await handle.close().catch(()=>{});await rm(lock,{force:true}).catch(()=>{})}
}
async function readJournal(path){
 const st=await lstat(path)
 if(!st.isFile()||st.size>MAX_JOURNAL)throw Error('unsafe journal file')
 const obj=JSON.parse(await readFile(path,'utf8'))
 if(obj.schema!==SCHEMA||!Array.isArray(obj.files)||!obj.id||!Array.isArray(obj.files)||obj.files.length>MAX_FILES)throw Error('unsupported journal')
 return obj
}
async function allJournals(folder){
 const results=[]
 for(const entry of await readdir(folder,{withFileTypes:true})){
  if(!entry.isDirectory()||!/^tx-[0-9a-f]{24}$/.test(entry.name))continue
  const file=join(folder,entry.name,'journal.json')
  try {results.push({path:file,value:await readJournal(file)})}
  catch(err){results.push({path:file,error:err.message})}
 }
 return results
}
function compact(j){return {id:j.id,state:j.state,createdAt:j.createdAt,updatedAt:j.updatedAt,files:j.files.map(f=>({path:f.path,beforeSha256:f.beforeSha256,afterSha256:f.afterSha256}))}}
async function atomicRestore(root,txId,file,contents,mode){
 const {target}=await targetPath(root,file)
 const temp=join(dirname(target),'.'+basename(target)+'.dsh-restore-'+txId)
 try{
  await syncFile(temp,contents,mode)
  await rename(temp,target)
  await syncDir(dirname(target))
 }finally{await rm(temp,{force:true}).catch(()=>{})}
}
async function rollback(root,journalPath,journal){
 const dir=dirname(journalPath),conflicts=[],restored=[],untouched=[]
 journal.state='recovering';journal.updatedAt=now()
 await replaceJournal(journalPath,journal)
 for(let i=journal.files.length-1;i>=0;i--){
  const entry=journal.files[i]
  try{
   const {target}=await targetPath(root,entry.path),current=await readFile(target),hash=sha(current)
   if(hash===entry.beforeSha256){untouched.push(entry.path);continue}
   if(hash!==entry.afterSha256){conflicts.push({path:entry.path,reason:'external modification detected'});continue}
   const snapshot=await readFile(join(dir,'before-'+i+'.bin'))
   if(sha(snapshot)!==entry.beforeSha256){conflicts.push({path:entry.path,reason:'backup integrity failed'});continue}
   await atomicRestore(root,journal.id,entry.path,snapshot,entry.mode)
   restored.push(entry.path)
  }catch(error){conflicts.push({path:entry.path,reason:String(error.message||error).slice(0,180)})}
 }
 journal.state=conflicts.length?'needs_review':'rolled_back'
 journal.updatedAt=now()
 journal.recovery={restored,untouched,conflicts}
 await replaceJournal(journalPath,journal)
 return {id:journal.id,state:journal.state,restored,untouched,conflicts}
}
async function historyCleanup(folder){
 const journals=await allJournals(folder)
 const finished=journals.filter(x=>x.value&&['committed','rolled_back'].includes(x.value.state))
 finished.sort((a,b)=>b.value.updatedAt-a.value.updatedAt)
 for(const j of finished.slice(MAX_HISTORY))await rm(dirname(j.path),{recursive:true,force:true}).catch(()=>{})
}
export async function codeTransactionStatus(input={}){
 const root=await rootDir(input.root),folder=await transactionSpace(root)
 return lockWorkspace(folder,async()=>{
  const journals=await allJournals(folder)
  const unresolved=journals.filter(x=>x.error||x.value&&!['committed','rolled_back'].includes(x.value.state))
  return{root,total:journals.length,unresolved:unresolved.map(x=>x.error?{id:basename(dirname(x.path)),error:x.error}:compact(x.value)),history:journals.filter(x=>x.value).slice(-24).map(x=>({id:x.value.id,state:x.value.state,updatedAt:x.value.updatedAt})),note:'Recovery never overwrites external modifications'}
 })
}
export async function codeTransactionRecover(input={}){
 const root=await rootDir(input.root),folder=await transactionSpace(root)
 if(input.id!==undefined&&!/^tx-[0-9a-f]{24}$/.test(input.id))throw Error('invalid transaction id')
 return lockWorkspace(folder,async()=>{
  const journals=await allJournals(folder)
  const selected=journals.filter(x=>input.id===undefined||basename(dirname(x.path))===input.id)
  if(input.id&&!selected.length)throw Error('unknown transaction id')
  const repaired=[],unresolved=[]
  for(const item of selected){
   if(item.error){unresolved.push({id:basename(dirname(item.path)),error:item.error});continue}
   if(['committed','rolled_back'].includes(item.value.state))continue
   if(item.value.state==='needs_review'&&input.allowReviewRetry!==true){unresolved.push(compact(item.value));continue}
   if(item.value.root!==root){unresolved.push({id:item.value.id,error:'workspace root mismatch'});continue}
   const result=await rollback(root,item.path,item.value)
   if(result.state==='rolled_back')repaired.push(result)
   else unresolved.push(result)
  }
  return{root,recovered:repaired,unresolved}
 })
}
async function checkInputs(root,changes){
 if(!Array.isArray(changes)||changes.length<1||changes.length>MAX_FILES)throw Error('changes must contain 1..16 items')
 const records=[],names=new Set();let total=0
 for(const change of changes){
  if(!change||typeof change!=='object')throw Error('invalid file change')
  const name=safeRelative(change.path)
  if(names.has(name))throw Error('duplicate file: '+name)
  names.add(name)
  const {target,stat:st}=await targetPath(root,name)
  const before=await readFile(target),current=sha(before),expected=change.expectedSha256
  if(typeof expected!=='string'||!/^[0-9a-f]{64}$/.test(expected))throw Error('expectedSha256 required')
  if(current!==expected)throw Error('CODING_TX_STALE: '+name)
  textBytes(before)
  if(typeof change.oldText!=='string'||!change.oldText||typeof change.newText!=='string')throw Error('invalid replacement for '+name)
  const beforeText=before.toString('utf8')
  const count=beforeText.split(change.oldText).length-1
  if(count!==1)throw Error('CODING_TX_AMBIGUOUS: '+name+' has '+count+' matches')
  const after=Buffer.from(beforeText.replace(change.oldText,change.newText),'utf8')
  if(after.length>MAX_FILE)throw Error('new file too large: '+name)
  total+=before.length+after.length
  if(total>MAX_TOTAL)throw Error('transaction exceeds 8 MiB total')
  records.push({name,target,before,after,mode:st.mode&0o777,beforeSha256:current,afterSha256:sha(after)})
 }
 return records
}
export async function runCodeTransaction(input={}){
 const root=await rootDir(input.root),folder=await transactionSpace(root)
 return lockWorkspace(folder,async()=>{
  const data=await checkInputs(root,input.changes),dryRun=input.dryRun!==false
  const changes=data.map(x=>({path:x.name,beforeSha256:x.beforeSha256,afterSha256:x.afterSha256}))
  if(dryRun)return{dryRun:true,changes,guarantee:'checked, no writes performed'}
  const pending=(await allJournals(folder)).filter(j=>j.error||j.value&&!['committed','rolled_back'].includes(j.value.state))
  if(pending.length)throw Error('CODING_TX_RECOVERY_REQUIRED: '+pending.map(x=>basename(dirname(x.path))).join(','))
  const id='tx-'+uuid(),dir=join(folder,id),journalPath=join(dir,'journal.json')
  await mkdir(dir,{mode:0o700})
  const journal={schema:SCHEMA,id,root,state:'prepared',createdAt:now(),updatedAt:now(),
   files:data.map(x=>({path:x.name,beforeSha256:x.beforeSha256,afterSha256:x.afterSha256,mode:x.mode}))}
  let ready=false
  try{
   for(let i=0;i<data.length;i++){
    await syncFile(join(dir,'before-'+i+'.bin'),data[i].before)
    await syncFile(join(dir,'after-'+i+'.bin'),data[i].after)
   }
   await replaceJournal(journalPath,journal);ready=true
   journal.state='applying';journal.updatedAt=now();await replaceJournal(journalPath,journal)
   for(let i=0;i<data.length;i++){
    const record=data[i],currentFile=await targetPath(root,record.name)
    const actual=sha(await readFile(currentFile.target))
    if(actual!==record.beforeSha256)throw Error('CODING_TX_CONFLICT: '+record.name)
    const temp=join(dirname(record.target),'.'+basename(record.target)+'.dsh-stage-'+id)
    try{
     await syncFile(temp,record.after,record.mode)
     const lastHash=sha(await readFile((await targetPath(root,record.name)).target))
     if(lastHash!==record.beforeSha256)throw Error('CODING_TX_CONFLICT: '+record.name)
     await rename(temp,record.target);await syncDir(dirname(record.target))
    }finally{await rm(temp,{force:true}).catch(()=>{})}
    // Test-only hard process abort, simulating a power/process kill after one rename.
    if(process.env.DSH_CODE_TX_TEST_MODE==='1'&&Number(process.env.DSH_CODE_TX_CRASH_AFTER)===i+1)process.exit(86)
    if(process.env.DSH_CODE_TX_TEST_MODE==='1'&&Number(process.env.DSH_CODE_TX_FAIL_AFTER)===i+1)throw Error('CODING_TX_INJECTED_FAILURE')
   }
   journal.state='committed';journal.updatedAt=now();await replaceJournal(journalPath,journal)
   await historyCleanup(folder)
   return{dryRun:false,id,state:'committed',changes}
  }catch(error){
   if(ready){
    let result
    try{result=await rollback(root,journalPath,journal)}
    catch(recoveryError){throw Error('CODING_TX_RECOVERY_REQUIRED: '+id+'; original='+error.message+'; rollback='+recoveryError.message)}
    if(result.state==='needs_review')throw Error('CODING_TX_NEEDS_REVIEW: '+id+'; '+JSON.stringify(result.conflicts))
   }else await rm(dir,{recursive:true,force:true}).catch(()=>{})
   throw error
  }
 })
}
async function selfTest(){
 const home=await (await import('node:fs/promises')).mkdtemp(join(tmpdir(),'dsh-tx-home-'))
 const root=join(home,'workspace'),old=process.env.DSH_CODE_TX_HOME
 process.env.DSH_CODE_TX_HOME=join(home,'state')
 try{
  await mkdir(root)
  const a=join(root,'a.js'),b=join(root,'b.js')
  await (await import('node:fs/promises')).writeFile(a,'let value=1\n')
  await (await import('node:fs/promises')).writeFile(b,'let other=2\n')
  const digestA=sha(await readFile(a)),digestB=sha(await readFile(b))
  const changes=[{path:'a.js',expectedSha256:digestA,oldText:'value=1',newText:'value=3'},
   {path:'b.js',expectedSha256:digestB,oldText:'other=2',newText:'other=4'}]
  const preview=await runCodeTransaction({root,changes})
  if(!preview.dryRun||sha(await readFile(a))!==digestA)throw Error('preview wrote data')
  let failed=false
  try{await runCodeTransaction({root,changes, dryRun:false,expectedVersion:'unused'})}catch(e){failed=true}
  if(failed)throw Error('ordinary transaction failed')
  if(!(await readFile(a,'utf8')).includes('value=3')||!(await readFile(b,'utf8')).includes('other=4'))throw Error('commit incorrect')
  let stale=false
  try{await runCodeTransaction({root,changes,dryRun:false})}catch(e){stale=/CODING_TX_STALE/.test(e.message)}
  if(!stale)throw Error('stale precondition accepted')
  const edits=[{path:'a.js',expectedSha256:sha(await readFile(a)),oldText:'value=3',newText:'value=5'},
   {path:'b.js',expectedSha256:sha(await readFile(b)),oldText:'other=4',newText:'other=6'}]
  process.env.DSH_CODE_TX_TEST_MODE='1';process.env.DSH_CODE_TX_FAIL_AFTER='1'
  let roll=false
  try{await runCodeTransaction({root,changes:edits,dryRun:false})}catch(e){roll=/INJECTED_FAILURE/.test(e.message)}
  delete process.env.DSH_CODE_TX_FAIL_AFTER
  if(!roll||!(await readFile(a,'utf8')).includes('value=3'))throw Error('failure rollback broken')
  const script=resolve(new URL(import.meta.url).pathname)
  const child=spawnSync(process.execPath,[script,'--crash-helper',root,JSON.stringify(edits)],
    {env:{...process.env,DSH_CODE_TX_TEST_MODE:'1',DSH_CODE_TX_CRASH_AFTER:'1'},encoding:'utf8'})
  if(child.status!==86)throw Error('hard crash fault injection missing: '+child.stderr)
  const state=await codeTransactionStatus({root})
  if(state.unresolved.length!==1||!state.unresolved[0].state||state.unresolved[0].state!=='applying')throw Error('crashed journal missing')
  const recovered=await codeTransactionRecover({root,id:state.unresolved[0].id})
  if(recovered.recovered.length!==1||recovered.unresolved.length)throw Error('crash recovery failed: '+JSON.stringify(recovered))
  if(!(await readFile(a,'utf8')).includes('value=3')||!(await readFile(b,'utf8')).includes('other=4'))throw Error('recovered data mismatch')
  // Third-party changes after a crash must not be destroyed by recovery.
  const external=[{path:'a.js',expectedSha256:sha(await readFile(a)),oldText:'value=3',newText:'value=8'},
    {path:'b.js',expectedSha256:sha(await readFile(b)),oldText:'other=4',newText:'other=9'}]
  const third=spawnSync(process.execPath,[script,'--crash-helper',root,JSON.stringify(external)],
    {env:{...process.env,DSH_CODE_TX_TEST_MODE:'1',DSH_CODE_TX_CRASH_AFTER:'1'},encoding:'utf8'})
  if(third.status!==86)throw Error('external conflict crash injection failed')
  await (await import('node:fs/promises')).writeFile(a,'let value=777 // external writer\n')
  const conflicted=await codeTransactionRecover({root})
  if(!conflicted.unresolved.length||!(await readFile(a,'utf8')).includes('external writer'))throw Error('external content was overwritten')
  const lockedOut=await runCodeTransaction({root,changes:[{path:'b.js',expectedSha256:sha(await readFile(b)),oldText:'other=4',newText:'other=5'}],dryRun:false}).then(()=>false,e=>/CODING_TX_RECOVERY_REQUIRED/.test(e.message))
  if(!lockedOut)throw Error('unresolved journal did not block subsequent changes')
  // Resolve the external conflict explicitly without overwriting external content.
  const pending=await codeTransactionStatus({root})
  if(!pending.unresolved.some(x=>x.state==='needs_review'))throw Error('needs-review status omitted')
  await (await import('node:fs/promises')).writeFile(a,'let value=3\n')
  const finished=await codeTransactionRecover({root,allowReviewRetry:true})
  if(finished.unresolved.length)throw Error('review recovery failed after restoring known file hash')
  const badPath=await (await import('node:fs/promises')).symlink(a,join(root,'linked.js'))
  let rejected=false
  try{await runCodeTransaction({root,changes:[{path:'linked.js',expectedSha256:sha(await readFile(a)),oldText:'value=3',newText:'value=7'}]})}catch{rejected=true}
  if(!rejected)throw Error('symlink path accepted')
  const [left,right]=await Promise.allSettled([runCodeTransaction({root,changes:edits,dryRun:false}),runCodeTransaction({root,changes:edits,dryRun:false})])
  if([left,right].filter(x=>x.status==='fulfilled').length!==1)throw Error('concurrent mutation was not serialized')
  process.stdout.write('[DSH] Coding transactions crash recovery/self-test: OK\n')
 }finally{
  delete process.env.DSH_CODE_TX_TEST_MODE;delete process.env.DSH_CODE_TX_CRASH_AFTER;delete process.env.DSH_CODE_TX_FAIL_AFTER
  if(old===undefined)delete process.env.DSH_CODE_TX_HOME;else process.env.DSH_CODE_TX_HOME=old
  await rm(home,{recursive:true,force:true})
 }
}
if(process.argv[2]==='--crash-helper'){
 runCodeTransaction({root:process.argv[3],changes:JSON.parse(process.argv[4]),dryRun:false}).catch(e=>{console.error(e);process.exitCode=1})
}else if(process.argv.includes('--self-test'))selfTest().catch(e=>{console.error(e);process.exitCode=1})
