#!/usr/bin/env node
// Read-only Luau VM forensic helpers. Never run or fetch analyzed code.
import {createHash} from 'node:crypto'
import {readFile,realpath,stat} from 'node:fs/promises'
import {resolve} from 'node:path'
const MAX=6*1024*1024
const sha=v=>createHash('sha256').update(v).digest('hex')
const cap=(v,d,lo,hi)=>Number.isInteger(v)?Math.min(hi,Math.max(lo,v)):d
function err(s){throw new Error(s)}
async function load(a){
 if((a.source==null)===(a.path==null))err('exactly one of source or path required')
 if(a.source!=null){if(typeof a.source!=='string'||Buffer.byteLength(a.source)>MAX)err('source exceeds 6 MiB');return{source:a.source,path:null}}
 if(typeof a.path!=='string'||a.path.length>16384||a.path.includes('\0'))err('bad path')
 const path=await realpath(resolve(process.cwd(),a.path)),s=await stat(path)
 if(!s.isFile()||s.size>MAX)err('source must be a regular file <= 6 MiB')
 return{source:await readFile(path,'utf8'),path}
}
function mask(src){
 const out=src.split('');const blank=i=>{if(src[i]!=='\n'&&src[i]!=='\r')out[i]=' '}
 for(let i=0;i<src.length;){
  const x=src[i],isLine=(x==='-'&&src[i+1]==='-')||(x==='/'&&src[i+1]==='/')
  if(isLine){while(i<src.length&&src[i]!=='\n')blank(i++);continue}
  if(x==='/'&&src[i+1]==='*'){const p=src.indexOf('*/',i+2),end=p<0?src.length:p+2;while(i<end)blank(i++);continue}
  if(x==='"'||x==="'"||x.charCodeAt(0)===96){
   const q=x;blank(i++);while(i<src.length){if(src[i]==='\\'){blank(i++);if(i<src.length)blank(i++);continue}const stop=src[i]===q;blank(i++);if(stop)break}continue
  }
  if(x==='['){let j=i+1;while(src[j]==='=')j++;if(src[j]==='['){const delim=']'+'='.repeat(j-i-1)+']',p=src.indexOf(delim,j+1),end=p<0?src.length:p+delim.length;while(i<end)blank(i++);continue}}
  i++
 }
 return out.join('')
}
function lineAt(s){const starts=[0];for(let i=0;i<s.length;i++)if(s.charCodeAt(i)===10)starts.push(i+1);return pos=>{let l=0,r=starts.length;while(l+1<r){const m=(l+r)>>>1;if(starts[m]<=pos)l=m;else r=m}return l+1}}
function all(s,re,max=100){const a=[];for(const m of s.matchAll(re)){if(a.length>=max)break;a.push(m)}return a}
function sample(s,i){return s.slice(i,i+130).replace(/https?:\/\/[^\s"']+/g,t=>{try{const u=new URL(t);return u.origin+u.pathname+(u.search||u.hash?'?[redacted]':'')}catch{return'[url]'}}).replace(/\s+/g,' ')}
function loader(src,masked){
 const line=lineAt(src),urls=[]
 const re=/\b(?:game\s*:\s*HttpGet(?:Async)?|game\s*\.\s*HttpGet(?:Async)?|http\s*:\s*get)\s*\(\s*(["'])(https?:\/\/[^"'\r\n]{1,3000})\1/g
 for(const m of src.matchAll(re)){
  if(urls.length>=20)break
  if(!masked.slice(m.index,m.index+12).trim())continue
  try{const u=new URL(m[2]);if(!['http:','https:'].includes(u.protocol))continue
   urls.push({line:line(m.index),offset:m.index,host:u.hostname,path:u.pathname.slice(0,512),scheme:u.protocol.slice(0,-1),parametersRedacted:Boolean(u.search||u.hash||u.username||u.password),luarmorV4:u.hostname==='api.luarmor.net'&&/^\/files\/v4\/loaders\/[^/]+\.lua$/i.test(u.pathname)})
  }catch{}
 }
 const calls=all(masked,/\b(?:loadstring|load)\s*\(/g,20).map(m=>({line:line(m.index),offset:m.index}))
 return{stage:urls.length&&calls.length?'remote-bootstrap':urls.length?'network-loader':calls.length?'dynamic-loader':'source-only',urls,loadCalls:calls,executed:false,fetched:false,note:'URLs are not requested; loader references do not contain remotely hosted payloads.'}
}
const rules=[
 ['opcode-fetch',4,/\b(?:opcode|op|inst|instruction|vmop)\s*=\s*[\w.]+\s*\[\s*(?:pc|ip|vip)\s*\]/gi],
 ['byte-reader',3,/\b(?:string\.byte|readByte|readUInt\w*)\s*\(/gi],
 ['handler-table',4,/\b(?:handlers|dispatch|opcodes)\s*\[\s*(?:opcode|op|inst|vmop)\s*\]\s*\(/gi],
 ['handler-definition',3,/\b(?:handlers|dispatch|opcodes)\s*\[\s*(?:0x[\da-f]+|\d+)\s*\]\s*=\s*function/gi],
 ['opcode-branch',3,/\b(?:if|elseif)\s+(?:opcode|op|inst|instruction|vmop)\s*==\s*(?:0x[\da-f]+|\d+)\s+then/gi],
 ['program-counter',2,/\b(?:pc|vip|ip)\s*=\s*(?:pc|vip|ip)\s*[+\-]\s*\d+/gi],
 ['vm-loop',2,/\bwhile\s+(?:true|\w+\s*(?:<|<=)\s*#\w+)\s+do/gi],
 ['registers',2,/\b(?:registers|regs|stack|vstack)\s*\[/gi],
 ['constants',2,/\b(?:constants|consts|pool|kpool)\s*\[/gi],
 ['bitwise',2,/\b(?:bit32|bit)\s*\.\s*(?:bxor|band|rshift|lshift)\s*\(/gi]
]
function detect(src,code){
 const line=lineAt(src),indicators=[];let score=0
 for(const[k,w,r]of rules){const m=all(code,r,5);if(m.length){score+=w;indicators.push({kind:k,weight:w,locations:m.map(x=>({line:line(x.index),offset:x.index,evidence:sample(src,x.index)}))})}}
 const k=new Set(indicators.map(x=>x.kind)),dispatcher=k.has('handler-table')||k.has('handler-definition')||k.has('opcode-branch'),fetch=k.has('opcode-fetch')||k.has('byte-reader'),state=k.has('program-counter')||k.has('vm-loop'),probableVM=dispatcher&&(fetch||state)
 return{probableVM,confidence:!probableVM?'low':score>=14?'high':score>=9?'medium':'low',score,architecture:!probableVM?'not-established':k.has('handler-table')?'table-dispatch':'branch-dispatch',indicators,heuristic:true}
}
function handlers(src,code,max){
 const line=lineAt(src),found=[],dedupe=new Set()
 const tests=[
 ['branch',/\b(?:if|elseif)\s+(?:opcode|op|inst|instruction|vmop)\s*==\s*(0x[\da-f]+|\d+)\s+then/gi],
 ['branch',/\b(?:if|elseif)\s+(0x[\da-f]+|\d+)\s*==\s*(?:opcode|op|inst|instruction|vmop)\s+then/gi],
 ['table',/\b(?:handlers|dispatch|opcodes)\s*\[\s*(0x[\da-f]+|\d+)\s*\]\s*=\s*function\s*\(/gi]]
 for(const[k,r]of tests)for(const m of all(code,r,max*3)){
  const opcode=Number(m[1]);if(!Number.isSafeInteger(opcode))continue
  const id=m.index+':'+k+':'+opcode;if(dedupe.has(id))continue;dedupe.add(id)
  found.push({opcode,kind:k,line:line(m.index),offset:m.index,evidence:sample(src,m.index)})
 }
 found.sort((a,b)=>a.offset-b.offset)
 const result=found.slice(0,max),duplicates=[...new Set(result.filter((x,i)=>result.some((y,j)=>i!==j&&y.opcode===x.opcode)).map(x=>x.opcode))]
 return{handlers:result,total:found.length,truncated:found.length>max,duplicates,warning:'Numeric VM opcode meanings cannot be assumed.'}
}
function pools(src,code,limit,maxEntries){
 const line=lineAt(src),out=[]
 for(const m of code.matchAll(/\b(?:local\s+)?([A-Za-z_]\w*)\s*=\s*\{/g)){
  if(out.length>=limit)break
  if(!/^(?:code|bytecode|bytes|instructions?|program|constants?|consts?|strings?|pool|kpool|data|encoded|blob|stream|payload|lut|operands?)$/i.test(m[1]))continue
  const at=m.index+m[0].lastIndexOf('{');let depth=0,end=-1
  for(let j=at;j<code.length&&j-at<1000000;j++){if(code[j]==='{')depth++;else if(code[j]==='}'&&!--depth){end=j;break}}
  if(end<0)continue
  const body=src.slice(at+1,end),clean=code.slice(at+1,end),types={number:0,string:0,boolean:0,table:0,expression:0},examples=[]
  let size=0,start=0,nest=0
  const add=(a,b)=>{const s=body.slice(a,b).trim();if(!s)return
   let kind='expression'
   if(/^[-+]?(?:0x[\da-f]+|\d+(?:\.\d+)?)$/i.test(s))kind='number'
   else if(/^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')$/s.test(s))kind='string'
   else if(/^(?:true|false|nil)$/.test(s))kind='boolean'
   else if(s.startsWith('{'))kind='table'
   types[kind]++;size++;if(examples.length<16)examples.push({kind,preview:s.slice(0,100)})
  }
  for(let j=0;j<clean.length&&size<maxEntries;j++){if('{(['.includes(clean[j]))nest++;else if('})]'.includes(clean[j]))nest--;if(clean[j]===','&&nest===0){add(start,j);start=j+1}}
  if(size<maxEntries)add(start,body.length)
  out.push({name:m[1],line:line(m.index),entries:size,types,examples,sha256:sha(body),truncated:size>=maxEntries})
 }
 return{tables:out,truncated:out.length>=limit,warning:'Static expressions are not evaluated.'}
}
function lift(src,code,max){
 const list=handlers(src,code,max).handlers,out=[]
 for(let i=0;i<list.length;i++){
  const h=list[i],end=Math.min(src.length,h.offset+1400,list[i+1]?.offset??src.length),section=code.slice(h.offset,end),ops=[]
  const rules=[
   ['LOADK',/\b(?:registers|regs)\s*\[\s*(\d+)\s*\]\s*=\s*(?:constants|consts|pool|kpool)\s*\[\s*(\d+)\s*\]/gi],
   ['ADD',/\b(?:registers|regs)\s*\[\s*(\d+)\s*\]\s*=\s*(?:registers|regs)\s*\[\s*(\d+)\s*\]\s*\+\s*(?:registers|regs)\s*\[\s*(\d+)\s*\]/gi],
   ['MOVE',/\b(?:registers|regs)\s*\[\s*(\d+)\s*\]\s*=\s*(?:registers|regs)\s*\[\s*(\d+)\s*\](?!\s*[+\-*\/%])/gi],
   ['RETURN',/\breturn\s+(?:registers|regs)\s*\[\s*(\d+)\s*\]/gi],
   ['SET_PC',/\b(?:pc|ip|vip)\s*=\s*(0x[\da-f]+|\d+)\b/gi]]
  for(const[k,r]of rules)for(const m of all(section,r,10))ops.push({hypothesis:k,operands:m.slice(1).map(Number),offset:h.offset+m.index,evidence:sample(src,h.offset+m.index)})
  ops.sort((a,b)=>a.offset-b.offset);out.push({opcode:h.opcode,line:h.line,operations:ops.slice(0,30),confidence:ops.length?'pattern-only':'unclassified'})
 }
 return{handlers:out,syntheticIR:true,warning:'Pseudoinstructions are pattern hypotheses, not the original bytecode.'}
}
function trace(src,code,vm){
 const at=lineAt(src),anchors=[]
 for(const[k,r]of[
  ['fetch',/\b(?:opcode|op|inst|instruction|vmop)\s*=\s*[\w.]+\s*\[\s*(?:pc|ip|vip)\s*\]/gi],
  ['advance',/\b(?:pc|vip|ip)\s*=\s*(?:pc|vip|ip)\s*[+\-]\s*\d+/gi],
  ['dispatch',/\b(?:handlers|dispatch|opcodes)\s*\[\s*(?:opcode|op|inst|vmop)\s*\]\s*\(/gi]])
  for(const m of all(code,r,10))anchors.push({kind:k,line:at(m.index),offset:m.index,evidence:sample(src,m.index)})
 return{anchors,suggestedFields:['PC','opcode','operands','register-diff','constant-index'],limits:{maxInstructions:20000,maxEvents:3000,samplingEvery:10},executed:false,warning:vm.probableVM?'Verify instrumentation points against authorized isolated source.':'No confirmed VM dispatcher.'}
}
function bytes(a){
 if(typeof a.data!=='string'||a.data.length>65536)err('data too long')
 let b;if(a.encoding==='hex'){if(!/^(?:[0-9a-f]{2})*$/i.test(a.data))err('invalid hex');b=Buffer.from(a.data,'hex')}
 else if(a.encoding==='base64'){if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(a.data))err('invalid base64');b=Buffer.from(a.data,'base64');if(b.toString('base64')!==a.data)err('noncanonical base64')}
 else if(a.encoding==='decimal'){const v=a.data.split(/[\s,]+/).filter(Boolean);if(v.length>32768||v.some(x=>!/^\d{1,3}$/.test(x)||+x>255))err('bad byte list');b=Buffer.from(v.map(Number))}
 else err('invalid encoding')
 const actions=a.steps??[];if(!Array.isArray(actions)||actions.length>8)err('too many transforms')
 const out=Buffer.from(b)
 for(const s of actions){
  if(!s||!['xor','add','sub','rol','ror'].includes(s.operation)||!Number.isInteger(s.value)||s.value<0||s.value>255)err('invalid transform')
  for(let i=0;i<out.length;i++){let v=out[i],n=s.value;switch(s.operation){
   case'xor':out[i]=v^n;break;case'add':out[i]=(v+n)&255;break;case'sub':out[i]=(v-n)&255;break
   case'rol':n%=8;out[i]=((v<<n)|(v>>>(8-n)))&255;break
   case'ror':n%=8;out[i]=((v>>>n)|(v<<(8-n)))&255;break
  }}
 }
 const part=out.subarray(0,cap(a.maxOutputBytes,2048,64,8192))
 return{size:out.length,sha256:sha(out),hex:part.toString('hex'),utf8:part.toString('utf8'),truncated:part.length<out.length,executed:false}
}
const base={path:{type:'string'},source:{type:'string'}},schema=(extra={})=>({type:'object',properties:{...base,...extra},additionalProperties:false})
export const vmAssistTools=[
 {name:'reverse_loader_analyze',description:'Identify Roblox HttpGet/loadstring bootstraps without fetching remote script.',inputSchema:schema()},
 {name:'reverse_vm_detect',description:'Identify source VM dispatcher, opcode fetch, register and constant patterns.',inputSchema:schema()},
 {name:'reverse_vm_handlers',description:'Map static numeric Luau VM opcode branches and handler definitions.',inputSchema:schema({maxResults:{type:'integer',minimum:1,maximum:256,default:100}})},
 {name:'reverse_vm_pools',description:'Inspect VM constant and instruction tables without evaluating source.',inputSchema:schema({maxTables:{type:'integer',minimum:1,maximum:40,default:20},maxEntries:{type:'integer',minimum:1,maximum:10000,default:2000}})},
 {name:'reverse_vm_lift',description:'Build tentative LOADK/MOVE/ADD/RETURN/SET_PC pseudo-IR for VM handlers.',inputSchema:schema({maxResults:{type:'integer',minimum:1,maximum:256,default:100}})},
 {name:'reverse_vm_trace_plan',description:'Locate candidate PC/fetch/dispatch trace anchors without executing.',inputSchema:schema()},
 {name:'reverse_vm_bytecode_transform',description:'Explicit bytewise XOR/add/sub/rotation transforms, no automatic cracking.',inputSchema:{type:'object',properties:{data:{type:'string'},encoding:{type:'string',enum:['hex','base64','decimal']},steps:{type:'array',maxItems:8,items:{type:'object',properties:{operation:{type:'string',enum:['xor','add','sub','rol','ror']},value:{type:'integer',minimum:0,maximum:255}},required:['operation','value'],additionalProperties:false}},maxOutputBytes:{type:'integer',minimum:64,maximum:8192,default:2048}},required:['data','encoding'],additionalProperties:false}},
 {name:'reverse_vm_report',description:'One-call loader, VM, opcode, pool, pseudoinstruction and trace report.',inputSchema:schema()}
]
export async function vmAssistCall(name,a={}){
 if(!a||typeof a!=='object'||Array.isArray(a))err('arguments must be an object')
 if(name==='reverse_vm_bytecode_transform')return bytes(a)
 if(!vmAssistTools.some(t=>t.name===name))err('unknown VM helper '+name)
 const {source,path}=await load(a),code=mask(source),meta={path,bytes:Buffer.byteLength(source),sha256:sha(source)}
 const l=loader(source,code)
 if(name==='reverse_loader_analyze')return{...meta,...l}
 const vm=detect(source,code)
 if(name==='reverse_vm_detect')return{...meta,...vm,loaderStage:l.stage}
 const h=handlers(source,code,cap(a.maxResults,100,1,256))
 if(name==='reverse_vm_handlers')return{...meta,...h}
 if(name==='reverse_vm_lift')return{...meta,...lift(source,code,cap(a.maxResults,100,1,256))}
 const p=pools(source,code,cap(a.maxTables,20,1,40),cap(a.maxEntries,2000,1,10000))
 if(name==='reverse_vm_pools')return{...meta,...p}
 const t=trace(source,code,vm)
 if(name==='reverse_vm_trace_plan')return{...meta,...t}
 return{...meta,stage:l.stage,loader:l,vm,handlers:h,pools:p,lift:lift(source,code,100),tracePlan:t,
  outcome:vm.probableVM?'VM structure candidates found, not devirtualized':l.urls.length?'Bootstrap identified; authorized local payload required':'No VM confirmed',executed:false,fetched:false}
}
