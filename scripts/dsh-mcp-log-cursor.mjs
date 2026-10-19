import {createHash} from 'node:crypto'
const id=v=>createHash('sha256').update(v).digest('hex').slice(0,16)
const parseTime=line=>{const m=String(line).match(/^([0-9]{10}(?:\.[0-9]+)?)/);return m?Number(m[1]):null}
export function createMcpLogCursor({read,maxCursors=12}={}){
 if(typeof read!=='function')throw Error('logcat reader required')
 const sessions=new Map()
 async function delta({cursor='default',package:pkg,tag,level='W',maxLines=100}={}){
  if(typeof cursor!=='string'||!/^[a-z0-9_-]{1,40}$/i.test(cursor))throw Error('invalid cursor')
  if(pkg!==undefined&&(typeof pkg!=='string'||!/^[-a-zA-Z0-9_.]{1,140}$/.test(pkg)))throw Error('invalid package')
  if(tag!==undefined&&(typeof tag!=='string'||!/^[A-Za-z0-9_.-]{1,80}$/.test(tag)))throw Error('invalid tag')
  if(!/^[VDIWEF]$/.test(level))throw Error('invalid level')
  const take=Number.isSafeInteger(maxLines)?Math.min(200,Math.max(1,maxLines)):100
  const key=JSON.stringify([cursor,pkg||'',tag||'',level])
  const previous=sessions.get(key)
  const now=Date.now(),seconds=previous?Math.min(86400,Math.max(1,Math.ceil((now-previous.at)/1000)+3)):60
  const result=await read({package:pkg,tag,level,maxLines:Math.min(1000,take*4),sinceSeconds:seconds})
  const lines=Array.isArray(result.lines)?result.lines:[]
  const oldHashes=previous?.recent||new Set(),found=[]
  for(const line of lines){
   if(typeof line!=='string')continue
   const token=id(line)
   if(!oldHashes.has(token))found.push(line)
  }
  const unique=new Set(lines.slice(-600).filter(x=>typeof x==='string').map(id))
  if(sessions.size>=maxCursors&&!sessions.has(key))sessions.delete(sessions.keys().next().value)
  sessions.set(key,{at:now,recent:unique})
  return {cursor,package:pkg||null,tag:tag||null,level,lines:found.slice(-take),
   truncated:result.truncated||found.length>take,firstRead:!previous,
   note:'Process-local cursor; restart resets history. Android logcat may omit restricted entries.'}
 }
 return {delta}
}
