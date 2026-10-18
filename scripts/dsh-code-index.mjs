import {fileURLToPath} from 'node:url'
import {createHash,randomBytes} from 'node:crypto'
import {open,readFile,readdir,lstat,realpath,mkdir,rename,rm,mkdtemp,writeFile} from 'node:fs/promises'
import {resolve,join,extname,relative} from 'node:path'
import {tmpdir} from 'node:os'

const FORMAT=1,MAX_FILES=4000,MAX_SOURCE=512*1024,MAX_INDEX=8*1024*1024
const EXT=new Set(['.js','.mjs','.cjs','.jsx','.ts','.tsx','.kt','.java','.py','.go','.rs','.lua','.c','.cc','.cpp','.h','.hpp','.sh'])
const IGNORED=new Set(['node_modules','.git','.gradle','.idea','dist','build','vendor','coverage','.dsh','__pycache__'])
const digest=s=>createHash('sha256').update(s).digest('hex')
const delay=ms=>new Promise(r=>setTimeout(r,ms))
function limitInt(v,def,min,max){return Number.isInteger(v)?Math.max(min,Math.min(max,v)):def}
function safeRel(v){if(typeof v!=='string'||!v||v.length>512||v.includes('\0')||v.includes('\\')||v.startsWith('/')||v.split('/').some(x=>!x||x==='.'||x==='..'))throw Error('unsafe relative source path');return v}
async function workspace(p){const root=await realpath(resolve(p||'.'));if(!(await lstat(root)).isDirectory())throw Error('workspace is not a directory');return root}
async function enumerate(root){
 const files=[],queue=[''];let dirs=0,truncated=false
 for(let head=0;head<queue.length;head++){
  if(dirs++>=MAX_FILES){truncated=true;break}
  const dir=queue[head],entries=await readdir(resolve(root,dir),{withFileTypes:true})
  entries.sort((a,b)=>a.name.localeCompare(b.name))
  for(const entry of entries){
   if(entry.isSymbolicLink())continue
   const name=dir?dir+'/'+entry.name:entry.name
   if(entry.isDirectory()){if(!IGNORED.has(entry.name)&&queue.length<MAX_FILES)queue.push(name);else if(queue.length>=MAX_FILES)truncated=true}
   else if(entry.isFile()&&EXT.has(extname(name))){if(files.length<MAX_FILES)files.push(name);else truncated=true}
  }
 }
 return {files,truncated}
}
function parse(source,file){
 const ext=extname(file)
 const patterns=ext==='.py'?[ /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm ]:
 (ext==='.kt'||ext==='.java')?[ /^\s*(?:(?:public|private|protected|internal|open|suspend|static|final|abstract|override|data|sealed|inline|fun)\s+)*(?:class|interface|object|enum|fun|record)\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)/gm ]:
 ext==='.rs'?[ /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|mod)\s+([A-Za-z_]\w*)/gm ]:
 ext==='.go'?[ /^\s*(?:func|type)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm ]:
 ext==='.lua'?[ /^\s*(?:local\s+)?function\s+([A-Za-z_][\w.:]*)/gm ]:
 [ /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,/^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/gm ]
 const imports=[]
 const importPattern=ext==='.py'? /^\s*(?:from\s+([.\w]+)\s+import\b|import\s+([\w.]+))/gm :
 (ext==='.kt'||ext==='.java')?/^\s*import\s+(?:static\s+)?([\w.*]+)/gm:
 /\.(?:c|cc|cpp|h|hpp)$/.test(ext)?/^\s*#include\s*[<"]([^>"]+)[>"]/gm:
 /^\s*(?:import|export)\s+.*?\s+from\s+['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\)/gm
 // Precompute newline offsets; locating thousands of declarations stays O(n + k log n).
 const lines=[];for(let i=0;i<source.length;i++)if(source.charCodeAt(i)===10)lines.push(i)
 const lineAt=offset=>{let lo=0,hi=lines.length;while(lo<hi){const m=(lo+hi)>>1;if(lines[m]<offset)lo=m+1;else hi=m}return lo+1}
 const declarations=[]
 for(const p of patterns){for(const match of source.matchAll(p)){if(declarations.length>=300)break;declarations.push({name:match[1],line:lineAt(match.index)});}}
 for(const match of source.matchAll(importPattern)){if(imports.length>=120)break;const target=match[1]||match[2]||match[3];if(target)imports.push({target,line:lineAt(match.index)})}
 declarations.sort((a,b)=>a.line-b.line)
 return {declarations,imports}
}
function storeDir(){return resolve(process.env.DSH_CODE_INDEX_HOME||join(process.env.HOME||tmpdir(),'.dsh','mobile','coding-index'))}
async function writeAtomic(path,payload){
 const temp=path+'.tmp-'+randomBytes(7).toString('hex')
 try{const file=await open(temp,'wx',0o600);try{await file.writeFile(payload);await file.sync()}finally{await file.close()}await rename(temp,path)}
 catch(e){await rm(temp,{force:true}).catch(()=>{});throw e}
}
async function mutex(path,fn){
 const lock=path+'.lock',start=Date.now();let handle
 for(;;){try{handle=await open(lock,'wx',0o600);break}catch(e){if(e.code!=='EEXIST')throw e
  try{const state=await lstat(lock);if(Date.now()-state.mtimeMs>120000){await rm(lock,{force:true});continue}}catch(e2){if(e2.code!=='ENOENT')throw e2}
  if(Date.now()-start>5000)throw Error('project index busy');await delay(40)
 }}
 try{return await fn()}finally{await handle.close();await rm(lock,{force:true}).catch(()=>{})}
}
async function index(root,force=false){
 const folder=storeDir();await mkdir(folder,{recursive:true,mode:0o700})
 const path=join(folder,digest(root)+'.json')
 return mutex(path,async()=>{
  let previous=null
  if(!force)try{const st=await lstat(path);if(st.isFile()&&st.size<MAX_INDEX){const x=JSON.parse(await readFile(path,'utf8'));if(x.format===FORMAT&&x.root===root)previous=x}}catch(e){if(e.code!=='ENOENT'&&e.name!=='SyntaxError')throw e}
  const old=new Map((previous?.files||[]).map(x=>[x.path,x]))
  const listing=await enumerate(root),files=[]
  let reused=0,reparsed=0,skipped=0
  for(const name of listing.files){
   safeRel(name)
   const target=resolve(root,name),st=await lstat(target)
   if(!st.isFile()||st.size>MAX_SOURCE){skipped++;continue}
   const prev=old.get(name)
   if(prev&&prev.size===st.size&&prev.mtimeMs===st.mtimeMs&&prev.ctimeMs===st.ctimeMs){files.push(prev);reused++;continue}
   const content=await readFile(target,'utf8')
   const item={path:name,size:st.size,mtimeMs:st.mtimeMs,ctimeMs:st.ctimeMs,sha256:digest(content),...parse(content,name)}
   files.push(item);reparsed++
  }
  const result={format:FORMAT,root,files,updatedAt:Date.now(),truncated:listing.truncated}
  if(!previous||reparsed||old.size!==files.length||previous.truncated!==result.truncated){
   const serialized=JSON.stringify(result)
   if(Buffer.byteLength(serialized)>MAX_INDEX)throw Error('project index exceeds 8 MiB')
   await writeAtomic(path,serialized)
  }
  return {data:result,stats:{indexed:files.length,reused,reparsed,skipped,truncated:listing.truncated}}
 })
}
/**
 * P0 read-only snapshot. Reuses the bounded incremental index rather than
 * maintaining a second competing source tree. Syntax fidelity is heuristic.
 */
