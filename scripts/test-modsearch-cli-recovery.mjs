#!/usr/bin/env node
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,readFile,writeFile,rm,access} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {repairModsearch} from '../app/src/main/assets/modsearch-android-compat.mjs'

const root=await mkdtemp(join(tmpdir(),'dsh-modsearch-recovery-'))
const previous={home:process.env.HOME,android:process.env.DSH_ANDROID_STANDALONE,recovery:process.env.DSH_ANDROID_MODSEARCH_RECOVERY}
async function packageFile(folder,name,version,extra={}){
  await mkdir(folder,{recursive:true})
  await writeFile(join(folder,'package.json'),JSON.stringify({name,version,type:'module',...extra}))
}
try {
  const home=join(root,'home')
  const profile=join(home,'.dsh/profiles/web/node_modules/@liustack/modsearch')
  const resources=join(root,'resources/node_modules')
  await packageFile(profile,'@liustack/modsearch','5.10.11',{dependencies:{commander:'^13.1.0',undici:'^7.29.0'}})
  await mkdir(join(profile,'dsh'),{recursive:true})
  const body=[
    'function childEnv() { return process.env }',
    'function run(command, args, signal, env) {',
    '  const child=spawnHidden(command,args,{',
    "      stdio: ['ignore', 'pipe', 'pipe'],",
    '      signal,',
    '      env,',
    '    });',
    '  return child;',
    '}',
    'function registerReadPageTool(ctx) {',
    '  async function execute(args, exec) {',
    "    const cliArgs = ['-u', args.url, ...ownToolBudget()];",
    '    const entry = await runCli(cliArgs, exec.signal);',
    '    return entry;',
    '  }',
    '}',
    "/** The CLI budget flags for the plugin's own tools. */"
  ].join('\n')
  await writeFile(join(profile,'dsh/index.js'),body)
  await writeFile(join(profile,'user-plugin-notes.txt'),'keep exactly')
  const published=join(resources,'@liustack/modsearch')
  await packageFile(published,'@liustack/modsearch','5.10.11')
  await mkdir(join(published,'dist'),{recursive:true})
  await writeFile(join(published,'dist/main.js'),'console.log("recoverable-cli")')
  await mkdir(join(published,'dsh'),{recursive:true})
  await writeFile(join(published,'dsh/index.js'),body)
  await writeFile(join(published,'package.json'),JSON.stringify({name:'@liustack/modsearch',version:'5.10.11',dependencies:{commander:'^13.1.0',undici:'^7.29.0'}}))
  for(const [name,version] of [['commander','13.1.0'],['undici','7.29.0']]){
    await packageFile(join(resources,name),name,version,{main:'index.js'})
    await writeFile(join(resources,name,'index.js'),'export const loaded=true')
  }
  process.env.HOME=home
  process.env.DSH_ANDROID_STANDALONE='1'
  process.env.DSH_ANDROID_MODSEARCH_RECOVERY=resources
  const first=repairModsearch(home,true).results.find(x=>x.profile==='web')
  assert.equal(first.status,'patched',JSON.stringify(first))
  assert.deepEqual(first.restored,['dist/main.js','node_modules/commander','node_modules/undici'])
  assert.equal(await readFile(join(profile,'dist/main.js'),'utf8'),'console.log("recoverable-cli")')
  assert.equal(await readFile(join(profile,'user-plugin-notes.txt'),'utf8'),'keep exactly')
  assert.match(await readFile(join(profile,'dsh/index.js'),'utf8'),/bounded original read_page local fallback/)
  assert.equal((repairModsearch(home,true).results.find(x=>x.profile==='web')).status,'already-patched')
  // The profile still declares the exact package, but node_modules was
  // removed: reinstate the original published plugin without editing profile.
  const headless=join(home,'.dsh/profiles/headless')
  await mkdir(headless,{recursive:true})
  const declaration=JSON.stringify({dependencies:{'@liustack/modsearch':'^5.10.11'},custom:'preserve'})
  await writeFile(join(headless,'package.json'),declaration)
  const missing=repairModsearch(home,true).results.find(x=>x.profile==='headless')
  assert.equal(missing.status,'patched',JSON.stringify(missing))
  assert.ok(missing.restored.includes('package'))
  assert.equal(await readFile(join(headless,'package.json'),'utf8'),declaration)
  assert.equal((repairModsearch(home,true).results.find(x=>x.profile==='headless')).status,'already-patched')
  // Same app environment must not touch incompatible installed versions.
  await writeFile(join(profile,'package.json'),JSON.stringify({name:'@liustack/modsearch',version:'5.11.0'}))
  const ignored=repairModsearch(home,true).results.find(x=>x.profile==='web')
  assert.equal(ignored.warning,'unsupported-published-version')
  console.log('[OK] offline original ModSearch CLI + dependencies recovery, backups, no overwrite, idempotence')
}finally{
  for(const [k,v] of [['HOME',previous.home],['DSH_ANDROID_STANDALONE',previous.android],['DSH_ANDROID_MODSEARCH_RECOVERY',previous.recovery]]) {
    if(v===undefined)delete process.env[k];else process.env[k]=v
  }
  await rm(root,{recursive:true,force:true})
}
