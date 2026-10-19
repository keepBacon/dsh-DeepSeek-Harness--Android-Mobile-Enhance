import {createHash} from 'node:crypto'
import {readdir,readFile,lstat,realpath,stat} from 'node:fs/promises'
import {join,resolve,sep} from 'node:path'

const MAX_FILE=256*1024,MAX_READ=32*1024
const sha=s=>createHash('sha256').update(s).digest('hex')
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)
const valid=(x,cap=500)=>typeof x==='string'&&x.trim().length>0&&x.length<=cap
const resources=[
 {uri:'dsh://workspace/tree',name:'Workspace Tree',description:'Bounded shallow source tree',mimeType:'application/json'},
 {uri:'dsh://android/capabilities',name:'Android Capabilities',description:'Native permission and ABI observations',mimeType:'application/json'},
 {uri:'dsh://android/build',name:'Android Build Metadata',description:'Unverified local APK artifact metadata',mimeType:'application/json'},
 {uri:'dsh://android/saf',name:'Authorized SAF Imports',description:'List documents explicitly selected for MCP access',mimeType:'application/json'}
]
const templates=[{uriTemplate:'dsh://workspace/file/{path}',name:'Workspace File',description:'Bounded UTF-8 source, ?startLine=1&maxLines=80',mimeType:'text/plain'},
 {uriTemplate:'dsh://android/saf/{id}',name:'Imported SAF Text',description:'User-selected private text copy, limited to 32 KiB per resource read',mimeType:'text/plain'}]
