#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile,
} from 'node:fs/promises'

const HERE=dirname(fileURLToPath(import.meta.url))
const PREFIX=process.env.TERMUX__PREFIX||process.env.PREFIX||resolve(HERE,'../..')
const requireFromDsh=createRequire(resolve(PREFIX,'lib/node_modules/@deepseek-ai/dsh/package.json'))
const MAX_TEXT=1024*1024
const MAX_FILE=1024*1024*1024
const MAX_READ_FILE=16*1024*1024
const MAX_OUTPUT=192*1024
const MAX_COMMAND_OUTPUT=1024*1024
const MAX_SEARCH_OUTPUT=2*1024*1024
const MAX_HTTP_CAPTURE=4*1024*1024

const fileSchema={type:'object',properties:{path:{type:'string',description:'Absolute path or path relative to the MCP working directory.'}},required:['path'],additionalProperties:false}
const tools=[
 {name:'fs_read',description:'Read a UTF-8 text file. Paths may be absolute or relative to the MCP cwd. Use startLine/endLine for focused source reads.',inputSchema:{type:'object',properties:{path:{type:'string'},startLine:{type:'integer',minimum:1},endLine:{type:'integer',minimum:1},maxBytes:{type:'integer',minimum:1,maximum:1048576,default:262144}},required:['path'],additionalProperties:false}},
 {name:'fs_list',description:'List one directory level with stable structured entries. Defaults to the MCP cwd; hidden entries are off unless requested.',inputSchema:{type:'object',properties:{path:{type:'string',default:'.'},showHidden:{type:'boolean',default:false},maxEntries:{type:'integer',minimum:1,maximum:2000,default:500}},additionalProperties:false}},
 {name:'fs_search',description:'Search source/text with embedded ripgrep and return structured path/line/column matches. Literal, case-sensitive search is the default; regex and context are optional.',inputSchema:{type:'object',properties:{query:{type:'string'},path:{type:'string',default:'.'},glob:{type:'string'},regex:{type:'boolean',default:false},caseSensitive:{type:'boolean',default:true},showHidden:{type:'boolean',default:false},maxResults:{type:'integer',minimum:1,maximum:200,default:80},contextLines:{type:'integer',minimum:0,maximum:5,default:2}},required:['query'],additionalProperties:false}},
 {name:'fs_write',description:'Create or replace one UTF-8 text file atomically. Existing files require overwrite=true; parent creation is opt-in.',inputSchema:{type:'object',properties:{path:{type:'string'},content:{type:'string'},overwrite:{type:'boolean',default:false},createParents:{type:'boolean',default:false}},required:['path','content'],additionalProperties:false}},
 {name:'fs_patch',description:'Safely patch a text file by exact oldText -> newText replacement. Defaults to exactly one occurrence and supports dryRun.',inputSchema:{type:'object',properties:{path:{type:'string'},oldText:{type:'string'},newText:{type:'string'},expectedOccurrences:{type:'integer',minimum:1,maximum:100,default:1},dryRun:{type:'boolean',default:false}},required:['path','oldText','newText'],additionalProperties:false}},
 {name:'command_run',description:'Run one executable directly with argv (shell=false). Returns exitCode/stdout/stderr/timing. Prefer fs_patch/fs_write for file mutation; use this for builds, tests and CLI tools.',inputSchema:{type:'object',properties:{command:{type:'string'},args:{type:'array',items:{type:'string'},maxItems:128,default:[]},cwd:{type:'string'},env:{type:'object',additionalProperties:{type:'string'}},timeoutMs:{type:'integer',minimum:100,maximum:60000,default:10000},maxOutputBytes:{type:'integer',minimum:1024,maximum:1048576,default:196608}},required:['command'],additionalProperties:false}},
 {name:'git_status',description:'Return structured Git working-tree status for a repository directory. Defaults to the MCP cwd.',inputSchema:{type:'object',properties:{repo:{type:'string',default:'.'}},additionalProperties:false}},
 {name:'git_diff',description:'Show a Git diff without color or external diff drivers. Supports staged changes, one comparison ref and an optional path.',inputSchema:{type:'object',properties:{repo:{type:'string',default:'.'},staged:{type:'boolean',default:false},ref:{type:'string'},path:{type:'string'},maxLines:{type:'integer',minimum:1,maximum:5000,default:1600}},additionalProperties:false}},
 {name:'git_log',description:'Read recent Git history as structured commits. Defaults to 20 commits from HEAD; optionally scope to ref/path.',inputSchema:{type:'object',properties:{repo:{type:'string',default:'.'},ref:{type:'string'},path:{type:'string'},limit:{type:'integer',minimum:1,maximum:100,default:20}},additionalProperties:false}},
 {name:'http_request',description:'Send an HTTP/HTTPS request with bounded body capture and timeout. Useful for API/MCP/local-host diagnostics; redirects follow by default.',inputSchema:{type:'object',properties:{method:{type:'string',enum:['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'],default:'GET'},url:{type:'string'},headers:{type:'object',additionalProperties:{type:'string'}},body:{type:'string'},timeoutMs:{type:'integer',minimum:100,maximum:60000,default:15000},maxResponseBytes:{type:'integer',minimum:1,maximum:4194304,default:1048576},followRedirects:{type:'boolean',default:true}},required:['url'],additionalProperties:false}},
 {name:'android_logcat',description:'Read bounded Android logcat output, optionally filtered by package PID, tag, minimum level and recent seconds.',inputSchema:{type:'object',properties:{package:{type:'string'},tag:{type:'string'},level:{type:'string',enum:['V','D','I','W','E','F'],default:'V'},sinceSeconds:{type:'integer',minimum:1,maximum:86400},maxLines:{type:'integer',minimum:1,maximum:2000,default:400}},additionalProperties:false}},
 {name:'apk_inspect',description:'Inspect an APK with embedded aapt2/unzip: package/version/SDK/permissions/launchable activity/ABIs plus bounded manifest tree and archive metadata.',inputSchema:fileSchema},
 {name:'protocol_decode',description:'Decode UTF-8/hex/base64/base64url data.',inputSchema:{type:'object',properties:{data:{type:'string'},encoding:{type:'string',enum:['utf8','hex','base64','base64url']}},required:['data','encoding'],additionalProperties:false}},
 {name:'protocol_encode',description:'Encode UTF-8 text as hex/base64/base64url/URL component.',inputSchema:{type:'object',properties:{text:{type:'string'},encoding:{type:'string',enum:['hex','base64','base64url','url-component']}},required:['text','encoding'],additionalProperties:false}},
 {name:'protocol_hash',description:'Hash text or encoded bytes.',inputSchema:{type:'object',properties:{data:{type:'string'},inputEncoding:{type:'string',enum:['utf8','hex','base64','base64url']},algorithm:{type:'string',enum:['sha256','sha1','md5','sha512']}},required:['data','algorithm'],additionalProperties:false}},
 {name:'protocol_parse_http',description:'Parse a raw HTTP/1.x request or response without sending traffic.',inputSchema:{type:'object',properties:{message:{type:'string'}},required:['message'],additionalProperties:false}},
 {name:'protocol_parse_url',description:'Parse an absolute URL.',inputSchema:{type:'object',properties:{url:{type:'string'}},required:['url'],additionalProperties:false}},
 {name:'binary_info',description:'Inspect a local binary with file/readelf.',inputSchema:fileSchema},
 {name:'binary_sections',description:'List ELF sections with readelf -SW.',inputSchema:fileSchema},
 {name:'binary_symbols',description:'List symbols with nm/readelf.',inputSchema:fileSchema},
 {name:'binary_strings',description:'Extract printable strings.',inputSchema:{type:'object',properties:{path:{type:'string'},minLength:{type:'integer',minimum:3,maximum:64},maxLines:{type:'integer',minimum:1,maximum:2000}},required:['path'],additionalProperties:false}},
 {name:'binary_disassemble',description:'Disassemble a local ELF/object with objdump -d.',inputSchema:{type:'object',properties:{path:{type:'string'},startAddress:{type:'string'},stopAddress:{type:'string'},maxLines:{type:'integer',minimum:1,maximum:4000}},required:['path'],additionalProperties:false}},
]

