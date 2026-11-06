#!/usr/bin/env node
import assert from 'node:assert/strict'
import {mkdtemp, mkdir, readFile, writeFile, rm, symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {resolve, join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {repairModsearch} from '../app/src/main/assets/modsearch-android-compat.mjs'
const home=await mkdtemp(join(tmpdir(),'dsh-modsearch-'))
try{
  const root=join(home,'.dsh/profiles/web/node_modules/@liustack/modsearch')
  await mkdir(join(root,'dsh'),{recursive:true})
  await mkdir(join(root,'dist'),{recursive:true})
  await writeFile(join(root,'package.json'),JSON.stringify({name:'@liustack/modsearch',version:'5.10.11'}))
  await writeFile(join(root,'dist/main.js'),'process.stdout.write("original CLI")')
  const plugin=join(root,'dsh/index.js')
  const body=[
    "export function run(command, args, signal, env) {",
    "  const child = spawnHidden(command, args, {",
    "      stdio: ['ignore', 'pipe', 'pipe'],",
    "      signal,",
    "      env,",
    "    });",
    "  return child;",
    "}"
  ].join('\n')
  await writeFile(plugin,body)
  const before=repairModsearch(home,false)
  assert.equal(before.results.find(x=>x.profile==='web').status,'ready')
  assert.equal(await readFile(plugin,'utf8'),body)
  const first=repairModsearch(home,true)
  assert.equal(first.results.find(x=>x.profile==='web').status,'patched')
  const next=await readFile(plugin,'utf8')
  assert.match(next,/DSH Android modsearch: stable app-private CLI cwd/)
  assert.match(next,/DSH_ANDROID_MODSEARCH_CWD/)
  assert.match(next,/DSH_ANDROID_STANDALONE/)
  assert.equal(await readFile(plugin+'.dsh-pre-android-cwd.bak','utf8'),body)
  assert.equal(repairModsearch(home,true).results.find(x=>x.profile==='web').status,'already-patched')
  const other=join(home,'.dsh/profiles/headless/node_modules/@liustack/modsearch')
  await mkdir(join(other,'dsh'),{recursive:true})
  await mkdir(join(other,'dist'),{recursive:true})
  await writeFile(join(other,'package.json'),JSON.stringify({name:'someone-else'}))
  await writeFile(join(other,'dist/main.js'),'hello')
  await writeFile(join(other,'dsh/index.js'),body)
  assert.equal(repairModsearch(home,true).results.find(x=>x.profile==='headless').status,'unexpected-package-identity')
  assert.equal(await readFile(join(other,'dsh/index.js'),'utf8'),body)
  const badRoot=join(home,'out-of-home')
  await mkdir(badRoot,{recursive:true})
  const link=join(home,'.dsh/profiles/headless/node_modules/@liustack/modsearch')
  await rm(link,{recursive:true})
  await symlink(badRoot,link)
  assert.equal(repairModsearch(home,true).results.find(x=>x.profile==='headless').status,'unexpected-package-identity')
  // Syntax-check patched file by prepending a minimal import stub.
  const syntax=spawnSync(process.execPath,['--check','--input-type=module'],{input:next,encoding:'utf8'})
  assert.equal(syntax.status,0,syntax.stderr)
  console.log('[OK] original ModSearch DSH bundle compat: idempotent, guarded, backed up, parseable')
}finally{
 await rm(home,{recursive:true,force:true})
}
