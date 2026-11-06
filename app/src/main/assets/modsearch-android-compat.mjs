#!/usr/bin/env node
// Android-only compatibility for the original @liustack/modsearch DSH bundle.
// No replacement tools, providers or credentials are installed. The only
// change is where the ORIGINAL plugin's CLI child starts: the app-private HOME
// instead of an incidental DSH profile / workspace cwd.
// Source anchor: liustack/modsearch@5.10.11 dsh/index.js, function run().
import {existsSync, lstatSync, readFileSync, realpathSync, statSync, copyFileSync, chmodSync, writeFileSync, renameSync, unlinkSync, mkdirSync} from 'node:fs'
import {resolve, join, relative, dirname} from 'node:path'
import {randomBytes} from 'node:crypto'

const MARKER='DSH Android modsearch: stable app-private CLI cwd'
const OLD='      signal,\n      env,\n    });'
const NEW='      signal,\n      env,\n      // '+MARKER+'\n      ...(process.env.DSH_ANDROID_STANDALONE === "1" ? { cwd: process.env.DSH_ANDROID_MODSEARCH_CWD || process.env.HOME || process.cwd() } : {}),\n    });'
function scoped(root, path) {
  const rel=relative(root,path)
  return rel==='' || (rel!=='..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !rel.startsWith('/'))
}
function verifyManifest(dir){
  const manifest=JSON.parse(readFileSync(join(dir,'package.json'),'utf8'))
  return manifest.name==='@liustack/modsearch'
}
function inspectProfile(home, name){
  const profile=resolve(home,'.dsh','profiles',name)
  const pkg=join(profile,'node_modules','@liustack','modsearch')
  if(!existsSync(pkg))return {profile:name,status:'absent'}
  const resolved=realpathSync(pkg)
  // Follow pnpm links inside the app-private profile tree; never modify an
  // arbitrary absolute link pointing elsewhere, even if its name matches.
  if(!scoped(home,resolved))return {profile:name,status:'external-package-path',packagePath:resolved}
  if(!verifyManifest(resolved))return {profile:name,status:'unexpected-package-identity'}
  const plugin=join(resolved,'dsh','index.js')
  const cli=join(resolved,'dist','main.js')
  if(!existsSync(plugin))return {profile:name,status:'plugin-entry-missing'}
  if(!existsSync(cli))return {profile:name,status:'cli-build-missing',advice:'Install the npm package, not the GitHub source URL'}
  const cliStat=statSync(cli)
  if(!cliStat.isFile())return {profile:name,status:'cli-not-a-file'}
  return {profile:name,status:'ready',plugin,cli,packagePath:resolved}
}
function patchPlugin(file) {
  const before=readFileSync(file,'utf8')
  if(before.includes(MARKER))return 'already-patched'
  if(!before.includes('function run(command, args, signal, env)') && !before.includes('function run(command,args,signal,env)'))
    return 'unknown-plugin-version'
  const count=before.split(OLD).length-1
  if(count!==1)return 'unexpected-spawn-shape-'+count
  const next=before.replace(OLD,NEW)
  const backup=file+'.dsh-pre-android-cwd.bak'
  if(!existsSync(backup))copyFileSync(file,backup)
  const mode=statSync(file).mode & 0o777
  const temp=file+'.dsh-tmp-'+randomBytes(6).toString('hex')
  try {
    writeFileSync(temp,next,{flag:'wx',mode})
    chmodSync(temp,mode)
    renameSync(temp,file)
  }finally{if(existsSync(temp))unlinkSync(temp)}
  return 'patched'
}
export function repairModsearch(home, write=false){
  const canonical=realpathSync(home)
  const results=[]
  for(const name of ['web','headless']){
    try{
      const item=inspectProfile(canonical,name)
      if(item.status!=='ready'){results.push(item);continue}
      results.push({profile:name,status:write?patchPlugin(item.plugin):'ready',cliPresent:true})
    }catch(error){
      results.push({profile:name,status:'error',error:String(error?.code||error?.message||error).slice(0,240)})
    }
  }
  return {home:canonical,write,results}
}
if(process.argv[1] && resolve(process.argv[1])===new URL(import.meta.url).pathname){
  const flag=process.argv[2]
  const home=process.argv[3]
  if(!['--repair-home','--inspect-home'].includes(flag)||!home){
    console.error('Usage: node modsearch-android-compat.mjs --repair-home|--inspect-home <app-private-home>')
    process.exitCode=2
  }else{
    const report=repairModsearch(home,flag==='--repair-home')
    console.log(JSON.stringify(report))
    if(report.results.some(x=>x.status==='error'))process.exitCode=1
  }
}