function text(v,n='input',max=MAX_TEXT){if(typeof v!=='string')throw new Error(n+' must be a string');if(Buffer.byteLength(v)>max)throw new Error(n+' exceeds '+max+' bytes');return v}
function int(v,def,min,max){return Number.isInteger(v)?Math.max(min,Math.min(max,v)):def}
function bool(v,def=false){return typeof v==='boolean'?v:def}
function userPath(p='.') {const raw=text(p,'path',16384);if(raw.includes('\0'))throw new Error('path contains NUL');return resolve(process.cwd(),raw)}
async function existingPath(p){const path=await realpath(userPath(p));const s=await stat(path);return{path,stat:s}}
async function checkedDir(p='.'){const x=await existingPath(p);if(!x.stat.isDirectory())throw new Error('not a directory');return{path:x.path}}
async function checkedPath(p){const x=await existingPath(p);if(!x.stat.isFile())throw new Error('not a regular file');if(x.stat.size>MAX_FILE)throw new Error('file exceeds 1 GiB');return{path:x.path,size:x.stat.size}}
function sha256(value){return createHash('sha256').update(value).digest('hex')}
function decode(data,enc='utf8'){const s=text(data,'data');if(enc==='utf8')return Buffer.from(s);if(enc==='hex'){if(!/^(?:[0-9a-fA-F]{2})*$/.test(s))throw new Error('invalid hex');return Buffer.from(s,'hex')}if(enc==='base64'){const b=Buffer.from(s,'base64');if(b.toString('base64')!==s)throw new Error('invalid canonical base64');return b}if(enc==='base64url')return Buffer.from(s,'base64url');throw new Error('unsupported encoding')}
function projection(b){const x=b.subarray(0,65536);return{byteLength:b.length,truncated:b.length>x.length,utf8:x.toString(),hex:x.toString('hex'),base64:x.toString('base64')}}
function trimLines(s,max=800){const a=String(s).split(/\r?\n/);return{output:a.slice(0,max).join('\n').slice(0,MAX_OUTPUT),truncated:a.length>max||Buffer.byteLength(a.slice(0,max).join('\n'))>MAX_OUTPUT,totalLines:a.length}}
function addr(v){if(v==null||v==='')return null;if(typeof v!=='string'||!/^(?:0x)?[0-9a-fA-F]+$/.test(v))throw new Error('invalid address');return '0x'+v.replace(/^0x/i,'')}
function sanitizeEnv(extra){if(extra==null)return process.env;if(typeof extra!=='object'||Array.isArray(extra))throw new Error('env must be an object');const env={...process.env};for(const [k,v] of Object.entries(extra)){if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k))throw new Error('invalid env key: '+k);env[k]=text(v,'env.'+k,65536)}return env}

