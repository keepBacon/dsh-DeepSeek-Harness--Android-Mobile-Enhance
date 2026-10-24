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

async function symbols(a){
 const decl='\\b(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(function|class|interface|type|enum|struct|trait|def|fn|func|const|let|var|fun|object|record)\\s+([A-Za-z_$][\\w$]*)'
 const rx=new RegExp(decl)
 const result=await search({path:a.path||'.',query:a.query||decl,regex:!a.query,maxResults:a.maxResults||100})
 return {...result,strategy:'declaration-pattern',symbols:result.matches.map(m=>{const x=rx.exec(m.text||'');return {path:m.path,line:m.line,kind:x?.[1]||'match',name:x?.[2]||null,signature:(m.text||'').trim()}})}
}
const codeLines=value=>{const end=value.endsWith('\n'),lines=value.split('\n');if(end)lines.pop();if(!value)lines.length=0;return {lines,end}}
function makeDiff(before,after,file){
 if(before===after)return {changed:false,patch:''}
 const a=codeLines(before),b=codeLines(after)
 const lines=['--- a/'+file,'+++ b/'+file,'@@ -'+(a.lines.length?1:0)+','+a.lines.length+' +'+(b.lines.length?1:0)+','+b.lines.length+' @@']
 for(const line of a.lines)lines.push('-'+line)
 if(!a.end&&a.lines.length)lines.push('\\ No newline at end of file')
 for(const line of b.lines)lines.push('+'+line)
 if(!b.end&&b.lines.length)lines.push('\\ No newline at end of file')
 return {changed:true,patch:lines.join('\n')+'\n',nonMinimal:true}
}
function parseUnified(text,root){
 const lines=string(text,'patch').replace(/\r\n/g,'\n').split('\n'),result=[]
 let i=0
 while(i<lines.length){
  if(!lines[i]){i++;continue}
  const old=/^--- a\/(.+)$/.exec(lines[i++]||''),next=/^\+\+\+ b\/(.+)$/.exec(lines[i++]||'')
  if(!old||!next||old[1]!==next[1])throw Error('invalid unified file headers')
  const path=resolve(root,old[1])
  if(old[1].startsWith('/')||old[1].split('/').includes('..')||path===root||!path.startsWith(root+sep))throw Error('invalid patch path')
  const hunks=[]
  while((lines[i]||'').startsWith('@@ ')){
   const match=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i++])
   if(!match)throw Error('invalid hunk header')
   const h={start:Number(match[1])===0?0:Number(match[1])-1,oldCount:match[2]===undefined?1:Number(match[2]),newCount:match[4]===undefined?1:Number(match[4]),rows:[]}
   while(lines[i]&&[' ','-','+'].includes(lines[i][0])){
    const row={op:lines[i][0],text:lines[i++].slice(1)}
    if(lines[i]==='\\ No newline at end of file'){row.noNewline=true;i++}
    h.rows.push(row)
   }
   if(!h.rows.length)throw Error('hunk is empty')
   hunks.push(h)
  }
  if(!hunks.length||result.some(x=>x.path===path))throw Error('empty or duplicated patch file')
  result.push({path,hunks})
  if(result.length>32)throw Error('too many patch files')
 }
 if(!result.length)throw Error('empty patch')
 return result
}
async function unified(args){
 const root=resolve(args.root||'.'),patches=parseUnified(args.patch,root),plans=[]
 for(const entry of patches){
  const file=await read(entry.path),original=codeLines(file.text),lines=original.lines,out=[]
  let offset=0,newline=original.end
  for(const h of entry.hunks){
   if(h.start<offset||h.start>lines.length)throw Error('misplaced hunk')
   out.push(...lines.slice(offset,h.start))
   let removed=0,added=0
   for(const row of h.rows){
    if(row.op!=='+'&&lines[h.start+removed]!==row.text)throw Error('hunk context mismatch: '+entry.path)
    if(row.op!=='-'){out.push(row.text);added++}
    if(row.op!=='+')removed++
    if(row.noNewline&&row.op==='+')newline=false
    if(row.noNewline&&row.op==='-')newline=true
   }
   if(removed!==h.oldCount||added!==h.newCount)throw Error('hunk count mismatch')
   offset=h.start+removed
  }
  out.push(...lines.slice(offset))
  plans.push({...file,original:file.text,after:out.join('\n')+(newline&&out.length?'\n':'')})
 }
 return commit(plans,args.dryRun===true)
}

export async function codeCall(name,a={}){
 switch(name){
  case 'code_context':{const f=await read(a.path),lines=f.text.split(/\r?\n/),start=Math.max(1,Number(a.startLine)||1),end=Math.min(lines.length,Math.max(start,Number(a.endLine)||start+120));return {path:f.path,sha256:hash(f.text),totalLines:lines.length,content:lines.slice(start-1,end).map((s,i)=>(start+i)+' | '+s).join('\n')}}
  case 'code_search':return search(a)
  case 'code_symbols':return symbols(a)
  case 'code_references':{const symbol=string(a.symbol,'symbol');if(!/^[A-Za-z_$][\w$]*$/.test(symbol))throw Error('invalid identifier');return search({query:'\\b'+symbol+'\\b',path:a.path,regex:true,maxResults:a.maxResults})}
  case 'code_apply_patch':return unified(a)
  case 'code_diff':{const file=await read(a.path);return makeDiff(file.text,string(a.after,'after'),relative(process.cwd(),file.path).replace(/\\/g,'/'))}
  case 'code_patch':return edits([{path:a.path,oldText:a.oldText,newText:a.newText,expectedSha256:a.expectedSha256}],a.dryRun===true)
  case 'code_multi_edit':return edits(a.edits,a.dryRun===true)
  default:throw Error('unknown Code Engine tool: '+name)
 }
}
