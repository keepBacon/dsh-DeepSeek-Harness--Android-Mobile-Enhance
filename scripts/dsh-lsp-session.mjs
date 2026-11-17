// P3 bounded persistent LSP session pool (MCP process lifetime only).
// A session is reused per canonical project root + exact backend argv.
// One request runs at a time in each session; errors invalidate the session.
import {spawn} from 'node:child_process'
import {readFile,lstat} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {devLaunch} from './dsh-dev-process.mjs'

const MAX_SESSIONS=2, MAX_DOCS=24, MAX_FILE=1024*1024, MAX_RESPONSE=4*1024*1024
const MAX_QUERY_BYTES=24*1024*1024, IDLE_MS=120000
const sessions=new Map()
const digest=b=>createHash('sha256').update(b).digest('hex')
const uri=path=>pathToFileURL(path).href
const frame=obj=>{
 const bytes=Buffer.from(JSON.stringify(obj),'utf8')
 return Buffer.concat([Buffer.from('Content-Length: '+bytes.length+'\r\n\r\n'),bytes])
}
function destroy(session,reason){
 if(session.dead)return
 session.dead=true
 for(const waiter of session.pending.values()){clearTimeout(waiter.timer);waiter.reject(Error(reason))}
 session.pending.clear()
 session.child.stdin?.destroy()
 session.child.stdout?.destroy()
 session.child.stderr?.destroy()
 try{if(process.platform!=='win32')process.kill(-session.child.pid,'SIGKILL')
 else session.child.kill('SIGKILL')}catch{try{session.child.kill('SIGKILL')}catch{}}
 if(sessions.get(session.key)?.instance===session)sessions.delete(session.key)
}
function send(session,message){
 if(session.dead||!session.child.stdin?.writable)throw Error('LSP session is closed')
 session.child.stdin.write(frame(message))
}
function notify(session,method,params){send(session,{jsonrpc:'2.0',method,params})}
function request(session,method,params,timeoutMs){
 const id=++session.nextId
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{destroy(session,'LSP request timeout: '+method)},timeoutMs)
  session.pending.set(id,{resolve,reject,timer})
  try{send(session,{jsonrpc:'2.0',id,method,params})}
  catch(error){clearTimeout(timer);session.pending.delete(id);reject(error)}
 })
}
function receive(session,buf){
 session.bytesThisQuery+=buf.length
 if(session.bytesThisQuery>MAX_QUERY_BYTES){destroy(session,'LSP output budget exceeded');return}
 session.input=Buffer.concat([session.input,buf])
 while(!session.dead){
  const end=session.input.indexOf('\r\n\r\n')
  if(end<0){
   if(session.input.length>4096)destroy(session,'LSP header too large')
   break
  }
  const header=session.input.subarray(0,end).toString('ascii')
  const match=/(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/i.exec(header)
  if(!match){destroy(session,'LSP missing Content-Length');break}
  const count=Number(match[1])
  if(!Number.isSafeInteger(count)||count>MAX_RESPONSE){destroy(session,'LSP response too large');break}
  if(session.input.length<end+4+count)break
  const bytes=session.input.subarray(end+4,end+4+count)
  session.input=session.input.subarray(end+4+count)
  let message
  try{message=JSON.parse(bytes.toString('utf8'))}
  catch{destroy(session,'Malformed LSP JSON');break}
  if(message.method&&message.id!==undefined){
   // No project-owned commands are executed through server requests.
   try{send(session,{jsonrpc:'2.0',id:message.id,result:message.method==='workspace/configuration'?[]:null})}
   catch{destroy(session,'LSP response write failed')}
  }else if(message.id!==undefined){
   const pending=session.pending.get(message.id)
   if(pending){
    clearTimeout(pending.timer);session.pending.delete(message.id)
    if(message.error)pending.reject(Error(String(message.error.message||'LSP error').slice(0,400)))
    else pending.resolve(message.result)
   }
  }
 }
}
async function start(key,options){
 const launch=await devLaunch(options.command,options.args||[],{cwd:options.root})
 const child=spawn(launch.command,launch.args,{cwd:options.root,env:launch.env,
  shell:false,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']})
 const session={key,child,dead:false,input:Buffer.alloc(0),pending:new Map(),nextId:0,
  docs:new Map(),tail:Promise.resolve(),busy:false,bytesThisQuery:0,lastUsed:Date.now(),
  pid:child.pid,stderr:''}
 child.on('error',e=>destroy(session,'LSP spawn failed: '+e.message))
 child.on('close',(code,sig)=>destroy(session,'LSP exited: '+(code??sig??'unknown')))
 child.stdout.on('data',chunk=>receive(session,chunk))
 child.stderr.on('data',chunk=>{session.stderr=(session.stderr+chunk.toString('utf8')).slice(-1000)})
 try{
  await request(session,'initialize',{
   processId:process.pid,rootUri:uri(options.root),rootPath:options.root,
   workspaceFolders:[{uri:uri(options.root),name:'DSH project'}],
   capabilities:{textDocument:{definition:{},references:{},documentSymbol:{hierarchicalDocumentSymbolSupport:true}},
    workspace:{configuration:true}},clientInfo:{name:'DSH P3 pooled',version:'1.0'}
  },options.timeoutMs||15000)
  notify(session,'initialized',{})
  return session
 }catch(error){destroy(session,'LSP initialization failed');throw error}
}
function expire(){
 const current=Date.now()
 for(const [key,slot] of sessions){
  if(slot.instance&&!slot.instance.busy&&current-slot.instance.lastUsed>IDLE_MS){
   destroy(slot.instance,'LSP idle session expired')
   sessions.delete(key)
  }
 }
}
export function lspSessionStatus(){
 expire()
 return {size:sessions.size,limit:MAX_SESSIONS,idleMs:IDLE_MS,
  sessions:[...sessions.values()].filter(x=>x.instance).map(x=>({
   root:x.options.root,command:x.options.command,pid:x.instance.pid,
   active:x.instance.busy,documents:x.instance.docs.size,lastUsed:x.instance.lastUsed
  }))}
}
export async function lspSessionClose({root}={}){
 let closed=0
 for(const [key,slot] of [...sessions]){
  if(root&&slot.options.root!==root)continue
  const session=slot.instance||await slot.promise.catch(()=>null)
  if(session)destroy(session,'LSP session closed by user')
  sessions.delete(key);closed++
 }
 return {closed}
}
export async function lspSessionQuery(options){
 if(!['definition','references','documentSymbols'].includes(options.action))throw Error('invalid LSP action')
 const timeoutMs=Math.min(30000,Math.max(1000,options.timeoutMs||15000))
 const source=await lstat(options.file)
 if(!source.isFile()||source.isSymbolicLink()||source.size>MAX_FILE)
  throw Error('LSP document must be a regular source <= 1 MiB')
 expire()
 const key=JSON.stringify([options.root,options.command,options.args||[]])
 let slot=sessions.get(key)
 if(!slot){
  if(sessions.size>=MAX_SESSIONS){
   const victim=[...sessions.values()].find(x=>x.instance&&!x.instance.busy)
   if(!victim)throw Error('maximum active LSP sessions reached')
   destroy(victim.instance,'LSP pool capacity eviction')
   sessions.delete(victim.key)
  }
  slot={key,options,instance:null,promise:null}
  sessions.set(key,slot)
  slot.promise=start(key,options).then(instance=>{slot.instance=instance;return instance})
   .catch(error=>{sessions.delete(key);throw error})
 }
 const session=await slot.promise
 const run=async()=>{
  if(session.dead)throw Error('LSP session expired')
  session.busy=true;session.bytesThisQuery=0
  try{
   const bytes=await readFile(options.file)
   if(bytes.length>MAX_FILE)throw Error('LSP document exceeds 1 MiB')
   const text=bytes.toString('utf8'),sha=digest(bytes),document=uri(options.file)
   let doc=session.docs.get(document)
   if(!doc){
    if(session.docs.size>=MAX_DOCS){
     const oldest=session.docs.keys().next().value
     notify(session,'textDocument/didClose',{textDocument:{uri:oldest}})
     session.docs.delete(oldest)
    }
    doc={sha,version:1}
    notify(session,'textDocument/didOpen',{textDocument:{
     uri:document,languageId:options.language,version:doc.version,text}})
   }else if(doc.sha!==sha){
    doc={sha,version:doc.version+1}
    notify(session,'textDocument/didChange',{
     textDocument:{uri:document,version:doc.version},contentChanges:[{text}]})
   }
   session.docs.delete(document);session.docs.set(document,doc)
   const method=options.action==='definition'?'textDocument/definition':
    options.action==='references'?'textDocument/references':'textDocument/documentSymbol'
   const params=options.action==='documentSymbols'?{textDocument:{uri:document}}:{
    textDocument:{uri:document},position:{line:Math.max(0,(options.line||1)-1),character:Math.max(0,(options.column||1)-1)},
    ...(options.action==='references'?{context:{includeDeclaration:true}}:{})}
   const result=await request(session,method,params,timeoutMs)
   session.lastUsed=Date.now()
   return {backend:options.command,precision:'language-server',method,
    result:Array.isArray(result)?result.slice(0,500):result,
    truncated:Array.isArray(result)&&result.length>500,persistent:true,
    sessionPid:session.pid,documentVersion:doc.version,stderr:session.stderr.slice(-250)}
  }finally{session.busy=false;session.lastUsed=Date.now()}
 }
 // Serialize per-server didOpen/didChange/queries to prevent interleaving.
 const output=session.tail.then(run)
 session.tail=output.catch(()=>{})
 try{return await output}
 catch(error){destroy(session,'LSP query failed');throw error}
}
// Keep pooled children from becoming orphans on normal MCP process exit.
process.once('exit',()=>{for(const slot of sessions.values()){
 if(slot.instance)destroy(slot.instance,'LSP host exiting')
}})
