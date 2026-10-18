import {codeIndexSnapshot} from './dsh-code-index.mjs'
import {selectCodeTests,parseCodeDiagnostics} from './dsh-code-diagnostics.mjs'
import {readFile,lstat,realpath} from 'node:fs/promises'
import {spawn} from 'node:child_process'
import {join,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {resolve,posix} from 'node:path'
const limit=x=>Number.isInteger(x)?Math.max(1,Math.min(150,x)):60
const safe=p=>typeof p==='string'&&p.length>0&&p.length<=512&&!p.startsWith('/')&&!p.includes('..')&&!p.includes('\\')
const paths=x=>{if(!Array.isArray(x)||!x.length||x.length>64||!x.every(safe))throw Error('invalid paths');return x}
async function secureRead(root,path){
 if(!safe(path))throw Error('unsafe indexed path')
 const target=resolve(root,path),st=await lstat(target)
 if(!st.isFile()||st.isSymbolicLink()||st.size>512*1024)throw Error('unsafe indexed file')
 const actual=await realpath(target)
 if(!actual.startsWith(root+'/'))throw Error('indexed path escaped workspace')
 return readFile(actual,'utf8')
}
async function pythonEvidence(files,symbol,cap){
 const script=join(dirname(fileURLToPath(import.meta.url)),'dsh-code-semantic-ast.py')
 return new Promise((ok,fail)=>{
  const child=spawn('python3',[script],{stdio:['pipe','pipe','pipe'],shell:false})
  let stdout='',stderr='',settled=false
  const timeout=setTimeout(()=>{child.kill('SIGKILL')},10000)
  child.stdout.on('data',b=>{stdout+=b;if(stdout.length>1048576)child.kill('SIGKILL')})
  child.stderr.on('data',b=>{stderr+=b;if(stderr.length>1024)child.kill('SIGKILL')})
  child.on('error',e=>{if(!settled){settled=true;clearTimeout(timeout);fail(e)}})
  child.on('close',code=>{if(settled)return;settled=true;clearTimeout(timeout);if(code!==0)return fail(Error('AST analysis failed: '+stderr.slice(0,180)));try{ok(JSON.parse(stdout))}catch(e){fail(e)}})
  child.stdin.on('error',()=>{})
  child.stdin.end(JSON.stringify({mode:'analyze',files,symbol,limit:cap}))
 })
}
const out=(kind,data)=>({kind,readOnly:true,confidence:'heuristic',semanticVerified:false,...data})
async function data(a){return codeIndexSnapshot(a)}
async function graph(a){const d=await data(a),edges=[];for(const f of d.files)for(const i of f.imports){if(!i.target.startsWith('.'))continue;const raw=posix.normalize(posix.join(posix.dirname(f.path),i.target));const dest=d.files.find(g=>g.path===raw||g.path.replace(/\.[^.]+$/,'')===raw.replace(/\.[^.]+$/,''));if(dest&&edges.length<4000)edges.push({from:f.path,to:dest.path,line:i.line})}return {data:d,edges}}
export async function codeSemanticIndex(a={}){const d=await data(a);return out('semantic_index',{root:d.root,indexed:d.files.length,stats:d.stats,declarations:d.files.reduce((n,f)=>n+f.declarations.length,0),backend:'incremental-heuristic',note:'No AST/LSP symbol resolution'})}
export async function codeSymbolReferences(a={}){
 if(a.backend==='python-ast'){
  if(typeof a.symbol!=='string'||!/^[A-Za-z_][A-Za-z_0-9]*$/.test(a.symbol))throw Error('invalid Python symbol')
  const d=await data(a),selected=d.files.filter(f=>f.path.endsWith('.py')&&(!a.path||f.path===a.path)).slice(0,16)
  const files=[]
  for(const f of selected)files.push({path:f.path,text:await secureRead(d.root,f.path)})
  const evidence=await pythonEvidence(files,a.symbol,limit(a.limit))
  return {kind:'symbol_references',readOnly:true,confidence:'syntax',semanticVerified:false,
   ...evidence,filesScanned:files.length,filesTruncated:d.files.filter(f=>f.path.endsWith('.py')).length>files.length}
 }
if(typeof a.symbol!=='string'||!a.symbol||a.symbol.length>120)throw Error('symbol required');const d=await data(a),found=[];for(const f of d.files){if(a.path&&a.path!==f.path)continue;const source=await secureRead(d.root,f.path);const rows=source.split('\n');for(let i=0;i<rows.length;i++){if(rows[i].includes(a.symbol))found.push({path:f.path,line:i+1,kind:f.declarations.some(x=>x.name===a.symbol&&x.line===i+1)?'declaration':'text_reference'});if(found.length>=limit(a.limit))return out('symbol_references',{matches:found,truncated:true})}}return out('symbol_references',{matches:found,truncated:false})}
export async function codeDependencyGraph(a={}){const g=await graph(a),edges=a.paths?g.edges.filter(e=>paths(a.paths).includes(e.from)||paths(a.paths).includes(e.to)):g.edges;return out('dependency_graph',{nodes:g.data.files.length,edges:edges.slice(0,limit(a.limit)),truncated:edges.length>limit(a.limit)})}
export async function codeCallGraph(a={}){const g=await graph(a),r=await codeSymbolReferences(a);return out('call_graph',{definitions:g.data.files.flatMap(f=>f.declarations.filter(x=>x.name===a.symbol).map(x=>({path:f.path,line:x.line}))),candidateSites:r.matches.filter(x=>x.kind!=='declaration'),note:'Text references are not proven call edges'})}
export async function codeChangeImpact(a={}){const changed=paths(a.paths),g=await graph(a),visited=new Set(changed),front=[...changed];for(let n=0;n<Math.min(5,Math.max(1,a.depth||2));n++){const next=[];for(const e of g.edges)if(front.includes(e.to)&&!visited.has(e.from)){visited.add(e.from);next.push(e.from)}front.splice(0,front.length,...next)}const affected=[...visited].filter(x=>!changed.includes(x));return out('change_impact',{changed,possiblyAffected:affected.slice(0,limit(a.limit)),truncated:affected.length>limit(a.limit)})}
export async function codeRootCause(a={}){if(typeof a.log!=='string'||!a.log.trim()||Buffer.byteLength(a.log)>1048576)throw Error('invalid bounded log');const parsed=parseCodeDiagnostics(a),p=[...new Set(parsed.diagnostics.map(x=>x.path).filter(safe))];const impact=p.length?await codeChangeImpact({root:a.root,paths:p.slice(0,64)}):null;return out('root_cause',{diagnostics:parsed.diagnostics,possibleUpstream:impact?.possiblyAffected||[],rootCauseConfirmed:false})}
export async function codeTestImpact(a={}){const changed=paths(a.paths),impact=await codeChangeImpact(a),t=await selectCodeTests({root:a.root,changedPaths:[...new Set([...changed,...impact.possiblyAffected])].slice(0,64)});return out('test_impact',{relatedTests:t.relatedTests,suggestedCommands:t.suggestedCommands,executed:false})}
export async function codePatchPlan(a={}){const changed=paths(a.paths),t=await codeTestImpact(a);return out('patch_plan',{steps:[{id:'inspect',paths:changed},{id:'edit',blockedBy:['inspect'],dryRun:true},{id:'verify',blockedBy:['edit'],tests:t.relatedTests},{id:'review',blockedBy:['verify']}],autoEdited:false,autoExecuted:false})}
