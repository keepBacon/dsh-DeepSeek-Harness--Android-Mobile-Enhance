// DSH Development Engine P1: bounded, incremental, durable project index.
// No source code execution and no writes to the indexed repository.
// Persistence is in DSH-owned HOME, keyed by canonical project path.
// JS/TS syntax uses bundled TypeScript AST when present; cross-file semantic
// navigation delegates to the existing TypeScript language service.
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, lstat, rename, rm, stat, writeFile } from 'node:fs/promises'
import { resolve, relative, dirname, extname, join, sep } from 'node:path'
import { homedir } from 'node:os'
import { TextDecoder } from 'node:util'
import { languageOf, parseSource } from './dsh-project-language.mjs'
import { codeAstCall } from './dsh-code-engine-ast.mjs'

const VERSION=1, MAX_FILES=5000, MAX_SIZE=1024*1024, MAX_DEPTH=24, MAX_TOTAL=48*1024*1024
const IGNORED=new Set(['.git','node_modules','build','dist','target','.gradle','.idea','.cache','vendor',
 'coverage','.next','.venv','venv','__pycache__','.turbo','.yarn','.pnpm-store','out','bin','obj','.dsh'])
const MAX_INDEX_BYTES=20*1024*1024
const queues=new Map()
const obj=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false})
const str={type:'string'}
const root={root:{type:'string',description:'Project directory; defaults to current MCP working directory.'}}
const limit={limit:{type:'integer',minimum:1,maximum:500,default:100}}
export const workspaceTools=[
 {name:'workspace_index',description:'Build/update a bounded incremental persistent project symbol/import index. Never follows symlinks or writes to the project.',inputSchema:obj({...root,maxFiles:{type:'integer',minimum:1,maximum:5000},force:{type:'boolean',default:false}})},
 {name:'workspace_status',description:'Show last indexed project snapshot freshness, file counts and analysis confidence.',inputSchema:obj(root)},
 {name:'workspace_symbols',description:'Search indexed declarations in all supported languages. JS/TS parsed with TypeScript AST, others with conservative heuristics.',inputSchema:obj({...root,query:str,language:str,...limit})},
 {name:'workspace_references',description:'Find word-occurrence candidates for a symbol; optional JS/TS source position yields TypeScript semantic references for bounded projects.',inputSchema:obj({...root,name:str,file:str,line:{type:'integer',minimum:1},column:{type:'integer',minimum:1},semantic:{type:'boolean',default:true},...limit},['name'])},
 {name:'workspace_definition',description:'List possible declarations for a name. A JS/TS position can use the existing TypeScript language service for precise symbol references.',inputSchema:obj({...root,name:str,file:str,line:{type:'integer',minimum:1},column:{type:'integer',minimum:1},...limit},['name'])},
 {name:'workspace_dependencies',description:'Inspect indexed local import graph and unresolved imports; dynamic imports remain incomplete.',inputSchema:obj({...root,file:str,...limit})},
 {name:'workspace_impact',description:'Find reverse transitive importers of changed source files; conservative static impact graph.',inputSchema:obj({...root,changedFiles:{type:'array',minItems:1,maxItems:40,items:str},...limit},['changedFiles'])},
 {name:'workspace_diagnostics',description:'List bounded parser errors and unresolved static local imports, with explicit heuristic confidence.',inputSchema:obj({...root,file:str,...limit})},
]
export const isWorkspaceTool=name=>workspaceTools.some(x=>x.name===name)
const sha=data=>createHash('sha256').update(data).digest('hex')
const bounded=(n,d,min,max)=>Number.isInteger(n)?Math.max(min,Math.min(max,n)):d
const inRoot=(path,base)=>path===base||path.startsWith(base+sep)
const normalized=(p)=>p.split(sep).join('/')
const persistentRoot=()=>process.env.DSH_PROJECT_INDEX_DIR||join(process.env.HOME||homedir(),'.dsh','project-index')
function memoryBarrier(root,task){
 const prev=queues.get(root)||Promise.resolve()
 const current=prev.catch(()=>{}).then(task)
 queues.set(root,current)
 void current.finally(()=>{if(queues.get(root)===current)queues.delete(root)}).catch(()=>{})
 return current
}
async function projectRoot(requested){
 const root=await realpath(resolve(requested||process.cwd()))
 if(!(await stat(root)).isDirectory())throw Error('project root is not a directory')
 return root
}
function cachePath(root){return join(persistentRoot(),sha(root)+'.json')}
async function load(root){
 try{
  const file=cachePath(root),metadata=await lstat(file)
  if(!metadata.isFile()||metadata.size>MAX_INDEX_BYTES)throw Error('project index cache invalid or too large')
  const data=JSON.parse(await readFile(file,'utf8'))
  if(data.version!==VERSION||data.root!==root||typeof data.files!=='object'||Array.isArray(data.files))
   throw Error('project index schema incompatible; reindex required')
  return data
 }catch(e){if(e.code==='ENOENT')return null;throw e}
}
async function save(root,data){
 const dir=persistentRoot()
 await mkdir(dir,{recursive:true,mode:0o700})
 const payload=JSON.stringify(data)
 if(Buffer.byteLength(payload)>MAX_INDEX_BYTES)throw Error('project index exceeds 20 MiB')
 const dest=cachePath(root),tmp=dest+'.'+randomBytes(6).toString('hex')+'.tmp'
 try{
  await writeFile(tmp,payload,{mode:0o600,flag:'wx'})
  await rename(tmp,dest)
 }finally{await rm(tmp,{force:true}).catch(()=>{})}
}
async function discover(base,maxFiles){
 let skipped=0,truncated=false
 const names=[],pending=[{dir:base,depth:0}]
 while(pending.length){
  const {dir,depth}=pending.shift()
  let entries
  try{entries=await readdir(dir,{withFileTypes:true})}catch(e){
   if(['EACCES','EPERM','ENOENT'].includes(e.code)){skipped++;continue}throw e
  }
  entries.sort((a,b)=>a.name.localeCompare(b.name))
  for(const entry of entries){
   if(entry.isSymbolicLink()){skipped++;continue}
   const path=join(dir,entry.name)
   if(entry.isDirectory()){
    if(!IGNORED.has(entry.name)&&depth<MAX_DEPTH)pending.push({dir:path,depth:depth+1})
    else skipped++
   }else if(entry.isFile()&&languageOf(entry.name)){
    if(names.length>=maxFiles){truncated=true;pending.length=0;break}
    names.push({path,relative:normalized(relative(base,path))})
   }
  }
 }
 return {names,skipped,truncated}
}
async function indexUnlocked(base,opts={}){
 const maxFiles=bounded(opts.maxFiles,MAX_FILES,1,MAX_FILES)
 const previous=opts.force?null:await load(base)
 const files={},scan=await discover(base,maxFiles)
 let changed=0,reused=0,removed=0,oversize=0,scannedBytes=0
 for(const entry of scan.names){
  const st=await lstat(entry.path).catch(()=>null)
  if(!st||!st.isFile()){scan.skipped++;continue}
  if(st.size>MAX_SIZE){oversize++;continue}
  const fingerprint=[st.size,st.mtimeMs,st.ctimeMs,st.ino].join(':')
  const prior=previous?.files?.[entry.relative]
  if(prior&&prior.fingerprint===fingerprint){files[entry.relative]=prior;reused++;continue}
  if(scannedBytes+st.size>MAX_TOTAL){scan.truncated=true;break}
  scannedBytes+=st.size
  let content
  try{
   const bytes=await readFile(entry.path)
   content=new TextDecoder('utf-8',{fatal:true}).decode(bytes)
   if(content.includes('\0')){scan.skipped++;continue}
  }catch(e){if(e.name==='TypeError'||e.code==='EACCES'){scan.skipped++;continue}throw e}
  const parsed=parseSource(entry.relative,content)
  files[entry.relative]={fingerprint,sha256:sha(content),size:st.size,
   language:parsed.language,parser:parsed.parser,confidence:parsed.confidence,
   symbols:parsed.symbols,refs:parsed.refs,imports:parsed.imports,
   diagnostics:parsed.diagnostics,packageName:parsed.packageName}
  changed++
 }
 if(previous)removed=Object.keys(previous.files).filter(x=>!Object.hasOwn(files,x)).length
 const result={version:VERSION,root:base,updatedAt:new Date().toISOString(),files,
  stats:{total:Object.keys(files).length,changed,reused,removed,oversize,skipped:scan.skipped,
   truncated:scan.truncated,scannedBytes,complete:!scan.truncated&&oversize===0}}
 await save(base,result)
 return result
}
async function ensure(base,opts={}){
 // Queries update the index only when explicitly requested or missing.
 return memoryBarrier(base,async()=> {
  const current=await load(base)
  return opts.update||!current?await indexUnlocked(base,opts):current
 })
}
function summarize(state,extra={}){
 return {root:state.root,version:state.version,updatedAt:state.updatedAt,
  stats:state.stats,...extra,
  coverage:'JS/TS AST when TypeScript is installed; other languages heuristic. No LSP service for Python/Java/Kotlin/C++/Lua.'}
}
function allEntries(state){
 return Object.entries(state.files).sort(([a],[b])=>a.localeCompare(b))
}
function normalizeFile(file,base){
 const result=resolve(base,file)
 if(!inRoot(result,base))throw Error('path escapes project root: '+file)
 return normalized(relative(base,result))
}
function resolveImports(state){
 const entries=allEntries(state),paths=new Set(entries.map(([file])=>file))
 const packageLookup=new Map()
 for(const [file,row] of entries)if((row.language==='Java'||row.language==='Kotlin')&&row.packageName)
  packageLookup.set(row.packageName+'.'+file.split('/').at(-1).replace(/\.[^.]+$/,''),file)
 const edges=[],unresolved=[]
 const extensions=['.ts','.tsx','.mts','.cts','.js','.jsx','.mjs','.cjs','.py','.kt','.java','.lua','.luau','.h','.hpp']
 const targetFor=(base,extensions)=>{
  const normalizedBase=normalized(base)
  return [normalizedBase,...extensions.map(x=>normalizedBase+x),...['index.ts','index.js','index.mjs','__init__.py','init.lua'].map(x=>normalizedBase+'/'+x)].find(x=>paths.has(x))
 }
 for(const [file,row] of entries){
  for(const item of row.imports){
   const ref=item.specifier
   let target=null,local=false
   const pathDirectory=dirname('/'+file)
   if(ref.startsWith('.')){
    local=true
    if(row.language==='Python'){
     const dots=ref.match(/^\.+/)?.[0].length||1
     const module=ref.slice(dots).replace(/\./g,'/')
     const anchor=resolve(pathDirectory,...Array(dots-1).fill('..'),module)
     target=targetFor(anchor,extensions)
    }else{
     target=targetFor(resolve(pathDirectory,ref),extensions)
    }
   }else if((row.language==='Java'||row.language==='Kotlin')&&packageLookup.has(ref)){
    local=true;target=packageLookup.get(ref)
   }else if((row.language==='Java'||row.language==='Kotlin')&&ref.endsWith('.*')){
    for(const [name,fileTarget] of packageLookup)if(name.startsWith(ref.slice(0,-1)))edges.push({from:file,to:fileTarget,kind:item.kind})
    continue
   }else if((row.language==='C'||row.language==='C++'||row.language==='C/C++')&&
    (paths.has(normalized(resolve(pathDirectory,ref)).replace(/^\//,''))||paths.has(ref))){
    local=true;target=targetFor(resolve(pathDirectory,ref),extensions)||ref
   }
   if(target){
    target=target.replace(/^\//,'')
    if(target!==file&&paths.has(target))edges.push({from:file,to:target,kind:item.kind})
    else if(local)unresolved.push({file,ref,line:item.line,kind:item.kind})
   }else if(local)unresolved.push({file,ref,line:item.line,kind:item.kind})
  }
 }
 return {edges:[...new Map(edges.map(x=>[[x.from,x.to,x.kind].join('\0'),x])).values()],
  unresolved:unresolved.slice(0,1000),complete:state.stats.complete}
}
function projectedEntries(state,args){
 const query=(args.query||'').toLowerCase()
 const limit=bounded(args.limit,100,1,500)
 const results=[]
 for(const [file,row] of allEntries(state)){
  if(args.language&&row.language.toLowerCase()!==String(args.language).toLowerCase())continue
  for(const x of row.symbols){
   if(query&&!x.name.toLowerCase().includes(query))continue
   results.push({file,language:row.language,parser:row.parser,confidence:row.confidence,...x})
   if(results.length>=limit)return {results,truncated:true}
  }
 }
 return {results,truncated:false}
}
async function semanticRefs(state,base,args){
 if(args.semantic===false||!args.file||!args.line||!args.column)return null
 const selected=normalizeFile(args.file,base)
 if(!/\.([cm]?js|[cm]?ts|jsx|tsx)$/.test(selected))return null
 const sources=allEntries(state).filter(([p])=>/\.([cm]?js|[cm]?ts|jsx|tsx)$/.test(p)).map(([p])=>join(base,p))
 if(sources.length>128)return {strategy:'incomplete',reason:'TypeScript language service is bounded to 128 source files',truncated:true}
 try{
  const file=join(base,selected)
  const response=await codeAstCall('code_ast_references',{file,line:args.line,column:args.column,
   projectFiles:sources.filter(x=>x!==file),maxResults:bounded(args.limit,100,1,500)})
  return {strategy:'typescript-language-service',precision:'semantic',results:response.locations.map(x=>({...x,file:normalizeFile(x.path,base)})),
   total:response.total,truncated:response.truncated}
 }catch(error){return {strategy:'typescript-language-service-unavailable',reason:String(error.message||error),truncated:true}}
}
function referenceCandidates(state,name,limit){
 const found=[]
 for(const [file,row] of allEntries(state))for(const ref of row.refs){
  if(ref.name!==name)continue
  found.push({file,language:row.language,confidence:'lexical-candidate',...ref})
  if(found.length>=limit)return {results:found,truncated:true}
 }
 return {results:found,truncated:false}
}
function dependencies(state,args){
 const graph=resolveImports(state),limit=bounded(args.limit,100,1,500)
 const key=args.file?normalizeFile(args.file,state.root):null
 return summarize(state,{strategy:'static-import-graph',complete:graph.complete,
  edges:graph.edges.filter(x=>!key||x.from===key||x.to===key).slice(0,limit),
  unresolved:graph.unresolved.filter(x=>!key||x.file===key).slice(0,limit),
  totalEdges:graph.edges.length,
  truncated:graph.edges.length>limit||graph.unresolved.length>limit})
}
function impact(state,args){
 const graph=resolveImports(state),backward=new Map()
 for(const edge of graph.edges){
  if(!backward.has(edge.to))backward.set(edge.to,new Set())
  backward.get(edge.to).add(edge.from)
 }
 const seed=(args.changedFiles||[]).map(x=>normalizeFile(x,state.root))
 const visited=new Set(seed),queue=seed.map(file=>({file,depth:0})),affected=[]
 while(queue.length){
  const {file,depth}=queue.shift()
  for(const parent of backward.get(file)||[]){
   if(visited.has(parent))continue
   visited.add(parent);affected.push({file:parent,depth:depth+1,via:file})
   queue.push({file:parent,depth:depth+1})
   if(affected.length>5000)break
  }
  if(affected.length>5000)break
 }
 return summarize(state,{changedFiles:seed,affected:affected.slice(0,bounded(args.limit,100,1,500)),
  totalAffected:affected.length,truncated:affected.length>bounded(args.limit,100,1,500)||!state.stats.complete,
  strategy:'reverse-static-imports',semantic:false})
}
function diagnostics(state,args){
 const graph=resolveImports(state),limit=bounded(args.limit,100,1,500)
 const file=args.file?normalizeFile(args.file,state.root):null
 const issues=[]
 for(const [path,row] of allEntries(state)){
  if(file&&file!==path)continue
  for(const item of row.diagnostics)issues.push({file:path,source:row.parser,...item})
  if(issues.length>=limit)break
 }
 for(const x of graph.unresolved){
  if(file&&file!==x.file)continue
  if(issues.length>=limit)break
  issues.push({file:x.file,line:x.line,source:'static-import-graph',severity:'warning',
   message:'Unresolved relative import: '+x.ref})
 }
 return summarize(state,{issues,totalIssues:issues.length,truncated:issues.length>=limit||!state.stats.complete,
  note:'Heuristic languages have no compiler diagnostics. Use language compilers/LSP for authoritative errors.'})
}
export async function workspaceCall(name,args={}){
 if(!isWorkspaceTool(name))throw Error('unknown workspace tool')
 const base=await projectRoot(args.root)
 if(name==='workspace_index'){
  const state=await ensure(base,{update:true,force:args.force===true,maxFiles:args.maxFiles})
  return summarize(state)
 }
 const state=await ensure(base)
 if(name==='workspace_status')return summarize(state)
 if(name==='workspace_symbols')return summarize(state,projectedEntries(state,args))
 if(name==='workspace_references'){
  const semantic=await semanticRefs(state,base,args)
  if(semantic?.strategy==='typescript-language-service')return summarize(state,semantic)
  const candidates=referenceCandidates(state,args.name,bounded(args.limit,100,1,500))
  return summarize(state,{strategy:'lexical-candidates',precision:'heuristic',...candidates,
   semanticAttempt:semantic||null})
 }
 if(name==='workspace_definition'){
  const symbols=projectedEntries(state,{query:args.name,limit:500})
  const results=symbols.results.filter(x=>x.name===args.name).slice(0,bounded(args.limit,100,1,500))
  return summarize(state,{strategy:'declaration-candidates',precision:'heuristic',results,
   ambiguous:results.length>1,truncated:symbols.truncated})
 }
 if(name==='workspace_dependencies')return dependencies(state,args)
 if(name==='workspace_impact')return impact(state,args)
 if(name==='workspace_diagnostics')return diagnostics(state,args)
 throw Error('unknown workspace operation')
}
