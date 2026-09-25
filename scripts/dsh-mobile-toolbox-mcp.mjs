#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm, stat, writeFile,
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

 {name:'no_root_capabilities',description:'Report capabilities that work without Root/Shizuku, including self/same-UID proc access, child tracing and optional ADB Wireless Debugging client availability.',inputSchema:{type:'object',properties:{probeAdb:{type:'boolean',default:false}},additionalProperties:false}},
 {name:'self_runtime_snapshot',description:'Capture a no-root snapshot of the MCP process: threads, modules, file descriptors and socket inodes. Does not require ptrace.',inputSchema:{type:'object',properties:{maxEntries:{type:'integer',minimum:1,maximum:5000,default:1000}},additionalProperties:false}},
 {name:'runtime_snapshot',description:'Capture a bounded snapshot for a PID only when normal Android /proc permissions allow it. Stores the snapshot in-memory for runtime_diff.',inputSchema:{type:'object',properties:{pid:{type:'integer',minimum:1},maxEntries:{type:'integer',minimum:1,maximum:5000,default:1000}},required:['pid'],additionalProperties:false}},
 {name:'runtime_diff',description:'Compare two previously captured runtime_snapshot/self_runtime_snapshot IDs for module/thread/fd/socket changes.',inputSchema:{type:'object',properties:{before:{type:'string'},after:{type:'string'}},required:['before','after'],additionalProperties:false}},
 {name:'process_fds',description:'List accessible /proc/<pid>/fd entries without following outside the kernel-provided fd symlink target. Works for self/same-UID when Android permits.',inputSchema:{type:'object',properties:{pid:{type:'integer',minimum:1},maxEntries:{type:'integer',minimum:1,maximum:5000,default:1000}},required:['pid'],additionalProperties:false}},
 {name:'process_network',description:'Correlate accessible process socket FDs with /proc/<pid>/net TCP/UDP tables. Best-effort and no-root.',inputSchema:{type:'object',properties:{pid:{type:'integer',minimum:1},maxEntries:{type:'integer',minimum:1,maximum:5000,default:1000}},required:['pid'],additionalProperties:false}},
 {name:'child_strace',description:'Launch a child command under strace for bounded no-root dynamic analysis. Only traces the new child process tree started by this tool.',inputSchema:{type:'object',properties:{command:{type:'string'},args:{type:'array',items:{type:'string'},maxItems:128,default:[]},cwd:{type:'string'},durationMs:{type:'integer',minimum:100,maximum:30000,default:5000},categories:{type:'array',items:{type:'string',enum:['file','network','memory','process','signal','ipc']},maxItems:6},maxLines:{type:'integer',minimum:1,maximum:4000,default:1200}},required:['command'],additionalProperties:false}},
 {name:'adb_devices',description:'List devices reachable through the bundled ADB client. No Root required; Wireless Debugging must be enabled/authorized by the user.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
 {name:'adb_pair',description:'Pair the bundled ADB client with an Android Wireless Debugging pairing endpoint using a user-provided one-time pairing code.',inputSchema:{type:'object',properties:{endpoint:{type:'string'},code:{type:'string'}},required:['endpoint','code'],additionalProperties:false}},
 {name:'adb_connect',description:'Connect the bundled ADB client to a previously paired Wireless Debugging endpoint.',inputSchema:{type:'object',properties:{endpoint:{type:'string'}},required:['endpoint'],additionalProperties:false}},
 {name:'adb_package_info',description:'Read package/PID/APK/data/ABI/debuggable information through an authorized ADB shell.',inputSchema:{type:'object',properties:{package:{type:'string'},serial:{type:'string'}},required:['package'],additionalProperties:false}},
 {name:'adb_process_info',description:'Inspect process list through an authorized ADB shell, filtered by package/name or exact PID.',inputSchema:{type:'object',properties:{serial:{type:'string'},package:{type:'string'},pid:{type:'integer',minimum:1},maxLines:{type:'integer',minimum:1,maximum:2000,default:500}},additionalProperties:false}},
 {name:'adb_logcat',description:'Read bounded logcat through an authorized ADB connection, optionally filtered by package PID.',inputSchema:{type:'object',properties:{serial:{type:'string'},package:{type:'string'},maxLines:{type:'integer',minimum:1,maximum:4000,default:1000}},additionalProperties:false}},
 {name:'adb_jdwp_list',description:'List JDWP-debuggable process IDs exposed by an authorized ADB daemon.',inputSchema:{type:'object',properties:{serial:{type:'string'}},additionalProperties:false}},
 {name:'adb_pull_apk',description:'Pull installed APK split/base paths for a package through authorized ADB into a local destination directory.',inputSchema:{type:'object',properties:{package:{type:'string'},destination:{type:'string'},serial:{type:'string'},overwrite:{type:'boolean',default:false}},required:['package','destination'],additionalProperties:false}},
 {name:'reverse_capabilities',description:'Report which local Android reverse/debug backends are actually available: proc visibility, root status, Frida, GDB/gdbserver, strace, Rizin, debuggerd and binutils. Optionally probes Frida connectivity.',inputSchema:{type:'object',properties:{probeFrida:{type:'boolean',default:false}},additionalProperties:false}},
 {name:'package_process_info',description:'Resolve an Android package to visible PID(s), UID, APK paths, data directory, ABI and debuggable flag using pidof/cmd/dumpsys. Read-only.',inputSchema:{type:'object',properties:{package:{type:'string'}},required:['package'],additionalProperties:false}},
 {name:'native_backtrace',description:'Request a bounded native backtrace through Android debuggerd for an authorized/debuggable PID. Returns permission errors explicitly.',inputSchema:{type:'object',properties:{pid:{type:'integer',minimum:1},maxLines:{type:'integer',minimum:1,maximum:4000,default:1200}},required:['pid'],additionalProperties:false}},
 {name:'frida_detach',description:'Detach and close a managed persistent Frida session previously created with frida_attach/frida_spawn persistent=true.',inputSchema:{type:'object',properties:{sessionId:{type:'string'}},required:['sessionId'],additionalProperties:false}},
 {name:'symbol_resolve',description:'Resolve a runtime address to its mapped module, load bias, RVA and best-effort addr2line/nearest-symbol information.',inputSchema:{type:'object',properties:{pid:{type:'integer',minimum:1},address:{type:'string'}},required:['pid','address'],additionalProperties:false}},
 {name:'address_rebase',description:'Convert module base + RVA to runtime VA, or runtime VA - module base to RVA using exact 64-bit integer arithmetic.',inputSchema:{type:'object',properties:{base:{type:'string'},rva:{type:'string'},runtimeAddress:{type:'string'}},required:['base'],additionalProperties:false}},
 {name:'il2cpp_metadata_info',description:'Inspect a global-metadata.dat header: magic, metadata version, string table and raw section offset/size pairs with bounds checks.',inputSchema:{type:'object',properties:{metadata:{type:'string'}},required:['metadata'],additionalProperties:false}},
 {name:'il2cpp_find_class',description:'Locate exact IL2CPP class/namespace names inside the validated metadata string table. Returns metadata offsets without inventing type-definition RVAs.',inputSchema:{type:'object',properties:{metadata:{type:'string'},name:{type:'string'},namespace:{type:'string'},maxResults:{type:'integer',minimum:1,maximum:256,default:64}},required:['metadata','name'],additionalProperties:false}},
 {name:'process_list',description:'List Android/Linux processes visible to this app UID. Returns PID/PPID/UID/name/cmdline; inaccessible processes are skipped.',inputSchema:{type:'object',properties:{nameFilter:{type:'string'},maxResults:{type:'integer',minimum:1,maximum:2000,default:300}},additionalProperties:false}},
 {name:'process_info',description:'Inspect one visible process through /proc: status, cmdline, executable, cwd and basic identity. Access follows Android kernel permissions.',inputSchema:{type:'object',properties:{pid:{type:'integer',minimum:1}},required:['pid'],additionalProperties:false}},
 {name:'process_maps',description:'Parse /proc/<pid>/maps into structured mappings with addresses, permissions, offsets and paths.',inputSchema:{type:'object',properties:{pid:{type:'integer',minimum:1},pathContains:{type:'string'},executableOnly:{type:'boolean',default:false}},required:['pid'],additionalProperties:false}},
 {name:'process_threads',description:'List visible threads for a process with TID/name/state.',inputSchema:{type:'object',properties:{pid:{type:'integer',minimum:1},maxResults:{type:'integer',minimum:1,maximum:5000,default:1000}},required:['pid'],additionalProperties:false}},
 {name:'module_list',description:'Aggregate process mappings into loaded file-backed modules and stable base/end ranges.',inputSchema:{type:'object',properties:{pid:{type:'integer',minimum:1},pathContains:{type:'string'}},required:['pid'],additionalProperties:false}},
 {name:'memory_regions',description:'Alias of process_maps focused on readable/writable/executable region analysis.',inputSchema:{type:'object',properties:{pid:{type:'integer',minimum:1},pathContains:{type:'string'}},required:['pid'],additionalProperties:false}},
 {name:'memory_read',description:'Read bytes from /proc/<pid>/mem at an explicit address when Android ptrace/proc permissions allow it. Read-only.',inputSchema:{type:'object',properties:{pid:{type:'integer',minimum:1},address:{type:'string'},length:{type:'integer',minimum:1,maximum:1048576,default:256}},required:['pid','address'],additionalProperties:false}},
 {name:'memory_search',description:'Search readable process mappings for UTF-8 text or an exact hex byte pattern. Read-only and bounded by maxBytes.',inputSchema:{type:'object',properties:{pid:{type:'integer',minimum:1},text:{type:'string'},hex:{type:'string'},pathContains:{type:'string'},maxBytes:{type:'integer',minimum:4096,maximum:134217728,default:67108864},maxMatches:{type:'integer',minimum:1,maximum:128,default:32}},required:['pid'],additionalProperties:false}},
 {name:'syscall_trace',description:'Trace system calls of an authorized/debuggable process with strace for a bounded duration. Categories: file/network/memory/process/signal/ipc.',inputSchema:{type:'object',properties:{pid:{type:'integer',minimum:1},durationMs:{type:'integer',minimum:100,maximum:15000,default:3000},categories:{type:'array',items:{type:'string',enum:['file','network','memory','process','signal','ipc']},maxItems:6},maxLines:{type:'integer',minimum:1,maximum:4000,default:1000}},required:['pid'],additionalProperties:false}},
 {name:'frida_processes',description:'List processes/apps through the bundled Frida client. Requires a reachable Frida backend for targets outside this app sandbox.',inputSchema:{type:'object',properties:{device:{type:'string',enum:['local','usb','remote'],default:'local'},host:{type:'string'},appsOnly:{type:'boolean',default:false}},additionalProperties:false}},
 {name:'frida_attach',description:'Attach Frida to a PID. By default this is a one-shot verification; persistent=true creates a managed session that remains attached until frida_detach.',inputSchema:{type:'object',properties:{pid:{type:'integer',minimum:1},device:{type:'string',enum:['local','usb','remote'],default:'local'},host:{type:'string'},timeoutMs:{type:'integer',minimum:500,maximum:30000,default:5000},persistent:{type:'boolean',default:false}},required:['pid'],additionalProperties:false}},
 {name:'frida_spawn',description:'Spawn an authorized package through Frida and optionally run a supplied script. persistent=true creates a managed session closable with frida_detach.',inputSchema:{type:'object',properties:{package:{type:'string'},script:{type:'string'},device:{type:'string',enum:['local','usb','remote'],default:'local'},host:{type:'string'},timeoutMs:{type:'integer',minimum:500,maximum:30000,default:8000},persistent:{type:'boolean',default:false}},required:['package'],additionalProperties:false}},
 {name:'frida_script',description:'Run a bounded Frida JavaScript snippet against a PID, process name, or spawned package.',inputSchema:{type:'object',properties:{pid:{type:'integer',minimum:1},name:{type:'string'},package:{type:'string'},script:{type:'string'},device:{type:'string',enum:['local','usb','remote'],default:'local'},host:{type:'string'},timeoutMs:{type:'integer',minimum:500,maximum:30000,default:8000}},required:['script'],additionalProperties:false}},
 {name:'frida_trace',description:'Run frida-trace for a bounded time against a PID and include pattern; partial trace output is returned when the duration ends.',inputSchema:{type:'object',properties:{pid:{type:'integer',minimum:1},include:{type:'string'},device:{type:'string',enum:['local','usb','remote'],default:'local'},host:{type:'string'},durationMs:{type:'integer',minimum:500,maximum:15000,default:5000},maxLines:{type:'integer',minimum:1,maximum:4000,default:1200}},required:['pid','include'],additionalProperties:false}},
 {name:'debug_session_start',description:'Start a persistent GDB/MI session and optionally attach to a PID. Use only on processes Android permits this app to debug.',inputSchema:{type:'object',properties:{pid:{type:'integer',minimum:1}},additionalProperties:false}},
 {name:'debug_attach',description:'Attach an existing GDB/MI session to a PID.',inputSchema:{type:'object',properties:{sessionId:{type:'string'},pid:{type:'integer',minimum:1}},required:['sessionId','pid'],additionalProperties:false}},
 {name:'debug_breakpoint_set',description:'Set a GDB breakpoint by absolute address or symbol in a persistent debug session.',inputSchema:{type:'object',properties:{sessionId:{type:'string'},address:{type:'string'},symbol:{type:'string'},temporary:{type:'boolean',default:false}},required:['sessionId'],additionalProperties:false}},
 {name:'debug_continue',description:'Continue a GDB debug session and wait briefly for a stop event; returns running=true when no stop arrives inside waitMs.',inputSchema:{type:'object',properties:{sessionId:{type:'string'},waitMs:{type:'integer',minimum:0,maximum:15000,default:1500}},required:['sessionId'],additionalProperties:false}},
 {name:'debug_registers',description:'Read raw register values from the current GDB frame.',inputSchema:{type:'object',properties:{sessionId:{type:'string'}},required:['sessionId'],additionalProperties:false}},
 {name:'debug_backtrace',description:'Read a bounded GDB stack backtrace from the current stopped thread.',inputSchema:{type:'object',properties:{sessionId:{type:'string'},maxFrames:{type:'integer',minimum:1,maximum:256,default:64}},required:['sessionId'],additionalProperties:false}},
 {name:'debug_memory_read',description:'Read memory through the active GDB session at an explicit address. Read-only.',inputSchema:{type:'object',properties:{sessionId:{type:'string'},address:{type:'string'},length:{type:'integer',minimum:1,maximum:1048576,default:256}},required:['sessionId','address'],additionalProperties:false}},
 {name:'debug_session_close',description:'Detach and close a persistent GDB/MI session.',inputSchema:{type:'object',properties:{sessionId:{type:'string'}},required:['sessionId'],additionalProperties:false}},
 {name:'binary_functions',description:'Analyze a local binary with Rizin and return discovered functions (address/name/size metadata).',inputSchema:{type:'object',properties:{path:{type:'string'},filter:{type:'string'},maxResults:{type:'integer',minimum:1,maximum:5000,default:1000}},required:['path'],additionalProperties:false}},
 {name:'binary_xrefs',description:'Find Rizin cross-references to an address/symbol, or to strings containing a query.',inputSchema:{type:'object',properties:{path:{type:'string'},address:{type:'string'},symbol:{type:'string'},string:{type:'string'},maxResults:{type:'integer',minimum:1,maximum:1000,default:200}},required:['path'],additionalProperties:false}},
 {name:'jni_map_java_native',description:'Map exported JNI-style symbols and report JNI_OnLoad/RegisterNatives indicators in an ELF shared library.',inputSchema:{type:'object',properties:{path:{type:'string'},maxResults:{type:'integer',minimum:1,maximum:5000,default:1000}},required:['path'],additionalProperties:false}},
 {name:'il2cpp_detect',description:'Detect common Unity IL2CPP artifacts in an APK or supplied libil2cpp/global-metadata paths and report metadata header/version.',inputSchema:{type:'object',properties:{apk:{type:'string'},lib:{type:'string'},metadata:{type:'string'}},additionalProperties:false}},
 {name:'il2cpp_find_method',description:'Best-effort IL2CPP method-name locator: finds exact metadata string offsets and exported/native symbol candidates. It does not invent an RVA when stripped metadata cannot prove one.',inputSchema:{type:'object',properties:{metadata:{type:'string'},lib:{type:'string'},method:{type:'string'},class:{type:'string'},namespace:{type:'string'},maxResults:{type:'integer',minimum:1,maximum:256,default:64}},required:['metadata','method'],additionalProperties:false}},
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


function pidValue(v){if(!Number.isInteger(v)||v<1)throw new Error('pid must be a positive integer');return v}
function procFile(pid,leaf=''){return '/proc/'+pidValue(pid)+(leaf?'/'+leaf:'')}
async function optionalRead(path,encoding='utf8'){try{return await readFile(path,encoding)}catch{return null}}
async function optionalReadlink(path){try{return await readlink(path)}catch{return null}}
function parseProcStatus(raw){const out={};for(const line of String(raw||'').split(/\r?\n/)){const i=line.indexOf(':');if(i>0)out[line.slice(0,i)]=line.slice(i+1).trim()}return out}
function parseProcMaps(raw){const out=[];for(const line of String(raw).split(/\r?\n/)){if(!line)continue;const m=line.match(/^([0-9a-fA-F]+)-([0-9a-fA-F]+)\s+(\S+)\s+([0-9a-fA-F]+)\s+(\S+)\s+(\d+)\s*(.*)$/);if(!m)continue;const start=parseInt(m[1],16),end=parseInt(m[2],16);out.push({start:'0x'+m[1].toLowerCase(),end:'0x'+m[2].toLowerCase(),size:end-start,permissions:m[3],offset:'0x'+m[4].toLowerCase(),device:m[5],inode:Number(m[6]),path:m[7]||''})}return out}
async function mapsFor(pid){const raw=await readFile(procFile(pid,'maps'),'utf8');return parseProcMaps(raw)}
async function existsPathForTool(path){try{const s=await stat(path);return s.isFile()}catch{return false}}
function addressNumber(value){const normalized=addr(value);const n=Number(BigInt(normalized));if(!Number.isSafeInteger(n))throw new Error('address exceeds safe integer range');return n}
function toolDirect(name){return resolve(PREFIX,'bin',name)}
function toolWrapped(name){return resolve(PREFIX,'libexec/dsh/wrappers',name)}
function fridaDeviceArgs(a){const device=a.device||'local';if(device==='usb')return['-U'];if(device==='remote'){const host=text(a.host,'host',1024);return['-H',host]}if(a.host)return['-H',text(a.host,'host',1024)];return[]}
function fridaTargetArgs(a,{spawn=false}={}){if(spawn){return['-f',text(a.package,'package',1024)]}if(Number.isInteger(a.pid))return['-p',String(pidValue(a.pid))];if(a.name!=null)return['-n',text(a.name,'name',1024)];if(a.package!=null)return['-f',text(a.package,'package',1024)];throw new Error('provide pid, name, or package')}
function decodeJniName(symbol){let s=symbol.replace(/^Java_/,'');const sig=s.indexOf('__');if(sig>=0)s=s.slice(0,sig);s=s.replace(/_0([0-9a-fA-F]{4})/g,(_,h)=>String.fromCharCode(parseInt(h,16))).replace(/_1/g,'_').replace(/_2/g,';').replace(/_3/g,'[').replace(/_/g,'.');return s}
function bufferPattern(a){const hasText=typeof a.text==='string',hasHex=typeof a.hex==='string';if(hasText===hasHex)throw new Error('provide exactly one of text or hex');if(hasText){const b=Buffer.from(text(a.text,'text',65536));if(!b.length)throw new Error('text pattern is empty');return{buffer:b,kind:'text',value:a.text}}const h=text(a.hex,'hex',131072).replace(/\s+/g,'');if(!/^(?:[0-9a-fA-F]{2})+$/.test(h))throw new Error('hex must contain complete bytes');return{buffer:Buffer.from(h,'hex'),kind:'hex',value:h.toLowerCase()}}
function findBufferOffsets(haystack,needle,base,maxMatches){const out=[];let pos=0;while(out.length<maxMatches){const i=haystack.indexOf(needle,pos);if(i<0)break;out.push('0x'+(BigInt(base)+BigInt(i)).toString(16));pos=i+Math.max(1,needle.length)}return out}
async function rizinJson(path,command,timeoutMs=20000){const r=await runProcess(toolWrapped('rizin'),['-2','-q','-c',command,path],{timeoutMs,maxOutputBytes:MAX_COMMAND_OUTPUT});if(r.exitCode!==0)throw new Error('rizin failed: '+(r.stderr||r.stdout).slice(0,MAX_OUTPUT));const raw=r.stdout.trim();try{return JSON.parse(raw)}catch{const start=Math.min(...['[','{'].map(ch=>{const i=raw.indexOf(ch);return i<0?Number.MAX_SAFE_INTEGER:i}));if(Number.isSafeInteger(start)){try{return JSON.parse(raw.slice(start))}catch{}}return{raw:raw.slice(0,MAX_COMMAND_OUTPUT),stderr:r.stderr.trim()}}}

function hexBig(value,name='address'){
 const v=text(value,name,128)
 if(!/^(?:0x)?[0-9a-fA-F]+$/.test(v))throw new Error(name+' must be a hexadecimal integer')
 return BigInt('0x'+v.replace(/^0x/i,''))
}
function hexValue(value){return '0x'+BigInt(value).toString(16)}
async function executableAvailable(path){try{const s=await stat(path);return s.isFile()&&(s.mode&0o111)!==0}catch{return false}}
function metadataHeader(data,fileSize){
 if(data.length<8)throw new Error('metadata header is shorter than 8 bytes')
 const magic=data.readUInt32LE(0),version=data.readInt32LE(4)
 const names=['stringLiteral','stringLiteralData','string','events','properties','methods','parameterDefaultValues','fieldDefaultValues','fieldAndParameterDefaultValueData','fieldMarshaledSizes','parameters','fields','genericParameters','genericParameterConstraints','genericContainers','nestedTypes','interfaces','vtableMethods','interfaceOffsets','typeDefinitions','rgctxEntries','images','assemblies','metadataUsageLists','metadataUsagePairs','fieldRefs','referencedAssemblies','attributesInfo','attributeTypes','unresolvedVirtualCallParameterTypes','unresolvedVirtualCallParameterRanges','windowsRuntimeTypeNames','windowsRuntimeStrings','exportedTypeDefinitions']
 const sections=[]
 for(let i=0;i<names.length;i++){const pos=8+i*8;if(pos+8>data.length)break;const offset=data.readUInt32LE(pos),rawSize=data.readUInt32LE(pos+4);sections.push({name:names[i],offset:'0x'+offset.toString(16),rawSizeOrCount:rawSize,inFile:offset<=fileSize&&rawSize<=fileSize&&offset+rawSize<=fileSize})}
 return{magic:'0x'+magic.toString(16),magicOk:magic===0xfab11baf,version,sections}
}


const RUNTIME_SNAPSHOTS=new Map()
let SNAPSHOT_SEQ=0
function snapshotGet(id){const s=RUNTIME_SNAPSHOTS.get(text(id,'snapshotId',128));if(!s)throw new Error('unknown runtime snapshot');return s}
function trimSnapshotStore(){while(RUNTIME_SNAPSHOTS.size>32){const first=RUNTIME_SNAPSHOTS.keys().next().value;RUNTIME_SNAPSHOTS.delete(first)}}
async function procFds(pid,maxEntries=1000){
 const dir=procFile(pid,'fd'),entries=await readdir(dir,{withFileTypes:true}),fds=[]
 for(const e of entries){if(fds.length>=maxEntries)break;if(!/^\d+$/.test(e.name))continue;let target=null;try{target=await readlink(resolve(dir,e.name))}catch{continue};const socket=target.match(/^socket:\[(\d+)\]$/);fds.push({fd:Number(e.name),target,socketInode:socket?socket[1]:null})}
 fds.sort((a,b)=>a.fd-b.fd);return fds
}
function decodeIpv4Hex(hex){if(!/^[0-9A-Fa-f]{8}$/.test(hex))return null;const b=[];for(let i=0;i<8;i+=2)b.push(parseInt(hex.slice(i,i+2),16));return b.reverse().join('.')}
function parseNetEndpoint(raw,family){const i=raw.lastIndexOf(':');if(i<0)return{raw};const addressHex=raw.slice(0,i),portHex=raw.slice(i+1),port=parseInt(portHex,16);if(family==='ipv4')return{raw,address:decodeIpv4Hex(addressHex),port};return{raw,addressHex:addressHex.toLowerCase(),port}}
async function procNetRows(pid,maxEntries=5000){
 const specs=[['tcp','ipv4'],['tcp6','ipv6'],['udp','ipv4'],['udp6','ipv6']],rows=[]
 for(const [proto,family] of specs){const raw=await optionalRead(procFile(pid,'net/'+proto));if(raw==null)continue;for(const line of raw.split(/\r?\n/).slice(1)){if(rows.length>=maxEntries)break;const cols=line.trim().split(/\s+/);if(cols.length<10)continue;rows.push({protocol:proto,family,local:parseNetEndpoint(cols[1],family),remote:parseNetEndpoint(cols[2],family),state:cols[3],uid:Number(cols[7]||0),inode:cols[9]||null})}}
 return rows
}
async function procNetwork(pid,maxEntries=1000){
 const fds=await procFds(pid,maxEntries),wanted=new Set(fds.map(x=>x.socketInode).filter(Boolean)),rows=await procNetRows(pid,Math.max(maxEntries*4,1000)),socketFds=new Map()
 for(const fd of fds){if(fd.socketInode){const list=socketFds.get(fd.socketInode)||[];list.push(fd.fd);socketFds.set(fd.socketInode,list)}}
 return rows.filter(x=>x.inode&&wanted.has(x.inode)).slice(0,maxEntries).map(x=>({...x,fds:socketFds.get(x.inode)||[]}))
}
async function captureRuntimeSnapshot(pid,maxEntries=1000){
 const status=parseProcStatus(await readFile(procFile(pid,'status'),'utf8')),maps=await mapsFor(pid),task=await readdir(procFile(pid,'task'),{withFileTypes:true}),threads=[]
 for(const e of task){if(threads.length>=maxEntries)break;if(!/^\d+$/.test(e.name))continue;const raw=await optionalRead(procFile(pid,'task/'+e.name+'/status'));if(raw==null)continue;const s=parseProcStatus(raw);threads.push({tid:Number(e.name),name:s.Name||'',state:s.State||''})}
 const fds=await procFds(pid,maxEntries),network=await procNetwork(pid,maxEntries),groups=new Map()
 for(const m of maps){if(!m.path||m.path.startsWith('['))continue;const g=groups.get(m.path)||{path:m.path,base:m.start,end:m.end};if(hexBig(m.start)<hexBig(g.base))g.base=m.start;if(hexBig(m.end)>hexBig(g.end))g.end=m.end;groups.set(m.path,g)}
 const id='snap-'+Date.now().toString(36)+'-'+(++SNAPSHOT_SEQ).toString(36),snapshot={id,timestamp:new Date().toISOString(),pid,name:status.Name||'',uid:Number((status.Uid||'0').split(/\s+/)[0]),modules:[...groups.values()],threads,fds,network}
 RUNTIME_SNAPSHOTS.set(id,snapshot);trimSnapshotStore();return snapshot
}
function diffByKey(before,after,keyFn){const a=new Map(before.map(x=>[keyFn(x),x])),b=new Map(after.map(x=>[keyFn(x),x]));return{added:[...b].filter(([k])=>!a.has(k)).map(([,v])=>v),removed:[...a].filter(([k])=>!b.has(k)).map(([,v])=>v)}}
function adbEndpoint(v){const s=text(v,'endpoint',1024);if(!s||s.startsWith('-')||/\s/.test(s)||!/:\d{1,5}$/.test(s))throw new Error('endpoint must be host:port without whitespace');return s}
function adbPackage(v){const s=text(v,'package',512);if(!/^[A-Za-z][A-Za-z0-9_.]*$/.test(s))throw new Error('invalid Android package name');return s}
function adbPrefix(serial){const args=[];if(serial!=null)args.push('-s',text(serial,'serial',1024));return args}
async function adbRun(args,{serial,timeoutMs=15000,maxOutputBytes=MAX_COMMAND_OUTPUT}={}){
 const argv=[...adbPrefix(serial),...args],r=await runProcess(toolWrapped('adb'),argv,{timeoutMs,maxOutputBytes});if(r.exitCode!==0)throw new Error('adb failed: '+(r.stderr||r.stdout).slice(0,MAX_OUTPUT));return r
}

const FRIDA_SESSIONS=new Map()
let FRIDA_SEQ=0
function fridaSession(id){const s=FRIDA_SESSIONS.get(text(id,'sessionId',128));if(!s||s.closed)throw new Error('unknown or closed Frida session');return s}
async function startManagedFrida(a,targetArgs,userScript=''){
 const id='frida-'+Date.now().toString(36)+'-'+(++FRIDA_SEQ).toString(36)
 const tmpRoot=await mkdtemp(resolve(process.env.TMPDIR||process.cwd(),'.dsh-frida-session-'))
 const scriptPath=resolve(tmpRoot,'agent.js')
 const source="console.log('__DSH_READY__'+JSON.stringify({pid:Process.id,arch:Process.arch,platform:Process.platform}));\n"+userScript+"\nsetInterval(function(){},1000);\n"
 await writeFile(scriptPath,source,{mode:0o600})
 const args=[...fridaDeviceArgs(a),...targetArgs,'-q','-l',scriptPath]
 const child=spawn(toolWrapped('frida'),args,{env:process.env,cwd:process.cwd(),shell:false,stdio:['pipe','pipe','pipe']})
 const session={id,child,tmpRoot,closed:false,lines:[],ready:null,pid:null,target:targetArgs.join(' ')}
 FRIDA_SESSIONS.set(id,session)
 const feed=chunk=>{for(const line of chunk.toString('utf8').split(/\r?\n/)){if(!line)continue;session.lines.push(line);if(session.lines.length>1000)session.lines.splice(0,session.lines.length-1000);const at=line.indexOf('__DSH_READY__');if(at>=0){try{session.ready=JSON.parse(line.slice(at+'__DSH_READY__'.length));session.pid=session.ready.pid}catch{}}}}
 child.stdout.on('data',feed);child.stderr.on('data',feed)
 child.on('close',()=>{session.closed=true;FRIDA_SESSIONS.delete(id);rm(tmpRoot,{recursive:true,force:true}).catch(()=>{})})
 const timeout=int(a.timeoutMs,5000,500,30000),started=Date.now()
 while(!session.ready&&!session.closed&&Date.now()-started<timeout)await new Promise(r=>setTimeout(r,50))
 if(!session.ready){const recent=session.lines.slice(-40).join('\n');await closeFrida(session);throw new Error('Frida persistent attach did not become ready: '+recent.slice(0,MAX_OUTPUT))}
 return session
}
async function closeFrida(session){
 if(session.closed)return
 try{session.child.stdin.end()}catch{}
 try{session.child.kill('SIGINT')}catch{}
 await new Promise(r=>setTimeout(r,150))
 if(!session.closed){try{session.child.kill('SIGKILL')}catch{}}
 session.closed=true
 FRIDA_SESSIONS.delete(session.id)
 await rm(session.tmpRoot,{recursive:true,force:true}).catch(()=>{})
}

const DEBUG_SESSIONS=new Map()
let DEBUG_SEQ=0
function debugSession(id){const s=DEBUG_SESSIONS.get(text(id,'sessionId',128));if(!s||s.closed)throw new Error('unknown or closed debug session');return s}
function debugLine(session,line){session.lines.push(line);if(session.lines.length>2000)session.lines.splice(0,session.lines.length-2000);for(const pending of session.pending.values())pending.lines.push(line);for(const waiter of [...session.stopWaiters]){if(line.startsWith('*stopped')){session.stopWaiters.delete(waiter);clearTimeout(waiter.timer);waiter.resolve(line)}}for(const [token,pending] of session.pending){if(line.startsWith(token+'^')){session.pending.delete(token);clearTimeout(pending.timer);if(line.startsWith(token+'^error'))pending.reject(new Error('gdb: '+line));else pending.resolve({result:line,lines:pending.lines.slice(-200)})}}}
async function startDebugSession(){const id='gdb-'+Date.now().toString(36)+'-'+(++DEBUG_SEQ).toString(36),bin=toolDirect('gdb'),args=['--interpreter=mi2','-q','-nx','--data-directory='+resolve(PREFIX,'share/gdb')],child=spawn(bin,args,{env:process.env,cwd:process.cwd(),shell:false,stdio:['pipe','pipe','pipe']});const session={id,child,closed:false,buffer:'',lines:[],pending:new Map(),stopWaiters:new Set(),token:0,attachedPid:null};DEBUG_SESSIONS.set(id,session);const feed=chunk=>{session.buffer+=chunk.toString('utf8');while(true){const i=session.buffer.indexOf('\n');if(i<0)break;const line=session.buffer.slice(0,i).replace(/\r$/,'');session.buffer=session.buffer.slice(i+1);if(line)debugLine(session,line)}};child.stdout.on('data',feed);child.stderr.on('data',chunk=>feed(Buffer.from('&stderr:'+chunk.toString('utf8'))));child.on('close',()=>{session.closed=true;for(const p of session.pending.values()){clearTimeout(p.timer);p.reject(new Error('gdb session exited'))}session.pending.clear();for(const w of session.stopWaiters){clearTimeout(w.timer);w.reject(new Error('gdb session exited'))}session.stopWaiters.clear()});await miCommand(session,'-gdb-set pagination off',5000);return session}
function miCommand(session,command,timeoutMs=5000){if(session.closed)throw new Error('debug session is closed');const token=String(++session.token);return new Promise((resolvePromise,reject)=>{const pending={lines:[],resolve:resolvePromise,reject,timer:null};pending.timer=setTimeout(()=>{session.pending.delete(token);reject(new Error('gdb command timed out: '+command))},timeoutMs);session.pending.set(token,pending);session.child.stdin.write(token+command+'\n')})}
function waitDebugStop(session,timeoutMs){for(let i=session.lines.length-1;i>=0&&i>=session.lines.length-20;i--){if(session.lines[i].startsWith('*stopped'))return Promise.resolve(session.lines[i])}return new Promise((resolvePromise,reject)=>{const waiter={resolve:resolvePromise,reject,timer:null};waiter.timer=setTimeout(()=>{session.stopWaiters.delete(waiter);resolvePromise(null)},timeoutMs);session.stopWaiters.add(waiter)})}
async function closeDebug(session){if(session.closed)return;try{if(session.attachedPid)await miCommand(session,'-target-detach',3000)}catch{}try{await miCommand(session,'-gdb-exit',3000)}catch{}try{session.child.kill('SIGKILL')}catch{}session.closed=true;DEBUG_SESSIONS.delete(session.id)}

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
   const method=(a.method||'GET').toUpperCase(),u=new URL(text(a.url,'url',16384));if(u.protocol!=='http:'&&u.protocol!=='https:')throw new Error('only http/https URLs are supported');const headers={};if(a.headers!=null){if(typeof a.headers!=='object'||Array.isArray(a.headers))throw new Error('headers must be an object');for(const [k,v] of Object.entries(a.headers))headers[text(k,'header name',1024)]=text(v,'header '+k,65536)}if(!Object.keys(headers).some(k=>k.toLowerCase()==='user-agent'))headers['User-Agent']='DSH-Mobile-Tools/3.0';const timeoutMs=int(a.timeoutMs,15000,100,60000),maxBytes=int(a.maxResponseBytes,1048576,1,MAX_HTTP_CAPTURE),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);let response;const chunks=[];let captured=0,truncated=false;try{response=await fetch(u,{method,headers,body:a.body!=null&&method!=='GET'&&method!=='HEAD'?text(a.body,'body',MAX_TEXT):undefined,redirect:bool(a.followRedirects,true)?'follow':'manual',signal:controller.signal});if(response.body&&method!=='HEAD'){const reader=response.body.getReader();while(true){const {done,value}=await reader.read();if(done)break;const b=Buffer.from(value),room=maxBytes-captured;if(room>0){chunks.push(b.subarray(0,room));captured+=Math.min(room,b.length)}if(b.length>room){truncated=true;await reader.cancel().catch(()=>{});break}}}}finally{clearTimeout(timer)}const body=Buffer.concat(chunks),contentType=response.headers.get('content-type')||'',isText=/^(text\/|application\/(?:json|xml|javascript|x-www-form-urlencoded)|[^;]+\+(?:json|xml))/i.test(contentType);return{url:response.url,status:response.status,statusText:response.statusText,redirected:response.redirected,headers:Object.fromEntries(response.headers.entries()),capturedBytes:body.length,truncated,contentType,bodyText:isText?body.toString('utf8'):undefined,bodyBase64:isText?undefined:body.toString('base64')}
  }
  case 'android_logcat': {
   const level=a.level||'V',limit=int(a.maxLines,400,1,2000),scan=Math.min(8000,Math.max(limit*4,limit)),args=['-d','-v','epoch','-t',String(scan)];let pid=null;if(a.package!=null){const pkg=text(a.package,'package',512),p=await runProcess('/system/bin/pidof',[pkg],{timeoutMs:3000,maxOutputBytes:8192});pid=p.stdout.trim().split(/\s+/).filter(Boolean)[0]||null;if(!pid)return{package:pkg,pid:null,lines:[],message:'package is not running'};args.push('--pid='+pid)}if(a.tag!=null)args.push(text(a.tag,'tag',512)+':'+level,'*:S');else args.push('*:'+level);const r=await runProcess('/system/bin/logcat',args,{timeoutMs:8000,maxOutputBytes:MAX_COMMAND_OUTPUT});if(r.exitCode!==0)throw new Error('logcat failed: '+(r.stderr||r.stdout).slice(0,MAX_OUTPUT));let lines=r.stdout.split(/\r?\n/).filter(Boolean);if(a.sinceSeconds!=null){const cutoff=Date.now()/1000-int(a.sinceSeconds,1,1,86400);lines=lines.filter(line=>{const epoch=logcatEpoch(line);return epoch===null||epoch>=cutoff})}if(lines.length>limit)lines=lines.slice(lines.length-limit);return{package:a.package||null,pid,tag:a.tag||null,level,lines,truncated:r.truncated||lines.length>=limit}
  }
  case 'apk_inspect': {
   const f=await checkedPath(a.path),badging=await runStrict('aapt2',['dump','badging',f.path],{timeoutMs:15000,maxOutputBytes:MAX_COMMAND_OUTPUT}),meta=parseBadging(badging);let manifestTree='';try{manifestTree=await runStrict('aapt2',['dump','xmltree',f.path,'--file','AndroidManifest.xml'],{timeoutMs:15000,maxOutputBytes:MAX_COMMAND_OUTPUT})}catch(error){manifestTree='[xmltree unavailable] '+error.message}let archive='';try{archive=await runStrict('unzip',['-Z1',f.path],{timeoutMs:10000,maxOutputBytes:MAX_COMMAND_OUTPUT})}catch{}const entries=archive.split(/\r?\n/).filter(Boolean),abis=[...new Set(entries.map(x=>x.match(/^lib\/([^/]+)\//)?.[1]).filter(Boolean))],signatureFiles=entries.filter(x=>/^META-INF\/.*\.(?:RSA|DSA|EC|SF)$/i.test(x)).slice(0,100);return{...f,...meta,abis,signatureFiles,archiveEntries:entries.length,manifestTree:trimLines(manifestTree,500),badging:trimLines(badging,500)}
  }


  case 'no_root_capabilities': {
   let selfMaps=false,selfFd=false,selfNet=false;try{await readFile('/proc/self/maps','utf8');selfMaps=true}catch{};try{await readdir('/proc/self/fd');selfFd=true}catch{};try{await readFile('/proc/self/net/tcp','utf8');selfNet=true}catch{}
   const adbPath=toolWrapped('adb'),adbAvailable=await executableAvailable(adbPath);let adbProbe=null;if(bool(a.probeAdb,false)&&adbAvailable){const q=await runProcess(adbPath,['devices','-l'],{timeoutMs:5000,maxOutputBytes:65536});adbProbe={ok:q.exitCode===0,output:q.stdout.trim(),stderr:q.stderr.trim()||undefined}}
   return{mode:'no-root-first',uid:typeof process.getuid==='function'?process.getuid():null,root:typeof process.getuid==='function'?process.getuid()===0:false,direct:{selfProcMaps:selfMaps,selfFd,selfNetworkTables:selfNet,childStrace:await executableAvailable(toolDirect('strace'))},wirelessAdb:{clientAvailable:adbAvailable,probe:adbProbe,requiresUserAction:'Enable Android Developer options > Wireless debugging, pair this app client, then connect.'},restrictedWithoutAuthorization:['other-app /proc details','ptrace attach','other-app memory','debuggerd on non-debuggable targets','Frida attach without a reachable authorized backend']}
  }
  case 'self_runtime_snapshot': {
   const snap=await captureRuntimeSnapshot(process.pid,int(a.maxEntries,1000,1,5000));return{...snap,self:true}
  }
  case 'runtime_snapshot': {
   const snap=await captureRuntimeSnapshot(pidValue(a.pid),int(a.maxEntries,1000,1,5000));return snap
  }
  case 'runtime_diff': {
   const before=snapshotGet(a.before),after=snapshotGet(a.after);if(before.pid!==after.pid)throw new Error('snapshots belong to different PIDs')
   return{before:before.id,after:after.id,pid:before.pid,durationMs:Math.max(0,new Date(after.timestamp)-new Date(before.timestamp)),modules:diffByKey(before.modules,after.modules,x=>x.path+'@'+x.base),threads:diffByKey(before.threads,after.threads,x=>String(x.tid)),fds:diffByKey(before.fds,after.fds,x=>String(x.fd)+':'+x.target),network:diffByKey(before.network,after.network,x=>x.protocol+':'+x.inode+':'+x.local.raw+':'+x.remote.raw)}
  }
  case 'process_fds': {
   const pid=pidValue(a.pid),fds=await procFds(pid,int(a.maxEntries,1000,1,5000));return{pid,fds,count:fds.length}
  }
  case 'process_network': {
   const pid=pidValue(a.pid),connections=await procNetwork(pid,int(a.maxEntries,1000,1,5000));return{pid,connections,count:connections.length}
  }
  case 'child_strace': {
   const command=text(a.command,'command',4096),args=Array.isArray(a.args)?a.args:[],cwd=a.cwd?(await checkedDir(a.cwd)).path:process.cwd(),duration=int(a.durationMs,5000,100,30000),cats=Array.isArray(a.categories)&&a.categories.length?a.categories:['file','network','memory','process'],trace=cats.map(x=>'%'+x).join(','),argv=['-f','-tt','-T','-s','256','-e','trace='+trace,'--',command,...args],r=await runProcess(toolDirect('strace'),argv,{cwd,timeoutMs:duration,maxOutputBytes:MAX_COMMAND_OUTPUT});return{command,args,cwd,durationMs:duration,categories:cats,...trimLines((r.stderr||r.stdout),int(a.maxLines,1200,1,4000)),endedByTimeout:r.timedOut,exitCode:r.exitCode}
  }
  case 'adb_devices': {
   const r=await adbRun(['devices','-l'],{timeoutMs:8000,maxOutputBytes:65536}),devices=[];for(const line of r.stdout.split(/\r?\n/).slice(1)){if(!line.trim())continue;const parts=line.trim().split(/\s+/),serial=parts.shift(),state=parts.shift();devices.push({serial,state,details:parts})}return{devices}
  }
  case 'adb_pair': {
   const endpoint=adbEndpoint(a.endpoint),code=text(a.code,'code',64);if(!/^\d{6}$/.test(code))throw new Error('pairing code must be 6 digits');const r=await runProcess(toolWrapped('adb'),['pair',endpoint,code],{timeoutMs:15000,maxOutputBytes:65536});if(r.exitCode!==0)throw new Error('adb pair failed: '+(r.stderr||r.stdout).replace(code,'******').slice(0,MAX_OUTPUT));return{endpoint,paired:true,output:r.stdout.replace(code,'******').trim()}
  }
  case 'adb_connect': {
   const endpoint=adbEndpoint(a.endpoint),r=await adbRun(['connect',endpoint],{timeoutMs:12000,maxOutputBytes:65536});return{endpoint,connected:/connected to|already connected to/i.test(r.stdout+r.stderr),output:(r.stdout+r.stderr).trim()}
  }
  case 'adb_package_info': {
   const pkg=adbPackage(a.package),serial=a.serial,[paths,dump,pid]=await Promise.all([adbRun(['shell','pm','path',pkg],{serial,timeoutMs:8000,maxOutputBytes:65536}),adbRun(['shell','dumpsys','package',pkg],{serial,timeoutMs:12000,maxOutputBytes:MAX_COMMAND_OUTPUT}),adbRun(['shell','pidof',pkg],{serial,timeoutMs:5000,maxOutputBytes:65536}).catch(()=>({stdout:''}))]),raw=dump.stdout,flags=raw.match(/\bflags=\[([^\]]*)\]/)?.[1]||''
   return{package:pkg,serial:serial||null,pids:String(pid.stdout||'').trim().split(/\s+/).filter(x=>/^\d+$/.test(x)).map(Number),apkPaths:paths.stdout.split(/\r?\n/).map(x=>x.replace(/^package:/,'').trim()).filter(Boolean),uid:Number(raw.match(/\buserId=(\d+)/)?.[1]||0)||null,dataDir:raw.match(/\bdataDir=([^\s]+)/)?.[1]||null,primaryCpuAbi:raw.match(/\bprimaryCpuAbi=([^\s]+)/)?.[1]||null,debuggable:/\bDEBUGGABLE\b/.test(flags)}
  }
  case 'adb_process_info': {
   const serial=a.serial,probe=await adbRun(['shell','ps','-A','-o','USER,PID,PPID,NAME,ARGS'],{serial,timeoutMs:8000,maxOutputBytes:MAX_COMMAND_OUTPUT}).catch(async()=>await adbRun(['shell','ps','-A'],{serial,timeoutMs:8000,maxOutputBytes:MAX_COMMAND_OUTPUT})),needle=a.package!=null?adbPackage(a.package):null,pid=a.pid==null?null:pidValue(a.pid),limit=int(a.maxLines,500,1,2000),lines=probe.stdout.split(/\r?\n/),header=lines.shift()||'',matches=lines.filter(line=>(pid==null||new RegExp('(^|\\s)'+pid+'(\\s|$)').test(line))&&(needle==null||line.includes(needle))).slice(0,limit);return{serial:serial||null,header,lines:matches,truncated:matches.length>=limit}
  }
  case 'adb_logcat': {
   const serial=a.serial,limit=int(a.maxLines,1000,1,4000),args=['logcat','-d','-v','threadtime'];let pid=null;if(a.package!=null){const pkg=adbPackage(a.package),p=await adbRun(['shell','pidof',pkg],{serial,timeoutMs:5000,maxOutputBytes:65536});pid=p.stdout.trim().split(/\s+/).find(x=>/^\d+$/.test(x))||null;if(pid)args.push('--pid='+pid)}const r=await adbRun(args,{serial,timeoutMs:12000,maxOutputBytes:MAX_COMMAND_OUTPUT});return{serial:serial||null,pid,package:a.package||null,...trimLines(r.stdout,limit)}
  }
  case 'adb_jdwp_list': {
   const r=await adbRun(['jdwp'],{serial:a.serial,timeoutMs:8000,maxOutputBytes:65536});return{serial:a.serial||null,pids:r.stdout.split(/\r?\n/).filter(x=>/^\d+$/.test(x)).map(Number)}
  }
  case 'adb_pull_apk': {
   const pkg=adbPackage(a.package),serial=a.serial,dest=userPath(a.destination);await mkdir(dest,{recursive:true});const paths=await adbRun(['shell','pm','path',pkg],{serial,timeoutMs:8000,maxOutputBytes:65536}),remote=paths.stdout.split(/\r?\n/).map(x=>x.replace(/^package:/,'').trim()).filter(Boolean);if(!remote.length)throw new Error('package has no APK paths');const files=[]
   for(const source of remote){const target=resolve(dest,basename(source));if(await existsPathForTool(target)&&!bool(a.overwrite,false))throw new Error('destination exists: '+target);const r=await adbRun(['pull',source,target],{serial,timeoutMs:60000,maxOutputBytes:MAX_COMMAND_OUTPUT});files.push({source,target,output:r.stdout.trim()})}return{package:pkg,serial:serial||null,destination:dest,files}
  }

  case 'reverse_capabilities': {
   const bins={frida:toolWrapped('frida'),fridaPs:toolWrapped('frida-ps'),fridaTrace:toolWrapped('frida-trace'),fridaServer:toolWrapped('frida-server'),gdb:toolDirect('gdb'),gdbserver:toolDirect('gdbserver'),strace:toolDirect('strace'),rizin:toolWrapped('rizin'),addr2line:toolDirect('addr2line'),nm:toolDirect('nm'),debuggerd:'/system/bin/debuggerd'}
   const available={};for(const [k,p] of Object.entries(bins))available[k]=await executableAvailable(p)
   let procMaps=false,procMemRead=false;try{await readFile('/proc/self/maps','utf8');procMaps=true}catch{};try{const h=await open('/proc/self/mem','r');await h.close();procMemRead=true}catch{}
   let fridaProbe=null;if(bool(a.probeFrida,false)&&available.fridaPs){const q=await runProcess(bins.fridaPs,[],{timeoutMs:5000,maxOutputBytes:65536});fridaProbe={ok:q.exitCode===0,exitCode:q.exitCode,stderr:q.stderr.trim()||undefined}}
   return{uid:typeof process.getuid==='function'?process.getuid():null,root:typeof process.getuid==='function'?process.getuid()===0:false,proc:{maps:procMaps,selfMemRead:procMemRead},available,fridaProbe,shizuku:{status:'not-probed',reason:'Shizuku binder capability is not reliably inferable from a shell-only MCP process'},notes:['Other-process proc/memory/ptrace access still depends on Android SELinux, UID, debuggable state, root or an authorized debug backend.']}
  }
  case 'package_process_info': {
   const pkg=text(a.package,'package',512)
   const [pidof,pathResult,dump]=await Promise.all([
    runProcess('/system/bin/pidof',[pkg],{timeoutMs:3000,maxOutputBytes:65536}),
    runProcess('/system/bin/cmd',['package','path',pkg],{timeoutMs:5000,maxOutputBytes:65536}),
    runProcess('/system/bin/dumpsys',['package',pkg],{timeoutMs:8000,maxOutputBytes:MAX_COMMAND_OUTPUT})
   ])
   const pids=pidof.stdout.trim().split(/\s+/).filter(x=>/^\d+$/.test(x)).map(Number),apkPaths=pathResult.stdout.split(/\r?\n/).map(x=>x.replace(/^package:/,'').trim()).filter(Boolean)
   const raw=dump.stdout,uid=Number(raw.match(/\buserId=(\d+)/)?.[1]||0)||null,dataDir=raw.match(/\bdataDir=([^\s]+)/)?.[1]||null,primaryCpuAbi=raw.match(/\bprimaryCpuAbi=([^\s]+)/)?.[1]||null,flags=raw.match(/\bflags=\[([^\]]*)\]/)?.[1]||''
   return{package:pkg,running:pids.length>0,pids,uid,apkPaths,dataDir,primaryCpuAbi,debuggable:/\bDEBUGGABLE\b/.test(flags),packageManagerReadable:dump.exitCode===0}
  }
  case 'native_backtrace': {
   const pid=pidValue(a.pid),r=await runProcess('/system/bin/debuggerd',['-b',String(pid)],{timeoutMs:12000,maxOutputBytes:MAX_COMMAND_OUTPUT}),combined=(r.stdout+(r.stderr?'\n[stderr]\n'+r.stderr:'')).trim()
   return{pid,ok:r.exitCode===0,exitCode:r.exitCode,...trimLines(combined,int(a.maxLines,1200,1,4000))}
  }
  case 'symbol_resolve': {
   const pid=pidValue(a.pid),address=hexBig(a.address),maps=await mapsFor(pid),m=maps.find(x=>address>=hexBig(x.start)&&address<hexBig(x.end))
   if(!m)return{pid,address:hexValue(address),mapped:false}
   const start=hexBig(m.start),fileOffset=hexBig(m.offset),loadBias=start-fileOffset,rva=address-loadBias,path=m.path?.replace(/\s+\(deleted\)$/,'')||''
   let addr2line=null,nearestSymbol=null
   if(path&&path.startsWith('/')&&await existsPathForTool(path)){const a2=await runProcess(toolDirect('addr2line'),['-f','-C','-e',path,hexValue(rva)],{timeoutMs:8000,maxOutputBytes:65536});if(a2.exitCode===0)addr2line=a2.stdout.trim();const nm=await runProcess(toolDirect('nm'),['-an',path],{timeoutMs:10000,maxOutputBytes:MAX_COMMAND_OUTPUT});if(nm.exitCode===0){let best=null;for(const line of nm.stdout.split(/\r?\n/)){const q=line.trim().match(/^([0-9a-fA-F]+)\s+\w\s+(.+)$/);if(!q)continue;const sa=BigInt('0x'+q[1]);if(sa<=rva&&(!best||sa>best.address))best={address:sa,symbol:q[2]}}if(best)nearestSymbol={symbol:best.symbol,address:hexValue(best.address),offset:hexValue(rva-best.address)}}}
   return{pid,address:hexValue(address),mapped:true,module:path||null,mapping:m,loadBias:hexValue(loadBias),rva:hexValue(rva),addr2line,nearestSymbol}
  }
  case 'address_rebase': {
   const base=hexBig(a.base,'base'),hasRva=a.rva!=null,hasRuntime=a.runtimeAddress!=null;if(hasRva===hasRuntime)throw new Error('provide exactly one of rva or runtimeAddress')
   if(hasRva){const rva=hexBig(a.rva,'rva');return{base:hexValue(base),rva:hexValue(rva),runtimeAddress:hexValue(base+rva)}}
   const runtimeAddress=hexBig(a.runtimeAddress,'runtimeAddress');if(runtimeAddress<base)throw new Error('runtimeAddress is below base');return{base:hexValue(base),runtimeAddress:hexValue(runtimeAddress),rva:hexValue(runtimeAddress-base)}
  }
  case 'il2cpp_metadata_info': {
   const meta=await checkedPath(a.metadata),h=await open(meta.path,'r');try{const size=Math.min(meta.size,512),b=Buffer.alloc(size),rr=await h.read(b,0,size,0),header=metadataHeader(b.subarray(0,rr.bytesRead),meta.size);const stringSection=header.sections.find(x=>x.name==='string')||null;return{metadata:meta.path,size:meta.size,...header,stringSection}}finally{await h.close()}
  }
  case 'il2cpp_find_class': {
   const meta=await checkedPath(a.metadata);if(meta.size>256*1024*1024)throw new Error('metadata exceeds 256 MiB search limit');const data=await readFile(meta.path),header=metadataHeader(data.subarray(0,Math.min(512,data.length)),data.length);if(!header.magicOk)throw new Error('not a valid IL2CPP metadata file');const stringSection=header.sections.find(x=>x.name==='string');if(!stringSection||!stringSection.inFile)throw new Error('metadata string table is unavailable or out of bounds');const start=Number(BigInt(stringSection.offset)),size=stringSection.rawSizeOrCount,end=start+size,table=data.subarray(start,end),name=text(a.name,'name',4096),namespace=a.namespace==null?null:text(a.namespace,'namespace',4096),max=int(a.maxResults,64,1,256)
   const findExact=value=>{const needle=Buffer.from(value+'\0'),out=[];let pos=0;while(out.length<max){const i=table.indexOf(needle,pos);if(i<0)break;out.push({stringTableOffset:'0x'+i.toString(16),metadataOffset:'0x'+(start+i).toString(16)});pos=i+needle.length}return out}
   return{metadata:meta.path,version:header.version,name,namespace,classNameOffsets:findExact(name),namespaceOffsets:namespace?findExact(namespace):[],confidence:'validated-string-table-only',note:'Type-definition record mapping is version-dependent; this tool does not invent a class index or RVA.'}
  }
  case 'process_list': {
   const limit=int(a.maxResults,300,1,2000),filter=a.nameFilter==null?null:text(a.nameFilter,'nameFilter',1024).toLowerCase(),entries=await readdir('/proc',{withFileTypes:true}),out=[]
   for(const e of entries){if(!e.isDirectory()||!/^[0-9]+$/.test(e.name))continue;const pid=Number(e.name),statusRaw=await optionalRead(procFile(pid,'status'));if(statusRaw==null)continue;const status=parseProcStatus(statusRaw),cmdRaw=await optionalRead(procFile(pid,'cmdline'),null).catch(()=>null);let cmdline='';if(Buffer.isBuffer(cmdRaw))cmdline=cmdRaw.toString('utf8').replace(/\0+/g,' ').trim();const item={pid,ppid:Number(status.PPid||0),uid:Number((status.Uid||'0').split(/\s+/)[0]),name:status.Name||'',state:status.State||'',cmdline};if(filter&&!((item.name+' '+item.cmdline).toLowerCase().includes(filter)))continue;out.push(item);if(out.length>=limit)break}out.sort((x,y)=>x.pid-y.pid);return{processes:out,truncated:out.length>=limit}
  }
  case 'process_info': {
   const pid=pidValue(a.pid),statusRaw=await readFile(procFile(pid,'status'),'utf8'),status=parseProcStatus(statusRaw),cmdRaw=await optionalRead(procFile(pid,'cmdline'),null);return{pid,name:status.Name||'',state:status.State||'',ppid:Number(status.PPid||0),uid:Number((status.Uid||'0').split(/\s+/)[0]),gid:Number((status.Gid||'0').split(/\s+/)[0]),threads:Number(status.Threads||0),vmRss:status.VmRSS||null,vmSize:status.VmSize||null,cmdline:Buffer.isBuffer(cmdRaw)?cmdRaw.toString('utf8').replace(/\0+/g,' ').trim():'',exe:await optionalReadlink(procFile(pid,'exe')),cwd:await optionalReadlink(procFile(pid,'cwd'))}
  }
  case 'process_maps': {
   const pid=pidValue(a.pid),needle=a.pathContains==null?null:text(a.pathContains,'pathContains',4096),execOnly=bool(a.executableOnly,false);let maps=await mapsFor(pid);if(needle)maps=maps.filter(x=>x.path.includes(needle));if(execOnly)maps=maps.filter(x=>x.permissions.includes('x'));return{pid,mappings:maps,count:maps.length}
  }
  case 'process_threads': {
   const pid=pidValue(a.pid),limit=int(a.maxResults,1000,1,5000),dirs=await readdir(procFile(pid,'task'),{withFileTypes:true}),threads=[];for(const e of dirs){if(!e.isDirectory()||!/^[0-9]+$/.test(e.name))continue;const tid=Number(e.name),raw=await optionalRead(procFile(pid,'task/'+tid+'/status'));if(raw==null)continue;const s=parseProcStatus(raw);threads.push({tid,name:s.Name||'',state:s.State||''});if(threads.length>=limit)break}threads.sort((x,y)=>x.tid-y.tid);return{pid,threads,truncated:threads.length>=limit}
  }
  case 'module_list': {
   const pid=pidValue(a.pid),needle=a.pathContains==null?null:text(a.pathContains,'pathContains',4096),maps=await mapsFor(pid),groups=new Map();for(const m of maps){if(!m.path||m.path.startsWith('['))continue;if(needle&&!m.path.includes(needle))continue;const g=groups.get(m.path)||{path:m.path,base:m.start,end:m.end,segments:[],executable:false};g.segments.push(m);if(parseInt(m.start,16)<parseInt(g.base,16))g.base=m.start;if(parseInt(m.end,16)>parseInt(g.end,16))g.end=m.end;if(m.permissions.includes('x'))g.executable=true;groups.set(m.path,g)}const modules=[...groups.values()].map(g=>({...g,size:parseInt(g.end,16)-parseInt(g.base,16)})).sort((x,y)=>parseInt(x.base,16)-parseInt(y.base,16));return{pid,modules,count:modules.length}
  }
  case 'memory_regions': {
   const pid=pidValue(a.pid),needle=a.pathContains==null?null:text(a.pathContains,'pathContains',4096);let maps=await mapsFor(pid);if(needle)maps=maps.filter(x=>x.path.includes(needle));return{pid,regions:maps,count:maps.length}
  }
  case 'memory_read': {
   const pid=pidValue(a.pid),address=addressNumber(a.address),length=int(a.length,256,1,1048576),handle=await open(procFile(pid,'mem'),'r');try{const buffer=Buffer.alloc(length),r=await handle.read(buffer,0,length,address),data=buffer.subarray(0,r.bytesRead);return{pid,address:'0x'+address.toString(16),bytesRead:r.bytesRead,hex:data.toString('hex'),base64:data.toString('base64'),utf8:data.toString('utf8')}}finally{await handle.close()}
  }
  case 'memory_search': {
   const pid=pidValue(a.pid),pattern=bufferPattern(a),maxBytes=int(a.maxBytes,67108864,4096,134217728),maxMatches=int(a.maxMatches,32,1,128),needlePath=a.pathContains==null?null:text(a.pathContains,'pathContains',4096),maps=(await mapsFor(pid)).filter(m=>m.permissions.startsWith('r')&&(!needlePath||m.path.includes(needlePath))),handle=await open(procFile(pid,'mem'),'r'),matches=[];let scanned=0,skipped=0
   try{for(const m of maps){if(matches.length>=maxMatches||scanned>=maxBytes)break;let start=parseInt(m.start,16),remain=Math.min(m.size,maxBytes-scanned),offset=0,carry=Buffer.alloc(0);while(remain>0&&matches.length<maxMatches){const size=Math.min(1024*1024,remain),buf=Buffer.alloc(size);let bytesRead=0;try{const r=await handle.read(buf,0,size,start+offset);bytesRead=r.bytesRead}catch{skipped++;break}if(bytesRead<=0)break;const chunk=Buffer.concat([carry,buf.subarray(0,bytesRead)]),base=BigInt(start+offset-carry.length),found=findBufferOffsets(chunk,pattern.buffer,base,maxMatches-matches.length);for(const address of found)matches.push({address,region:m.path||'',permissions:m.permissions});carry=chunk.subarray(Math.max(0,chunk.length-Math.max(0,pattern.buffer.length-1)));offset+=bytesRead;remain-=bytesRead;scanned+=bytesRead}}}finally{await handle.close()}return{pid,pattern:{kind:pattern.kind,value:pattern.value,byteLength:pattern.buffer.length},matches,scannedBytes:scanned,skippedRegions:skipped,truncated:scanned>=maxBytes||matches.length>=maxMatches}
  }
  case 'syscall_trace': {
   const pid=pidValue(a.pid),duration=int(a.durationMs,3000,100,15000),cats=Array.isArray(a.categories)&&a.categories.length?a.categories:['file','network','memory','process'],trace=cats.map(x=>'%'+x).join(','),r=await runProcess(toolDirect('strace'),['-f','-tt','-T','-s','256','-e','trace='+trace,'-p',String(pid)],{timeoutMs:duration,maxOutputBytes:MAX_COMMAND_OUTPUT}),combined=(r.stderr||r.stdout);return{pid,durationMs:duration,categories:cats,...trimLines(combined,int(a.maxLines,1000,1,4000)),endedByTimeout:r.timedOut,exitCode:r.exitCode}
  }
  case 'frida_processes': {
   const args=[...fridaDeviceArgs(a)];if(bool(a.appsOnly,false))args.push('-a');const r=await runProcess(toolWrapped('frida-ps'),args,{timeoutMs:8000,maxOutputBytes:MAX_COMMAND_OUTPUT});if(r.exitCode!==0)throw new Error('frida-ps failed: '+(r.stderr||r.stdout).slice(0,MAX_OUTPUT));return{device:a.device||'local',output:r.stdout.trim(),stderr:r.stderr.trim()||undefined}
  }
  case 'frida_attach': {
   const pid=pidValue(a.pid)
   if(bool(a.persistent,false)){const session=await startManagedFrida(a,['-p',String(pid)]);return{pid,sessionId:session.id,persistent:true,ready:session.ready,recent:session.lines.slice(-20)}}
   const script="console.log(JSON.stringify({pid:Process.id,arch:Process.arch,platform:Process.platform}));",args=[...fridaDeviceArgs(a),'-p',String(pid),'-q','-e',script],r=await runProcess(toolWrapped('frida'),args,{timeoutMs:int(a.timeoutMs,5000,500,30000),maxOutputBytes:MAX_OUTPUT});if(r.exitCode!==0&& !r.timedOut)throw new Error('frida attach failed: '+(r.stderr||r.stdout).slice(0,MAX_OUTPUT));return{pid,stdout:r.stdout.trim(),stderr:r.stderr.trim(),timedOut:r.timedOut,exitCode:r.exitCode,persistent:false}
  }
  case 'frida_spawn':
  case 'frida_script': {
   const script=name==='frida_spawn'?(a.script==null?"console.log(JSON.stringify({pid:Process.id,arch:Process.arch,platform:Process.platform}));":text(a.script,'script')):text(a.script,'script')
   const target=name==='frida_spawn'?fridaTargetArgs(a,{spawn:true}):fridaTargetArgs(a)
   if(name==='frida_spawn'&&bool(a.persistent,false)){const session=await startManagedFrida(a,target,script);return{target:target.join(' '),sessionId:session.id,persistent:true,ready:session.ready,recent:session.lines.slice(-20)}}
   const tmpRoot=await mkdtemp(resolve(process.env.TMPDIR||process.cwd(),'.dsh-frida-')),scriptPath=resolve(tmpRoot,'agent.js');try{await writeFile(scriptPath,script,{mode:0o600});const args=[...fridaDeviceArgs(a),...target,'-q','-l',scriptPath],r=await runProcess(toolWrapped('frida'),args,{timeoutMs:int(a.timeoutMs,8000,500,30000),maxOutputBytes:MAX_COMMAND_OUTPUT});if(r.exitCode!==0&&!r.timedOut)throw new Error('frida failed: '+(r.stderr||r.stdout).slice(0,MAX_OUTPUT));return{target:target.join(' '),stdout:r.stdout.trim(),stderr:r.stderr.trim(),timedOut:r.timedOut,exitCode:r.exitCode,persistent:false}}finally{await rm(tmpRoot,{recursive:true,force:true})}
  }
  case 'frida_detach': {
   const session=fridaSession(a.sessionId),id=session.id,pid=session.pid;await closeFrida(session);return{sessionId:id,pid,detached:true}
  }
  case 'frida_trace': {
   const args=[...fridaDeviceArgs(a),'-p',String(pidValue(a.pid)),'-i',text(a.include,'include',4096)],r=await runProcess(toolWrapped('frida-trace'),args,{timeoutMs:int(a.durationMs,5000,500,15000),maxOutputBytes:MAX_COMMAND_OUTPUT});return{pid:a.pid,include:a.include,...trimLines((r.stdout+(r.stderr?'\n[stderr]\n'+r.stderr:'')),int(a.maxLines,1200,1,4000)),endedByTimeout:r.timedOut,exitCode:r.exitCode}
  }
  case 'debug_session_start': {
   const session=await startDebugSession();if(a.pid!=null){await miCommand(session,'-target-attach '+pidValue(a.pid),8000);session.attachedPid=a.pid}return{sessionId:session.id,pid:session.attachedPid,recent:session.lines.slice(-20)}
  }
  case 'debug_attach': {
   const session=debugSession(a.sessionId),pid=pidValue(a.pid),result=await miCommand(session,'-target-attach '+pid,8000);session.attachedPid=pid;return{sessionId:session.id,pid,result}
  }
  case 'debug_breakpoint_set': {
   const session=debugSession(a.sessionId),hasAddr=a.address!=null,hasSymbol=a.symbol!=null;if(hasAddr===hasSymbol)throw new Error('provide exactly one of address or symbol');const location=hasAddr?'*'+addr(a.address):text(a.symbol,'symbol',4096),cmd='-break-insert '+(bool(a.temporary,false)?'-t ':'')+location;return{sessionId:session.id,...await miCommand(session,cmd,5000)}
  }
  case 'debug_continue': {
   const session=debugSession(a.sessionId),before=session.lines.length,result=await miCommand(session,'-exec-continue',5000),waitMs=int(a.waitMs,1500,0,15000);let stopped=session.lines.slice(before).find(x=>x.startsWith('*stopped'))||null;if(!stopped&&waitMs>0)stopped=await waitDebugStop(session,waitMs);return{sessionId:session.id,result,stopped,running:stopped==null,recent:session.lines.slice(-40)}
  }
  case 'debug_registers': {
   const session=debugSession(a.sessionId);return{sessionId:session.id,...await miCommand(session,'-data-list-register-values x',5000)}
  }
  case 'debug_backtrace': {
   const session=debugSession(a.sessionId),max=int(a.maxFrames,64,1,256);return{sessionId:session.id,...await miCommand(session,'-stack-list-frames 0 '+(max-1),5000)}
  }
  case 'debug_memory_read': {
   const session=debugSession(a.sessionId),address=addr(a.address),length=int(a.length,256,1,1048576);return{sessionId:session.id,address,length,...await miCommand(session,'-data-read-memory-bytes '+address+' '+length,5000)}
  }
  case 'debug_session_close': {
   const session=debugSession(a.sessionId),id=session.id;await closeDebug(session);return{sessionId:id,closed:true}
  }
  case 'binary_functions': {
   const f=await checkedPath(a.path),raw=await rizinJson(f.path,'aaa;aflj',30000),list=Array.isArray(raw)?raw:[],filter=a.filter==null?null:text(a.filter,'filter',4096).toLowerCase(),limit=int(a.maxResults,1000,1,5000),functions=list.filter(x=>!filter||String(x.name||'').toLowerCase().includes(filter)).slice(0,limit).map(x=>({name:x.name||null,offset:x.offset==null?null:'0x'+Number(x.offset).toString(16),size:x.size??x.realsz??null,nargs:x.nargs??null,type:x.type??null}));return{...f,functions,truncated:list.length>functions.length}
  }
  case 'binary_xrefs': {
   const f=await checkedPath(a.path),limit=int(a.maxResults,200,1,1000),modes=[a.address!=null,a.symbol!=null,a.string!=null].filter(Boolean).length;if(modes!==1)throw new Error('provide exactly one of address, symbol, or string');if(a.address!=null||a.symbol!=null){const target=a.address!=null?addr(a.address):text(a.symbol,'symbol',4096),raw=await rizinJson(f.path,'aaa;axtj @ '+target,30000),refs=Array.isArray(raw)?raw.slice(0,limit):raw;return{...f,target,refs,truncated:Array.isArray(raw)&&raw.length>limit}}const query=text(a.string,'string',65536),strings=await rizinJson(f.path,'izzj',30000),hits=(Array.isArray(strings)?strings:[]).filter(x=>String(x.string||'').includes(query)).slice(0,Math.min(32,limit)),refs=[];for(const hit of hits){const at=hit.vaddr??hit.paddr;if(at==null)continue;const target='0x'+Number(at).toString(16),x=await rizinJson(f.path,'aaa;axtj @ '+target,30000);refs.push({string:hit.string,address:target,refs:Array.isArray(x)?x.slice(0,limit):x})}return{...f,query,stringHits:refs,truncated:hits.length>=32}
  }
  case 'jni_map_java_native': {
   const f=await checkedPath(a.path),limit=int(a.maxResults,1000,1,5000),r=await runProcess('nm',['-D','--defined-only',f.path],{timeoutMs:15000,maxOutputBytes:MAX_COMMAND_OUTPUT});if(r.exitCode!==0)throw new Error('nm failed: '+(r.stderr||r.stdout).slice(0,MAX_OUTPUT));const mappings=[];let jniOnLoad=null;for(const line of r.stdout.split(/\r?\n/)){const m=line.trim().match(/^([0-9a-fA-F]+)\s+\w\s+(\S+)$/);if(!m)continue;if(m[2]==='JNI_OnLoad')jniOnLoad='0x'+m[1].toLowerCase();if(m[2].startsWith('Java_')&&mappings.length<limit)mappings.push({address:'0x'+m[1].toLowerCase(),symbol:m[2],javaApprox:decodeJniName(m[2])})}const all=await runProcess('nm',['-D',f.path],{timeoutMs:15000,maxOutputBytes:MAX_COMMAND_OUTPUT}),registerNatives=/\bRegisterNatives\b/.test(all.stdout+all.stderr);return{...f,jniOnLoad,registerNativesImported:registerNatives,mappings,truncated:mappings.length>=limit}
  }
  case 'il2cpp_detect': {
   const out={apk:null,lib:null,metadata:null};if(a.apk!=null){const f=await checkedPath(a.apk),list=await runStrict('unzip',['-Z1',f.path],{timeoutMs:10000,maxOutputBytes:MAX_COMMAND_OUTPUT}),entries=list.split(/\r?\n/).filter(Boolean),libs=entries.filter(x=>/(^|\/)libil2cpp\.so$/.test(x)),metadata=entries.filter(x=>/(^|\/)global-metadata\.dat$/.test(x));out.apk={path:f.path,libil2cppEntries:libs,metadataEntries:metadata,detected:libs.length>0&&metadata.length>0}}if(a.lib!=null){const f=await checkedPath(a.lib);out.lib={path:f.path,size:f.size,looksLikeIl2Cpp:/libil2cpp\.so$/i.test(f.path)}}if(a.metadata!=null){const f=await checkedPath(a.metadata),h=await open(f.path,'r');try{const b=Buffer.alloc(8),r=await h.read(b,0,8,0);out.metadata={path:f.path,size:f.size,headerHex:b.subarray(0,r.bytesRead).toString('hex'),magicOk:r.bytesRead>=4&&b.readUInt32LE(0)===0xfab11baf,version:r.bytesRead>=8?b.readInt32LE(4):null}}finally{await h.close()}}return{detected:Boolean(out.apk?.detected||out.lib?.looksLikeIl2Cpp||out.metadata?.magicOk),...out}
  }
  case 'il2cpp_find_method': {
   const meta=await checkedPath(a.metadata);if(meta.size>256*1024*1024)throw new Error('metadata exceeds 256 MiB search limit');const method=text(a.method,'method',4096),data=await readFile(meta.path),needle=Buffer.from(method),max=int(a.maxResults,64,1,256),offsets=[];let pos=0;while(offsets.length<max){const i=data.indexOf(needle,pos);if(i<0)break;offsets.push('0x'+i.toString(16));pos=i+needle.length}const result={metadata:meta.path,method,class:a.class||null,namespace:a.namespace||null,metadataNameOffsets:offsets,exportCandidates:[],resolvedRva:null,confidence:'name-only'};if(a.lib!=null){const lib=await checkedPath(a.lib),r=await runProcess('nm',['-D','-an',lib.path],{timeoutMs:15000,maxOutputBytes:MAX_COMMAND_OUTPUT});const q=method.toLowerCase();result.lib=lib.path;result.exportCandidates=r.stdout.split(/\r?\n/).filter(x=>x.toLowerCase().includes(q)).slice(0,max).map(line=>{const m=line.trim().match(/^([0-9a-fA-F]+)\s+\w\s+(\S+)/);return m?{address:'0x'+m[1].toLowerCase(),symbol:m[2]}:{raw:line}});if(result.exportCandidates.length===1&&result.exportCandidates[0].address){result.resolvedRva=result.exportCandidates[0].address;result.confidence='export-symbol'}}return result
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
 const names=new Set(tools.map(x=>x.name));for(const name of ['fs_read','fs_list','fs_search','fs_write','fs_patch','command_run','git_status','git_diff','git_log','http_request','android_logcat','apk_inspect','process_list','process_info','process_maps','process_threads','module_list','memory_regions','memory_read','memory_search','syscall_trace','frida_processes','frida_attach','frida_spawn','frida_script','frida_trace','debug_session_start','debug_attach','debug_breakpoint_set','debug_continue','debug_registers','debug_backtrace','debug_memory_read','debug_session_close','binary_functions','binary_xrefs','jni_map_java_native','no_root_capabilities','self_runtime_snapshot','runtime_snapshot','runtime_diff','process_fds','process_network','child_strace','adb_devices','adb_pair','adb_connect','adb_package_info','adb_process_info','adb_logcat','adb_jdwp_list','adb_pull_apk','reverse_capabilities','package_process_info','native_backtrace','frida_detach','symbol_resolve','address_rebase','il2cpp_detect','il2cpp_metadata_info','il2cpp_find_class','il2cpp_find_method'])if(!names.has(name))throw new Error('missing tool '+name)
 if((await call('protocol_decode',{data:'414243',encoding:'hex'})).utf8!=='ABC')throw new Error('decode self-test failed')
 const rebased=await call('address_rebase',{base:'0x1000',rva:'0x20'});if(rebased.runtimeAddress!=='0x1020')throw new Error('address_rebase self-test failed')
 const caps=await call('reverse_capabilities',{});if(!caps.proc?.maps)throw new Error('reverse_capabilities self-test failed')
 const noRoot=await call('no_root_capabilities',{});if(!noRoot.direct?.selfProcMaps)throw new Error('no_root_capabilities self-test failed')
 const snap1=await call('self_runtime_snapshot',{maxEntries:256}),snap2=await call('runtime_snapshot',{pid:process.pid,maxEntries:256}),diff=await call('runtime_diff',{before:snap1.id,after:snap2.id});if(diff.pid!==process.pid)throw new Error('runtime snapshot self-test failed')
 for(const b of ['file','readelf','objdump','nm','strings','rg','git'])await runStrict(b,['--version'])
 await runStrict('openssl',['version'])
 await runStrict('aapt2',['version'])
 await runStrict(toolDirect('gdb'),['--version'])
 await runStrict(toolDirect('strace'),['-V'])
 await runStrict(toolWrapped('rizin'),['-v'])
 await runStrict(toolWrapped('frida'),['--version'])
 await runStrict(toolWrapped('adb'),['version'])
 const own=await call('process_info',{pid:process.pid});if(own.pid!==process.pid)throw new Error('process_info self-test failed')
 const ownMaps=await call('process_maps',{pid:process.pid});if(!ownMaps.mappings.length)throw new Error('process_maps self-test failed')
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
async function main(){if(process.argv.includes('--self-test'))return selfTest();const{Server,StdioServerTransport,ListToolsRequestSchema,CallToolRequestSchema}=await sdk();const server=new Server({name:'dsh-mobile-toolbox',version:'3.2.0'},{capabilities:{tools:{}}});server.setRequestHandler(ListToolsRequestSchema,async()=>({tools}));server.setRequestHandler(CallToolRequestSchema,async req=>{const value=await call(req.params.name,req.params.arguments||{});return{content:[{type:'text',text:JSON.stringify(value,null,2)}],structuredContent:value}});await server.connect(new StdioServerTransport())}
main().catch(e=>{process.stderr.write('[dsh-mobile-toolbox] '+(e?.stack||e?.message||String(e))+'\n');process.exitCode=1})
