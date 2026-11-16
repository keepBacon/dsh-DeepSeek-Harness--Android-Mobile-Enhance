// DSH P1 optional LSP backend. Uses standard Content-Length JSON-RPC over
// argv-only stdio; never shells user text or installs language servers.
// The MCP API reports unavailable backends instead of implying precision.
import { spawn } from 'node:child_process'
import { realpath, readFile, lstat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { devLaunch } from './dsh-dev-process.mjs'

const BACKENDS={
 clangd:{command:'clangd',args:['--background-index=false','--log=error'],ext:['.c','.cc','.cpp','.cxx','.h','.hpp','.hh'],language:'cpp'},
 pyright:{command:'pyright-langserver',args:['--stdio'],ext:['.py'],language:'python'},
 kotlin:{command:'kotlin-language-server',args:[],ext:['.kt','.kts'],language:'kotlin'},
 java:{command:'jdtls',args:[],ext:['.java'],language:'java'},
 lua:{command:'lua-language-server',args:[],ext:['.lua','.luau'],language:'lua'},
}
const LIMIT=2, active={count:0}
const obj=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false})
export const lspTools=[
 {name:'workspace_lsp_status',description:'Check which optional C/C++/Python/Java/Kotlin/Lua language-server executables are installed. No server is launched.',inputSchema:obj({})},
 {name:'workspace_lsp_query',description:'Ask an installed language server for definition, references or document symbols using bounded JSON-RPC; returns explicit missing-backend errors.',inputSchema:obj({
  root:{type:'string'},file:{type:'string'},backend:{type:'string',enum:['auto',...Object.keys(BACKENDS)],default:'auto'},
  action:{type:'string',enum:['definition','references','documentSymbols']},
  line:{type:'integer',minimum:1},column:{type:'integer',minimum:1},
  timeoutMs:{type:'integer',minimum:1000,maximum:30000}
 },['file','action'])},
]
export const isLspTool=name=>lspTools.some(t=>t.name===name)
const inRoot=(x,root)=>x===root||x.startsWith(root+sep)
const clamp=(x,d,a,b)=>Number.isInteger(x)?Math.max(a,Math.min(b,x)):d
function selectBackend(file,preferred){
 if(preferred&&preferred!=='auto'){
  if(!BACKENDS[preferred])throw Error('unknown LSP backend')
  return preferred
 }
 const ext=/\.[a-z0-9]+$/i.exec(file)?.[0]?.toLowerCase()
 return Object.keys(BACKENDS).find(name=>BACKENDS[name].ext.includes(ext))||null
}
async function probeBackend(name){
 const backend=BACKENDS[name]
 const prefix=process.env.TERMUX__PREFIX||process.env.PREFIX||''
 if(prefix.startsWith('/data/')){
  const path=join(prefix,'bin',backend.command)
  try{
   const f=await lstat(path)
   return {backend:name,command:backend.command,installed:f.isFile()||f.isSymbolicLink(),reason:null}
  }catch(e){return {backend:name,command:backend.command,installed:false,reason:e.code||'not_available'}}
 }
 const paths=(process.env.PATH||'').split(':')
 for(const path of paths){if(!path)continue;try{
  const f=await lstat(join(path,backend.command))
  if(f.isFile()||f.isSymbolicLink())return {backend:name,command:backend.command,installed:true}
 }catch{}}
 return {backend:name,command:backend.command,installed:false,reason:'not_on_path'}
}
function uri(p){return pathToFileURL(p).href}
function asLspFrame(message){
 const raw=Buffer.from(JSON.stringify(message),'utf8')
 return Buffer.concat([Buffer.from('Content-Length: '+raw.length+'\r\n\r\n','ascii'),raw])
}
export async function lspExchange({command,args=[],root,file,language,action,line=1,column=1,timeoutMs=10000}){
 if(active.count>=LIMIT)throw Error('maximum concurrent language-server requests reached')
 active.count++
 let child,ended=false,input=Buffer.alloc(0),inFlight=new Map(),errOutput='',total=0
 const timeout=clamp(timeoutMs,10000,1000,30000)
 const fail=error=>{for(const waiter of inFlight.values())waiter.reject(error);inFlight.clear()}
 function reply(message){
  if(message.method&&message.id!==undefined){
   // Standard capability requests; do not execute LSP "workspace/executeCommand".
   const response={jsonrpc:'2.0',id:message.id,result:
    message.method==='workspace/configuration'?[]:null}
   send(response)
  }else if(message.id!==undefined){
   const waiter=inFlight.get(message.id)
   if(waiter){inFlight.delete(message.id);if(message.error)waiter.reject(Error(String(message.error.message||'LSP error')))
    else waiter.resolve(message.result)}
  }
 }
 function parse(){
  while(input.length){
   const end=input.indexOf('\r\n\r\n')
   if(end<0){if(input.length>4096)throw Error('oversized LSP header');break}
   const header=input.subarray(0,end).toString('ascii')
   const match=/(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/i.exec(header)
   if(!match)throw Error('language server sent invalid Content-Length')
   const length=Number(match[1])
   if(!Number.isSafeInteger(length)||length>4*1024*1024||length<0)throw Error('LSP response too large')
   if(input.length<end+4+length)break
   const payload=input.subarray(end+4,end+4+length)
   input=input.subarray(end+4+length)
   reply(JSON.parse(payload.toString('utf8')))
  }
 }
 function send(message){
  if(ended||!child?.stdin?.writable)throw Error('LSP server not writable')
  child.stdin.write(asLspFrame(message))
 }
 function request(id,method,params){
  return new Promise((resolve,reject)=>{
   inFlight.set(id,{resolve,reject})
   try{send({jsonrpc:'2.0',id,method,params})}catch(e){inFlight.delete(id);reject(e)}
  })
 }
 const term=()=>{
  if(!child?.pid)return
  try{process.kill(-child.pid,'SIGKILL')}catch{try{child.kill('SIGKILL')}catch{}}
 }
 try{
  const launch=await devLaunch(command,args,{cwd:root})
  child=spawn(launch.command,launch.args,{cwd:root,env:launch.env,shell:false,
   detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']})
  child.on('error',e=>{ended=true;fail(e)})
  child.on('close',(code,signal)=>{ended=true;fail(Error('LSP server exited: '+(code??signal??'unknown')+' '+errOutput.slice(-300)))})
  child.stdout.on('data',buf=>{
   total+=buf.length
   if(total>24*1024*1024){ended=true;term();fail(Error('LSP output budget exceeded'));return}
   input=Buffer.concat([input,buf])
   try{parse()}catch(e){ended=true;term();fail(e)}
  })
  child.stderr.on('data',buf=>{errOutput=(errOutput+buf.toString('utf8')).slice(-1000)})
  const abort=setTimeout(()=>{ended=true;term();fail(Error('LSP request timeout'))},timeout)
  try{
   await request(1,'initialize',{processId:process.pid,rootUri:uri(root),rootPath:root,
    workspaceFolders:[{uri:uri(root),name:'DSH project'}],
    capabilities:{textDocument:{definition:{},references:{},documentSymbol:{hierarchicalDocumentSymbolSupport:true}},
     workspace:{configuration:true}},clientInfo:{name:'DSH P1',version:'1.0'}})
   send({jsonrpc:'2.0',method:'initialized',params:{}})
   const content=await readFile(file,'utf8')
   if(Buffer.byteLength(content)>1024*1024)throw Error('source exceeds 1 MiB')
   send({jsonrpc:'2.0',method:'textDocument/didOpen',params:{textDocument:{
    uri:uri(file),languageId:language,version:1,text:content}}})
   const position={line:Math.max(0,line-1),character:Math.max(0,column-1)}
   const method=action==='definition'?'textDocument/definition':
    action==='references'?'textDocument/references':'textDocument/documentSymbol'
   const params=action==='documentSymbols'?{textDocument:{uri:uri(file)}}:
    {textDocument:{uri:uri(file)},position,
     ...(action==='references'?{context:{includeDeclaration:true}}:{})}
   const result=await request(2,method,params)
   return {backend:command,precision:'language-server',method,
    result:Array.isArray(result)?result.slice(0,500):result,
    truncated:Array.isArray(result)&&result.length>500,stderr:errOutput.slice(-250)}
  }finally{clearTimeout(abort)}
 }finally{
  ended=true;term()
  child?.stdin?.destroy()
  child?.stdout?.destroy()
  child?.stderr?.destroy()
  active.count--
 }
}
export async function lspCall(name,args={}){
 if(name==='workspace_lsp_status')
  return {backends:await Promise.all(Object.keys(BACKENDS).map(probeBackend)),
   note:'Language server must be present to provide semantic results; unavailable tools are not simulated.'}
 if(name!=='workspace_lsp_query')throw Error('unknown language server tool')
 const root=await realpath(resolve(args.root||process.cwd()))
 const file=await realpath(resolve(root,args.file))
 if(!inRoot(file,root))throw Error('LSP source is outside project root')
 const backend=selectBackend(file,args.backend||'auto')
 if(!backend)return {available:false,reason:'No registered language server for this language'}
 const status=await probeBackend(backend)
 if(!status.installed)return {available:false,backend,reason:'Language server missing: '+status.command}
 const profile=BACKENDS[backend]
 const response=await lspExchange({command:profile.command,args:profile.args,root,file,
  language:profile.language,action:args.action,line:args.line||1,column:args.column||1,
  timeoutMs:args.timeoutMs||15000})
 return {available:true,backend,...response}
}
