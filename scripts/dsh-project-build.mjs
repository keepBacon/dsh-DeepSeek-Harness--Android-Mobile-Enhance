// DSH Development Engine P2: project-system detection, builds, tests,
// structured diagnostics and verification. Runs through Android Linker Bridge.
import {lstat,realpath,readdir,readFile} from 'node:fs/promises'
import {resolve,join,dirname,relative,sep} from 'node:path'
import {devRun} from './dsh-dev-process.mjs'

const obj=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false})
const str={type:'string'}
const MAX_OUTPUT=128*1024
export const projectBuildTools=[
 {name:'workspace_detect',description:'Detect Gradle, CMake, Make, npm, Python, Cargo or Go build systems from project manifests, without launching tools.',inputSchema:obj({root:str},['root'])},
 {name:'workspace_build',description:'Build the selected project using argv-only Android-compatible execution and report compiler/Gradle diagnostics. Supports dry-run.',inputSchema:obj({root:str,system:str,target:str,args:{type:'array',maxItems:64,items:str},timeoutMs:{type:'integer',minimum:1000,maximum:3600000},dryRun:{type:'boolean'}},['root'])},
 {name:'workspace_test',description:'Discover or run the project test command, with bounded runtime, stdout/stderr, structured failure diagnostics and dry-run.',inputSchema:obj({root:str,system:str,args:{type:'array',maxItems:64,items:str},timeoutMs:{type:'integer',minimum:1000,maximum:3600000},dryRun:{type:'boolean'}},['root'])},
 {name:'workspace_verify',description:'Run build and optionally test sequentially, stopping after failure. Returns phase-specific diagnostics and next actions.',inputSchema:obj({root:str,system:str,runTests:{type:'boolean'},timeoutMs:{type:'integer',minimum:1000,maximum:3600000},dryRun:{type:'boolean'}},['root'])},
]
export const isProjectBuildTool=name=>projectBuildTools.some(t=>t.name===name)
const inRoot=(path,root)=>path===root||path.startsWith(root+sep)
async function rootDir(arg){
 const root=await realpath(resolve(arg))
 if(!(await lstat(root)).isDirectory())throw Error('project root is not a directory')
 return root
}
async function isFile(path){
 try{const s=await lstat(path);return s.isFile()}catch(e){if(e.code==='ENOENT')return false;throw e}
}
async function listDir(root){
 const entries=await readdir(root,{withFileTypes:true})
 return new Set(entries.filter(e=>e.isFile()).map(e=>e.name))
}
async function detect(root){
 const names=await listDir(root),choices=[]
 function add(system,files,priority){
  if(files.some(x=>names.has(x)))choices.push({system,manifests:files.filter(x=>names.has(x)),priority})
 }
 add('gradle',['gradlew','settings.gradle.kts','settings.gradle','build.gradle.kts','build.gradle'],100)
 add('cmake',['CMakeLists.txt'],90)
 add('npm',['package.json'],80)
 add('python',['pyproject.toml','pytest.ini','setup.py'],70)
 add('cargo',['Cargo.toml'],60)
 add('go',['go.mod'],55)
 add('make',['Makefile','makefile','GNUmakefile'],50)
 choices.sort((a,b)=>b.priority-a.priority)
 const selected=choices[0]||null
 return {root,systems:choices,selected:selected?.system||null,ambiguous:choices.length>1,
  warning:choices.length>1?'Multiple build systems detected; pass system explicitly to choose.':null}
}
const supported=new Set(['gradle','cmake','npm','python','cargo','go','make'])
function validArgs(args){
 if(args===undefined)return []
 if(!Array.isArray(args)||args.length>64||args.some(x=>typeof x!=='string'||x.includes('\0')||x.length>8192))
  throw Error('args must be <=64 safe argv strings')
 return args
}
function commandFor(root,system,phase,opts){
 const args=validArgs(opts.args),target=opts.target
 if(target!==undefined&&(typeof target!=='string'||!target||target.startsWith('-')||target.includes('\0')))
  throw Error('invalid target')
 switch(system){
  case 'gradle':
   return {command:opts.wrapper===false?'gradle':'./gradlew',args:[phase==='build'?'assemble':'test',...args]}
  case 'cmake':
   if(phase==='build')return {command:'cmake',args:['--build',join(root,'build'),...(target?['--target',target]:[]),...args]}
   return {command:'ctest',args:['--test-dir',join(root,'build'),'--output-on-failure',...args]}
  case 'npm':return {command:'npm',args:['run',phase==='build'?'build':'test','--',...args]}
  case 'python':
   return {command:'python3',args:phase==='build'?['-m','compileall','-q','-f',root,...args]:
     opts.pytest?['-m','pytest',...args]:['-m','unittest','discover',...args]}
  case 'cargo':return {command:'cargo',args:[phase,...args]}
  case 'go':return {command:'go',args:[phase==='build'?'build':'test','./...',...args]}
  case 'make':return {command:'make',args:[target||(phase==='build'?'all':'test'),...args]}
  default:throw Error('unsupported project system')
 }
}
function diagnostics(text,root,limit=80){
 const patterns=[
  /^(?<path>(?:[A-Za-z]:)?[^:\r\n]+):(?<line>\d+):(?<column>\d+):\s*(?<severity>fatal error|error|warning):\s*(?<message>.+)$/gm,
  /^(?<path>(?:[A-Za-z]:)?[^:\r\n]+):(?<line>\d+):\s*(?<severity>error|warning):\s*(?<message>.+)$/gm,
  /^(?<path>[^\r\n]+?\.(?:kt|kts|java)):(?<line>\d+):(?<column>\d+):\s*(?<severity>error|warning):\s*(?<message>.+)$/gm,
  /^(?<severity>error|warning):\s*(?<message>.+)$/gm,
 ]
 const issues=[],seen=new Set()
 for(const pattern of patterns)for(const m of text.matchAll(pattern)){
  const value=m.groups
  const item={severity:value.severity.includes('error')?'error':value.severity,
    message:value.message.slice(0,600),line:value.line?Number(value.line):null,
    column:value.column?Number(value.column):null}
  if(value.path){
   const path=resolve(root,value.path.trim())
   item.file=inRoot(path,root)?relative(root,path):value.path.trim().slice(0,240)
  }
  const key=JSON.stringify(item)
  if(!seen.has(key)){issues.push(item);seen.add(key)}
  if(issues.length>=limit)return {issues,truncated:true}
 }
 return {issues,truncated:false}
}
async function phaseRun(root,system,phase,opts={}){
 const names=await listDir(root)
 const spec=commandFor(root,system,phase,{
  ...opts,wrapper:names.has('gradlew'),pytest:names.has('pytest.ini')})
 const timeoutMs=Math.min(3600000,Math.max(1000,opts.timeoutMs||600000))
 const setup=system==='cmake'&&phase==='build'?
  {command:'cmake',args:['-S',root,'-B',join(root,'build')]}:null
 if(opts.dryRun===true)return {ok:true,dryRun:true,phase,system,...spec,cwd:root,
  prerequisites:setup?[setup]:[]}
 if(system==='npm'){
  const packageFile=JSON.parse(await readFile(join(root,'package.json'),'utf8'))
  if(!Object.hasOwn(packageFile.scripts||{},phase)){
   return {ok:false,phase,system,command:spec.command,args:spec.args,cwd:root,exitCode:null,
    diagnostics:[],nextAction:'package.json lacks a '+phase+' script; define one or select another build system.'}
  }
 }
 if(setup){
  const pre=await devRun(setup.command,setup.args,{cwd:root,timeoutMs,maxOutputBytes:MAX_OUTPUT,captureTail:true})
  if(!pre.ok){
   const parsed=diagnostics(pre.stdout+'\n'+pre.stderr,root)
   return {ok:false,phase:'configure',system,command:setup.command,args:setup.args,cwd:root,
    exitCode:pre.exitCode,timedOut:pre.timedOut,stdout:pre.stdout,stderr:pre.stderr,
    diagnostics:parsed.issues,nextAction:'CMake configuration failed; correct toolchain or CMakeLists.txt before building.'}
  }
 }
 // No shell; project-owned build scripts still execute with the privileges of
 // the DSH application. Use trusted project sources only.
 const run=await devRun(spec.command,spec.args,{cwd:root,timeoutMs,maxOutputBytes:MAX_OUTPUT,captureTail:true})
 const parsed=diagnostics(run.stdout+'\n'+run.stderr,root)
 return {ok:run.ok,phase,system,command:spec.command,args:spec.args,cwd:root,
  exitCode:run.exitCode,timedOut:run.timedOut,cancelled:run.cancelled,truncated:run.truncated,
  durationMs:run.durationMs,stdout:run.stdout,stderr:run.stderr,diagnostics:parsed.issues,
  diagnosticsTruncated:parsed.truncated,nextAction:run.ok?null:run.timedOut?
   'Build/test timed out; inspect output and raise timeoutMs if needed.':
   parsed.issues.length?'Fix reported errors and run workspace_verify again.':
   'Inspect stdout/stderr and verify required Android toolchain executables are available.'}
}
async function selected(args){
 const root=await rootDir(args.root),detected=await detect(root)
 const system=args.system||detected.selected
 if(!system||!supported.has(system)||!detected.systems.some(x=>x.system===system))
  throw Error('build system not detected in root; inspect workspace_detect or specify a supported project manifest')
 return {root,system,detected}
}
export async function projectBuildCall(name,args={}){
 if(name==='workspace_detect')return detect(await rootDir(args.root))
 if(!isProjectBuildTool(name))throw Error('unknown project build tool')
 const {root,system,detected}=await selected(args)
 if(name==='workspace_build')return phaseRun(root,system,'build',args)
 if(name==='workspace_test')return phaseRun(root,system,'test',args)
 if(name==='workspace_verify'){
  const steps=[]
  const build=await phaseRun(root,system,'build',args);steps.push(build)
  if(!build.ok)return {ok:false,system,root,failedPhase:'build',steps,nextAction:build.nextAction}
  if(args.runTests!==false)steps.push(await phaseRun(root,system,'test',args))
  const failed=steps.find(s=>!s.ok)
  return {ok:!failed,system,root,failedPhase:failed?.phase||null,steps,
   nextAction:failed?.nextAction||null}
 }
 throw Error('unknown P2 project build tool')
}
