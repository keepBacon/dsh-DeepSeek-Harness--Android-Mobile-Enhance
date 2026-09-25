#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { realpath, stat } from 'node:fs/promises'

const execFileAsync=promisify(execFile)
const HERE=dirname(fileURLToPath(import.meta.url))
const PREFIX=process.env.TERMUX__PREFIX||process.env.PREFIX||resolve(HERE,'../..')
const requireFromDsh=createRequire(resolve(PREFIX,'lib/node_modules/@deepseek-ai/dsh/package.json'))
const MAX_TEXT=1024*1024, MAX_FILE=1024*1024*1024, MAX_OUTPUT=192*1024

const fileSchema={type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}
const tools=[
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

function text(v,n='input'){if(typeof v!=='string')throw new Error(n+' must be a string');if(Buffer.byteLength(v)>MAX_TEXT)throw new Error(n+' exceeds 1 MiB');return v}
function decode(data,enc='utf8'){const s=text(data,'data');if(enc==='utf8')return Buffer.from(s);if(enc==='hex'){if(!/^(?:[0-9a-fA-F]{2})*$/.test(s))throw new Error('invalid hex');return Buffer.from(s,'hex')}if(enc==='base64'){const b=Buffer.from(s,'base64');if(b.toString('base64')!==s)throw new Error('invalid canonical base64');return b}if(enc==='base64url')return Buffer.from(s,'base64url');throw new Error('unsupported encoding')}
function projection(b){const x=b.subarray(0,65536);return{byteLength:b.length,truncated:b.length>x.length,utf8:x.toString(),hex:x.toString('hex'),base64:x.toString('base64')}}
async function checkedPath(p){const raw=text(p,'path');if(!raw.startsWith('/'))throw new Error('path must be absolute');const path=await realpath(raw);const s=await stat(path);if(!s.isFile())throw new Error('not a regular file');if(s.size>MAX_FILE)throw new Error('file exceeds 1 GiB');return{path,size:s.size}}
async function run(bin,args){try{const r=await execFileAsync(bin,args,{encoding:'utf8',timeout:10000,maxBuffer:MAX_OUTPUT,env:process.env});return(r.stdout+(r.stderr?'\n[stderr]\n'+r.stderr:'')).trim()}catch(e){throw new Error(bin+' failed: '+((e.stderr||e.stdout||e.message||String(e)).toString().slice(0,MAX_OUTPUT)))}}
function trimLines(s,max=800){const a=String(s).split(/\r?\n/);return{output:a.slice(0,max).join('\n').slice(0,MAX_OUTPUT),truncated:a.length>max,totalLines:a.length}}
function addr(v){if(v==null||v==='')return null;if(typeof v!=='string'||!/^(?:0x)?[0-9a-fA-F]+$/.test(v))throw new Error('invalid address');return '0x'+v.replace(/^0x/i,'')}

async function call(name,a={}){
 switch(name){
  case 'protocol_decode': return projection(decode(a.data,a.encoding))
  case 'protocol_encode': {const b=Buffer.from(text(a.text,'text'));if(a.encoding==='hex')return{value:b.toString('hex')};if(a.encoding==='base64')return{value:b.toString('base64')};if(a.encoding==='base64url')return{value:b.toString('base64url')};if(a.encoding==='url-component')return{value:encodeURIComponent(a.text)};throw new Error('bad encoding')}
  case 'protocol_hash': {const b=decode(a.data,a.inputEncoding||'utf8');return{algorithm:a.algorithm,digest:createHash(a.algorithm).update(b).digest('hex'),byteLength:b.length}}
  case 'protocol_parse_http': {const raw=text(a.message,'message'), parts=raw.split(/\r?\n\r?\n/,2), lines=parts[0].split(/\r?\n/),startLine=lines.shift()||'',headers={};for(const l of lines){const i=l.indexOf(':');if(i>0){const k=l.slice(0,i).trim().toLowerCase(),v=l.slice(i+1).trim();(headers[k]??=[]).push(v)}}const body=parts[1]||'';return{kind:/^HTTP\//i.test(startLine)?'response':'request',startLine,headers,bodyBytes:Buffer.byteLength(body),bodyPreview:body.slice(0,8192)}}
  case 'protocol_parse_url': {const u=new URL(text(a.url,'url'));return{href:u.href,protocol:u.protocol,host:u.host,hostname:u.hostname,port:u.port,pathname:u.pathname,query:Object.fromEntries([...u.searchParams.keys()].map(k=>[k,u.searchParams.getAll(k)])),hash:u.hash}}
  case 'binary_info': {const f=await checkedPath(a.path);const [kind,h,d]=await Promise.all([run('file',['-b',f.path]),run('readelf',['-h',f.path]).catch(e=>e.message),run('readelf',['-d',f.path]).catch(e=>e.message)]);return{...f,file:kind,elfHeader:trimLines(h,120),dynamic:trimLines(d,200)}}
  case 'binary_sections': {const f=await checkedPath(a.path);return{...f,...trimLines(await run('readelf',['-SW',f.path]),1200)}}
  case 'binary_symbols': {const f=await checkedPath(a.path);let o;try{o=await run('nm',['-an',f.path])}catch{o=await run('readelf',['-Ws',f.path])}return{...f,...trimLines(o,1600)}}
  case 'binary_strings': {const f=await checkedPath(a.path),n=Number.isInteger(a.minLength)?Math.max(3,Math.min(64,a.minLength)):4,m=Number.isInteger(a.maxLines)?Math.max(1,Math.min(2000,a.maxLines)):500;return{...f,...trimLines(await run('strings',['-a','-n',String(n),f.path]),m)}}
  case 'binary_disassemble': {const f=await checkedPath(a.path),argv=['-d'],s=addr(a.startAddress),e=addr(a.stopAddress);if(s)argv.push('--start-address='+s);if(e)argv.push('--stop-address='+e);argv.push(f.path);const m=Number.isInteger(a.maxLines)?Math.max(1,Math.min(4000,a.maxLines)):1200;return{...f,...trimLines(await run('objdump',argv),m)}}
  default: throw new Error('unknown tool: '+name)
 }
}

async function sdk(){const server=requireFromDsh.resolve('@modelcontextprotocol/sdk/server/index.js'),stdio=requireFromDsh.resolve('@modelcontextprotocol/sdk/server/stdio.js'),types=requireFromDsh.resolve('@modelcontextprotocol/sdk/types.js');const [{Server},{StdioServerTransport},t]=await Promise.all([import(pathToFileURL(server).href),import(pathToFileURL(stdio).href),import(pathToFileURL(types).href)]);return{Server,StdioServerTransport,ListToolsRequestSchema:t.ListToolsRequestSchema,CallToolRequestSchema:t.CallToolRequestSchema}}
async function selfTest(){await sdk();if((await call('protocol_decode',{data:'414243',encoding:'hex'})).utf8!=='ABC')throw new Error('decode self-test failed');for(const b of ['file','readelf','objdump','nm','strings'])await run(b,['--version']);await run('openssl',['version']);process.stdout.write('[DSH] Mobile MCP toolbox self-test: OK\n')}
async function main(){if(process.argv.includes('--self-test'))return selfTest();const{Server,StdioServerTransport,ListToolsRequestSchema,CallToolRequestSchema}=await sdk();const server=new Server({name:'dsh-mobile-toolbox',version:'1.0.0'},{capabilities:{tools:{}}});server.setRequestHandler(ListToolsRequestSchema,async()=>({tools}));server.setRequestHandler(CallToolRequestSchema,async req=>{const value=await call(req.params.name,req.params.arguments||{});return{content:[{type:'text',text:JSON.stringify(value,null,2)}],structuredContent:value}});await server.connect(new StdioServerTransport())}
main().catch(e=>{process.stderr.write('[dsh-mobile-toolbox] '+(e?.stack||e?.message||String(e))+'\n');process.exitCode=1})
