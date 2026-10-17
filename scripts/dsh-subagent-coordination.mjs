#!/usr/bin/env node
import {fileURLToPath} from 'node:url'
/**
 * DSH Android cooperative task board.
 *
 * Coordinates assignments for existing DSH subagent/workflow tools; it never
 * starts children, grants permissions, edits workspaces, or impersonates agents.
 * Atomic JSON snapshots and exclusive locks survive MCP process restarts.
 * All agent ids are advisory labels; callers must use native DSH subagent
 * controls for actual child authentication, execution and interruption.
 */
import { randomBytes } from 'node:crypto'
import { open, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { resolve, join, posix } from 'node:path'

const MAX_TASKS=64, MAX_BYTES=256*1024, MAX_LEASE=1800, MIN_LEASE=30
const WAIT_MS=25, LOCK_WAIT_MS=3000, STALE_LOCK_MS=30000
const pause=ms=>new Promise(done=>setTimeout(done,ms))
function checkName(s,field,max=80) {
 if(typeof s!=='string'||!s.length||s.length>max||!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(s)) throw new Error('invalid '+field)
 return s
}
function checkText(s,field,max) {
 if(typeof s!=='string'||!s.trim()||Buffer.byteLength(s)>max) throw new Error('invalid '+field)
 return s.trim()
}
function scope(value) {
 if(typeof value!=='string'||Buffer.byteLength(value)>512||value.includes('\\')||value.includes('\0')||value.startsWith('/')||value.startsWith('~'))throw new Error('invalid writeScope')
 const normalized=posix.normalize(value)
 if(normalized==='.'||normalized==='..'||normalized.startsWith('../')||normalized.startsWith('/'))throw new Error('unsafe writeScope')
 return normalized.replace(/\/$/,'')
}
function overlap(a,b) { return a===b||a.startsWith(b+'/')||b.startsWith(a+'/') }
function validateTasks(tasks) {
 if(!Array.isArray(tasks)||!tasks.length||tasks.length>MAX_TASKS)throw new Error('tasks must have 1..64 entries')
 const ids=new Set(),out=[]
 for(const task of tasks) {
  if(!task||typeof task!=='object'||Array.isArray(task))throw new Error('task must be an object')
  const id=checkName(task.id,'task id',40),title=checkText(task.title,'title',180)
  if(ids.has(id))throw new Error('duplicate task id: '+id)
  ids.add(id)
  const deps=task.blockedBy??[],scopes=task.writeScopes??[]
  if(!Array.isArray(deps)||deps.length>MAX_TASKS||!Array.isArray(scopes)||scopes.length>20)throw new Error('invalid dependencies or writeScopes')
  const blockedBy=deps.map(x=>checkName(x,'dependency',40))
  const writeScopes=scopes.map(scope)
  if(new Set(blockedBy).size!==blockedBy.length||new Set(writeScopes).size!==writeScopes.length)throw new Error('duplicate dependency or scope')
  out.push({id,title,description:typeof task.description==='string'?task.description.slice(0,2048):'',blockedBy,writeScopes,status:'pending',revision:0,attempts:0,owner:null,leaseUntil:null,summary:null,evidence:[],updatedAt:Date.now()})
 }
 const byId=new Map(out.map(t=>[t.id,t]))
 const visiting=new Set(),visited=new Set()
 function visit(id) {
  if(visiting.has(id))throw new Error('cyclic task dependency: '+id)
  if(visited.has(id))return
  visiting.add(id)
  for(const dep of byId.get(id).blockedBy) {
   if(!byId.has(dep))throw new Error('unknown dependency: '+dep)
   visit(dep)
  }
  visiting.delete(id);visited.add(id)
 }
 for(const t of out)visit(t.id)
 return out
}
function publicTask(t) { return {...t} }
function refresh(board,now=Date.now()) {
 let changed=false
 for(const task of board.tasks){
  if(task.status!=='running'||!task.leaseUntil||task.leaseUntil>now)continue
  task.status=task.attempts>=board.maxAttempts?'failed':'pending'
  task.owner=null;task.leaseUntil=null;task.revision++;task.updatedAt=now
  if(task.status==='failed')task.summary='Lease expired; retry limit reached'
  changed=true
 }
 return changed
}
function status(board) {
 const counts={pending:0,running:0,completed:0,failed:0}
 for(const t of board.tasks)counts[t.status]++
 const byId=new Map(board.tasks.map(t=>[t.id,t]))
 const running=board.tasks.filter(t=>t.status==='running')
 const ready=board.tasks.filter(t=>t.status==='pending'&&t.blockedBy.every(id=>byId.get(id).status==='completed'))
   .map(t=>({id:t.id,title:t.title,revision:t.revision,blockedBy:t.blockedBy,writeScopes:t.writeScopes,
    conflicts:running.filter(r=>t.writeScopes.some(a=>r.writeScopes.some(b=>overlap(a,b)))).map(r=>r.id)}))
 return {boardId:board.id,version:board.version,updatedAt:board.updatedAt,maxParallel:board.maxParallel,maxAttempts:board.maxAttempts,counts,capacity:Math.max(0,board.maxParallel-counts.running),ready,tasks:board.tasks.map(publicTask)}
}
async function atomicWrite(path,data){
 const temp=path+'.tmp-'+randomBytes(6).toString('hex')
 try{
  const h=await open(temp,'wx',0o600)
  try{await h.writeFile(JSON.stringify(data));await h.sync()}finally{await h.close()}
  await rename(temp,path)
 }catch(e){await rm(temp,{force:true}).catch(()=>{});throw e}
}
export function createCoordinator(home=process.env.HOME||process.cwd()){
 const root=resolve(home,'.dsh','mobile','coordination')
 async function boardFile(id){checkName(id,'boardId',64);await mkdir(root,{recursive:true,mode:0o700});return join(root,id+'.json')}
 async function load(path){
  const info=await stat(path)
  if(!info.isFile()||info.size>MAX_BYTES)throw new Error('invalid board data')
  const data=JSON.parse(await readFile(path,'utf8'))
  if(data.schema!==1||!Array.isArray(data.tasks))throw new Error('unsupported board version')
  return data
 }
 async function locked(id,fn){
  const path=await boardFile(id),lock=path+'.lock',started=Date.now()
  let h
  while(!h){
   try{h=await open(lock,'wx',0o600);await h.writeFile(JSON.stringify({pid:process.pid,at:Date.now()}))}
   catch(e){
    if(e.code!=='EEXIST')throw e
    try{const info=await stat(lock);if(Date.now()-info.mtimeMs>STALE_LOCK_MS){await rm(lock,{force:true});continue}}catch(e2){if(e2.code!=='ENOENT')throw e2}
    if(Date.now()-started>LOCK_WAIT_MS)throw new Error('task board busy: '+id)
    await pause(WAIT_MS)
   }
  }
  try{
   const board=await load(path)
   const expired=refresh(board),previous=JSON.stringify(board)
   const result=await fn(board)
   if(expired||JSON.stringify(board)!==previous){
    board.version++
    board.updatedAt=Date.now()
    if(Buffer.byteLength(JSON.stringify(board))>MAX_BYTES)throw new Error('task board exceeds 256 KiB')
    await atomicWrite(path,board)
   }
   return result===undefined?status(board):result
  }finally{await h.close();await rm(lock,{force:true})}
 }
 return {
  async create(input) {
   const tasks=validateTasks(input.tasks),maxParallel=input.maxParallel??3,maxAttempts=input.maxAttempts??2
   if(!Number.isInteger(maxParallel)||maxParallel<1||maxParallel>8||!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>5)throw new Error('invalid coordination limits')
   const id='board-'+randomBytes(8).toString('hex'),path=await boardFile(id)
   const now=Date.now()
   const board={schema:1,id,version:1,createdAt:now,updatedAt:now,maxParallel,maxAttempts,tasks}
   if(Buffer.byteLength(JSON.stringify(board))>MAX_BYTES)throw new Error('task board exceeds 256 KiB')
   const handle=await open(path,'wx',0o600)
   try{await handle.writeFile(JSON.stringify(board));await handle.sync()}finally{await handle.close()}
   return status(board)
  },
  async status(id){return locked(id,()=>undefined)},
  async claim({boardId,taskId,agentId,leaseSeconds=300}){
   checkName(taskId,'taskId',40);checkName(agentId,'agentId',128)
   if(!Number.isInteger(leaseSeconds)||leaseSeconds<MIN_LEASE||leaseSeconds>MAX_LEASE)throw new Error('leaseSeconds out of bounds')
   return locked(boardId,board=>{
    const task=board.tasks.find(t=>t.id===taskId)
    if(!task)throw new Error('unknown task')
    if(task.status!=='pending')throw new Error('task not claimable: '+task.status)
    const byId=new Map(board.tasks.map(t=>[t.id,t]))
    if(!task.blockedBy.every(id=>byId.get(id).status==='completed'))throw new Error('task dependencies not completed')
    const active=board.tasks.filter(t=>t.status==='running')
    if(active.length>=board.maxParallel)throw new Error('parallel capacity reached')
    const conflict=active.find(t=>t.writeScopes.some(a=>task.writeScopes.some(b=>overlap(a,b))))
    if(conflict)throw new Error('writeScope conflict with '+conflict.id)
    task.status='running';task.owner=agentId;task.attempts++;task.revision++;task.leaseUntil=Date.now()+leaseSeconds*1000;task.updatedAt=Date.now()
    return {boardId,task:publicTask(task),maxParallel:board.maxParallel}
   })
  },
  async update({boardId,taskId,agentId,revision,action,summary,evidence,leaseSeconds=300}){
   checkName(taskId,'taskId',40);checkName(agentId,'agentId',128)
   if(!Number.isInteger(revision)||revision<0)throw new Error('expected revision required')
   if(!['heartbeat','complete','fail','release'].includes(action))throw new Error('invalid action')
   if(action==='heartbeat'&&(!Number.isInteger(leaseSeconds)||leaseSeconds<MIN_LEASE||leaseSeconds>MAX_LEASE))throw new Error('invalid leaseSeconds')
   return locked(boardId,board=>{
    const task=board.tasks.find(t=>t.id===taskId)
    if(!task)throw new Error('unknown task')
    if(task.status!=='running'||task.owner!==agentId)throw new Error('task is not owned by caller')
    if(task.revision!==revision)throw new Error('TASK_STALE_REVISION expected '+task.revision+' got '+revision)
    if(action==='heartbeat')task.leaseUntil=Date.now()+leaseSeconds*1000
    else{
     task.status=action==='complete'?'completed':action==='fail'?'failed':'pending'
     if(action==='complete'&&!summary?.trim())throw new Error('completion requires a summary')
     if(summary!==undefined)task.summary=checkText(summary,'summary',2048)
     if(evidence!==undefined){
      if(!Array.isArray(evidence)||evidence.length>8)throw new Error('invalid evidence')
      task.evidence=evidence.map(v=>checkText(v,'evidence',256))
     }
     task.owner=null;task.leaseUntil=null
    }
    task.revision++;task.updatedAt=Date.now()
    return {boardId,task:publicTask(task)}
   })
  },
 }
}
async function selfTest(){
 const {mkdtemp}=await import('node:fs/promises')
 const {tmpdir}=await import('node:os')
 const dir=await mkdtemp(join(tmpdir(),'dsh-board-'))
 try{
  const a=createCoordinator(dir)
  const board=await a.create({maxParallel:2,tasks:[
   {id:'one',title:'First',writeScopes:['src/ui']},
   {id:'two',title:'Second',writeScopes:['src/ui/panel']},
   {id:'three',title:'After first',blockedBy:['one'],writeScopes:['src/core']}
  ]})
  const a1=await a.claim({boardId:board.boardId,taskId:'one',agentId:'worker-1'})
  let conflict=false
  try{await a.claim({boardId:board.boardId,taskId:'two',agentId:'worker-2'})}catch(e){conflict=/writeScope conflict/.test(e.message)}
  if(!conflict)throw new Error('write scope conflict missed')
  const hb=await a.update({boardId:board.boardId,taskId:'one',agentId:'worker-1',revision:a1.task.revision,action:'heartbeat'})
  let stale=false
  try{await a.update({boardId:board.boardId,taskId:'one',agentId:'worker-1',revision:a1.task.revision,action:'complete',summary:'x'})}catch(e){stale=/TASK_STALE_REVISION/.test(e.message)}
  if(!stale)throw new Error('revision guard missed')
  await a.update({boardId:board.boardId,taskId:'one',agentId:'worker-1',revision:hb.task.revision,action:'complete',summary:'Validated output',evidence:['test pass']})
  const ready=await createCoordinator(dir).status(board.boardId)
  if(!ready.ready.some(t=>t.id==='three')||ready.counts.completed!==1)throw new Error('task dependencies or persistence broken')
  const [r1,r2]=await Promise.allSettled([
   a.claim({boardId:board.boardId,taskId:'two',agentId:'worker-2'}),
   a.claim({boardId:board.boardId,taskId:'two',agentId:'worker-3'})
  ])
  if([r1,r2].filter(r=>r.status==='fulfilled').length!==1)throw new Error('double claim accepted')
  await a.create({tasks:[{id:'a',title:'recovery'}]})
  let cycle=false
  try{await a.create({tasks:[{id:'a',title:'A',blockedBy:['b']},{id:'b',title:'B',blockedBy:['a']}]})}catch(e){cycle=/cyclic/.test(e.message)}
  if(!cycle)throw new Error('dependency cycle accepted')
  // An oversized board must fail at creation, never become an unreadable
  // persisted board that strands pending tasks after a process restart.
  const huge=Array.from({length:64},(_,i)=>({
   id:'huge'+i,title:'Oversized board regression',
   writeScopes:Array.from({length:20},(_,j)=>'dir'+i+'_'+j+'_'+'x'.repeat(480))
  }))
  let oversized=false
  try{await a.create({tasks:huge})}catch(e){oversized=/exceeds 256 KiB/.test(e.message)}
  if(!oversized)throw new Error('oversized unreadable board was persisted')
  let excessiveScope=false
  try{await a.create({tasks:[{id:'long',title:'Long scope',writeScopes:['x'.repeat(513)]}]})}
  catch(e){excessiveScope=/writeScope/.test(e.message)}
  if(!excessiveScope)throw new Error('overlong write scope accepted')

  process.stdout.write('[DSH] Subagent coordination board self-test: OK\n')
 }finally{await rm(dir,{recursive:true,force:true})}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)&&process.argv.includes('--self-test'))selfTest().catch(e=>{console.error(e);process.exitCode=1})
