#!/usr/bin/env node
// Offline integration test against the PUBLISHED @liustack/modsearch package.
// Exercises the real DSH plugin's original read_page and x_search execute()
// methods with a deterministic local CLI stub (no network/API keys).
import assert from 'node:assert/strict'
import {spawnSync,spawn} from 'node:child_process'
import {createServer} from 'node:http'
import {cp, mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {repairModsearch} from '../app/src/main/assets/modsearch-android-compat.mjs'

const installed=process.argv[2]
if(!installed)throw new Error('usage: node test-modsearch-published-plugin.mjs <npm-package-dir>')
const root=await mkdtemp(join(tmpdir(),'dsh-published-modsearch-'))
const envNames=['HOME','DSH_ANDROID_STANDALONE','DSH_ANDROID_MODSEARCH_CWD','MODSEARCH_DSH_CLI','NODE_OPTIONS']
const previous=Object.fromEntries(envNames.map(name=>[name,process.env[name]]))
try{
  const packageDir=join(root,'.dsh/profiles/web/node_modules/@liustack/modsearch')
  const appCwd=join(root,'app-home')
  // Preserve npm's complete hoisted node_modules tree, including commander.
  // Copying only the plugin folder reproduces ERR_MODULE_NOT_FOUND even though
  // both DSH tool registrations load successfully.
  await mkdir(join(root,'.dsh/profiles/web'),{recursive:true})
  await cp(resolve(installed,'../..'),join(root,'.dsh/profiles/web/node_modules'),{recursive:true,force:true})
  await mkdir(appCwd)
  const pkg=JSON.parse(await readFile(join(packageDir,'package.json'),'utf8'))
  assert.equal(pkg.name,'@liustack/modsearch')
  assert.equal(pkg.version,'5.10.11')
  assert.equal(repairModsearch(root,true).results[0].status,'patched')
  process.env.HOME=root
  process.env.DSH_ANDROID_STANDALONE='1'
  process.env.DSH_ANDROID_MODSEARCH_CWD=appCwd
  process.env.NODE_OPTIONS='--no-warnings'
  const cli=join(root,'cli-mock.mjs')
  await writeFile(cli,[
    'const a=process.argv.slice(2)',
    'const isRead=a.includes("-u")',
    'if(isRead && a.includes("https://example.com/fallback") && !a.includes("--engine")){console.error("remote engine unavailable");process.exit(2)}',
    'const entry={status:"ok",source:isRead?"web":"x",summary:JSON.stringify({cwd:process.cwd(),nodeOptions:process.env.NODE_OPTIONS??null,args:a}),content:isRead?"original read_page executed":undefined,items:[{title:"Original X post",url:"https://example.com/post/1",snippet:"sample"}],links:[],uncertainty:[],warnings:[]}',
    'console.log(JSON.stringify({results:[entry]}))'
  ].join('\n'))
  process.env.MODSEARCH_DSH_CLI=cli
  const plugin=await import(pathToFileURL(join(packageDir,'dsh/index.js')).href)
  const registered=new Map()
  plugin.apply({tools:{register(tool){registered.set(tool.name,tool)}},web:{}},{searchProvider:false,settingsCard:false})
  for(const toolName of ['read_page','x_search'])assert.ok(registered.has(toolName),'original tool absent: '+toolName)

  // Plain URL must use upstream guarded local engine without waiting for
  // cloud quotas. Focused request retains cloud first; on failure it must
  // retry through local and clearly label that focus synthesis was skipped.
  const plain=await registered.get('read_page').execute({url:'https://example.com/plain'}, {signal:AbortSignal.timeout(10000)})
  const plainArgs=JSON.parse(plain.summary).args
  assert.ok(plainArgs.includes('--engine'))
  assert.equal(plainArgs[plainArgs.indexOf('--engine')+1],'local')
  assert.equal(plainArgs[plainArgs.indexOf('--timeout')+1],'18000')
  const read=await registered.get('read_page').execute({url:'https://example.com/docs',query:'scope'}, {signal:AbortSignal.timeout(10000)})
  assert.equal(read.content,'original read_page executed')
  const x=await registered.get('x_search').execute({query:'some topic',max_results:3},{signal:AbortSignal.timeout(10000)})
  assert.equal(x.items.length,1)
  const readArgs=JSON.parse(read.summary)
  const xArgs=JSON.parse(x.summary)
  assert.equal(resolve(readArgs.cwd),resolve(appCwd))
  assert.equal(resolve(xArgs.cwd),resolve(appCwd))
  assert.equal(readArgs.nodeOptions,null)
  assert.equal(xArgs.nodeOptions,null)
  assert.ok(readArgs.args.includes('-u'))
  assert.ok(readArgs.args.includes('https://example.com/docs'))
  assert.equal(readArgs.args.includes('--engine'),false,'focused read should retain original cloud route')
  assert.equal(readArgs.args[readArgs.args.indexOf('--deadline')+1],'32000')
  const fallback=await registered.get('read_page').execute({url:'https://example.com/fallback',query:'focus'}, {signal:AbortSignal.timeout(10000)})
  const fallbackArgs=JSON.parse(fallback.summary).args
  assert.equal(fallbackArgs[fallbackArgs.indexOf('--engine')+1],'local')
  assert.ok(fallback.warnings.some(x=>x.includes('without query-specific synthesis')))

  assert.ok(xArgs.args.includes('--source'))
  assert.ok(xArgs.args.includes('x'))
  const doctor=spawnSync(process.execPath,[join(packageDir,'dist/main.js'),'doctor','--json'],{encoding:'utf8',timeout:15000,env:{...process.env,NODE_OPTIONS:''},cwd:appCwd})
  assert.equal(doctor.status,0,doctor.stderr.slice(0,2000))
  const diagnosed=JSON.parse(doctor.stdout)
  assert.equal(diagnosed.node?.ok,true,'published ModSearch doctor must accept the Node runtime')
  assert.equal(diagnosed.configFile?.exists,false,'fresh published ModSearch installation should use zero-config defaults')
  assert.equal(diagnosed.configFile?.permissionsOk,true,'zero-config mode must not require permissions repair')
  for(const role of ['search','fetch','social']){
    const item=diagnosed.roles?.find(x=>x.role===role)
    assert.ok(item,'published doctor missing role '+role)
    assert.ok(Array.isArray(item.candidates),'role must have structured candidates')
  }
  // Exercise the REAL built-in ModSearch local HTTP engine, not the CLI mock.
  // --allow-private-network is deliberately restricted to this loopback test;
  // production read_page does NOT pass this flag and retains upstream SSRF guards.
  const server=createServer((req,res)=>{
    res.writeHead(200,{'content-type':'text/html; charset=utf-8'})
    res.end('<html><head><title>DSH Test Page</title></head><body><h1>Real Local Fetch</h1><p>Deterministic page content token q7z2</p></body></html>')
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  try{
    const url='http://127.0.0.1:'+server.address().port+'/'
    const real=spawn(process.execPath,[join(packageDir,'dist/main.js'),'-u',url,'--engine','local','--allow-private-network','--timeout','10000','--deadline','15000'],{
      env:{...process.env,NODE_OPTIONS:''},cwd:appCwd,stdio:['ignore','pipe','pipe']
    })
    let stdout='',stderr=''
    real.stdout.on('data',v=>stdout+=v)
    real.stderr.on('data',v=>stderr+=v)
    const exit=await Promise.race([
      new Promise((resolve,reject)=>{real.once('error',reject);real.once('close',code=>resolve(code))}),
      new Promise((_,reject)=>setTimeout(()=>{real.kill('SIGKILL');reject(new Error('real ModSearch local fetch timed out'))},15000))
    ])
    assert.equal(exit,0,stderr.slice(0,1200))
    const data=JSON.parse(stdout)
    assert.equal(data.results?.[0]?.status,'ok')
    assert.match(JSON.stringify(data.results?.[0]),/Deterministic page content token q7z2/)
  }finally{
    await new Promise(resolve=>server.close(resolve))
  }

  console.log('[OK] published @liustack/modsearch '+pkg.version+': read_page, x_search, CLI doctor and original DSH plugin')
}finally{
 for(const name of envNames){if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name]}
 await rm(root,{recursive:true,force:true})
}