const prompts=[
 {name:'engineering-audit',description:'Review architecture and regression risks',arguments:[{name:'scope',required:true}]},
 {name:'root-cause-analysis',description:'Evidence-based bug analysis',arguments:[{name:'symptom',required:true}]},
 {name:'safe-patch',description:'Plan a transactional code change',arguments:[{name:'goal',required:true}]},
 {name:'android-build-check',description:'Review Android/Termux build evidence',arguments:[{name:'target',required:true}]},
 {name:'mcp-plugin-diagnosis',description:'Safely inspect MCP plugin dispatch and schema',arguments:[{name:'plugin',required:true}]}
]
const bodies={
 'engineering-audit':x=>'Inspect '+x.scope+'. Map components, dependencies, contract risks, coverage, verified and unverified findings. Use bounded read-only workspace resources. Do not claim successful implementation without evidence.',
 'root-cause-analysis':x=>'Investigate '+x.symptom+'. Separate observation from hypotheses, correlate references and logs, and propose falsifiable reproduction tests. Never apply changes implicitly.',
 'safe-patch':x=>'Plan the smallest safe change for '+x.goal+'. Inspect impacted callers, define checksummed transactional edits, specify tests and rollback conditions. Confirm irreversible effects.',
 'android-build-check':x=>'Review '+x.target+'. Distinguish CI assemble, Termux packaging and real device execution. Check ABI, permissions, artifact provenance, signing and launch evidence.',
 'mcp-plugin-diagnosis':x=>'Diagnose plugin '+x.plugin+'. Compare registrations, schemas, dispatcher, read-only handler probes and JSON fidelity. Do not execute side-effectful probes.'
}
function safeRel(path){
 if(!valid(path,384)||path.startsWith('/')||path.includes('\\')||path.includes('\0'))throw Error('MCP_RESOURCE_INVALID_PATH')
 if(path.split('/').some(x=>!x||x==='.'||x==='..'||x.startsWith('.')||['node_modules','build','dist'].includes(x)))throw Error('MCP_RESOURCE_UNSAFE_PATH')
 return path
}
export function createMcpContext({workspace=process.env.DSH_MCP_WORKSPACE_ROOT||process.cwd(),androidSnapshotFile=process.env.DSH_MCP_ANDROID_CAPABILITIES_FILE||'',buildDir=process.env.DSH_MCP_BUILD_DIR||'',safDir=process.env.DSH_MCP_SAF_DIR||''}={}){
 const cache=new Map()
 let rootPromise
 const root=()=>rootPromise??=(async()=>{const p=await realpath(resolve(workspace));if(!(await lstat(p)).isDirectory())throw Error('MCP_WORKSPACE_NOT_DIRECTORY');return p})()
 async function checked(p){
  const r=await root();let current=r
  for(const segment of safeRel(p).split('/')){
   current=join(current,segment)
   const s=await lstat(current)
   if(s.isSymbolicLink())throw Error('MCP_RESOURCE_SYMLINK')
  }
  const actual=await realpath(current)
  if(!actual.startsWith(r+sep))throw Error('MCP_RESOURCE_OUTSIDE_ROOT')
  return actual
 }
 async function tree(){
  const r=await root(),items=[]
  async function walk(path,prefix='',depth=0){
   const listed=(await readdir(path,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))
   for(const entry of listed){
    if(items.length>=150)return
    if(entry.name.startsWith('.')||['build','dist','node_modules'].includes(entry.name)||entry.isSymbolicLink())continue
    const p=prefix?prefix+'/'+entry.name:entry.name
    if(entry.isDirectory()){items.push({path:p,type:'directory'});if(depth<1)await walk(join(path,entry.name),p,depth+1)}
    else if(entry.isFile())items.push({path:p,type:'file'})
   }
  }
  await walk(r)
  return {source:'workspace',entries:items,truncated:items.length>=150,maxDepth:2}
 }
 async function nativeSnapshot(){
  const fallback={source:'node-only',nativeBridge:false,root:'not-probed',shizuku:'not-probed',accessibility:'not-probed'}
  if(!androidSnapshotFile)return fallback
  try{
   const f=await lstat(androidSnapshotFile)
   if(!f.isFile()||f.isSymbolicLink()||f.size>16384)throw Error('unsafe native snapshot')
   const v=JSON.parse(await readFile(androidSnapshotFile,'utf8'))
   if(!obj(v)||v.schema!==1||v.source!=='android-native')throw Error('invalid native snapshot')
   return {source:'android-native',nativeBridge:true,sdkInt:v.sdkInt,deviceAbi:v.deviceAbi,
    permissions:obj(v.permissions)?v.permissions:{},collectedAt:v.collectedAt,
    safPersistedReadGrantCount:Number.isSafeInteger(v.safPersistedReadGrantCount)?v.safPersistedReadGrantCount:0,
    safContentBridgeAvailable:v.safContentBridgeAvailable===true,
    availableMemoryBytes:Number.isSafeInteger(v.availableMemoryBytes)?v.availableMemoryBytes:null,
    lowMemory:v.lowMemory===true,
    batteryOptimizationExempt:v.batteryOptimizationExempt===true,
    root:'not-probed',shizuku:'not-probed',accessibility:'not-probed',
    note:'Permission and provider availability are separate from authorization.'}
  }catch(e){return {...fallback,source:'snapshot-unavailable',error:String(e.code||e.message).slice(0,80)}}
 }
 async function builds(){
  if(!buildDir)return {enabled:false,artifacts:[],verified:false,note:'Configure DSH_MCP_BUILD_DIR to inspect file metadata.'}
  const base=await realpath(resolve(buildDir)),found=[]
  for(const name of ['app-debug.apk','app-release.apk','app-release-unsigned.apk','build-termux.log']){
   try{
    const f=await lstat(join(base,name))
    if(f.isFile()&&!f.isSymbolicLink())found.push({name,sizeBytes:f.size,modifiedAt:new Date(f.mtimeMs).toISOString(),verified:false})
   }catch(e){if(e.code!=='ENOENT')throw e}
  }
  return {enabled:true,artifacts:found,buildVerified:false,signingVerified:false}
 }
 async function safIndex(){
  if(!safDir)return {available:false,documents:[],note:'Android user-imported SAF bridge is not configured.'}
  const base=resolve(safDir)
  let dir
  try{dir=await lstat(base)}
  catch(e){if(e.code==='ENOENT')return {available:true,documents:[],note:'No user-selected documents.'};throw e}
  if(!dir.isDirectory()||dir.isSymbolicLink())throw Error('MCP_SAF_UNSAFE_DIRECTORY')
  const index=join(base,'index.json')
  let st
  try{st=await lstat(index)}
  catch(e){if(e.code==='ENOENT')return {available:true,documents:[]};throw e}
  if(!st.isFile()||st.isSymbolicLink()||st.size>32768)throw Error('MCP_SAF_UNSAFE_INDEX')
  const data=JSON.parse(await readFile(index,'utf8'))
  if(data.schema!==1||!Array.isArray(data.documents)||data.documents.length>12)throw Error('MCP_SAF_INVALID_INDEX')
  const docs=data.documents.map(x=>{
   if(!obj(x)||typeof x.id!=='string'||!/^saf-[0-9a-f]{32}$/.test(x.id)||
      !valid(x.name,100)||!Number.isSafeInteger(x.sizeBytes)||x.sizeBytes<1||x.sizeBytes>131072||
      typeof x.sha256!=='string'||!/^[0-9a-f]{64}$/.test(x.sha256))
     throw Error('MCP_SAF_INVALID_ENTRY')
   return {id:x.id,name:x.name,sizeBytes:x.sizeBytes,sha256:x.sha256,addedAt:x.addedAt}
  })
  if(new Set(docs.map(x=>x.id)).size!==docs.length)throw Error('MCP_SAF_DUPLICATE_ENTRY')
  return {available:true,documents:docs,resourceTemplate:'dsh://android/saf/{id}',note:'Only explicitly selected copies are listed. Original content:// URIs are never exposed.'}
 }
 async function safFile(uri){
  const u=new URL(uri),id=u.pathname.slice('/saf/'.length)
  if(!/^saf-[0-9a-f]{32}$/.test(id))throw Error('MCP_SAF_INVALID_ID')
  const allowed=await safIndex(),doc=allowed.documents.find(x=>x.id===id)
  if(!doc)throw Error('MCP_SAF_NOT_AUTHORIZED')
  const base=await realpath(resolve(safDir)),file=join(base,id+'.txt')
  const st=await lstat(file)
  if(!st.isFile()||st.isSymbolicLink()||st.size!==doc.sizeBytes||st.size>131072)
   throw Error('MCP_SAF_UNSAFE_FILE')
  const bytes=await readFile(file),text=bytes.toString('utf8')
  if(sha(bytes)!==doc.sha256||!Buffer.from(text).equals(bytes)||text.includes('\0'))
   throw Error('MCP_SAF_CONTENT_MISMATCH')
  const start=u.searchParams.has('startLine')?Number(u.searchParams.get('startLine')):1
  const count=u.searchParams.has('maxLines')?Number(u.searchParams.get('maxLines')):80
  if([...u.searchParams.keys()].some(x=>!['startLine','maxLines'].includes(x))||
    !Number.isSafeInteger(start)||start<1||!Number.isSafeInteger(count)||count<1||count>160)
   throw Error('MCP_SAF_INVALID_LINE_RANGE')
  const rows=text.split('\n'),chosen=rows.slice(start-1,start-1+count)
  let excerpt=chosen.join('\n'),truncated=excerpt.length>MAX_READ
  if(truncated)excerpt=excerpt.slice(0,MAX_READ)
  return {text:excerpt,metadata:{id,sha256:doc.sha256,totalLines:rows.length,
    startLine:start,returnedLines:chosen.length,truncated:truncated||start-1+count<rows.length}}
 }
 async function sourceFile(uri){
  const u=new URL(uri),p=decodeURIComponent(u.pathname.slice('/file/'.length))
  const start=u.searchParams.has('startLine')?Number(u.searchParams.get('startLine')):1
  const count=u.searchParams.has('maxLines')?Number(u.searchParams.get('maxLines')):80
  if([...u.searchParams.keys()].some(x=>!['startLine','maxLines'].includes(x))||
     !Number.isSafeInteger(start)||start<1||!Number.isSafeInteger(count)||count<1||count>160)
   throw Error('MCP_RESOURCE_INVALID_LINE_RANGE')
  const target=await checked(p),st=await stat(target)
  if(!st.isFile()||st.size>MAX_FILE)throw Error('MCP_RESOURCE_TOO_LARGE')
  const cacheKey=target+'|'+st.size+'|'+st.mtimeMs
  let text
  const item=cache.get(cacheKey)
  if(item&&Date.now()-item.at<3000)text=item.text
  else{
   const bytes=await readFile(target)
   text=bytes.toString('utf8')
   if(!Buffer.from(text).equals(bytes)||text.includes('\0'))throw Error('MCP_RESOURCE_BINARY')
   if(cache.size>=16)cache.clear()
   cache.set(cacheKey,{at:Date.now(),text})
  }
  const rows=text.split('\n'),chosen=rows.slice(start-1,start-1+count)
  let excerpt=chosen.join('\n')
  const clipped=excerpt.length>MAX_READ
  if(clipped)excerpt=excerpt.slice(0,MAX_READ)
  return {text:excerpt,metadata:{sha256:sha(text),version:st.mtimeMs,totalLines:rows.length,
   returnedLines:chosen.length,startLine:start,truncated:clipped||start-1+count<rows.length}}
 }
 async function readResource({uri}={}){
  if(!valid(uri,640)||!uri.startsWith('dsh://'))throw Error('MCP_RESOURCE_INVALID_URI')
  const u=new URL(uri)
  if(u.protocol!=='dsh:'||u.username||u.password||u.hash||u.port)throw Error('MCP_RESOURCE_UNSAFE_URI')
  let result,mimeType='application/json'
  if(u.hostname==='workspace'&&u.pathname.startsWith('/file/')){result=await sourceFile(uri);mimeType='text/plain'}
  else if(u.hostname==='android'&&u.pathname.startsWith('/saf/')){result=await safFile(uri);mimeType='text/plain'}
  else if(uri==='dsh://android/saf')result={text:JSON.stringify(await safIndex())}
  else if(uri==='dsh://workspace/tree')result={text:JSON.stringify(await tree())}
  else if(uri==='dsh://android/capabilities')result={text:JSON.stringify(await nativeSnapshot())}
  else if(uri==='dsh://android/build')result={text:JSON.stringify(await builds())}
  else throw Error('MCP_RESOURCE_UNKNOWN')
  return {contents:[{uri,mimeType,text:result.text}],_meta:{dsh:result.metadata||{bounded:true}}}
 }
 function listResources(){return {resources:resources.map(x=>({...x}))}}
 function listResourceTemplates(){return {resourceTemplates:templates.map(x=>({...x}))}}
 function listPrompts(){return {prompts:prompts.map(x=>({...x}))}}
 function getPrompt({name,arguments:values={}}={}){
  if(typeof name!=='string'||!Object.hasOwn(bodies,name))throw Error('MCP_PROMPT_UNKNOWN')
  const definition=prompts.find(x=>x.name===name)
  if(!obj(values)||Object.keys(values).some(k=>!definition.arguments.some(arg=>arg.name===k)))throw Error('MCP_PROMPT_UNKNOWN_ARGUMENT')
  for(const arg of definition.arguments)if(!valid(values[arg.name],400))throw Error('MCP_PROMPT_REQUIRED_ARGUMENT: '+arg.name)
  return {description:definition.description,messages:[{role:'user',content:{type:'text',text:bodies[name](values)}}]}
 }
 function contextBudget({text,query='',maxChars=4000}={}){
  if(!valid(text,MAX_FILE))throw Error('MCP_CONTEXT_TEXT_REQUIRED')
  const budget=Number.isInteger(maxChars)?Math.min(12000,Math.max(256,maxChars)):4000
  const terms=typeof query==='string'?query.toLowerCase().slice(0,120).split(/\s+/).filter(Boolean):[]
  const lines=text.split('\n'),scored=lines.map((line,i)=>({line,i,score:terms.reduce((sum,x)=>sum+Number(line.toLowerCase().includes(x)),0)}))
  const candidates=terms.length?scored.filter(x=>x.score>0).sort((a,b)=>b.score-a.score||a.i-b.i):scored
  let used=0;const chosen=[]
  for(const c of candidates){
   const fragment=(c.i+1)+': '+c.line
   if(used+fragment.length+1>budget)break
   chosen.push({i:c.i,fragment});used+=fragment.length+1
  }
  chosen.sort((a,b)=>a.i-b.i)
  return {excerpt:chosen.map(x=>x.fragment).join('\n'),inputSha256:sha(text),inputChars:text.length,
   outputChars:used,selectedLines:chosen.length,totalLines:lines.length,truncated:chosen.length<lines.length,
   note:'Extractive context only; no generated claims. Original evidence remains authoritative.'}
 }
 return {listResources,listResourceTemplates,readResource,listPrompts,getPrompt,contextBudget,nativeSnapshot,builds}
}
