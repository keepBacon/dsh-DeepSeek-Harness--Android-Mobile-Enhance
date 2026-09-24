#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
const fail=(m)=>{console.error('[DSH family lock] '+m);process.exit(2)}
const readJson=(f)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch(e){fail('cannot read '+f+': '+(e instanceof Error?e.message:String(e)))}}
function family(file,expected){
  const x=readJson(file)
  if(x?.schema!==1||typeof x.version!=='string'||!Array.isArray(x.packages))fail('invalid release-family lock')
  if(expected!==undefined&&x.version!==expected)fail('family lock '+x.version+' does not match requested '+expected)
  x.packages=[...new Set(x.packages)]
  if(!x.packages.includes('@deepseek-ai/dsh')||x.packages.length<200)fail('incomplete release-family lock')
  return x
}
function lockName(k,e){
  if(typeof e?.name==='string')return e.name
  const mark='node_modules/',at=k.lastIndexOf(mark);if(at<0)return undefined
  const p=k.slice(at+mark.length).split('/')
  return p[0]?.startsWith('@')?(p.length>1?p.slice(0,2).join('/'):undefined):(p[0]||undefined)
}
function check(n,v,f,w,out){
  if(n!=='@deepseek-ai/dsh'&&!n.startsWith('@deepseek-ai/dsh-'))return false
  if(!f.packages.includes(n))out.push(w+': unknown DSH-family package '+n+'@'+String(v))
  else if(v!==f.version)out.push(w+': version skew '+n+'@'+String(v)+'; expected '+f.version)
  return true
}
function verifyLock(f,file){
  const l=readJson(file);if(l?.packages===undefined)fail('unsupported npm lock: '+file)
  const out=[];let count=0,root=false
  for(const [k,e] of Object.entries(l.packages)){const n=lockName(k,e);if(typeof n!=='string')continue;if(check(n,e?.version,f,k||'<root>',out)){count++;if(n==='@deepseek-ai/dsh')root=true}}
  if(!root)out.push('package-lock does not contain @deepseek-ai/dsh')
  if(out.length)fail('release-family skew in resolved npm lock:\n'+out.slice(0,40).join('\n'))
  console.log('[DSH] DSH release-family lock: OK ('+count+' package entries @ '+f.version+')')
}
function verifyInstalled(f,root){
  const out=[],stack=[path.resolve(root)],visited=new Set();let count=0,rootSeen=false
  while(stack.length){
    const dir=stack.pop();let real;try{real=fs.realpathSync(dir)}catch{continue}
    if(visited.has(real))continue;visited.add(real)
    let es;try{es=fs.readdirSync(dir,{withFileTypes:true})}catch{continue}
    const mf=path.join(dir,'package.json')
    if(fs.existsSync(mf)){try{const p=readJson(mf);if(typeof p.name==='string'&&check(p.name,p.version,f,mf,out)){count++;if(p.name==='@deepseek-ai/dsh')rootSeen=true}}catch{}}
    for(const e of es){if(!e.isDirectory()||e.isSymbolicLink()||['.cache','.git','build'].includes(e.name))continue;stack.push(path.join(dir,e.name))}
  }
  if(!rootSeen)out.push('installed tree does not contain @deepseek-ai/dsh')
  if(out.length)fail('release-family skew in installed runtime:\n'+out.slice(0,40).join('\n'))
  console.log('[DSH] Installed DSH release family: OK ('+count+' package entries @ '+f.version+')')
}
const [mode,file,a,b]=process.argv.slice(2)
if(!mode||!file)fail('usage: dsh-runtime-family.mjs <manifest|verify-lock|verify-installed> <family-lock> ...')
if(mode==='manifest'){
  if(!a||!b)fail('manifest needs <dsh-version> <pnpm-version>')
  const f=family(file,a),overrides={}
  for(const n of f.packages)if(n!=='@deepseek-ai/dsh')overrides[n]=f.version
  process.stdout.write(JSON.stringify({name:'dsh-android-runtime-install',version:'0.0.0',private:true,dependencies:{'@deepseek-ai/dsh':f.version,pnpm:b},overrides},null,2)+'\n')
}else if(mode==='verify-lock'){if(!a)fail('verify-lock needs lock path');verifyLock(family(file,b),a)
}else if(mode==='verify-installed'){if(!a)fail('verify-installed needs node_modules path');verifyInstalled(family(file,b),a)
}else fail('unknown mode: '+mode)
