import { createHash, randomBytes } from 'node:crypto'
import { readFile, writeFile, rename, unlink, stat } from 'node:fs/promises'
import { dirname, basename, resolve, relative, isAbsolute, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { TextDecoder } from 'node:util'

const obj=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false})
const str={type:'string'}
export const codeTools=[
 {name:'code_context',description:'Read source lines with numbers and a SHA-256 snapshot for precise edits.',inputSchema:obj({path:str,startLine:{type:'integer',minimum:1},endLine:{type:'integer',minimum:1}},['path'])},
 {name:'code_search',description:'Search a source tree with ripgrep and return structured path/line matches.',inputSchema:obj({query:str,path:str,regex:{type:'boolean'},maxResults:{type:'integer',minimum:1,maximum:200}},['query'])},
 {name:'code_patch',description:'Replace exact source context with a SHA-256 concurrency precondition and dry run.',inputSchema:obj({path:str,oldText:str,newText:str,expectedSha256:str,dryRun:{type:'boolean'}},['path','oldText','newText'])},
 {name:'code_multi_edit',description:'Validate and apply a set of source edits with staged files and rollback on failure.',inputSchema:obj({edits:{type:'array',minItems:1,maxItems:32,items:obj({path:str,oldText:str,newText:str,expectedSha256:str},['path','oldText','newText'])},dryRun:{type:'boolean'}},['edits'])},
 {name:'code_symbols',description:'Find best-effort source declarations and symbol locations (regex-based, not a full AST).',inputSchema:obj({path:str,query:str,maxResults:{type:'integer',minimum:1,maximum:200}},[])},
 {name:'code_references',description:'Find exact identifier references across source files with file, line and column.',inputSchema:obj({symbol:str,path:str,maxResults:{type:'integer',minimum:1,maximum:200}},['symbol'])},
 {name:'code_apply_patch',description:'Apply standard multi-file unified diff hunks with exact context and dry-run support. Modifies existing files only.',inputSchema:obj({patch:str,root:str,dryRun:{type:'boolean'}},['patch'])},
 {name:'code_diff',description:'Create a valid unified-diff patch for one existing source file from its current contents to proposed UTF-8 text.',inputSchema:obj({path:str,after:str,context:{type:'integer',minimum:0,maximum:10}},['path','after'])},
]
const hash=s=>createHash('sha256').update(s).digest('hex')
const string=(v,label)=>{if(typeof v!=='string')throw Error(label+' must be a string');return v}
const read=async p=>{const path=resolve(string(p,'path'));const bytes=await readFile(path);if(bytes.length>16*1024*1024)throw Error('file exceeds 16 MiB');const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(text.includes('\u0000'))throw Error('refusing to treat a binary file as UTF-8 code: '+path);return {path,text,meta:await stat(path)}}
async function stageFile(item){
 const temp=resolve(dirname(item.path),'.'+basename(item.path)+'.code2-'+randomBytes(8).toString('hex'))
 await writeFile(temp,item.after,{flag:'wx',mode:item.meta.mode})
 return temp
}
async function replaceAtomic(item){const temp=await stageFile(item);try{await rename(temp,item.path)}finally{await unlink(temp).catch(()=>{})}}
function apply(text,oldText,newText,path){
 if(oldText==='')throw Error('empty edit context for '+path)
 const n=text.split(oldText).length-1
 if(n!==1)throw Error(path+': edit context must occur exactly once, found '+n)
 const after=text.replace(oldText,newText)
 if(Buffer.byteLength(after)>16*1024*1024)throw Error('result too large: '+path)
 return after
}
async function edits(list,dryRun){
 if(!Array.isArray(list)||list.length<1||list.length>32)throw Error('edits must contain 1..32 entries')
 const planned=new Map()
 for(const e of list){
  const path=resolve(string(e.path,'path')),oldText=string(e.oldText,'oldText'),newText=string(e.newText,'newText')
  let row=planned.get(path)
  if(!row){const f=await read(path);row={...f,original:f.text,after:f.text};planned.set(path,row)}
  if(e.expectedSha256&&hash(row.original)!==e.expectedSha256.toLowerCase())throw Error('stale source hash: '+path)
  row.after=apply(row.after,oldText,newText,path)
 }
 return commit([...planned.values()],dryRun)
}
async function commit(rows,dryRun){
 const summary=rows.map(x=>({path:x.path,beforeSha256:hash(x.original),afterSha256:hash(x.after),changed:x.after!==x.original}))
 if(dryRun)return {dryRun:true,files:summary}
 const staged=[],committed=[]
 try{
  for(const row of rows){const current=await read(row.path);if(hash(current.text)!==hash(row.original))throw Error('source changed during edit: '+row.path);staged.push({row,tmp:await stageFile(row)})}
  for(const {row,tmp} of staged){await rename(tmp,row.path);committed.push(row)}
 }catch(error){
  const failures=[]
  for(const row of committed.reverse())try{await replaceAtomic({...row,after:row.original})}catch(e){failures.push(row.path+': '+e.message)}
  throw Error('code_multi_edit failed: '+error.message+(failures.length?'; rollback failed: '+failures.join('; '):''))
 }finally{for(const {tmp} of staged)await unlink(tmp).catch(()=>{})}
 return {dryRun:false,files:summary}
}
async function search(a){
 const pattern=string(a.query,'query'),cwd=resolve(a.path||'.')
 if(!pattern)throw Error('query is empty')
 const args=['--json','--line-number','--max-columns','1000','--max-filesize','4M']
 if(a.regex!==true)args.push('--fixed-strings')
 args.push('--',pattern,cwd)
 const limit=Math.min(200,Math.max(1,Number(a.maxResults)||80))
 const result=await new Promise((ok,fail)=>{
  const proc=spawn('rg',args,{stdio:['ignore','pipe','pipe'],shell:false})
  let stdout='',stderr='',truncated=false
  const timer=setTimeout(()=>proc.kill('SIGKILL'),15000)
  proc.stdout.on('data',d=>{if(stdout.length<2*1024*1024)stdout+=d;else truncated=true})
  proc.stderr.on('data',d=>{stderr=(stderr+d).slice(-2048)})
  proc.on('error',fail)
  proc.on('close',code=>{clearTimeout(timer);if(code!==0&&code!==1)fail(Error('rg failed: '+stderr));else ok({stdout,truncated})})
 })
 const matches=[]
 for(const line of result.stdout.split(/\r?\n/)){if(!line)continue;let event;try{event=JSON.parse(line)}catch{continue}
  if(event.type!=='match')continue
  matches.push({path:event.data.path?.text,line:event.data.line_number,text:event.data.lines?.text?.slice(0,1000)})
  if(matches.length>=limit)break
 }
 return {matches,truncated:result.truncated||matches.length>=limit,query:pattern}
}
export async function codeCall(name,a={}){
 switch(name){
  case 'code_context':{const f=await read(a.path),lines=f.text.split(/\r?\n/),start=Math.max(1,Number(a.startLine)||1),end=Math.min(lines.length,Math.max(start,Number(a.endLine)||start+120));return {path:f.path,sha256:hash(f.text),totalLines:lines.length,content:lines.slice(start-1,end).map((s,i)=>(start+i)+' | '+s).join('\n')}}
  case 'code_search':return search(a)
  case 'code_patch':return edits([{path:a.path,oldText:a.oldText,newText:a.newText,expectedSha256:a.expectedSha256}],a.dryRun===true)
  case 'code_multi_edit':return edits(a.edits,a.dryRun===true)
  default:throw Error('unknown Code Engine tool: '+name)
 }
}
