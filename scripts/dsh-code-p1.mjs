/**
 * Coding Engine P1: bounded, fail-closed engineering helpers.
 * Only the existing journaled transaction layer may mutate user source.
 * AST edits use Python's real ast.parse; other languages are deliberately
 * not advertised as AST-capable until a parser backend is integrated.
 */
import {createHash,randomBytes} from 'node:crypto'
import {readFile,lstat,realpath,mkdir,open,rename,rm,readdir} from 'node:fs/promises'
import {resolve,relative,dirname,join,extname} from 'node:path'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {runCodeTransaction,codeTransactionStatus} from './dsh-code-transactions.mjs'
import {codeRepairCycle} from './dsh-code-repair-cycle.mjs'
import {parseCodeDiagnostics} from './dsh-code-diagnostics.mjs'
import {codeIndexSnapshot} from './dsh-code-index.mjs'

const LIMIT=1024*1024
const sha=b=>createHash('sha256').update(b).digest('hex')
const valid=(p)=>typeof p==='string'&&p.length>0&&p.length<=512&&!p.startsWith('/')&&!p.includes('\\')&&!p.includes('\0')&&p.split('/').every(x=>x!==''&&x!=='.'&&x!=='..')
const int=(n,d,max)=>Number.isInteger(n)?Math.max(1,Math.min(max,n)):d
async function rootOf(v){const p=await realpath(resolve(v||'.'));if(!(await lstat(p)).isDirectory())throw Error('invalid workspace root');return p}
async function source(root,name){
 if(!valid(name))throw Error('invalid source path')
 const path=resolve(root,name),r=relative(root,path)
 if(!r||r.startsWith('..')||r.startsWith('/'))throw Error('workspace escape')
 let parent=dirname(path)
 while(parent!==root){
  const st=await lstat(parent)
  if(!st.isDirectory()||st.isSymbolicLink())throw Error('unsafe parent')
  parent=dirname(parent)
 }
 const st=await lstat(path)
 if(!st.isFile()||st.isSymbolicLink()||st.size>LIMIT)throw Error('unsafe or oversized source')
 const bytes=await readFile(path)
 const text=bytes.toString('utf8')
 if(!Buffer.from(text).equals(bytes))throw Error('source is not UTF-8')
 return {path,text,sha256:sha(bytes)}
}
const report=(name,fields)=>({operation:name,readOnly:true,...fields})
async function pythonAstHelper(action,args){
 const script=join(dirname(fileURLToPath(import.meta.url)),'dsh-code-p1-ast.py')
 return await new Promise((done,reject)=>{
  const child=spawn('python3',[script,action],{stdio:['pipe','pipe','pipe'],shell:false})
  let out='',err='',ended=false
  const timer=setTimeout(()=>{child.kill('SIGKILL')},10000)
  child.stdout.on('data',b=>{out+=b; if(out.length>LIMIT*2)child.kill('SIGKILL')})
  child.stderr.on('data',b=>{err+=b; if(err.length>4096)child.kill('SIGKILL')})
  child.on('error',e=>{if(!ended){ended=true;clearTimeout(timer);reject(e)}})
  child.on('close',(code)=>{
   if(ended)return;ended=true;clearTimeout(timer)
   if(code!==0)return reject(Error('Python AST parser rejected input: '+err.slice(0,240)))
   try{const result=JSON.parse(out);if(result.error)throw Error(result.error);done(result)}
   catch(e){reject(e)}
  })
  child.stdin.on('error',()=>{})
  child.stdin.end(JSON.stringify(args))
 })
}
export async function codeAstEdit(a={}){
 const root=await rootOf(a.root),item=await source(root,a.path)
 if(extname(a.path)!=='.py')throw Error('AST_BACKEND_UNAVAILABLE: only Python AST is currently supported')
 if(typeof a.symbol!=='string'||!/^[A-Za-z_][A-Za-z_0-9]*$/.test(a.symbol))throw Error('invalid Python symbol')
 if(typeof a.expectedSha256!=='string'||a.expectedSha256!==item.sha256)throw Error('CODING_TX_STALE')
 if(typeof a.newText!=='string'||!a.newText.trim()||Buffer.byteLength(a.newText)>LIMIT)throw Error('invalid replacement')
 const plan=await pythonAstHelper('replace',{text:item.text,symbol:a.symbol,newText:a.newText})
 const patch={path:a.path,expectedSha256:item.sha256,oldText:plan.oldText,newText:plan.newText}
 const result=await runCodeTransaction({root,changes:[patch],dryRun:a.dryRun!==false})
 return {...result,backend:'python-ast',symbol:a.symbol}
}
export async function codeRefactor(a={}){
 // Preview-only for non-compiler-resolved references: committing a token search
 // would silently rename unrelated symbols, comments or unrelated namespaces.
 if(a.dryRun===false)throw Error('REFACTOR_REQUIRES_LANGUAGE_SERVER: preview only')
 if(typeof a.oldName!=='string'||typeof a.newName!=='string'||
    !/^[A-Za-z_$][\w$]*$/.test(a.oldName)||!/^[A-Za-z_$][\w$]*$/.test(a.newName)||
    a.oldName===a.newName)throw Error('invalid rename')
 const root=await rootOf(a.root),selected=a.paths
 if(!Array.isArray(selected)||!selected.length||selected.length>16)throw Error('paths required')
 const files=[]
 for(const p of selected){
  const f=await source(root,p)
  const matches=[...f.text.matchAll(new RegExp('(^|[^\\w$])'+a.oldName+'(?=[^\\w$]|$)','g'))]
  files.push({path:p,sha256:f.sha256,candidateOccurrences:matches.length})
 }
 return report('refactor',{dryRun:true,oldName:a.oldName,newName:a.newName,files,
  requiresSemanticReview:true,note:'No edits made. AST/LSP rename resolution required before applying changes.'})
}
export async function codeContractCheck(a={}){
 const snap=await codeIndexSnapshot(a),list=[]
 const byName=new Map()
 for(const f of snap.files)for(const d of f.declarations){
  const defs=byName.get(d.name)||[];defs.push({path:f.path,line:d.line});byName.set(d.name,defs)
 }
 for(const f of snap.files)for(const imp of f.imports){
  if(!imp.target.startsWith('.'))continue
  const key=resolve(dirname(resolve(snap.root,f.path)),imp.target)
  const local=snap.files.some(other=>{
   const full=resolve(snap.root,other.path)
   return full===key||full.replace(/\.[^.]+$/,'')===key.replace(/\.[^.]+$/,'')
  })
  if(!local)list.push({kind:'unresolved_relative_import',file:f.path,line:imp.line,target:imp.target})
  if(list.length>=int(a.limit,60,100))break
 }
 return report('contract_check',{checked:snap.files.length,warnings:list,truncated:list.length>=int(a.limit,60,100),
  note:'Import-path diagnostics only; type-level API/ABI compatibility needs compiler/LSP.'})
}
export async function codePatchConflict(a={}){
 const root=await rootOf(a.root),status=await codeTransactionStatus({root})
 const changes=a.changes||[]
 if(!Array.isArray(changes)||changes.length>16)throw Error('invalid changes')
 const conflicts=[]
 for(const c of changes){
  if(!c||!valid(c.path))throw Error('invalid changed path')
  try{
   const f=await source(root,c.path)
   if(f.sha256!==c.expectedSha256)conflicts.push({path:c.path,reason:'STALE_SHA256'})
  }catch(e){conflicts.push({path:c.path,reason:String(e.message||e)})}
 }
 return report('patch_conflict',{conflicts,unresolvedTransactions:status.unresolved,
  safeToApply:conflicts.length===0&&status.unresolved.length===0})
}
async function git(root,args){
 return await new Promise((done,reject)=>{
  const child=spawn('git',['-C',root,...args],{shell:false,stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_TERMINAL_PROMPT:'0'}})
  let out='',err='';let settled=false
  const timer=setTimeout(()=>{try{child.kill('SIGKILL')}catch{}},8000)
  child.stdout.on('data',v=>{out+=v;if(out.length>300000)child.kill('SIGKILL')})
  child.stderr.on('data',v=>{err+=v;if(err.length>4000)child.kill('SIGKILL')})
  child.on('error',e=>{if(!settled){settled=true;clearTimeout(timer);reject(e)}})
  child.on('close',code=>{if(settled)return;settled=true;clearTimeout(timer);code===0?done(out.trim()):reject(Error('git read-only inspection failed: '+err.slice(0,160)))})
 })
}
export async function codeRegressionBisect(a={}){
 const root=await rootOf(a.root)
 for(const name of ['good','bad'])if(typeof a[name]!=='string'||!/^[0-9a-fA-F]{7,40}$/.test(a[name]))throw Error('commit SHAs required')
 const good=await git(root,['rev-parse','--verify',a.good+'^{commit}'])
 const bad=await git(root,['rev-parse','--verify',a.bad+'^{commit}'])
 await git(root,['merge-base','--is-ancestor',good,bad])
 const history=(await git(root,['rev-list','--ancestry-path',good+'..'+bad])).split('\n').filter(Boolean)
 return report('regression_bisect',{good,bad,candidates:history.length,
  nextCandidate:history.length>1?history[Math.floor(history.length/2)]:history[0]||null,
  automaticCheckout:false,automaticTest:false,note:'Read-only bisect suggestion; non-linear Git DAG may need manual review.'})
}
export function codeFailureCluster(a={}){
 const parsed=parseCodeDiagnostics(a)
 const groups=new Map()
 for(const d of parsed.diagnostics){
  const key=d.tool+'|'+d.message.replace(/\b\d+\b/g,'#').replace(/(["']).*?\1/g,'<value>').slice(0,100)
  if(!groups.has(key))groups.set(key,{tool:d.tool,messagePattern:key.split('|').slice(1).join('|'),count:0,examples:[]})
  const g=groups.get(key);g.count++;if(g.examples.length<4)g.examples.push({path:d.path,line:d.line,message:d.message})
 }
 return report('failure_cluster',{groups:[...groups.values()].sort((a,b)=>b.count-a.count).slice(0,40),total:parsed.diagnostics.length,
  note:'Diagnostic clustering is heuristic and does not prove a shared root cause.'})
}
export async function codeFixVerify(a={}){
 // Explicit candidates and recipes only; no silent generation, no shell evaluation.
 return codeRepairCycle(a)
}
function checkpointDir(){return resolve(process.env.DSH_CODE_CHECKPOINT_HOME||join(process.env.HOME||process.cwd(),'.dsh','mobile','coding-checkpoints'))}
export async function codeCheckpoint(a={}){
 const root=await rootOf(a.root)
 if(!Array.isArray(a.paths)||!a.paths.length||a.paths.length>16)throw Error('paths required (1..16)')
 const entries=[]
 for(const p of a.paths){const f=await source(root,p);entries.push({path:p,sha256:f.sha256})}
 const mode=a.action||'preview'
 if(!['preview','save','check'].includes(mode))throw Error('invalid checkpoint action')
 if(mode==='preview')return report('checkpoint',{root,files:entries,saved:false})
 const home=checkpointDir();await mkdir(home,{recursive:true,mode:0o700})
 if(mode==='save'){
  const id='cp-'+randomBytes(12).toString('hex'),path=join(home,id+'.json')
  const payload={id,root,files:entries,createdAt:Date.now(),schema:1}
  const h=await open(path,'wx',0o600)
  try{await h.writeFile(JSON.stringify(payload));await h.sync()}finally{await h.close()}
  return report('checkpoint',{id,files:entries,saved:true,restoreAvailable:false})
 }
 if(typeof a.id!=='string'||!/^cp-[0-9a-f]{24}$/.test(a.id))throw Error('invalid checkpoint id')
 const item=JSON.parse(await readFile(join(home,a.id+'.json'),'utf8'))
 if(item.root!==root||item.schema!==1)throw Error('checkpoint workspace mismatch')
 const previous=new Map(item.files.map(x=>[x.path,x.sha256]))
 const changed=entries.filter(x=>previous.get(x.path)!==x.sha256)
 return report('checkpoint',{id:a.id,match:changed.length===0,changed,
  note:'Hash snapshot, not a source backup. Use transaction recovery for restoration.'})
}
