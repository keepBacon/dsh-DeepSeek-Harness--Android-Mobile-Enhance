/**
 * Coding Engine 2.0 P2 - bounded verification runner.
 *
 * No shell interpolation. Only fixed, explicitly documented verification
 * recipes may execute; arbitrary commands remain the existing command_run
 * interface. Returns compiler diagnostics in one tool call to minimize
 * repeat log reads and preserve failure evidence.
 */
import {spawn} from 'node:child_process'
import {lstat,realpath,readFile,mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises'
import {resolve,relative,dirname,join,basename} from 'node:path'
import {tmpdir} from 'node:os'
import {parseCodeDiagnostics} from './dsh-code-diagnostics.mjs'

const MAX_CAPTURE=32768,MAX_RUN_MS=120000
const PRESETS=Object.freeze({
 'node-syntax':{label:'Node JavaScript syntax check',tool:'node',needsFile:true,extensions:['.js','.mjs','.cjs'],timeout:15000},
 'npm-test':{label:'Node package test script',tool:'npm',args:['test','--','--runInBand'],marker:'package.json',timeout:60000},
 'gradle-test':{label:'Gradle project tests',tool:'./gradlew',args:['test','--no-daemon'],marker:'gradlew',timeout:120000},
 'go-test':{label:'Go module tests',tool:'go',args:['test','./...'],marker:'go.mod',timeout:60000},
 'cargo-test':{label:'Rust Cargo tests',tool:'cargo',args:['test','--locked'],marker:'Cargo.lock',timeout:120000},
 'pytest':{label:'Python pytest discovery',tool:'python3',args:['-m','pytest','-q'],marker:'pyproject.toml',timeout:60000},
})
function safeRel(v){
 if(typeof v!=='string'||!v||v.length>500||v.includes('\0')||v.includes('\\')||v.startsWith('/')||v.split('/').some(x=>!x||x==='..'||x==='.'))throw Error('unsafe relative path')
 return v
}
async function checkedRoot(path){const root=await realpath(resolve(path||'.'));const st=await lstat(root);if(!st.isDirectory())throw Error('root is not directory');return root}
async function checkedFile(root,rel){
 safeRel(rel)
 const target=resolve(root,rel)
 if(relative(root,target).startsWith('..'))throw Error('outside workspace')
 let p=dirname(target)
 while(p!==root){const st=await lstat(p);if(st.isSymbolicLink()||!st.isDirectory())throw Error('unsafe parent');p=dirname(p)}
 const st=await lstat(target)
 if(st.isSymbolicLink()||!st.isFile()||st.size>1024*1024)throw Error('test input is not regular file under 1 MiB')
 return target
}
function excerpt(chunks,total,limit=MAX_CAPTURE){
 const length=Math.min(total,limit)
 if(total<=limit)return Buffer.concat(chunks,total).toString('utf8')
 const raw=Buffer.concat(chunks,Math.min(total,limit))
 const mid=Math.floor(limit/2)
 return raw.subarray(0,mid).toString('utf8')+'\n[output truncated]\n'+raw.subarray(length-mid).toString('utf8')
}
function ringBuffer(limit){
 let chunks=[],length=0,total=0
 return{add(v){
  const b=Buffer.isBuffer(v)?v:Buffer.from(v)
  total+=b.length
  chunks.push(b);length+=b.length
  while(length>limit){const excess=length-limit,first=chunks[0];if(first.length<=excess){chunks.shift();length-=first.length}else{chunks[0]=first.subarray(excess);length-=excess}}
 },done(){const b=Buffer.concat(chunks,length);return{output:b.toString('utf8'),bytes:total,truncated:total>limit}}}
}
export function verificationRecipes(){
 return Object.entries(PRESETS).map(([id,x])=>({id,label:x.label,timeoutMs:x.timeout,needsFile:!!x.needsFile,marker:x.marker||null}))
}
export async function codeVerify(input={}){
 const root=await checkedRoot(input.root),preset=PRESETS[input.preset]
 if(!preset)throw Error('unknown verification preset')
 const timeoutMs=Number.isInteger(input.timeoutMs)?Math.min(MAX_RUN_MS,Math.max(1000,Math.min(input.timeoutMs,preset.timeout))):preset.timeout
 let argv=[...(preset.args||[])],binary=preset.tool
 if(preset.needsFile){
  const path=await checkedFile(root,input.path)
  if(!preset.extensions.some(ext=>path.endsWith(ext)))throw Error('unsupported syntax-check extension')
  argv=['--check',path]
 }else if(preset.marker){
  await checkedFile(root,preset.marker)
 }
 // /system/bin/sh, bash -c, redirects and arbitrary argv are deliberately absent.
 if(input.dryRun!==false)return{dryRun:true,preset:input.preset,command:binary,args:argv,cwd:root,timeoutMs,automatic:false}
 return await new Promise(done=>{
  const began=Date.now()
  let child,ended=false,timedOut=false,spawnFailure=null
  const stdout=ringBuffer(MAX_CAPTURE),stderr=ringBuffer(MAX_CAPTURE)
  let timer
  try{child=spawn(binary,argv,{cwd:root,shell:false,stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_TERMINAL_PROMPT:'0',CI:'1',NO_COLOR:'1'}})}
  catch(error){done({preset:input.preset,ok:false,exitCode:null,error:String(error),durationMs:0});return}
  child.stdout.on('data',b=>stdout.add(b))
  child.stderr.on('data',b=>stderr.add(b))
  child.on('error',e=>{spawnFailure=e})
  timer=setTimeout(()=>{
   timedOut=true
   try{child.kill('SIGKILL')}catch{}
  },timeoutMs)
  child.on('close',(code,signal)=>{
   if(ended)return;ended=true;clearTimeout(timer)
   const out=stdout.done(),err=stderr.done()
   const diagnostics=parseCodeDiagnostics({root,log:out.output+'\n'+err.output,limit:80})
   done({preset:input.preset,dryRun:false,ok:code===0&&!timedOut&&!spawnFailure,exitCode:code,signal,
    timedOut,error:spawnFailure?String(spawnFailure):null,durationMs:Date.now()-began,
    stdout:out.output,stderr:err.output,stdoutBytes:out.bytes,stderrBytes:err.bytes,
    truncated:out.truncated||err.truncated,diagnostics})
  })
 })
}
async function selfTest(){
 const root=await mkdtemp(join(tmpdir(),'dsh-verify-'))
 try{
  await mkdir(join(root,'src'))
  await writeFile(join(root,'src','ok.js'),'const x=1;\n')
  await writeFile(join(root,'src','fail.js'),'const = 2;\n')
  const preview=await codeVerify({root,preset:'node-syntax',path:'src/ok.js'})
  if(!preview.dryRun||preview.args[0]!=='--check')throw Error('dry-run unsafe')
  const ok=await codeVerify({root,preset:'node-syntax',path:'src/ok.js',dryRun:false})
  if(!ok.ok||ok.exitCode!==0)throw Error('node validation failed')
  const fail=await codeVerify({root,preset:'node-syntax',path:'src/fail.js',dryRun:false})
  if(fail.ok||fail.exitCode===0)throw Error('syntax failure missed')
  let rejected=false
  try{await codeVerify({root,preset:'node-syntax',path:'../etc/passwd',dryRun:false})}catch{rejected=true}
  if(!rejected)throw Error('path traversal allowed')
  rejected=false
  try{await codeVerify({root,preset:'arbitrary-command',dryRun:false})}catch{rejected=true}
  if(!rejected)throw Error('arbitrary command allowed')
  process.stdout.write('[DSH] Coding verification self-test: OK\n')
 }finally{await rm(root,{recursive:true,force:true})}
}
if(process.argv.includes('--self-test'))selfTest().catch(e=>{console.error(e);process.exitCode=1})
