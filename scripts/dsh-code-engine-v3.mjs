import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { TextDecoder } from 'node:util'
import { codeCall } from './dsh-code-engine.mjs'
const obj=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false})
const str={type:'string'},paths={type:'array',minItems:1,maxItems:32,items:str}
export const codeV3Tools=[
 {name:'code_rename_identifier',description:'Lexical JS/TS identifier rename across files; skips comments and quoted literals. Not scope-aware. Supports dryRun and SHA-256 preconditions.',inputSchema:obj({paths,from:str,to:str,dryRun:{type:'boolean'},expectedSha256ByPath:{type:'object',additionalProperties:str}},['paths','from','to'])},
 {name:'code_check',description:'Check JS syntax with node --check and TS syntax with tsc, returning structured results.',inputSchema:obj({paths,timeoutMs:{type:'integer',minimum:100,maximum:120000},typescriptCommand:str},['paths'])},
 {name:'code_test',description:'Run a test/build executable with argv (shell=false), timeout and bounded output.',inputSchema:obj({command:str,args:{type:'array',maxItems:128,items:str},cwd:str,timeoutMs:{type:'integer',minimum:100,maximum:120000},maxOutputBytes:{type:'integer',minimum:1024,maximum:1048576}},['command'])},
]
const hash=x=>createHash('sha256').update(x).digest('hex')
const ID=/^[A-Za-z_$][A-Za-z0-9_$]*$/
const reserved=new Set('await break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof let new null return super switch this throw true try typeof var void while with yield'.split(' '))
function lexicalRename(text,from,to){
 let out='',i=0,count=0,last=''
 while(i<text.length){
  const begin=i,c=text[i],n=text[i+1]
  if(c==='/'&&n==='/'){i=text.indexOf('\n',i+2);if(i<0)i=text.length;out+=text.slice(begin,i);continue}
  if(c==='/'&&n==='*'){i=text.indexOf('*/',i+2);if(i<0)throw Error('unterminated comment');i+=2;out+=text.slice(begin,i);continue}
  if(c==="'"||c==='"'||c.charCodeAt(0)===96){
   const template=c.charCodeAt(0)===96;i++;let closed=false
   while(i<text.length){if(text[i]==='\\'){i+=2;continue}if(template&&text[i]==='$'&&text[i+1]==='{')throw Error('template interpolation requires AST-based editing');if(text[i]===c){i++;closed=true;break}if(!template&&(text[i]==='\r'||text[i]==='\n'))break;i++}
   if(!closed)throw Error('unterminated string literal')
   out+=text.slice(begin,i);last='literal';continue
  }
  if(c==='/'&&['','=',':','(','[','{',',',';','!','?','return','throw','case'].includes(last)){
   let closed=false,inside=false;i++
   while(i<text.length){if(text[i]==='\\'){i+=2;continue}if(text[i]==='\n')break;if(text[i]==='[')inside=true;if(text[i]===']')inside=false;if(text[i]==='/'&&!inside){i++;while(i<text.length&&/[a-z]/i.test(text[i]))i++;closed=true;break}i++}
   if(!closed)throw Error('ambiguous regular expression; use code_patch')
   out+=text.slice(begin,i);last='literal';continue
  }
  if(/[A-Za-z_$]/.test(c)){i++;while(i<text.length&&/[A-Za-z0-9_$]/.test(text[i]))i++;const word=text.slice(begin,i);out+=word===from?to:word;if(word===from)count++;last=word;continue}
  if(!/\s/.test(c))last=c
  out+=c;i++
 }
 return {text:out,count}
}
async function rename(a){
 if(!Array.isArray(a.paths)||a.paths.length<1||a.paths.length>32)throw Error('paths must contain 1..32 source files')
 if(!ID.test(a.from)||!ID.test(a.to)||reserved.has(a.to)||a.from===a.to)throw Error('invalid identifier rename')
 const edits=[],files=[]
 for(const path of new Set(a.paths.map(p=>resolve(p)))){
  if(!/\.(js|jsx|mjs|cjs|ts|tsx)$/i.test(path))throw Error('only JS/TS sources supported: '+path)
  const data=await readFile(path);if(data.length>16*1024*1024)throw Error('source exceeds 16 MiB')
  const original=new TextDecoder('utf-8',{fatal:true}).decode(data);if(original.includes('\u0000'))throw Error('not UTF-8 source: '+path)
  const digest=hash(original),expected=a.expectedSha256ByPath?.[path];if(expected&&expected.toLowerCase()!==digest)throw Error('stale source hash: '+path)
  const changed=lexicalRename(original,a.from,a.to);files.push({path,occurrences:changed.count,beforeSha256:digest,afterSha256:hash(changed.text)})
  if(changed.count)edits.push({path,oldText:original,newText:changed.text,expectedSha256:digest})
 }
 if(!edits.length)throw Error('identifier not found in selected source files')
 return {...await codeCall('code_multi_edit',{edits,dryRun:a.dryRun===true}),mode:'lexical-js-ts',scopeAware:false,files}
}
async function run(command,args,cwd,timeoutMs=15000,maxOutputBytes=131072){
 const started=Date.now()
 return new Promise(done=>{
  let child,out='',err='',truncated=false,timedOut=false,spawnError=null,timer
  const capture=(buf,kind)=>{const current=kind==='out'?out:err,room=maxOutputBytes-Buffer.byteLength(current);if(room<=0){truncated=true;return}const text=buf.subarray(0,room).toString('utf8');if(kind==='out')out+=text;else err+=text;if(buf.length>room)truncated=true}
  try{
   child=spawn(command,args,{cwd,stdio:['ignore','pipe','pipe'],shell:false})
   timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL')},timeoutMs)
   child.stdout.on('data',b=>capture(b,'out'));child.stderr.on('data',b=>capture(b,'err'))
   child.on('error',e=>{spawnError=e.message})
   child.on('close',(exitCode,signal)=>{clearTimeout(timer);done({command,args,exitCode,signal,ok:exitCode===0&&!timedOut&&!spawnError,timedOut,truncated,stdout:out,stderr:err,error:spawnError,durationMs:Date.now()-started})})
  }catch(e){if(timer)clearTimeout(timer);done({command,args,ok:false,error:e.message,exitCode:null,durationMs:Date.now()-started})}
 })
}
export async function codeV3Call(name,a={}){
 if(name==='code_rename_identifier')return rename(a)
 if(name==='code_check'){
  if(!Array.isArray(a.paths)||a.paths.length<1||a.paths.length>32)throw Error('paths must contain 1..32 files')
  const results=[]
  for(const source of a.paths){
   const path=resolve(source),ts=/\.tsx?$/i.test(path),js=/\.(js|mjs|cjs)$/i.test(path)
   if(!ts&&!js){results.push({path,ok:false,error:'unsupported source extension'});continue}
   results.push({path,...await run(ts?(a.typescriptCommand||'tsc'):process.execPath,ts?['--pretty','false','--noEmit',path]:['--check',path],undefined,a.timeoutMs||15000,65536)})
  }
  return {ok:results.every(x=>x.ok),results}
 }
 if(name==='code_test'){
  if(typeof a.command!=='string'||!a.command.trim())throw Error('command required')
  if(a.args!==undefined&&(!Array.isArray(a.args)||a.args.length>128||a.args.some(x=>typeof x!=='string')))throw Error('args must contain <=128 strings')
  return run(a.command,a.args||[],a.cwd?resolve(a.cwd):undefined,Math.min(120000,Math.max(100,a.timeoutMs||15000)),Math.min(1048576,Math.max(1024,a.maxOutputBytes||131072)))
 }
 throw Error('unknown Code Engine V3 tool: '+name)
}
