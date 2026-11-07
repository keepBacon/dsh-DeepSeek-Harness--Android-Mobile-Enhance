#!/usr/bin/env node
// Modify actual app-private Web-profile npm modules before DSH Host starts.
// No user YAML, credentials, package.json, sessions, or provider config edits.
import {existsSync,lstatSync,readFileSync,writeFileSync,copyFileSync,renameSync,unlinkSync,chmodSync,readdirSync,realpathSync} from 'node:fs'
import {resolve,join,relative} from 'node:path'
import {randomBytes} from 'node:crypto'

const names=new Map([['@deepseek-ai/dsh-web-fetch-http','provider'],['@deepseek-ai/dsh-tool-web','renderer']])
const num='\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+\\-]?\\d+)?'
const defaultRE=name=>new RegExp('(\\b'+name+'\\s*:\\s*z\\.number\\(\\)\\.default\\(\\s*)('+num+')(\\s*\\))','g')
const renderRE=new RegExp('(\\b(?:const|let|var)\\s+DEFAULT_FETCH_MAX_OUTPUT_CHARS\\s*=\\s*)('+num+')','g')
const safe=(root,file)=>{
 const rel=relative(root,file)
 return rel===''||(rel!=='..'&&!rel.startsWith('../')&&!rel.startsWith('..\\')&&!rel.startsWith('/'))
}
const normalize=v=>v.replaceAll('_','').toLowerCase()
function adjusted(text,kind){
 let next=text
 if(kind==='provider'){
  for(const [name,value,accepted] of [
   ['maxBodyChars','400000',['100000','1e5','1e+5','1000000','1e6','400000']],
   ['maxResponseBytes','16777216',['5000000','5e6','5e+6','16777216']]
  ]){
   const re=defaultRE(name),matches=[...next.matchAll(re)]
   if(matches.length!==1)throw Error(name+' default count='+matches.length)
   if(!accepted.includes(normalize(matches[0][2])))throw Error(name+' unexpected default '+matches[0][2])
   next=next.replace(re,(_m,a,_v,b)=>a+value+b)
  }
 }else{
  const matches=[...next.matchAll(renderRE)]
  if(matches.length!==1)throw Error('renderer default count='+matches.length)
  if(!['200000','2e5','2e+5','400000','1000000','1e6'].includes(normalize(matches[0][2])))
   throw Error('renderer unexpected default '+matches[0][2])
  next=next.replace(renderRE,(_m,a)=>a+'400000')
 }
 return next
}
function patch(file,kind){
 const original=readFileSync(file,'utf8'),next=adjusted(original,kind)
 if(original===next)return 'already'
 if(adjusted(next,kind)!==next)throw Error('failed cap post-verification')
 const backup=file+'.dsh-before-web-fetch-cap.bak'
 if(!existsSync(backup))copyFileSync(file,backup)
 const mode=lstatSync(file).mode&0o777
 const temp=file+'.dsh-tmp-'+randomBytes(5).toString('hex')
 try{writeFileSync(temp,next,{flag:'wx',mode});chmodSync(temp,mode);renameSync(temp,file)}
 finally{try{unlinkSync(temp)}catch{}}
 return 'patched'
}
function scan(root,home,results){
 if(!existsSync(root))return
 const stack=[root],visited=new Set()
 let count=0
 while(stack.length){
  const current=stack.pop()
  if(++count>30000)throw Error('profile node_modules scan bound exceeded')
  const real=realpathSync(current)
  if(!safe(home,real)||visited.has(real))continue
  visited.add(real)
  for(const entry of readdirSync(current,{withFileTypes:true})){
   const target=join(current,entry.name)
   if(entry.isSymbolicLink())continue
   if(entry.isFile()&&entry.name==='package.json'){
    let pkg
    try{pkg=JSON.parse(readFileSync(target,'utf8'))}catch{continue}
    const kind=names.get(pkg.name)
    if(!kind)continue
    const file=join(current,'lib/index.js')
    if(!existsSync(file)||lstatSync(file).isSymbolicLink()){
     results.push({package:pkg.name,status:'module-missing'});continue
    }
    try{results.push({package:pkg.name,status:patch(file,kind)})}
    catch(e){results.push({package:pkg.name,status:'error',reason:String(e.message).slice(0,200)})}
   }else if(entry.isDirectory()&&!['.git','cache','dist','build'].includes(entry.name))stack.push(target)
  }
 }
}
export function patchInstalledWebFetch(home){
 const canonical=realpathSync(resolve(home)),results=[]
 for(const profile of ['web','headless'])scan(join(canonical,'.dsh/profiles',profile,'node_modules'),canonical,results)
 return {packages:results,foundProvider:results.some(x=>x.package==='@deepseek-ai/dsh-web-fetch-http'),
  foundRenderer:results.some(x=>x.package==='@deepseek-ai/dsh-tool-web'),
  errorCount:results.filter(x=>x.status==='error').length}
}
if(process.argv[1]&&resolve(process.argv[1])===new URL(import.meta.url).pathname){
 if(process.argv[2]!=='--apply'||!process.argv[3]){console.error('usage: web-fetch-android-compat.mjs --apply <app-private-home>');process.exitCode=2}
 else try{const result=patchInstalledWebFetch(process.argv[3]);console.log(JSON.stringify(result));if(result.errorCount)process.exitCode=1}
 catch(e){console.error('web_fetch compatibility: '+String(e.message));process.exitCode=1}
}
