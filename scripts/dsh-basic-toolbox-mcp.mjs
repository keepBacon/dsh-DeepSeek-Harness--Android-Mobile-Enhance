#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { connect as netConnect } from 'node:net'
import { createRequire } from 'node:module'
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chmod, copyFile, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'

const HERE=dirname(fileURLToPath(import.meta.url))
const PREFIX=process.env.TERMUX__PREFIX||process.env.PREFIX||resolve(HERE,'../..')
const requireFromDsh=createRequire(resolve(PREFIX,'lib/node_modules/@deepseek-ai/dsh/package.json'))
const MAX_OUTPUT=192*1024
const MAX_FILE=1024*1024*1024
const fileSchema={type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}

const tools=[
 {name:'file_info',description:'Inspect one file or directory.',inputSchema:fileSchema},
 {name:'file_hash',description:'Hash a regular file.',inputSchema:{type:'object',properties:{path:{type:'string'},algorithm:{type:'string',enum:['sha256','sha1','md5','sha512'],default:'sha256'}},required:['path'],additionalProperties:false}},
 {name:'file_copy',description:'Copy a regular file.',inputSchema:{type:'object',properties:{source:{type:'string'},destination:{type:'string'},overwrite:{type:'boolean',default:false}},required:['source','destination'],additionalProperties:false}},
 {name:'file_move',description:'Move a file or directory.',inputSchema:{type:'object',properties:{source:{type:'string'},destination:{type:'string'},overwrite:{type:'boolean',default:false}},required:['source','destination'],additionalProperties:false}},
 {name:'file_delete',description:'Delete a file or directory. Directories require recursive=true.',inputSchema:{type:'object',properties:{path:{type:'string'},recursive:{type:'boolean',default:false}},required:['path'],additionalProperties:false}},
 {name:'directory_tree',description:'Return a bounded directory tree without following symlinks.',inputSchema:{type:'object',properties:{path:{type:'string',default:'.'},maxDepth:{type:'integer',minimum:0,maximum:20,default:4},maxEntries:{type:'integer',minimum:1,maximum:20000,default:2000},showHidden:{type:'boolean',default:false}},additionalProperties:false}},
 {name:'directory_size',description:'Calculate regular-file bytes/count under a directory.',inputSchema:{type:'object',properties:{path:{type:'string',default:'.'},maxEntries:{type:'integer',minimum:1,maximum:200000,default:100000}},additionalProperties:false}},
 {name:'json_query',description:'Query JSON with jq.',inputSchema:{type:'object',properties:{path:{type:'string'},expression:{type:'string',default:'.'}},required:['path'],additionalProperties:false}},
 {name:'json_validate',description:'Validate JSON.',inputSchema:fileSchema},
 {name:'yaml_query',description:'Query YAML with yq.',inputSchema:{type:'object',properties:{path:{type:'string'},expression:{type:'string',default:'.'}},required:['path'],additionalProperties:false}},
 {name:'toml_query',description:'Read TOML and optional dot path.',inputSchema:{type:'object',properties:{path:{type:'string'},query:{type:'string',default:''}},required:['path'],additionalProperties:false}},
 {name:'xml_query',description:'Query XML with yq.',inputSchema:{type:'object',properties:{path:{type:'string'},expression:{type:'string',default:'.'}},required:['path'],additionalProperties:false}},
 {name:'csv_query',description:'Read bounded CSV rows.',inputSchema:{type:'object',properties:{path:{type:'string'},limit:{type:'integer',minimum:1,maximum:10000,default:200}},required:['path'],additionalProperties:false}},
 {name:'sqlite_query',description:'Execute a read-only SQLite query and return JSON rows.',inputSchema:{type:'object',properties:{path:{type:'string'},sql:{type:'string'}},required:['path','sql'],additionalProperties:false}},
 {name:'sqlite_schema',description:'Return SQLite schema objects.',inputSchema:fileSchema},
 {name:'text_diff',description:'Unified diff for two text files.',inputSchema:{type:'object',properties:{left:{type:'string'},right:{type:'string'}},required:['left','right'],additionalProperties:false}},
 {name:'text_replace',description:'Exact multi-file text replacement.',inputSchema:{type:'object',properties:{paths:{type:'array',items:{type:'string'},minItems:1,maxItems:100},oldText:{type:'string'},newText:{type:'string'},expectedOccurrences:{type:'integer',minimum:1,maximum:1000,default:1},dryRun:{type:'boolean',default:false}},required:['paths','oldText','newText'],additionalProperties:false}},
 {name:'regex_test',description:'Bounded JavaScript regexp test.',inputSchema:{type:'object',properties:{pattern:{type:'string'},flags:{type:'string',default:'g'},text:{type:'string'},maxMatches:{type:'integer',minimum:1,maximum:200,default:50}},required:['pattern','text'],additionalProperties:false}},
 {name:'env_info',description:'Return non-secret runtime metadata.',inputSchema:{type:'object',properties:{includePath:{type:'boolean',default:true}},additionalProperties:false}},
 {name:'disk_info',description:'Return filesystem capacity and usage.',inputSchema:{type:'object',properties:{path:{type:'string',default:'.'}},additionalProperties:false}},
 {name:'port_list',description:'List local listening sockets.',inputSchema:{type:'object',properties:{tcp:{type:'boolean',default:true},udp:{type:'boolean',default:true}},additionalProperties:false}},
 {name:'tcp_probe',description:'Probe one TCP host and port.',inputSchema:{type:'object',properties:{host:{type:'string'},port:{type:'integer',minimum:1,maximum:65535},timeoutMs:{type:'integer',minimum:100,maximum:15000,default:3000}},required:['host','port'],additionalProperties:false}},
 {name:'dns_lookup',description:'Resolve DNS records.',inputSchema:{type:'object',properties:{name:{type:'string'},type:{type:'string',enum:['A','AAAA','MX','TXT','CNAME'],default:'A'}},required:['name'],additionalProperties:false}},
 {name:'base_convert',description:'Convert utf8/hex/base64/base64url.',inputSchema:{type:'object',properties:{data:{type:'string'},from:{type:'string',enum:['utf8','hex','base64','base64url'],default:'utf8'},to:{type:'string',enum:['utf8','hex','base64','base64url'],default:'hex'}},required:['data'],additionalProperties:false}},
 {name:'encoding_detect',description:'Detect MIME and charset.',inputSchema:fileSchema},
 {name:'permissions_info',description:'Read POSIX mode/uid/gid.',inputSchema:fileSchema},
 {name:'symlink_info',description:'Inspect a symbolic link.',inputSchema:fileSchema},
 {name:'git_show',description:'Show a ref or path from Git.',inputSchema:{type:'object',properties:{repo:{type:'string',default:'.'},ref:{type:'string',default:'HEAD'},path:{type:'string'}},additionalProperties:false}},
 {name:'git_blame',description:'Run bounded git blame.',inputSchema:{type:'object',properties:{repo:{type:'string',default:'.'},path:{type:'string'}},required:['path'],additionalProperties:false}},
 {name:'git_branch',description:'List Git branches.',inputSchema:{type:'object',properties:{repo:{type:'string',default:'.'}},additionalProperties:false}},
 {name:'build_detect',description:'Detect common build systems.',inputSchema:{type:'object',properties:{path:{type:'string',default:'.'}},additionalProperties:false}},
 {name:'test_detect',description:'Detect common test runners.',inputSchema:{type:'object',properties:{path:{type:'string',default:'.'}},additionalProperties:false}},
 {name:'image_info',description:'Inspect image dimensions and format.',inputSchema:fileSchema},
 {name:'media_info',description:'Inspect audio/video streams.',inputSchema:fileSchema},
 {name:'pdf_info',description:'Inspect PDF metadata and page count.',inputSchema:fileSchema},
 {name:'archive_list',description:'List archive entries without extracting.',inputSchema:{type:'object',properties:{path:{type:'string'},maxEntries:{type:'integer',minimum:1,maximum:10000,default:1000}},required:['path'],additionalProperties:false}},
 {name:'checksum_manifest',description:'Generate a SHA-256 manifest for a directory tree.',inputSchema:{type:'object',properties:{path:{type:'string',default:'.'},maxEntries:{type:'integer',minimum:1,maximum:100000,default:20000}},additionalProperties:false}}
]

