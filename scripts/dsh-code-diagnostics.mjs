/**
 * Coding Engine 2.0 P2: deterministic compiler diagnostics + test selection.
 *
 * No model invocation, shell evaluation, network access or implicit file writes.
 * Code diagnostics are best effort: unknown formats are reported, not invented.
 */
import {realpath,readFile,lstat,readdir,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {join,resolve,relative,dirname,extname,basename} from 'node:path'
import {tmpdir} from 'node:os'

const MAX_LOG_BYTES=1024*1024,MAX_LINES=18000
const LANGUAGES={'.kt':'kotlin','.java':'java','.js':'javascript','.mjs':'javascript','.cjs':'javascript','.ts':'typescript','.tsx':'typescript','.jsx':'javascript','.py':'python','.rs':'rust','.go':'go','.cpp':'cpp','.cc':'cpp','.c':'c','.h':'c','.hpp':'cpp','.lua':'lua'}
const IGNORE=new Set(['node_modules','.git','build','dist','.gradle','.idea','vendor','coverage','.dsh','__pycache__'])
const cap=(n,def,min,max)=>Number.isInteger(n)?Math.max(min,Math.min(max,n)):def
function safePath(path) {
 if(typeof path!=='string'||!path||path.length>1024||path.includes('\0'))return null
 return path.replace(/\\/g,'/').replace(/^file:\/\//,'').trim()
}
function safeRel(path) {
 if(typeof path!=='string'||!path||path.length>500||path.includes('\0')||path.includes('\\')||path.startsWith('/')||path.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('invalid relative path')
 return path
}
async function rootPath(p) {const root=await realpath(resolve(p||'.'));if(!(await lstat(root)).isDirectory())throw Error('root must be directory');return root}
function normalizePath(path,root){
 const value=safePath(path)
 if(!value)return null
 if(value.startsWith('/')){
  if(!root)return value
  const rel=relative(root,value)
  return rel&&!rel.startsWith('..')&&!rel.startsWith('/')?rel:value
 }
 if(value.startsWith('../'))return value
 return value.replace(/^\.\//,'')
}
const severityOf=raw=>/^w(?:arning)?:/i.test(raw)?'warning':/^i(?:nfo)?:/i.test(raw)?'info':'error'
function addDiag(output,cache,root,{tool,code='',path=null,line=null,column=null,severity='error',message=''}){
 const name=normalizePath(path,root),clean=String(message||'').replace(/\s+/g,' ').trim().slice(0,500)
 if(!clean)return
 const diag={tool,severity,code:String(code||'').slice(0,32),path:name,line:Number.isInteger(line)?line:null,column:Number.isInteger(column)?column:null,message:clean}
 const key=[diag.tool,diag.path,diag.line,diag.column,diag.code,diag.message].join('|')
 if(cache.has(key))return
 cache.add(key);output.push(diag)
}
export function parseCodeDiagnostics(input={}){
 const src=typeof input.log==='string'?input.log:''
 const truncated=Buffer.byteLength(src)>MAX_LOG_BYTES
 const data=truncated?src.slice(-MAX_LOG_BYTES):src
 const lines=data.split(/\r?\n/)
 const limit=cap(input.limit,80,1,200),result=[],seen=new Set()
 const root=typeof input.root==='string'&&input.root?resolve(input.root):null
 const tools=new Set(),max=Math.min(lines.length,MAX_LINES)
 let tool='unknown',gradleTask=null
 const summary=[]
 for(let i=0;i<max;i++){
  const raw=lines[i],text=raw.trim()
  let m
  if((m=raw.match(/^(?:e|w):\s+(?:file:\/\/\/)?(.+?\.(?:kt|kts)):(\d+):(\d+):\s*(.+)$/i))){
   tool='kotlin';addDiag(result,seen,root,{tool,path:m[1],line:+m[2],column:+m[3],severity:severityOf(text),message:m[4]});continue
  }
  if((m=raw.match(/^(.+?\.java):(\d+):\s*(error|warning):\s*(.+)$/i))){
   tool='javac';addDiag(result,seen,result,{tool,path:m[1],line:+m[2],severity:m[3].toLowerCase(),message:m[4]});continue
  }
  if((m=raw.match(/^(.+?\.(?:ts|tsx|js|jsx))\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/i))){
   tool='typescript';addDiag(result,seen,result,{tool,path:m[1],line:+m[2],column:+m[3],code:m[4],message:m[5]});continue
  }
  if((m=raw.match(/^(.+?\.(?:ts|tsx|js|jsx)):(\d+):(\d+)\s*[- ]\s*(error|warning)\s+(TS\d+)?\s*(.+)$/i))){
   tool='typescript';addDiag(result,seen,result,{tool,path:m[1],line:+m[2],column:+m[3],severity:m[4].toLowerCase(),code:m[5],message:m[6]});continue
  }
  if((m=raw.match(/^(.+?\.(?:c|cc|cpp|h|hpp|go)):(\d+):(\d+):\s*(fatal error|error|warning):\s*(.+)$/i))){
   tool=m[1].endsWith('.go')?'go':'native';addDiag(result,seen,result,{tool,path:m[1],line:+m[2],column:+m[3],severity:m[4]==='warning'?'warning':'error',message:m[5]});continue
  }
  if((m=raw.match(/^\s*error(?:\[(E\d+)\])?:\s*(.+)$/))&&i+1<max){
   const locate=lines.slice(i+1,Math.min(i+6,max)).join('\n').match(/-->\s+(.+?):(\d+):(\d+)/)
   if(locate){tool='rust';addDiag(result,seen,result,{tool,code:m[1],message:m[2],path:locate[1],line:+locate[2],column:+locate[3]});continue}
  }
  if((m=raw.match(/^\s*File "([^"]+\.py)", line (\d+)(?:, in .+)?$/))){
   const after=lines.slice(i+1,Math.min(i+5,max)).map(x=>x.trim()).find(x=>/^(?:[A-Za-z_][A-Za-z_0-9]*(?:Error|Exception|Warning)|SyntaxError):/.test(x))
   if(after){tool='python';addDiag(result,seen,result,{tool,path:m[1],line:+m[2],message:after});continue}
  }
  if((m=raw.match(/^Execution failed for task '([^']+)'/))){
   tool='gradle';gradleTask=m[1];summary.push({type:'gradle_task',task:gradleTask});continue
  }
  if(/^(?:FAIL(?:ED)?|ERROR|error)\b/.test(text)&&summary.length<20)summary.push({type:'message',message:text.slice(0,200)})
  if(result.length>=limit)break
 }
 const counts={errors:0,warnings:0,info:0}
 for(const d of result){tools.add(d.tool);if(d.severity==='warning')counts.warnings++;else if(d.severity==='info')counts.info++;else counts.errors++}
 const normalized=result.map(({tool,severity,code,path,line,column,message})=>({tool,severity,code,path,line,column,message}))
 return {diagnostics:normalized,counts,formatHints:[...tools],gradleTask,summary:summary.slice(-10),truncated:truncated||lines.length>MAX_LINES||normalized.length>=limit,
  note:normalized.length?'Heuristic compiler output; validate file paths and code locations':'No recognized compiler diagnostics; inspect the original log'}
}
async function hasRegular(root,name){
 const path=resolve(root,name)
 try{
  const st=await lstat(path)
  if(!st.isFile()||st.isSymbolicLink())return false
  const relativePath=relative(root,path)
  return !!relativePath&&!relativePath.startsWith('..')
 }catch{return false}
}
async function existsDir(root,name){
 try{const st=await lstat(resolve(root,name));return st.isDirectory()&&!st.isSymbolicLink()}catch{return false}
}
async function discoverTests(root,depthLimit=5,limit=160){
 const found=[],queue=[{path:'',depth:0}]
 for(let pos=0;pos<queue.length&&queue.length<3000;pos++){
  const entry=queue[pos]
  let entries
  try{entries=await readdir(resolve(root,entry.path),{withFileTypes:true})}catch{continue}
  for(const e of entries){
   if(e.isSymbolicLink())continue
   const rel=entry.path?entry.path+'/'+e.name:e.name
   if(e.isDirectory()){
    if(entry.depth<depthLimit&&!IGNORE.has(e.name))queue.push({path:rel,depth:entry.depth+1})
   }else if(e.isFile()&&(/(?:^|[._-])(?:test|spec)[._-]/i.test(e.name)||e.name.endsWith('_test.go')||/\btest[s]?\//i.test(rel))){
    found.push(rel)
    if(found.length>=limit)return{files:found,truncated:true}
   }
  }
 }
 return{files:found,truncated:false}
}
function matching(source,test){
 const base=basename(source).replace(/\.(?:test|spec)\./,'').replace(/\.[^.]+$/,'').toLowerCase()
 const name=basename(test).toLowerCase()
 return base.length>=2&&(name.includes(base)||test.toLowerCase().includes('/'+base+'/'))
}
export async function selectCodeTests(input={}){
 const root=await rootPath(input.root)
 const changes=input.changedPaths
 if(!Array.isArray(changes)||!changes.length||changes.length>64)throw Error('changedPaths must contain 1..64 paths')
 const changed=changes.map(safeRel)
 const detected=[],commands=[]
 if(await hasRegular(root,'package.json')){
  try {
   const json=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'))
   const scripts=json.scripts||{}
   if(typeof scripts.test==='string'&&scripts.test.trim()&&!/^echo\b.*(?:no test|error)/i.test(scripts.test)){
    detected.push('node')
    commands.push({command:'npm',args:['test','--','--runInBand'],cwd:'.',automatic:false,reason:'npm test exists; flags may be framework-specific'})
   }
  }catch{}
 }
 if(await hasRegular(root,'gradlew')||await hasRegular(root,'gradlew.bat')||await hasRegular(root,'build.gradle')||await hasRegular(root,'build.gradle.kts')){
  detected.push('gradle')
  if(await hasRegular(root,'gradlew'))commands.push({command:'./gradlew',args:['test','--no-daemon'],cwd:'.',automatic:false,reason:'Gradle wrapper detected; test task may vary by Android variant'})
 }
 if(await hasRegular(root,'pytest.ini')||await hasRegular(root,'pyproject.toml')||await existsDir(root,'tests')){
  detected.push('python')
  commands.push({command:'python3',args:['-m','pytest','-q'],cwd:'.',automatic:false,reason:'Python test convention detected'})
 }
 if(await hasRegular(root,'go.mod')){
  detected.push('go')
  commands.push({command:'go',args:['test','./...'],cwd:'.',automatic:false,reason:'Go module detected'})
 }
 if(await hasRegular(root,'Cargo.toml')){
  detected.push('rust')
  commands.push({command:'cargo',args:['test'],cwd:'.',automatic:false,reason:'Cargo project detected'})
 }
 const tests=await discoverTests(root,cap(input.maxTests,100,1,160))
 const related=tests.files.filter(t=>changed.some(p=>matching(p,t))).slice(0,80)
 const languageCounts={}
 for(const path of changed){const lang=LANGUAGES[extname(path)]||'other';languageCounts[lang]=(languageCounts[lang]||0)+1}
 return{changed,languageCounts,detected:[...new Set(detected)],suggestedCommands:commands.slice(0,10),relatedTests:related,
  scannedTests:tests.files.length,truncated:tests.truncated,automaticExecution:false,note:'Suggestions only. Commands are never executed by this tool.'}
}
async function selfTest(){
 const root=await mkdtemp(join(tmpdir(),'dsh-diagnostics-'))
 try{
  const log=[
   'e: file:///project/app/src/Main.kt:22:7: Unresolved reference: asyncFoo',
   'src/app.ts(2,4): error TS2304: Cannot find name X',
   'src/Foo.java:12: error: cannot find symbol',
   'src/app.cpp:3:9: warning: unused variable',
   'error[E0425]: cannot find value x',
   ' --> src/lib.rs:4:3',
   'Execution failed for task \':app:compileDebugKotlin\'',
  ].join('\n')
  const out=parseCodeDiagnostics({log,root:'/project'})
  if(out.diagnostics.length!==5||out.counts.warnings!==1||out.gradleTask!==':app:compileDebugKotlin')throw Error('compiler diagnostics lost')
  if(out.diagnostics[0].path!=='app/src/Main.kt')throw Error('project-relative path')
  await mkdir(join(root,'src'));await mkdir(join(root,'tests'))
  await writeFile(join(root,'package.json'),JSON.stringify({scripts:{test:'vitest run'}}))
  await writeFile(join(root,'src','parser.js'),'export function parse(){}')
  await writeFile(join(root,'tests','parser.test.js'),'test("parse",()=>{})')
  const tests=await selectCodeTests({root,changedPaths:['src/parser.js']})
  if(!tests.detected.includes('node')||!tests.relatedTests.includes('tests/parser.test.js')||tests.automaticExecution)throw Error('test selection failure')
  let blocked=false
  try{await selectCodeTests({root,changedPaths:['../private']})}catch{blocked=true}
  if(!blocked)throw Error('unsafe test path accepted')
  process.stdout.write('[DSH] Coding diagnostics/test selection self-test: OK\n')
 }finally {await rm(root,{recursive:true,force:true})}
}
if(process.argv.includes('--self-test'))selfTest().catch(e=>{console.error(e);process.exitCode=1})