export async function codeIndexSnapshot(input={}){
 const root=await workspace(input.root),indexed=await index(root,input.force===true)
 return {root,files:indexed.data.files,stats:indexed.stats,updatedAt:indexed.data.updatedAt}
}
export async function codeIndexRefresh(input={}){
 const root=await workspace(input.root),indexed=await index(root,input.force===true)
 return {root,...indexed.stats,updatedAt:indexed.data.updatedAt,heuristic:true}
}
export async function codeIndexQuery(input={}){
 const root=await workspace(input.root),indexed=await index(root,input.force===true)
 const mode=input.mode??'symbols'
 if(!['symbols','imports'].includes(mode))throw Error('mode must be symbols or imports')
 const query=typeof input.query==='string'?input.query.trim().toLowerCase():''
 if(query.length>160)throw Error('query too large')
 const requested=input.path==null?null:safeRel(input.path)
 const limit=limitInt(input.limit,60,1,200),out=[]
 for(const entry of indexed.data.files){
  if(requested&&entry.path!==requested)continue
  const list=mode==='symbols'?entry.declarations:entry.imports
  for(const item of list){
   const value=mode==='symbols'?item.name:item.target
   if(query&&!value.toLowerCase().includes(query))continue
   out.push({path:entry.path,...item})
   if(out.length>=limit)return {mode,matches:out,truncated:true,index:indexed.stats}
  }
 }
 return {mode,matches:out,truncated:false,index:indexed.stats}
}
async function test(){
 const root=await mkdtemp(join(tmpdir(),'dsh-code-index-test-'))
 const oldEnv=process.env.DSH_CODE_INDEX_HOME
 process.env.DSH_CODE_INDEX_HOME=join(root,'cache')
 try{
  await mkdir(join(root,'src'))
  await writeFile(join(root,'src','a.js'),'export function alpha() { return 1 }\n')
  await writeFile(join(root,'src','b.js'),'import {alpha} from "./a.js"\n')
  const first=await codeIndexRefresh({root});if(first.reparsed!==2)throw Error('initial index')
  const second=await codeIndexRefresh({root});if(second.reused!==2||second.reparsed!==0)throw Error('cache reuse')
  const hit=await codeIndexQuery({root,mode:'symbols',query:'alpha'});if(hit.matches.length!==1)throw Error('symbol query')
  const imports=await codeIndexQuery({root,mode:'imports',query:'./a.js'});if(imports.matches.length!==1)throw Error('import query')
  await writeFile(join(root,'src','a.js'),'export function gamma() { return 1234 }\n')
  const third=await codeIndexRefresh({root});if(third.reparsed!==1||third.reused!==1)throw Error('incremental invalidation')
  const removed=await codeIndexQuery({root,query:'alpha'});if(removed.matches.length)throw Error('stale symbol retained')
  await rm(join(root,'src','b.js'))
  const fourth=await codeIndexRefresh({root});if(fourth.indexed!==1)throw Error('delete invalidation')
  process.stdout.write('[DSH] Coding index incremental self-test: OK\n')
 }finally{if(oldEnv===undefined)delete process.env.DSH_CODE_INDEX_HOME;else process.env.DSH_CODE_INDEX_HOME=oldEnv;await rm(root,{recursive:true,force:true})}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)&&process.argv.includes('--self-test'))test().catch(e=>{console.error(e);process.exitCode=1})