async function runProcess(command,args=[],opts={}){
 const bin=text(command,'command',4096)
 if(bin.includes('\0'))throw new Error('command contains NUL')
 const argv=(args||[]).map((v,i)=>text(v,'args['+i+']',65536))
 const cwd=opts.cwd? (await checkedDir(opts.cwd)).path : process.cwd()
 const timeoutMs=int(opts.timeoutMs,10000,100,60000)
 const maxOutput=int(opts.maxOutputBytes,MAX_OUTPUT,1024,MAX_COMMAND_OUTPUT)
 const env=opts.env||process.env
 return await new Promise((resolvePromise)=>{
  const started=Date.now()
  let child
  try{child=spawn(bin,argv,{cwd,env,shell:false,stdio:['ignore','pipe','pipe']})}catch(error){resolvePromise({exitCode:null,signal:null,stdout:'',stderr:String(error),timedOut:false,truncated:false,durationMs:Date.now()-started});return}
  let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),truncated=false,timedOut=false,spawnError=null
  const capture=(current,chunk)=>{const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);if(current.length>=maxOutput){truncated=true;return current}const room=maxOutput-current.length;if(b.length>room)truncated=true;return Buffer.concat([current,b.subarray(0,room)])}
  child.stdout?.on('data',chunk=>{stdout=capture(stdout,chunk)})
  child.stderr?.on('data',chunk=>{stderr=capture(stderr,chunk)})
  child.on('error',error=>{spawnError=error})
  const timer=setTimeout(()=>{timedOut=true;try{child.kill('SIGKILL')}catch{}},timeoutMs)
  child.on('close',(code,signal)=>{clearTimeout(timer);resolvePromise({exitCode:typeof code==='number'?code:null,signal:signal||null,stdout:stdout.toString('utf8'),stderr:(spawnError?String(spawnError)+'\n':'')+stderr.toString('utf8'),timedOut,truncated,durationMs:Date.now()-started})})
 })
}
async function runStrict(bin,args,opts={}){const r=await runProcess(bin,args,opts);if(r.timedOut)throw new Error(bin+' timed out');if(r.exitCode!==0)throw new Error(bin+' failed ('+r.exitCode+'): '+(r.stderr||r.stdout||'unknown error').slice(0,MAX_OUTPUT));return(r.stdout+(r.stderr?'\n[stderr]\n'+r.stderr:'')).trim()}