function text(v,n='input'){if(typeof v!=='string'||v.includes('\0'))throw new Error(n+' must be a valid string');return v}
function int(v,d,min,max){return Number.isInteger(v)?Math.max(min,Math.min(max,v)):d}
function bool(v,d=false){return typeof v==='boolean'?v:d}
function userPath(p='.'){return resolve(process.cwd(),text(p,'path'))}
async function checkedPath(p){const path=await realpath(userPath(p)),s=await stat(path);if(!s.isFile())throw new Error('not a regular file');if(s.size>MAX_FILE)throw new Error('file exceeds 1 GiB');return{path,stat:s,size:s.size}}
async function checkedDir(p='.'){const path=await realpath(userPath(p)),s=await stat(path);if(!s.isDirectory())throw new Error('not a directory');return{path}}
async function exists(p){try{await lstat(p);return true}catch(e){if(e?.code==='ENOENT')return false;throw e}}
function trim(s,n=1200){const a=String(s).split(/\r?\n/);return{output:a.slice(0,n).join('\n').slice(0,MAX_OUTPUT),truncated:a.length>n,totalLines:a.length}}
async function run(cmd,args=[],opts={}){return await new Promise(done=>{let out='',err='',finished=false;const child=spawn(cmd,args,{cwd:opts.cwd||process.cwd(),env:process.env,shell:false});const cap=MAX_OUTPUT;child.stdout?.on('data',b=>{if(out.length<cap)out=(out+b.toString()).slice(0,cap)});child.stderr?.on('data',b=>{if(err.length<cap)err=(err+b.toString()).slice(0,cap)});const timer=setTimeout(()=>{try{child.kill('SIGKILL')}catch{}},opts.timeout||30000);child.on('close',code=>{clearTimeout(timer);if(!finished){finished=true;done({exitCode:code,stdout:out,stderr:err})}});child.on('error',e=>{clearTimeout(timer);if(!finished){finished=true;done({exitCode:null,stdout:out,stderr:String(e)})}})})}
async function strict(cmd,args=[],opts={}){const r=await run(cmd,args,opts);if(r.exitCode!==0)throw new Error(cmd+' failed: '+(r.stderr||r.stdout));return r.stdout}
async function sha(path,alg='sha256'){const o=await strict('openssl',['dgst','-'+alg,path]);const m=o.match(/=\s*([0-9a-fA-F]+)\s*$/);if(!m)throw new Error('digest parse failed');return m[1].toLowerCase()}
function decode(data,enc='utf8'){if(enc==='utf8')return Buffer.from(data);if(enc==='base64url')return Buffer.from(data,'base64url');return Buffer.from(data,enc)}
async function tree(root,maxDepth,maxEntries,showHidden,sizeOnly=false){const rows=[];let bytes=0,files=0,dirs=0;async function walk(d,depth){if(depth>maxDepth)return;for(const e of await readdir(d,{withFileTypes:true})){if(!showHidden&&e.name.startsWith('.'))continue;if((sizeOnly?files+dirs:rows.length)>=maxEntries)return;const p=resolve(d,e.name),s=await lstat(p),type=s.isSymbolicLink()?'symlink':s.isDirectory()?'directory':s.isFile()?'file':'other';if(type==='file'){bytes+=s.size;files++}else if(type==='directory')dirs++;if(!sizeOnly)rows.push({path:relative(root,p),type,size:type==='file'?s.size:0});if(type==='directory')await walk(p,depth+1)}}await walk(root,0);return{rows,bytes,files,dirs}}

