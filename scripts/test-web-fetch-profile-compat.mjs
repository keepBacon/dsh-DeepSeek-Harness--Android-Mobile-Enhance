#!/usr/bin/env node
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {patchInstalledWebFetch} from '../app/src/main/assets/web-fetch-android-compat.mjs'

const home=await mkdtemp(join(tmpdir(),'dsh-web-fetch-profile-'))
try{
 const root=join(home,'.dsh/profiles/web/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
 const examples=[
  ['dsh-web-fetch-http','maxResponseBytes: z.number().default(5e6), maxBodyChars: z.number().default(1e5)'],
  ['dsh-tool-web','const DEFAULT_FETCH_MAX_OUTPUT_CHARS = 200_000']
 ]
 for(const [name,content] of examples){
  const dir=join(root,name)
  await mkdir(join(dir,'lib'),{recursive:true})
  await writeFile(join(dir,'package.json'),JSON.stringify({name:'@deepseek-ai/'+name}))
  await writeFile(join(dir,'lib/index.js'),content)
 }
 const report=patchInstalledWebFetch(home)
 assert.equal(report.errorCount,0,JSON.stringify(report))
 assert.equal(report.foundProvider,true)
 assert.equal(report.foundRenderer,true)
 const provider=await readFile(join(root,'dsh-web-fetch-http/lib/index.js'),'utf8')
 assert.match(provider,/maxBodyChars: z\.number\(\)\.default\(400000\)/)
 assert.match(provider,/maxResponseBytes: z\.number\(\)\.default\(16777216\)/)
 assert.equal(patchInstalledWebFetch(home).errorCount,0)
 const unchanged=await readFile(join(root,'dsh-web-fetch-http/lib/index.js'),'utf8')
 assert.equal(provider,unchanged)
 assert.match(await readFile(join(root,'dsh-web-fetch-http/lib/index.js.dsh-before-web-fetch-cap.bak'),'utf8'),/1e5/)
 const broken=join(root,'dsh-web-fetch-http/lib/index.js')
 await writeFile(broken,'maxBodyChars: z.number().default(5), maxResponseBytes: z.number().default(5000000)')
 assert.equal(patchInstalledWebFetch(home).errorCount,1)
 assert.match(await readFile(broken,'utf8'),/default\(5\)/)
 console.log('[OK] actual nested Web-profile 1e5/5e6 repair, backup, idempotence and fail-closed')
}finally{await rm(home,{recursive:true,force:true})}