async function readTextFile(p){const f=await checkedPath(p);if(f.size>MAX_READ_FILE)throw new Error('text file exceeds 16 MiB');const data=await readFile(f.path);if(data.subarray(0,8192).includes(0))throw new Error('binary file: use binary/apk tools instead');return{...f,data,text:data.toString('utf8')}}
async function atomicWrite(target,content,{overwrite=false,createParents=false}={}){
 const requested=userPath(target)
 let parent=dirname(requested)
 if(createParents)await mkdir(parent,{recursive:true})
 parent=await realpath(parent)
 const path=resolve(parent,basename(requested))
 let before=null
 try{const s=await lstat(path);if(s.isSymbolicLink())throw new Error('refusing to overwrite symlink');if(!s.isFile())throw new Error('target exists and is not a regular file');if(!overwrite)throw new Error('target exists; set overwrite=true');before=s}catch(error){if(error?.code!=='ENOENT')throw error}
 const temp=resolve(parent,'.'+basename(path)+'.dsh-'+process.pid+'-'+randomBytes(6).toString('hex')+'.tmp')
 try{
  await writeFile(temp,content,{flag:'wx',mode:before?(before.mode&0o777):0o600})
  if(before)await chmod(temp,before.mode&0o777)
  await rename(temp,path)
 }catch(error){await rm(temp,{force:true}).catch(()=>{});throw error}
 return{path,created:before===null,overwritten:before!==null,byteLength:Buffer.byteLength(content),sha256:sha256(content)}
}
function countOccurrences(haystack,needle){if(needle==='')throw new Error('oldText must not be empty');let count=0,pos=0;while(true){const i=haystack.indexOf(needle,pos);if(i<0)break;count++;pos=i+needle.length}return count}
async function contextFor(path,lineNumber,n,cache){if(n<=0)return undefined;let lines=cache.get(path);if(lines===undefined){try{const s=await stat(path);if(!s.isFile()||s.size>4*1024*1024){cache.set(path,null);return undefined}lines=(await readFile(path,'utf8')).split(/\r?\n/);cache.set(path,lines)}catch{cache.set(path,null);return undefined}}if(lines===null)return undefined;const start=Math.max(0,lineNumber-1-n),end=Math.min(lines.length,lineNumber+n);return{startLine:start+1,lines:lines.slice(start,end)}}

