// Read-only model diagnostics; no arbitrary page JS or credential collection.
import { randomBytes } from 'node:crypto';
import { readFile, readdir, realpath, lstat, mkdir, rename, writeFile, unlink, open } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from 'node:net';
import { androidToolLaunch } from './dsh-android-tool-spawn.mjs';
import { boundedSpawn } from './dsh-bounded-spawn.mjs';

const PREFIX=process.env.TERMUX__PREFIX||process.env.PREFIX||'/data/data/com.dshmobile.shell/files/usr';
const MAX_FILES=1600, MAX_SOURCE_BYTES=192*1024, MAX_SCAN_BYTES=12*1024*1024;
const IGNORE=new Set(['.git','node_modules','.gradle','.idea','.cache','build','dist','target','vendor','coverage','.next','.venv','venv','__pycache__']);
const LANG={'.js':'JavaScript','.jsx':'JavaScript','.mjs':'JavaScript','.cjs':'JavaScript','.ts':'TypeScript','.tsx':'TypeScript','.py':'Python','.kt':'Kotlin','.java':'Java','.lua':'Lua','.luau':'Luau','.sh':'Shell','.go':'Go','.rs':'Rust','.c':'C','.cc':'C++','.cpp':'C++','.h':'C/C++ header','.hpp':'C++'};
const JS=new Set(['.js','.jsx','.mjs','.cjs','.ts','.tsx']);
const MANIFEST=new Set(['package.json','build.gradle','build.gradle.kts','settings.gradle.kts','Cargo.toml','go.mod','pyproject.toml','requirements.txt','pom.xml','CMakeLists.txt','AndroidManifest.xml']);
const rootProp={root:{type:'string',description:'Existing project root (default: MCP cwd).'}};
export const inspectorTools=[
 {name:'webview_inspect',description:'Request a read-only DOM/layout/performance snapshot from the current trusted DSH Android WebView. Does not read text, field values, cookies, storage or tokens.',inputSchema:{type:'object',properties:{timeoutMs:{type:'integer',minimum:500,maximum:10000,default:5000}},additionalProperties:false}},
 {name:'runtime_doctor',description:'Read-only Android DSH native runtime diagnostic: command execution, ELF, missing entrypoints and Web Host TCP reachability.',inputSchema:{type:'object',properties:{probeCommands:{type:'boolean',default:true},probeHost:{type:'boolean',default:true}},additionalProperties:false}},
 {name:'project_overview',description:'Bounded project inventory by languages, manifests and largest files; ignores symlinks and dependencies.',inputSchema:{type:'object',properties:{...rootProp},additionalProperties:false}},
 {name:'project_dependency_graph',description:'Bounded local import graph for JS/TS, relative Python, and package-qualified Kotlin/Java modules.',inputSchema:{type:'object',properties:{...rootProp,maxNodes:{type:'integer',minimum:10,maximum:250,default:100}},additionalProperties:false}},
 {name:'project_architecture_audit',description:'Find static cycles, unresolved local imports, large source files and high fan-in modules without executing code.',inputSchema:{type:'object',properties:{...rootProp},additionalProperties:false}},
];
const NAMES=new Set(inspectorTools.map(x=>x.name));
export function isInspectorTool(name){return NAMES.has(name)}
function clamp(v,d,min,max){return Number.isInteger(v)?Math.max(min,Math.min(max,v)):d}
async function webviewSnapshot(timeoutMs){
 const root=resolve(PREFIX,'..','webview-inspector');
 const requests=join(root,'requests'),responses=join(root,'responses');
 await mkdir(requests,{recursive:true,mode:0o700});
 await mkdir(responses,{recursive:true,mode:0o700});
 const id=randomBytes(16).toString('hex'),filename='req-'+id+'.json';
 const request=join(requests,filename),tmp=request+'.tmp',reply=join(responses,'res-'+id+'.json');
 await writeFile(tmp,JSON.stringify({id,operation:'snapshot'}),{flag:'wx',mode:0o600});
 await rename(tmp,request);
 const start=Date.now(),timeout=clamp(timeoutMs,5000,500,10000);
 try{
  while(Date.now()-start<timeout){
   try{
    const result=await readFile(reply,'utf8');
    if(Buffer.byteLength(result)>262144)throw new Error('Snapshot exceeds maximum size');
    const data=JSON.parse(result);
    if(data.id!==id)throw new Error('Snapshot correlation mismatch');
    return data.ok?{available:true,...data.snapshot}:{available:false,error:data.error||'Snapshot refused'};
   }catch(e){if(e.code!=='ENOENT')throw e}
   await delay(80);
  }
  return {available:false,error:'No active WebView replied. Open DSH Android and keep its main page visible.'};
 }finally{await Promise.allSettled([unlink(request),unlink(reply)])}
}
function hostProbe(){
 return new Promise(done=>{
  const socket=connect({host:'127.0.0.1',port:3080});let ended=false;
  function finish(reachable,reason){if(ended)return;ended=true;socket.destroy();done({address:'127.0.0.1:3080',reachable,reason})}
  socket.once('connect',()=>finish(true,'tcp_connected'));
  socket.once('error',e=>finish(false,e.code||'tcp_error'));
  socket.setTimeout(1200,()=>finish(false,'timeout'));
 });
}
async function runtimeDoctor(args){
 const checks=[],commandChecks=[],issues=[];
 for(const file of ['bin/node','bin/bash','bin/git','bin/gh','bin/rg','bin/fd','bin/fzf','libexec/dsh-mobile/android-exec.sh','libexec/dsh/bash-real']){
  const p=join(PREFIX,file);
  try{
   const st=await lstat(p),item={component:file,present:true,kind:st.isFile()?'file':st.isSymbolicLink()?'symlink':'other',size:st.size};
   if(st.isFile()&&file.startsWith('bin/')){
    const handle=await open(p,'r');
    try{const bytes=Buffer.alloc(4);await handle.read(bytes,0,4,0);item.format=bytes.equals(Buffer.from([127,69,76,70]))?'ELF':bytes[0]===35&&bytes[1]===33?'script':'other'}finally{await handle.close()}
   }
   checks.push(item);
  }catch(e){checks.push({component:file,present:false,error:e.code||String(e)})}
 }
 if(args.probeCommands!==false){
  for(const name of ['node','bash','git','gh','rg','fd','fzf']){
   try{
    const launch=androidToolLaunch(join(PREFIX,'bin',name),['--version'],process.env);
    const r=await boundedSpawn(launch.command,launch.args,{env:process.env,timeoutMs:2500,maxOutputBytes:1536});
    commandChecks.push({command:name,bridged:launch.bridged,exitCode:r.exitCode,signal:r.signal||null,timedOut:!!r.timedOut,firstLine:(r.stdout||r.stderr||'').split('\n')[0].slice(0,140)});
   }catch(e){commandChecks.push({command:name,error:String(e.code||e.message).slice(0,160)})}
  }
 }
 const host=args.probeHost===false?{skipped:true}:await hostProbe();
 for(const x of checks)if(!x.present)issues.push({category:'payload',component:x.component,reason:x.error||'Missing runtime entrypoint',nextStep:'Check the ARM64 runtime package and noexec launcher; preserve app HOME.'});
 for(const x of commandChecks)if(x.error||x.exitCode!==0||x.timedOut)issues.push({category:'execution',component:x.command,reason:x.error||x.firstLine||x.signal||'nonzero exit',nextStep:'Check ELF bridge, inherited environment, child process stderr and timeout.'});
 if(host.reachable===false)issues.push({category:'host',component:'127.0.0.1:3080',reason:host.reason,nextStep:'Compare engine logs and official-only Web profile; TCP availability is not Host identity.'});
 return {platform:process.platform,arch:process.arch,node:process.version,prefix:PREFIX,checks,commandChecks,host,issues,limitations:['No secrets or user configuration are modified','WebView and full plugin integration require device testing']};
}
async function inventory(rawRoot){
 const root=await realpath(resolve(rawRoot||process.cwd()));
 if(!(await lstat(root)).isDirectory())throw new Error('root is not a directory');
 const rows=[],queue=[{p:root,depth:0}];let estimated=0,skipped=0,truncated=false;
 while(queue.length){
  const {p,depth}=queue.shift();
  const entries=(await readdir(p,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name));
  for(const ent of entries){
   if(ent.isSymbolicLink()){skipped++;continue}
   const full=join(p,ent.name);
   if(ent.isDirectory()){
    if(depth<12&&!IGNORE.has(ent.name))queue.push({p:full,depth:depth+1});else skipped++;
   }else if(ent.isFile()){
    if(rows.length>=MAX_FILES){truncated=true;queue.length=0;break}
    const ext=extname(ent.name).toLowerCase(),st=await lstat(full);
    if(LANG[ext]&&estimated>=MAX_SCAN_BYTES){truncated=true;skipped++;continue}
    rows.push({path:relative(root,full).split(sep).join('/'),ext,size:st.size,source:!!LANG[ext],manifest:MANIFEST.has(ent.name)});
    if(LANG[ext])estimated+=Math.min(st.size,MAX_SOURCE_BYTES);
   }
  }
 }
 return {root,rows,truncated,skipped};
}
function overview(s){
 const languages={};
 for(const r of s.rows.filter(x=>x.source)){
  const name=LANG[r.ext],entry=languages[name]||(languages[name]={files:0,bytes:0});
  entry.files++;entry.bytes+=r.size;
 }
 return {root:s.root,totalFiles:s.rows.length,sourceFiles:s.rows.filter(x=>x.source).length,skipped:s.skipped,truncated:s.truncated,languages,manifests:s.rows.filter(x=>x.manifest).map(x=>x.path).slice(0,60),largestSources:s.rows.filter(x=>x.source).sort((a,b)=>b.size-a.size).slice(0,20).map(x=>({path:x.path,bytes:x.size}))};
}
function refs(ext,text){
 if(JS.has(ext))return [...text.matchAll(/\b(?:import\s+(?:[^'";]*?\s+from\s*)?|export\s+[^'";]*?\s+from\s*|require\s*\(|import\s*\()\s*['"](\.[^'"]+)['"]/g)].map(m=>m[1]);
 if(ext==='.py')return [...text.matchAll(/^\s*from\s+(\.+[\w.]*)\s+import\b/gm)].map(m=>m[1]);
 if(ext==='.kt'||ext==='.java')return [...text.matchAll(/^\s*import\s+(?!static\s+)([\w.]+)\s*;?\s*$/gm)].map(m=>m[1]);
 return [];
}
async function dependencyGraph(s){
 const sources=s.rows.filter(x=>x.source&&(JS.has(x.ext)||['.py','.kt','.java'].includes(x.ext)));
 const paths=new Set(sources.map(x=>x.path)),qualified=new Map(),edges=[],unresolved=[];
 for(const row of sources){
  if(!['.kt','.java'].includes(row.ext)||row.size>MAX_SOURCE_BYTES)continue;
  try{const content=await readFile(join(s.root,row.path),'utf8'),match=content.match(/^\s*package\s+([\w.]+)/m);
   if(match)qualified.set(match[1]+'.'+row.path.split('/').at(-1).replace(/\.(kt|java)$/,''),row.path);
  }catch{}
 }
 for(const row of sources){
  if(row.size>MAX_SOURCE_BYTES)continue;
  let text;try{text=await readFile(join(s.root,row.path),'utf8')}catch{continue}
  for(const ref of refs(row.ext,text).slice(0,120)){
   let target;
   if(ref.startsWith('.')){
    let base;
    if(row.ext==='.py'){
     const n=ref.match(/^\.+/)[0].length;
     base=resolve('/',dirname(row.path),...Array(n-1).fill('..'),ref.slice(n).replace(/\./g,'/')).slice(1);
     target=[base+'.py',join(base,'__init__.py')].find(x=>paths.has(x));
    }else{
     base=resolve('/',dirname(row.path),ref).slice(1);
     target=[base,...['.js','.mjs','.cjs','.ts','.tsx','.jsx'].map(x=>base+x),...['index.js','index.mjs','index.ts','index.tsx'].map(x=>base+'/'+x)].find(x=>paths.has(x));
    }
    if(!target&&unresolved.length<60)unresolved.push({from:row.path,reference:ref});
   }else target=qualified.get(ref);
   if(target&&target!==row.path&&edges.length<18000)edges.push({from:row.path,to:target});
  }
 }
 return {nodes:sources.map(x=>x.path),edges,unresolved,scope:'Static JS/TS local, relative Python, Kotlin/Java qualified imports; dynamic and generated imports not resolved'};
}
function cycleCheck(graph){
 const map=new Map(graph.nodes.map(n=>[n,[]])),state=new Map(),stack=[],found=[],seen=new Set();
 for(const e of graph.edges)map.get(e.from)?.push(e.to);
 function visit(n){
  state.set(n,1);stack.push(n);
  for(const x of map.get(n)||[]){
   if(!state.get(x))visit(x);
   else if(state.get(x)===1){
    const cycle=stack.slice(stack.indexOf(x)).concat(x),key=[...new Set(cycle)].sort().join('|');
    if(!seen.has(key)){seen.add(key);found.push(cycle.slice(0,16))}
   }
   if(found.length>=15)break;
  }
  stack.pop();state.set(n,2);
 }
 for(const n of graph.nodes){if(!state.get(n))visit(n);if(found.length>=15)break}
 return found;
}
export async function inspectorCall(name,args={}){
 if(!isInspectorTool(name))throw new Error('Unknown inspector tool');
 if(name==='webview_inspect')return webviewSnapshot(args.timeoutMs);
 if(name==='runtime_doctor')return runtimeDoctor(args);
 const inv=await inventory(args.root);
 if(name==='project_overview')return overview(inv);
 const graph=await dependencyGraph(inv);
 if(name==='project_dependency_graph'){
  const limit=clamp(args.maxNodes,100,10,250),nodes=graph.nodes.slice(0,limit),set=new Set(nodes);
  return {root:inv.root,totalNodes:graph.nodes.length,totalEdges:graph.edges.length,nodes,edges:graph.edges.filter(e=>set.has(e.from)&&set.has(e.to)).slice(0,650),truncated:inv.truncated||graph.nodes.length>limit,scope:graph.scope};
 }
 const degrees=new Map();
 for(const edge of graph.edges)degrees.set(edge.to,(degrees.get(edge.to)||0)+1);
 return {root:inv.root,totalFiles:inv.rows.length,truncated:inv.truncated,cycles:cycleCheck(graph),unresolvedLocalImports:graph.unresolved.slice(0,50),highFanIn:[...degrees].sort((a,b)=>b[1]-a[1]).slice(0,20).map(([path,count])=>({path,count})),largeSources:inv.rows.filter(x=>x.source&&x.size>100000).sort((a,b)=>b.size-a.size).slice(0,20).map(x=>({path:x.path,bytes:x.size})),caveat:'Static heuristic only; no build or code execution.'};
}