async function call(name,a={}){
 switch(name){
  case 'file_info':{const p=userPath(a.path),s=await lstat(p);return{path:p,type:s.isSymbolicLink()?'symlink':s.isDirectory()?'directory':s.isFile()?'file':'other',size:s.size,mode:'0'+(s.mode&0o7777).toString(8),uid:s.uid,gid:s.gid,mtime:s.mtime.toISOString(),realpath:await realpath(p).catch(()=>null),target:s.isSymbolicLink()?await readlink(p):null}}
  case 'file_hash':{const f=await checkedPath(a.path);return{path:f.path,algorithm:a.algorithm||'sha256',digest:await sha(f.path,a.algorithm||'sha256')}}
  case 'file_copy':{const s=await checkedPath(a.source),d=userPath(a.destination);if(await exists(d)&&!bool(a.overwrite,false))throw new Error('destination exists');await mkdir(dirname(d),{recursive:true});await copyFile(s.path,d);await chmod(d,s.stat.mode&0o777);return{source:s.path,destination:d}}
  case 'file_move':{const s=userPath(a.source),d=userPath(a.destination);if((await lstat(s)).isSymbolicLink())throw new Error('refusing symlink source');if(await exists(d)){if(!bool(a.overwrite,false))throw new Error('destination exists');await rm(d,{recursive:true,force:true})}await mkdir(dirname(d),{recursive:true});await rename(s,d);return{source:s,destination:d}}
  case 'file_delete':{const p=userPath(a.path),rp=await realpath(p).catch(()=>p),cwd=await realpath(process.cwd()),s=await lstat(p);if(rp==='/'||rp===cwd)throw new Error('refusing root/current directory');if(s.isDirectory()&&!bool(a.recursive,false))throw new Error('recursive=true required');await rm(p,{recursive:bool(a.recursive,false)});return{deleted:true,path:p}}
  case 'directory_tree':{const d=(await checkedDir(a.path||'.')).path;return{path:d,...await tree(d,int(a.maxDepth,4,0,20),int(a.maxEntries,2000,1,20000),bool(a.showHidden,false))}}
  case 'directory_size':{const d=(await checkedDir(a.path||'.')).path,x=await tree(d,1000,int(a.maxEntries,100000,1,200000),true,true);return{path:d,totalBytes:x.bytes,totalFiles:x.files,totalDirectories:x.dirs}}
  case 'json_validate':{const f=await checkedPath(a.path);try{JSON.parse(await readFile(f.path,'utf8'));return{path:f.path,valid:true}}catch(e){return{path:f.path,valid:false,error:String(e.message||e)}}}
  case 'json_query':{const f=await checkedPath(a.path);return{path:f.path,output:(await strict('jq',['-c',a.expression||'.',f.path])).trim()}}
  case 'yaml_query':{const f=await checkedPath(a.path);return{path:f.path,output:(await strict('yq',['-o=json',a.expression||'.',f.path])).trim()}}
  case 'xml_query':{const f=await checkedPath(a.path);return{path:f.path,output:(await strict('yq',['-p=xml','-o=json',a.expression||'.',f.path])).trim()}}
  case 'toml_query':{const f=await checkedPath(a.path),q=a.query||'',s="import json,sys,tomllib\nd=tomllib.load(open(sys.argv[1],'rb'))\nfor p in filter(None,sys.argv[2].split('.')):d=d[p] if isinstance(d,dict) else d[int(p)]\nprint(json.dumps(d,ensure_ascii=False,default=str))";return{path:f.path,value:JSON.parse(await strict('python3',['-c',s,f.path,q]))}}
  case 'csv_query':{const f=await checkedPath(a.path),s="import csv,json,sys\nwith open(sys.argv[1],encoding='utf-8-sig',newline='') as h:r=csv.DictReader(h);print(json.dumps([x for _,x in zip(range(int(sys.argv[2])),r)],ensure_ascii=False))";return{path:f.path,rows:JSON.parse(await strict('python3',['-c',s,f.path,String(int(a.limit,200,1,10000))]))}}
  case 'sqlite_query':{const f=await checkedPath(a.path),o=await strict('sqlite3',['-readonly','-json',f.path,text(a.sql,'sql')]);return{path:f.path,rows:o.trim()?JSON.parse(o):[]}}
  case 'sqlite_schema':{const f=await checkedPath(a.path),o=await strict('sqlite3',['-readonly','-json',f.path,"SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name;"]);return{path:f.path,objects:o.trim()?JSON.parse(o):[]}}
  case 'text_diff':{const l=await checkedPath(a.left),r=await checkedPath(a.right),x=await run('git',['diff','--no-index','--no-color','--',l.path,r.path]);if(x.exitCode!==0&&x.exitCode!==1)throw new Error(x.stderr);return{different:x.exitCode===1,...trim(x.stdout)}}
  case 'text_replace':{const paths=a.paths||[],old=text(a.oldText),neu=text(a.newText),expected=int(a.expectedOccurrences,1,1,1000),dry=bool(a.dryRun,false),result=[];for(const p of paths){const f=await checkedPath(p),src=await readFile(f.path,'utf8'),count=src.split(old).length-1;if(count!==expected)throw new Error(f.path+': expected '+expected+', found '+count);if(!dry)await writeFile(f.path,src.split(old).join(neu));result.push({path:f.path,occurrences:count})}return{dryRun:dry,files:result}}
  case 'regex_test':{const p=text(a.pattern),flags=a.flags||'g',input=text(a.text),max=int(a.maxMatches,50,1,200),s="const[p,f,b,m]=process.argv.slice(1);let z=f.includes('g')?f:f+'g',r=new RegExp(p,z),t=Buffer.from(b,'base64').toString(),o=[],x;while((x=r.exec(t))&&o.length<+m){o.push({match:x[0],index:x.index,groups:x.slice(1)});if(!x[0])r.lastIndex++}console.log(JSON.stringify(o))";return{matches:JSON.parse(await strict('node',['-e',s,p,flags,Buffer.from(input).toString('base64'),String(max)],{timeout:2000}))}}
  case 'env_info':return{cwd:process.cwd(),platform:process.platform,arch:process.arch,node:process.version,pid:process.pid,env:{HOME:process.env.HOME||null,TMPDIR:process.env.TMPDIR||null,PREFIX:process.env.PREFIX||null,PATH:bool(a.includePath,true)?process.env.PATH:null}}
  case 'disk_info':{const p=await realpath(userPath(a.path||'.')),o=await strict('df',['-Pk',p]),c=o.trim().split(/\r?\n/).at(-1).trim().split(/\s+/);return{path:p,totalKiB:+c[1],usedKiB:+c[2],availableKiB:+c[3],usePercent:c[4],mount:c.slice(5).join(' ')}}
  case 'port_list':return trim(await strict('ss',['-H','-l','-n','-t','-u']),1000)
  case 'tcp_probe':{const host=text(a.host),port=int(a.port,0,1,65535),start=Date.now();return await new Promise(done=>{let finished=false;const s=netConnect({host,port});const finish=(ok,error=null)=>{if(finished)return;finished=true;s.destroy();done({host,port,ok,latencyMs:Date.now()-start,error})};s.setTimeout(int(a.timeoutMs,3000,100,15000),()=>finish(false,'timeout'));s.once('connect',()=>finish(true));s.once('error',e=>finish(false,e.code||e.message))})}
  case 'dns_lookup':return{name:a.name,type:a.type||'A',answers:(await strict('dig',['+short',text(a.name),a.type||'A'])).split(/\r?\n/).filter(Boolean)}
  case 'base_convert':{const b=decode(text(a.data),a.from||'utf8'),to=a.to||'hex';return{value:to==='utf8'?b.toString():b.toString(to)}}
  case 'encoding_detect':{const f=await checkedPath(a.path);return{path:f.path,mime:(await strict('file',['-b','--mime',f.path])).trim()}}
  case 'permissions_info':{const p=userPath(a.path),s=await lstat(p);return{path:p,mode:'0'+(s.mode&0o7777).toString(8),uid:s.uid,gid:s.gid}}
  case 'symlink_info':{const p=userPath(a.path),s=await lstat(p);return s.isSymbolicLink()?{path:p,isSymlink:true,target:await readlink(p),realpath:await realpath(p).catch(()=>null)}:{path:p,isSymlink:false}}
  case 'git_show':{const repo=(await checkedDir(a.repo||'.')).path,args=['-C',repo,'show','--no-color'];if(a.path)args.push((a.ref||'HEAD')+':'+a.path);else args.push('--stat',a.ref||'HEAD');return{repo,...trim(await strict('git',args),2000)}}
  case 'git_blame':{const repo=(await checkedDir(a.repo||'.')).path;return{repo,...trim(await strict('git',['-C',repo,'blame','--date=iso-strict','--',text(a.path)]),2000)}}
  case 'git_branch':{const repo=(await checkedDir(a.repo||'.')).path,o=await strict('git',['-C',repo,'branch','--format=%(HEAD)%09%(refname:short)%09%(objectname:short)%09%(upstream:short)']);return{repo,branches:o.split(/\r?\n/).filter(Boolean)}}
  case 'build_detect':{const root=(await checkedDir(a.path||'.')).path,has=async p=>await exists(resolve(root,p)),systems=[];if(await has('gradlew')||await has('build.gradle')||await has('build.gradle.kts'))systems.push({type:'gradle'});if(await has('package.json'))systems.push({type:'node',manager:await has('pnpm-lock.yaml')?'pnpm':'npm'});if(await has('CMakeLists.txt'))systems.push({type:'cmake'});if(await has('Cargo.toml'))systems.push({type:'cargo'});if(await has('pom.xml'))systems.push({type:'maven'});return{path:root,systems}}
  case 'test_detect':{const root=(await checkedDir(a.path||'.')).path,has=async p=>await exists(resolve(root,p)),tests=[];if(await has('gradlew'))tests.push('gradle:test');if(await has('package.json'))tests.push('node:test');if(await has('Cargo.toml'))tests.push('cargo:test');if(await has('pytest.ini')||await has('pyproject.toml'))tests.push('pytest');return{path:root,tests}}
  case 'image_info':{const f=await checkedPath(a.path),o=await strict('identify',['-format','%m\n%w\n%h\n%z\n%[colorspace]\n',f.path]),v=o.split(/\r?\n/);return{path:f.path,format:v[0],width:+v[1],height:+v[2],depth:+v[3],colorspace:v[4]}}
  case 'media_info':{const f=await checkedPath(a.path);return{path:f.path,info:JSON.parse(await strict('ffprobe',['-v','error','-show_format','-show_streams','-of','json',f.path],{timeout:30000}))}}
  case 'pdf_info':{const f=await checkedPath(a.path);return{path:f.path,...trim(await strict('pdfinfo',[f.path]),200)}}
  case 'archive_list':{const f=await checkedPath(a.path);return{path:f.path,...trim(await strict('7z',['l','-ba',f.path]),int(a.maxEntries,1000,1,10000))}}
  case 'checksum_manifest':{const root=(await checkedDir(a.path||'.')).path,limit=int(a.maxEntries,20000,1,100000),rows=[];async function walk(d){for(const e of await readdir(d,{withFileTypes:true})){if(rows.length>=limit)return;const p=resolve(d,e.name),s=await lstat(p);if(s.isSymbolicLink())continue;if(s.isDirectory())await walk(p);else if(s.isFile())rows.push({path:relative(root,p),sha256:await sha(p),size:s.size})}}await walk(root);return{path:root,files:rows,truncated:rows.length>=limit}}
  default:throw new Error('unknown tool: '+name)
 }
}

