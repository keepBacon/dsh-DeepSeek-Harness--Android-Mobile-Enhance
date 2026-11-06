#!/usr/bin/env node
// Runs the ACTUAL patched childEnv()/run() boundary with a real Node child.
// This rejects a source-only test where strings exist but subprocesses still
// inherit the wrong cwd, NODE_OPTIONS, or app-private environment.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {repairModsearch} from '../app/src/main/assets/modsearch-android-compat.mjs'
const home=await mkdtemp(join(tmpdir(),'dsh-modsearch-process-'))
const old={HOME:process.env.HOME,NODE_OPTIONS:process.env.NODE_OPTIONS,DSH_ANDROID_STANDALONE:process.env.DSH_ANDROID_STANDALONE,DSH_ANDROID_MODSEARCH_CWD:process.env.DSH_ANDROID_MODSEARCH_CWD}
try{
  const root=join(home,'.dsh/profiles/web/node_modules/@liustack/modsearch')
  const cwd=join(home,'safe-home')
  await mkdir(join(root,'dsh'),{recursive:true})
  await mkdir(join(root,'dist'),{recursive:true})
  await mkdir(cwd)
  await writeFile(join(root,'package.json'),JSON.stringify({name:'@liustack/modsearch',type:'module',version:'5.10.11'}))
  await writeFile(join(root,'dist/main.js'),"console.log('ok')")
  const plugin=join(root,'dsh/index.js')
  const code=[
    "import {spawn} from 'node:child_process';",
    "function spawnHidden(command, args, options) {return spawn(command, args, options)}",
    "function childEnv() {",
    "  return process.versions.electron ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env;",
    "}",
    "function run(command, args, signal, env) {",
    "  return new Promise((resolve,reject) => {",
    "    const child=spawnHidden(command,args,{",
    "      stdio: ['ignore', 'pipe', 'pipe'],",
    "      signal,",
    "      env,",
    "    });",
    "    let stdout='',stderr='';",
    "    child.stdout.on('data',c=>stdout+=c);",
    "    child.stderr.on('data',c=>stderr+=c);",
    "    child.on('error',reject);",
    "    child.on('close',code=>resolve({code,stdout,stderr}));",
    "  });",
    "}",
    "export async function exercise() {",
    "  return run(process.execPath,['-e', 'console.log(JSON.stringify({cwd:process.cwd(),NODE_OPTIONS:process.env.NODE_OPTIONS??null,HOME:process.env.HOME,marker:process.env.DSH_TEST_MARKER}))'],undefined,childEnv());",
    "}"
  ].join('\n')
  await writeFile(plugin,code)
  process.env.HOME=home
  process.env.DSH_ANDROID_STANDALONE='1'
  process.env.DSH_ANDROID_MODSEARCH_CWD=cwd
  // Reproduce the prior Android failure shape: a child inherits a relative
  // profile preload and Node cannot open it from its working directory.
  process.env.NODE_OPTIONS='--require=.dsh/profiles/missing-preload.cjs'
  process.env.DSH_TEST_MARKER='retained'
  const report=repairModsearch(home,true)
  assert.equal(report.results[0].status,'patched',JSON.stringify(report))
  const patched=await readFile(plugin,'utf8')
  assert.match(patched,/delete cleaned.NODE_OPTIONS/)
  const instance=await import(pathToFileURL(plugin).href+'?case=android')
  const android=await instance.exercise()
  assert.equal(android.code,0,android.stderr)
  const value=JSON.parse(android.stdout)
  assert.equal(resolve(value.cwd),resolve(cwd))
  assert.equal(value.NODE_OPTIONS,null)
  assert.equal(value.HOME,home)
  assert.equal(value.marker,'retained')
  // With the same broken inherited preload outside Android the original
  // semantics intentionally fail: this demonstrates the bug being isolated.
  process.env.DSH_ANDROID_STANDALONE='0'
  const brokenOutside=await instance.exercise()
  assert.notEqual(brokenOutside.code,0)
  assert.match(brokenOutside.stderr,/Cannot find module|MODULE_NOT_FOUND/)
  process.env.NODE_OPTIONS='--no-warnings'
  const outside=await instance.exercise()
  assert.equal(outside.code,0,outside.stderr)
  const ordinary=JSON.parse(outside.stdout)
  assert.equal(ordinary.NODE_OPTIONS,'--no-warnings','non-Android environments must retain original Node settings')
  assert.equal(resolve(ordinary.cwd),resolve(process.cwd()),'non-Android child cwd must be unchanged')
  console.log('[OK] ModSearch original child boundary: real Node subprocess, cwd, environment isolation')
}finally{
  for(const [k,v] of Object.entries(old)) { if(v===undefined)delete process.env[k];else process.env[k]=v }
  delete process.env.DSH_TEST_MARKER
  await rm(home,{recursive:true,force:true})
}
