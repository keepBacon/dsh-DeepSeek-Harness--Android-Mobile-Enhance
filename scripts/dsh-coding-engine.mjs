import {createHash} from 'node:crypto'
import {readFile,readdir,lstat,realpath,writeFile,rename,rm,mkdir,mkdtemp} from 'node:fs/promises'
import {resolve,relative,dirname,join,extname} from 'node:path'
const FILE_LIMIT=4000,BYTES_LIMIT=8*1024*1024
const CODE_EXT=new Set(['.kt','.java','.js','.mjs','.cjs','.ts','.tsx','.jsx','.py','.c','.cc','.cpp','.h','.hpp','.rs','.go','.lua','.sh'])
const IGNORE=new Set(['.git','node_modules','build','dist','.gradle','.idea','vendor','.dsh','coverage','__pycache__'])
const hash=s=>createHash('sha256').update(s).digest('hex')
async function rootPath(p){const root=await realpath(resolve(p||'.'));if(!(await lstat(root)).isDirectory())throw Error('not a directory');return root}
function safeName(s){if(typeof s!=='string'||!s||s.includes('\0')||s.startsWith('/')||s.includes('\\')||s.split('/').some(x=>x==='..'||x===''||x==='.')||s.length>512)throw Error('unsafe relative path');return s}
async function contained(root,name,{allowNew=false}={}){safeName(name);const target=resolve(root,name);if(relative(root,target).startsWith('..'))throw Error('path escape');let parent=dirname(target);while(parent!==root){let entry=await lstat(parent).catch(e=>{if(e.code==='ENOENT'&&allowNew)return null;throw e});if(entry?.isSymbolicLink())throw Error('symlink parent');parent=dirname(parent)}const entry=await lstat(target).catch(e=>{if(e.code==='ENOENT'&&allowNew)return null;throw e});if(entry?.isSymbolicLink()||entry&&!entry.isFile())throw Error('target not regular file');return target}
async function inventory(root){
 const files=[],dirs=['']
 while(dirs.length&&files.length<FILE_LIMIT){
  const folder=dirs.shift(),items=await readdir(resolve(root,folder),{withFileTypes:true})
  items.sort((a,b)=>a.name.localeCompare(b.name))
  for(const item of items){
   if(item.isSymbolicLink())continue
   const name=folder?folder+'/'+item.name:item.name
   if(item.isDirectory()){if(!IGNORE.has(item.name)&&dirs.length<FILE_LIMIT)dirs.push(name)}
   else if(item.isFile()&&CODE_EXT.has(extname(item.name)))files.push(name)
   if(files.length>=FILE_LIMIT)break
  }
 }
 return files
}
function symbols(source,file){
 const ext=extname(file),out=[]
 const patterns=ext==='.py'?[ /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm ]:
 ext==='.kt'||ext==='.java'?[ /^\s*(?:public |private |protected |internal |open |suspend |static |final |abstract |override |data )*(?:class|interface|object|enum|fun)\s+(?:<[^>]+>\s*)?([A-Za-z_]\w*)/gm ]:
 ext==='.rs'?[ /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|mod)\s+([A-Za-z_]\w*)/gm ]:
 ext==='.go'?[ /^\s*(?:func|type)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm ]:
 ext==='.lua'?[ /^\s*(?:local\s+)?function\s+([A-Za-z_][\w.:]*)/gm ]:
 [ /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,/^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/gm ]
 for(const p of patterns){for(const m of source.matchAll(p)){out.push({name:m[1],line:source.slice(0,m.index).split('\n').length}) ;if(out.length>=300)break}}
 return out.sort((a,b)=>a.line-b.line)
}
export async function codebaseMap(input={}){
 const root=await rootPath(input.root),files=await inventory(root),byType={},entries=[]
 for(const file of files){byType[extname(file)]=(byType[extname(file)]||0)+1;if(entries.length<150)entries.push(file)}
 return {root,files:files.length,truncated:files.length>=FILE_LIMIT,byType,sample:entries}
}
export async function codeSymbols(input={}){
 const root=await rootPath(input.root),files=input.path?[safeName(input.path)]:await inventory(root)
 const query=typeof input.query==='string'?input.query.toLowerCase():null
 const result=[],limit=Math.min(200,Math.max(1,input.limit||60))
 for(const file of files){const path=await contained(root,file);const info=await lstat(path);if(info.size>512*1024)continue
  const content=await readFile(path,'utf8');for(const symbol of symbols(content,file)){if(query&&!symbol.name.toLowerCase().includes(query))continue;result.push({path:file,...symbol});if(result.length>=limit)return{symbols:result,truncated:true}}}
 return{symbols:result,truncated:false}
}
export async function codeImpact(input={}){
 const root=await rootPath(input.root),names=input.paths
 if(!Array.isArray(names)||!names.length||names.length>64)throw Error('paths required (1..64)')
 const files=await inventory(root),terms=new Set()
 for(const name of names){const normalized=safeName(name),leaf=normalized.split('/').at(-1).replace(/\.[^.]+$/,'');if(leaf.length>2)terms.add(leaf)}
 const affected=[],limit=Math.min(100,Math.max(1,input.limit||40))
 for(const path of files){if(names.includes(path))continue;const info=await lstat(await contained(root,path));if(info.size>256*1024)continue;const source=await readFile(resolve(root,path),'utf8')
  const matches=[...terms].filter(t=>source.includes(t));if(matches.length)affected.push({path,matched:matches});if(affected.length>=limit)break}
 return{changed:names,possibleReferences:affected,truncated:affected.length>=limit,note:'Textual heuristic, not a compiler-confirmed dependency graph'}
}
export async function codeEditTransaction(input={}){
 const root=await rootPath(input.root),changes=input.changes,dryRun=input.dryRun!==false
 if(!Array.isArray(changes)||!changes.length||changes.length>16)throw Error('changes required (1..16)')
 const targets=[],seen=new Set()
 for(const item of changes){
  const file=safeName(item.path);if(seen.has(file))throw Error('duplicate file '+file);seen.add(file)
  const target=await contained(root,file);const info=await lstat(target);if(info.size>1024*1024)throw Error('file too large')
  const before=await readFile(target,'utf8'),digest=hash(before)
  if(item.expectedSha256!==digest)throw Error('stale file '+file+' (expectedSha256 required)')
  if(typeof item.oldText!=='string'||!item.oldText||typeof item.newText!=='string')throw Error('invalid replacement')
  const count=before.split(item.oldText).length-1
  if(count!==1)throw Error('ambiguous patch '+file+': '+count+' matches')
  const after=before.replace(item.oldText,item.newText)
  targets.push({file,target,before,after,beforeHash:digest,afterHash:hash(after)})
 }
 if(dryRun)return{dryRun:true,changes:targets.map(x=>({path:x.file,beforeSha256:x.beforeHash,afterSha256:x.afterHash}))}
 const staged=[],committed=[]
 try{
  for(const item of targets){
   const current=await readFile(await contained(root,item.file),'utf8')
   if(hash(current)!==item.beforeHash)throw Error('concurrent modification '+item.file)
   const temp=item.target+'.dsh-stage-'+process.pid+'-'+Math.random().toString(36).slice(2)
   await writeFile(temp,item.after,{flag:'wx',mode:(await lstat(item.target)).mode&0o777})
   staged.push({item,temp})
  }
  for(const {item,temp} of staged){const current=await readFile(await contained(root,item.file),'utf8');if(hash(current)!==item.beforeHash)throw Error('concurrent modification '+item.file);await rename(temp,item.target);committed.push(item)}
 }catch(e){
  for(const item of committed.reverse()){
   try {if(hash(await readFile(item.target,'utf8'))===item.afterHash)await writeFile(item.target,item.before)}catch{}
  }
  throw e
 }finally {for(const x of staged)await rm(x.temp,{force:true}).catch(()=>{})}
 return{dryRun:false,changes:targets.map(x=>({path:x.file,beforeSha256:x.beforeHash,afterSha256:x.afterHash}))}
}
async function selfTest(){
 const d=await mkdtemp(join(process.env.TMPDIR||'/tmp','dsh-code-'))
 try{
  await mkdir(join(d,'src'));await writeFile(join(d,'src','a.js'),'export function alpha() {return 1}\n');await writeFile(join(d,'src','b.js'),'import {alpha} from "./a.js"\n')
  const map=await codebaseMap({root:d});if(map.files!==2)throw Error('inventory failed')
  const syms=await codeSymbols({root:d,query:'alpha'});if(syms.symbols.length!==1)throw Error('symbols failed')
  const impact=await codeImpact({root:d,paths:['src/a.js']});if(!impact.possibleReferences.some(x=>x.path==='src/b.js'))throw Error('impact failed')
  const prior=await readFile(join(d,'src','a.js'),'utf8'),digest=hash(prior)
  let stale=false;try{await codeEditTransaction({root:d,dryRun:false,changes:[{path:'src/a.js',expectedSha256:'bad',oldText:'return 1',newText:'return 2'}]})}catch{stale=true}if(!stale)throw Error('stale guard failed')
  const patch={path:'src/a.js',expectedSha256:digest,oldText:'return 1',newText:'return 2'}
  await codeEditTransaction({root:d,changes:[patch]});if(await readFile(join(d,'src','a.js'),'utf8')!==prior)throw Error('dryRun modified file')
  await codeEditTransaction({root:d,dryRun:false,changes:[patch]});if(!(await readFile(join(d,'src','a.js'),'utf8')).includes('return 2'))throw Error('patch failed')
  process.stdout.write('[DSH] Coding Engine P0/P1 self-test: OK\n')
 }finally{await rm(d,{recursive:true,force:true})}
}
if(process.argv.includes('--self-test'))selfTest().catch(e=>{console.error(e);process.exitCode=1})