async function sdk(){const server=requireFromDsh.resolve('@modelcontextprotocol/sdk/server/index.js'),stdio=requireFromDsh.resolve('@modelcontextprotocol/sdk/server/stdio.js'),types=requireFromDsh.resolve('@modelcontextprotocol/sdk/types.js');const[{Server},{StdioServerTransport},t]=await Promise.all([import(pathToFileURL(server).href),import(pathToFileURL(stdio).href),import(pathToFileURL(types).href)]);return{Server,StdioServerTransport,ListToolsRequestSchema:t.ListToolsRequestSchema,CallToolRequestSchema:t.CallToolRequestSchema}}
async function selfTest(){await sdk();process.stdout.write('[DSH] Basic MCP toolbox self-test: OK ('+tools.length+' tools)\n')}
async function main(){if(process.argv.includes('--self-test'))return selfTest();const{Server,StdioServerTransport,ListToolsRequestSchema,CallToolRequestSchema}=await sdk();const server=new Server({name:'dsh-basic-toolbox',version:'1.0.0'},{capabilities:{tools:{}}});server.setRequestHandler(ListToolsRequestSchema,async()=>({tools}));server.setRequestHandler(CallToolRequestSchema,async req=>{const value=await call(req.params.name,req.params.arguments||{});return{content:[{type:'text',text:JSON.stringify(value,null,2)}],structuredContent:value}});await server.connect(new StdioServerTransport())}
main().catch(e=>{process.stderr.write('[dsh-basic-toolbox] '+(e?.stack||e?.message||String(e))+'\n');process.exitCode=1})
