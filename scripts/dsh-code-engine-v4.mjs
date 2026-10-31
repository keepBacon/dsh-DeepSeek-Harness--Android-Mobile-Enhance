// Code Engine 2.0 - dependency impact & verification pipeline.
// A bounded static module-graph heuristic; never claimed to be a compiler AST.
import { readdir, readFile, stat } from 'node:fs/promises'
import { resolve, relative, dirname, extname, join, sep, isAbsolute } from 'node:path'
import { codeV3Call } from './dsh-code-engine-v3.mjs'

const obj=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false})
const str={type:'string'}
const EXT=new Set(['.js','.jsx','.mjs','.cjs','.ts','.tsx','.json'])
const EXCLUDE=new Set(['node_modules','.git','.next','dist','build','coverage','.gradle','vendor','.dsh','.cache','.local','.npm','.pnpm-store'])
const RESOLVE_EXT=['','.ts','.tsx','.js','.jsx','.mjs','.cjs','.json']
export const codeV4Tools=[
 {name:'code_dependencies',description:'Scan static relative JS/TS imports and exports to return a bounded dependency graph, unresolved imports and transitive dependencies. Heuristic, not AST.',inputSchema:obj({root:str,entry:str,maxFiles:{type:'integer',minimum:1,maximum:4000},maxDepth:{type:'integer',minimum:1,maximum:32}},[])},
 {name:'code_impact',description:'Compute reverse dependency impact of modified JS/TS files, including transitive consumers and incomplete-scan warnings. Heuristic, not AST.',inputSchema:obj({root:str,changedFiles:{type:'array',minItems:1,maxItems:32,items:str},maxFiles:{type:'integer',minimum:1,maximum:4000},maxDepth:{type:'integer',minimum:1,maximum:32}},['changedFiles'])},
 {name:'code_verify',description:'Run code_check then a specified test command (argv only); return precise failure phase and diagnostics for the next repair iteration.',inputSchema:obj({paths:{type:'array',minItems:1,maxItems:32,items:str},command:str,args:{type:'array',maxItems:128,items:str},cwd:str,timeoutMs:{type:'integer',minimum:100,maximum:120000}},[])},
]
const validNum=(v,fallback,min,max)=>Number.isInteger(v)?Math.min(max,Math.max(min,v)):fallback
const inRoot=(root,path)=>path===root||path.startsWith(root+sep)
const display=(root,path)=>relative(root,path).split(sep).join('/')
async function collect(root,maxFiles,maxDepth){
 const output=[],stack=[{dir:root,depth:0}]
 let complete=true,skipped=0
 while(stack.length){
  const {dir,depth}=stack.pop()
  let entries
  try{entries=await readdir(dir,{withFileTypes:true})}
  catch(err){complete=false;skipped++;continue}
  entries.sort((a,b)=>a.name.localeCompare(b.name))
  for(const entry of entries){
   const path=join(dir,entry.name)
   if(entry.isSymbolicLink()){complete=false;skipped++;continue}
   if(entry.isDirectory()){
    if(!EXCLUDE.has(entry.name)&&depth<maxDepth)stack.push({dir:path,depth:depth+1})
    else {skipped++;if(depth>=maxDepth)complete=false}
   }else if(entry.isFile()&&EXT.has(extname(entry.name).toLowerCase())){
    if(output.length>=maxFiles){complete=false;skipped++;continue}
    output.push(path)
   }
  }
 }
 output.sort()
 return {paths:output,complete,skipped}
}
function declarations(source){
 const out=[]
 // Static ES imports/re-exports, side-effect imports, CommonJS require,
 // dynamic import with literal specifier. A syntax heuristic, not semantic AST.
 const patterns=[
  /^\s*(?:import|export)\s+(?:[^\n;]*?\s+from\s+)?['"]([^'"\n]+)['"]/gm,
  /\b(?:require|import)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
 ]
 for(const rx of patterns){
  for(const m of source.matchAll(rx)){
   if(m[1]?.startsWith('.'))out.push({specifier:m[1],offset:m.index})
  }
 }
 out.sort((a,b)=>a.offset-b.offset)
 return [...new Map(out.map(x=>[x.specifier+'@'+x.offset,x])).values()]
}
function resolveImport(from,spec,files,root){
 const target=resolve(dirname(from),spec)
 if(!inRoot(root,target))return null
 const candidates=[target]
 for(const ext of RESOLVE_EXT)if(ext)candidates.push(target+ext)
 // TS repositories often write './foo.js' but store foo.ts.
 if(/\.[cm]?js$/.test(target))for(const ext of ['.ts','.tsx','.mts','.cts'])candidates.push(target.replace(/\.[cm]?js$/,ext))
 for(const ext of RESOLVE_EXT)if(ext)candidates.push(join(target,'index'+ext))
 return candidates.find(x=>files.has(x))||null
}
async function graph(root,maxFiles,maxDepth){
 const scan=await collect(root,maxFiles,maxDepth),paths=new Set(scan.paths)
 const edges=[],unresolved=[]
 let complete=scan.complete,skipped=scan.skipped
 for(const path of scan.paths){
  if(extname(path).toLowerCase()==='.json')continue
  let source
  try{
   const meta=await stat(path)
   if(meta.size>1048576){complete=false;skipped++;continue}
   source=await readFile(path,'utf8')
  }catch(err){complete=false;skipped++;continue}
  for(const {specifier} of declarations(source)){
   const target=resolveImport(path,specifier,paths,root)
   if(target)edges.push({from:display(root,path),to:display(root,target),specifier})
   else unresolved.push({from:display(root,path),specifier})
  }
 }
 edges.sort((a,b)=>a.from.localeCompare(b.from)||a.to.localeCompare(b.to))
 return {root,files:scan.paths.map(x=>display(root,x)),edges,unresolved,complete,skipped}
}
function closure(seed,neighbors,maxDepth){
 const reached=new Set(seed),frontier=seed.map(path=>({path,depth:0}))
 for(let i=0;i<frontier.length;i++){
  const {path,depth}=frontier[i]
  if(depth>=maxDepth)continue
  for(const next of neighbors.get(path)||[]){
   if(reached.has(next))continue
   reached.add(next);frontier.push({path:next,depth:depth+1})
  }
 }
 return [...reached].sort()
}
async function analyzeDependencies(a){
 const root=resolve(a.root||'.'),maxFiles=validNum(a.maxFiles,1200,1,4000),maxDepth=validNum(a.maxDepth,12,1,32)
 const g=await graph(root,maxFiles,maxDepth)
 const outgoing=new Map()
 for(const edge of g.edges){if(!outgoing.has(edge.from))outgoing.set(edge.from,[]);outgoing.get(edge.from).push(edge.to)}
 if(a.entry){
  const entry=resolve(root,a.entry)
  if(!inRoot(root,entry))throw Error('entry escapes root')
  const rel=display(root,entry)
  if(!g.files.includes(rel))throw Error('entry is not indexed: '+rel)
  const visited=closure([rel],outgoing,maxDepth)
  return {strategy:'static-module-imports',root,entry:rel,dependencies:visited.filter(x=>x!==rel),edges:g.edges.filter(x=>visited.includes(x.from)),unresolved:g.unresolved.filter(x=>visited.includes(x.from)),scan:{files:g.files.length,complete:g.complete,skipped:g.skipped}}
 }
 return {strategy:'static-module-imports',root,edges:g.edges.slice(0,500),unresolved:g.unresolved.slice(0,100),truncated:g.edges.length>500||g.unresolved.length>100,scan:{files:g.files.length,complete:g.complete,skipped:g.skipped}}
}
async function impact(a){
 const root=resolve(a.root||'.'),maxFiles=validNum(a.maxFiles,1200,1,4000),maxDepth=validNum(a.maxDepth,12,1,32)
 if(!Array.isArray(a.changedFiles)||!a.changedFiles.length||a.changedFiles.length>32)throw Error('changedFiles must contain 1..32 paths')
 const g=await graph(root,maxFiles,maxDepth),reverse=new Map()
 for(const edge of g.edges){if(!reverse.has(edge.to))reverse.set(edge.to,[]);reverse.get(edge.to).push(edge.from)}
 const seeds=[...new Set(a.changedFiles.map(file=>{
  const full=isAbsolute(file)?resolve(file):resolve(root,file)
  if(!inRoot(root,full))throw Error('changed file escapes root')
  const rel=display(root,full)
  if(!g.files.includes(rel))throw Error('changed file is not indexed: '+rel)
  return rel
 }))]
 const affected=closure(seeds,reverse,maxDepth).filter(x=>!seeds.includes(x))
 return {strategy:'static-module-imports',root,changedFiles:seeds,affectedFiles:affected,affectedCount:affected.length,scan:{files:g.files.length,complete:g.complete,skipped:g.skipped},warning:g.complete?null:'The source scan is incomplete; impacted files may be missing'}
}
async function verify(a){
 const results=[]
 if(a.paths!==undefined){
  const check=await codeV3Call('code_check',{paths:a.paths,timeoutMs:a.timeoutMs})
  results.push({phase:'syntax',...check})
  if(!check.ok)return {ok:false,failedPhase:'syntax',results,nextAction:'Inspect syntax diagnostics, repair the reported files, and run code_verify again.'}
 }
 if(a.command!==undefined){
  const test=await codeV3Call('code_test',{command:a.command,args:a.args||[],cwd:a.cwd,timeoutMs:a.timeoutMs})
  results.push({phase:'test',...test})
  if(!test.ok)return {ok:false,failedPhase:'test',results,nextAction:'Inspect stderr/exit code and modify the failing behavior before rerunning verification.'}
 }
 if(results.length===0)throw Error('code_verify requires paths and/or command')
 return {ok:true,failedPhase:null,results,nextAction:null}
}
export async function codeV4Call(name,args={}){
 switch(name){
  case 'code_dependencies':return analyzeDependencies(args)
  case 'code_impact':return impact(args)
  case 'code_verify':return verify(args)
  default:throw Error('unknown Code Engine V4 tool: '+name)
 }
}