function parseBadging(raw){const lines=raw.split(/\r?\n/);const out={permissions:[],features:[],nativeCode:[]};for(const line of lines){let m;if((m=line.match(/^package: name='([^']*)' versionCode='([^']*)' versionName='([^']*)'/))){out.packageName=m[1];out.versionCode=m[2];out.versionName=m[3]}else if((m=line.match(/^sdkVersion:'([^']*)'/)))out.minSdk=m[1];else if((m=line.match(/^targetSdkVersion:'([^']*)'/)))out.targetSdk=m[1];else if((m=line.match(/^application-label(?:-[^:]+)?:'([^']*)'/))&&!out.applicationLabel)out.applicationLabel=m[1];else if((m=line.match(/^launchable-activity: name='([^']*)'/)))out.launchableActivity=m[1];else if((m=line.match(/^uses-permission(?:-sdk-\d+)?: name='([^']*)'/)))out.permissions.push(m[1]);else if((m=line.match(/^uses-feature(?:-not-required)?: name='([^']*)'/)))out.features.push(m[1]);else if(line.startsWith('native-code:'))out.nativeCode=[...line.matchAll(/'([^']+)'/g)].map(x=>x[1])}out.permissions=[...new Set(out.permissions)];out.features=[...new Set(out.features)];out.nativeCode=[...new Set(out.nativeCode)];return out}
function logcatEpoch(line){const m=line.match(/^\s*(\d+(?:\.\d+)?)\s+/);return m?Number(m[1]):null}

async function call(name,a={}){
 switch(name){
  case 'fs_read': {
   const f=await readTextFile(a.path),maxBytes=int(a.maxBytes,262144,1,MAX_TEXT),start=int(a.startLine,1,1,Number.MAX_SAFE_INTEGER),all=f.text.split(/\r?\n/),end=a.endLine==null?all.length:int(a.endLine,all.length,1,Number.MAX_SAFE_INTEGER)
   if(end<start)throw new Error('endLine must be >= startLine')
   const selected=all.slice(start-1,end);let content='',returnedLines=0,truncated=false
   for(const line of selected){const next=(returnedLines?'\n':'')+line;if(Buffer.byteLength(content)+Buffer.byteLength(next)>maxBytes){truncated=true;break}content+=next;returnedLines++}
   return{path:f.path,size:f.size,startLine:start,endLine:start+Math.max(0,returnedLines-1),totalLines:all.length,content,truncated:truncated||start+returnedLines-1<end}
  }
  case 'fs_list': {
   const d=await checkedDir(a.path||'.'),show=bool(a.showHidden,false),limit=int(a.maxEntries,500,1,2000),raw=await readdir(d.path,{withFileTypes:true});const filtered=raw.filter(e=>show||!e.name.startsWith('.')).sort((x,y)=>Number(y.isDirectory())-Number(x.isDirectory())||x.name.localeCompare(y.name));const slice=filtered.slice(0,limit);return{path:d.path,entries:slice.map(e=>({name:e.name,path:resolve(d.path,e.name),type:e.isDirectory()?'directory':e.isFile()?'file':e.isSymbolicLink()?'symlink':'other'})),truncated:filtered.length>slice.length,totalEntries:filtered.length}
  }
  case 'fs_search': {
   const query=text(a.query,'query'),d=await checkedDir(a.path||'.'),limit=int(a.maxResults,80,1,200),context=int(a.contextLines,2,0,5),args=['--json','--line-number','--column','--color','never','--max-columns','1000','--max-filesize','16M'];if(!bool(a.regex,false))args.push('--fixed-strings');if(!bool(a.caseSensitive,true))args.push('--ignore-case');if(bool(a.showHidden,false))args.push('--hidden');if(a.glob!=null)args.push('--glob',text(a.glob,'glob',4096));args.push('--',query,d.path);const r=await runProcess('rg',args,{timeoutMs:15000,maxOutputBytes:MAX_SEARCH_OUTPUT});if(r.exitCode!==0&&r.exitCode!==1&&!r.truncated)throw new Error('rg failed: '+(r.stderr||r.stdout).slice(0,MAX_OUTPUT));const matches=[],cache=new Map();for(const line of r.stdout.split(/\r?\n/)){if(!line)continue;let event;try{event=JSON.parse(line)}catch{continue}if(event.type!=='match')continue;const data=event.data,path=data.path?.text;if(!path)continue;const sub=data.submatches?.[0];const item={path,line:data.line_number,column:(sub?.start??0)+1,text:(data.lines?.text||'').replace(/\r?\n$/,'')};const c=await contextFor(path,item.line,context,cache);if(c)item.context=c;matches.push(item);if(matches.length>=limit)break}return{query,path:d.path,matches,truncated:r.truncated||matches.length>=limit,stderr:r.stderr.trim()||undefined}
  }
  case 'fs_write': {const content=text(a.content,'content');return await atomicWrite(a.path,content,{overwrite:bool(a.overwrite,false),createParents:bool(a.createParents,false)})}
  case 'fs_patch': {
   const f=await readTextFile(a.path),oldText=text(a.oldText,'oldText'),newText=text(a.newText,'newText'),expected=int(a.expectedOccurrences,1,1,100),found=countOccurrences(f.text,oldText);if(found!==expected)throw new Error('expected '+expected+' occurrence(s), found '+found);const next=f.text.split(oldText).join(newText);if(Buffer.byteLength(next)>MAX_READ_FILE)throw new Error('patched file exceeds 16 MiB');const result={path:f.path,occurrences:found,beforeSha256:sha256(f.text),afterSha256:sha256(next),beforeBytes:Buffer.byteLength(f.text),afterBytes:Buffer.byteLength(next)};if(bool(a.dryRun,false))return{...result,dryRun:true};await atomicWrite(f.path,next,{overwrite:true});return{...result,dryRun:false}
  }
  case 'command_run': {
   const cwd=a.cwd? (await checkedDir(a.cwd)).path : process.cwd();const args=Array.isArray(a.args)?a.args:[];return await runProcess(a.command,args,{cwd,env:sanitizeEnv(a.env),timeoutMs:int(a.timeoutMs,10000,100,60000),maxOutputBytes:int(a.maxOutputBytes,MAX_OUTPUT,1024,MAX_COMMAND_OUTPUT)})
  }
  case 'git_status': {
   const repo=(await checkedDir(a.repo||'.')).path,r=await runProcess('git',['-C',repo,'status','--porcelain=v1','-b','--untracked-files=normal'],{timeoutMs:10000,maxOutputBytes:MAX_OUTPUT});if(r.exitCode!==0)throw new Error('git status failed: '+(r.stderr||r.stdout).slice(0,MAX_OUTPUT));const lines=r.stdout.split(/\r?\n/).filter(Boolean),branch=lines[0]?.startsWith('## ')?lines.shift().slice(3):null;return{repo,branch,entries:lines.map(line=>({status:line.slice(0,2),path:line.slice(3)})),clean:lines.length===0}
  }
  case 'git_diff': {
   const repo=(await checkedDir(a.repo||'.')).path,args=['-C',repo,'diff','--no-ext-diff','--no-color'];if(bool(a.staged,false))args.push('--cached');if(a.ref!=null)args.push(text(a.ref,'ref',4096));if(a.path!=null)args.push('--',text(a.path,'path',16384));const r=await runProcess('git',args,{timeoutMs:15000,maxOutputBytes:MAX_COMMAND_OUTPUT});if(r.exitCode!==0)throw new Error('git diff failed: '+(r.stderr||r.stdout).slice(0,MAX_OUTPUT));return{repo,staged:bool(a.staged,false),...trimLines(r.stdout,int(a.maxLines,1600,1,5000))}
  }
  case 'git_log': {
   const repo=(await checkedDir(a.repo||'.')).path,limit=int(a.limit,20,1,100),args=['-C',repo,'log','-n',String(limit),'--date=iso-strict','--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s'];if(a.ref!=null)args.push(text(a.ref,'ref',4096));if(a.path!=null)args.push('--',text(a.path,'path',16384));const r=await runProcess('git',args,{timeoutMs:10000,maxOutputBytes:MAX_OUTPUT});if(r.exitCode!==0)throw new Error('git log failed: '+(r.stderr||r.stdout).slice(0,MAX_OUTPUT));return{repo,commits:r.stdout.split(/\r?\n/).filter(Boolean).map(line=>{const [sha,shortSha,author,date,subject]=line.split('\x1f');return{sha,shortSha,author,date,subject}})}
  }
  case 'http_request': {
   const method=(a.method||'GET').toUpperCase(),u=new URL(text(a.url,'url',16384));if(u.protocol!=='http:'&&u.protocol!=='https:')throw new Error('only http/https URLs are supported');const headers={};if(a.headers!=null){if(typeof a.headers!=='object'||Array.isArray(a.headers))throw new Error('headers must be an object');for(const [k,v] of Object.entries(a.headers))headers[text(k,'header name',1024)]=text(v,'header '+k,65536)}if(!Object.keys(headers).some(k=>k.toLowerCase()==='user-agent'))headers['User-Agent']='DSH-Mobile-Tools/2.0';const timeoutMs=int(a.timeoutMs,15000,100,60000),maxBytes=int(a.maxResponseBytes,1048576,1,MAX_HTTP_CAPTURE),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);let response;const chunks=[];let captured=0,truncated=false;try{response=await fetch(u,{method,headers,body:a.body!=null&&method!=='GET'&&method!=='HEAD'?text(a.body,'body',MAX_TEXT):undefined,redirect:bool(a.followRedirects,true)?'follow':'manual',signal:controller.signal});if(response.body&&method!=='HEAD'){const reader=response.body.getReader();while(true){const {done,value}=await reader.read();if(done)break;const b=Buffer.from(value),room=maxBytes-captured;if(room>0){chunks.push(b.subarray(0,room));captured+=Math.min(room,b.length)}if(b.length>room){truncated=true;await reader.cancel().catch(()=>{});break}}}}finally{clearTimeout(timer)}const body=Buffer.concat(chunks),contentType=response.headers.get('content-type')||'',isText=/^(text\/|application\/(?:json|xml|javascript|x-www-form-urlencoded)|[^;]+\+(?:json|xml))/i.test(contentType);return{url:response.url,status:response.status,statusText:response.statusText,redirected:response.redirected,headers:Object.fromEntries(response.headers.entries()),capturedBytes:body.length,truncated,contentType,bodyText:isText?body.toString('utf8'):undefined,bodyBase64:isText?undefined:body.toString('base64')}
  }
  case 'android_logcat': {
   const level=a.level||'V',limit=int(a.maxLines,400,1,2000),scan=Math.min(8000,Math.max(limit*4,limit)),args=['-d','-v','epoch','-t',String(scan)];let pid=null;if(a.package!=null){const pkg=text(a.package,'package',512),p=await runProcess('/system/bin/pidof',[pkg],{timeoutMs:3000,maxOutputBytes:8192});pid=p.stdout.trim().split(/\s+/).filter(Boolean)[0]||null;if(!pid)return{package:pkg,pid:null,lines:[],message:'package is not running'};args.push('--pid='+pid)}if(a.tag!=null)args.push(text(a.tag,'tag',512)+':'+level,'*:S');else args.push('*:'+level);const r=await runProcess('/system/bin/logcat',args,{timeoutMs:8000,maxOutputBytes:MAX_COMMAND_OUTPUT});if(r.exitCode!==0)throw new Error('logcat failed: '+(r.stderr||r.stdout).slice(0,MAX_OUTPUT));let lines=r.stdout.split(/\r?\n/).filter(Boolean);if(a.sinceSeconds!=null){const cutoff=Date.now()/1000-int(a.sinceSeconds,1,1,86400);lines=lines.filter(line=>{const epoch=logcatEpoch(line);return epoch===null||epoch>=cutoff})}if(lines.length>limit)lines=lines.slice(lines.length-limit);return{package:a.package||null,pid,tag:a.tag||null,level,lines,truncated:r.truncated||lines.length>=limit}
  }
  case 'apk_inspect': {
   const f=await checkedPath(a.path),badging=await runStrict('aapt2',['dump','badging',f.path],{timeoutMs:15000,maxOutputBytes:MAX_COMMAND_OUTPUT}),meta=parseBadging(badging);let manifestTree='';try{manifestTree=await runStrict('aapt2',['dump','xmltree',f.path,'--file','AndroidManifest.xml'],{timeoutMs:15000,maxOutputBytes:MAX_COMMAND_OUTPUT})}catch(error){manifestTree='[xmltree unavailable] '+error.message}let archive='';try{archive=await runStrict('unzip',['-Z1',f.path],{timeoutMs:10000,maxOutputBytes:MAX_COMMAND_OUTPUT})}catch{}const entries=archive.split(/\r?\n/).filter(Boolean),abis=[...new Set(entries.map(x=>x.match(/^lib\/([^/]+)\//)?.[1]).filter(Boolean))],signatureFiles=entries.filter(x=>/^META-INF\/.*\.(?:RSA|DSA|EC|SF)$/i.test(x)).slice(0,100);return{...f,...meta,abis,signatureFiles,archiveEntries:entries.length,manifestTree:trimLines(manifestTree,500),badging:trimLines(badging,500)}
  }
  case 'protocol_decode': return projection(decode(a.data,a.encoding))
  case 'protocol_encode': {const b=Buffer.from(text(a.text,'text'));if(a.encoding==='hex')return{value:b.toString('hex')};if(a.encoding==='base64')return{value:b.toString('base64')};if(a.encoding==='base64url')return{value:b.toString('base64url')};if(a.encoding==='url-component')return{value:encodeURIComponent(a.text)};throw new Error('bad encoding')}
  case 'protocol_hash': {const b=decode(a.data,a.inputEncoding||'utf8');return{algorithm:a.algorithm,digest:createHash(a.algorithm).update(b).digest('hex'),byteLength:b.length}}
  case 'protocol_parse_http': {const raw=text(a.message,'message'),parts=raw.split(/\r?\n\r?\n/,2),lines=parts[0].split(/\r?\n/),startLine=lines.shift()||'',headers={};for(const l of lines){const i=l.indexOf(':');if(i>0){const k=l.slice(0,i).trim().toLowerCase(),v=l.slice(i+1).trim();(headers[k]??=[]).push(v)}}const body=parts[1]||'';return{kind:/^HTTP\//i.test(startLine)?'response':'request',startLine,headers,bodyBytes:Buffer.byteLength(body),bodyPreview:body.slice(0,8192)}}
  case 'protocol_parse_url': {const u=new URL(text(a.url,'url'));return{href:u.href,protocol:u.protocol,host:u.host,hostname:u.hostname,port:u.port,pathname:u.pathname,query:Object.fromEntries([...u.searchParams.keys()].map(k=>[k,u.searchParams.getAll(k)])),hash:u.hash}}
  case 'binary_info': {const f=await checkedPath(a.path);const [kind,h,d]=await Promise.all([runStrict('file',['-b',f.path]),runStrict('readelf',['-h',f.path]).catch(e=>e.message),runStrict('readelf',['-d',f.path]).catch(e=>e.message)]);return{...f,file:kind,elfHeader:trimLines(h,120),dynamic:trimLines(d,200)}}
  case 'binary_sections': {const f=await checkedPath(a.path);return{...f,...trimLines(await runStrict('readelf',['-SW',f.path]),1200)}}
  case 'binary_symbols': {const f=await checkedPath(a.path);let o;try{o=await runStrict('nm',['-an',f.path])}catch{o=await runStrict('readelf',['-Ws',f.path])}return{...f,...trimLines(o,1600)}}
  case 'binary_strings': {const f=await checkedPath(a.path),n=int(a.minLength,4,3,64),m=int(a.maxLines,500,1,2000);return{...f,...trimLines(await runStrict('strings',['-a','-n',String(n),f.path]),m)}}
  case 'binary_disassemble': {const f=await checkedPath(a.path),argv=['-d'],s=addr(a.startAddress),e=addr(a.stopAddress);if(s)argv.push('--start-address='+s);if(e)argv.push('--stop-address='+e);argv.push(f.path);const m=int(a.maxLines,1200,1,4000);return{...f,...trimLines(await runStrict('objdump',argv),m)}}
  default: throw new Error('unknown tool: '+name)
 }
}

async function sdk(){const server=requireFromDsh.resolve('@modelcontextprotocol/sdk/server/index.js'),stdio=requireFromDsh.resolve('@modelcontextprotocol/sdk/server/stdio.js'),types=requireFromDsh.resolve('@modelcontextprotocol/sdk/types.js');const [{Server},{StdioServerTransport},t]=await Promise.all([import(pathToFileURL(server).href),import(pathToFileURL(stdio).href),import(pathToFileURL(types).href)]);return{Server,StdioServerTransport,ListToolsRequestSchema:t.ListToolsRequestSchema,CallToolRequestSchema:t.CallToolRequestSchema}}
async function selfTest(){
 await sdk()
 const names=new Set(tools.map(x=>x.name));for(const name of ['fs_read','fs_list','fs_search','fs_write','fs_patch','command_run','git_status','git_diff','git_log','http_request','android_logcat','apk_inspect'])if(!names.has(name))throw new Error('missing tool '+name)
 if((await call('protocol_decode',{data:'414243',encoding:'hex'})).utf8!=='ABC')throw new Error('decode self-test failed')
 for(const b of ['file','readelf','objdump','nm','strings','rg','git'])await runStrict(b,['--version'])
 await runStrict('openssl',['version'])
 await runStrict('aapt2',['version'])
 const root=await mkdtemp(resolve(process.env.TMPDIR||process.cwd(),'.dsh-mobile-tools-'))
 try{
  const sample=resolve(root,'sample.txt')
  await call('fs_write',{path:sample,content:'alpha\nbeta\n',overwrite:false})
  const read=await call('fs_read',{path:sample});if(!read.content.includes('beta'))throw new Error('fs_read self-test failed')
  await call('fs_patch',{path:sample,oldText:'beta',newText:'gamma'})
  const search=await call('fs_search',{path:root,query:'gamma'});if(search.matches.length!==1)throw new Error('fs_search self-test failed')
  const list=await call('fs_list',{path:root});if(!list.entries.some(x=>x.name==='sample.txt'))throw new Error('fs_list self-test failed')
  const cmd=await call('command_run',{command:'node',args:['--version']});if(cmd.exitCode!==0)throw new Error('command_run self-test failed')
 }finally{await rm(root,{recursive:true,force:true})}
 process.stdout.write('[DSH] Mobile MCP toolbox self-test: OK ('+tools.length+' tools)\n')
}
async function main(){if(process.argv.includes('--self-test'))return selfTest();const{Server,StdioServerTransport,ListToolsRequestSchema,CallToolRequestSchema}=await sdk();const server=new Server({name:'dsh-mobile-toolbox',version:'2.0.0'},{capabilities:{tools:{}}});server.setRequestHandler(ListToolsRequestSchema,async()=>({tools}));server.setRequestHandler(CallToolRequestSchema,async req=>{const value=await call(req.params.name,req.params.arguments||{});return{content:[{type:'text',text:JSON.stringify(value,null,2)}],structuredContent:value}});await server.connect(new StdioServerTransport())}
main().catch(e=>{process.stderr.write('[dsh-mobile-toolbox] '+(e?.stack||e?.message||String(e))+'\n');process.exitCode=1})
