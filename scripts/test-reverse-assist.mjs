#!/usr/bin/env node
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {reverseAssistTools,reverseAssistCall} from './dsh-reverse-assist.mjs'
import {mobileDispatchToolCall} from './dsh-mobile-toolbox-mcp.mjs'
const names=new Set(reverseAssistTools.map(t=>t.name))
for(const name of ['reverse_scan_obfuscation','reverse_decode_literal','reverse_extract_strings','reverse_identifier_profile','reverse_file_entropy','reverse_sourcemap_inspect'])assert.ok(names.has(name))
const hex=await reverseAssistCall('reverse_decode_literal',{encoding:'hex',text:'48656c6c6f'})
assert.equal(hex.utf8,'Hello')
assert.equal((await reverseAssistCall('reverse_decode_literal',{encoding:'luau-decimal',text:'\\072\\101\\108\\108\\111'})).utf8,'Hello')
assert.equal((await reverseAssistCall('reverse_decode_literal',{encoding:'charcodes',text:'72, 101, 108, 108, 111'})).utf8,'Hello')
for(const bad of ['GG','0','abc'])await assert.rejects(()=>reverseAssistCall('reverse_decode_literal',{encoding:'hex',text:bad}))
const input='const _0xabc123 = "\\x48\\x65\\x6c\\x6c\\x6f"; eval(_0xabc123);'
const scan=await reverseAssistCall('reverse_scan_obfuscation',{source:input})
assert.ok(scan.findings.some(x=>x.kind==='dynamic-evaluation'))
assert.ok(scan.findings.some(x=>x.kind==='hex-like-identifier'))
const strings=await reverseAssistCall('reverse_extract_strings',{source:input})
assert.equal(strings.results[0].decodedPreview,'Hello')
const profile=await reverseAssistCall('reverse_identifier_profile',{source:input})
assert.ok(profile.hexStyleCount>=1)
const routed=await mobileDispatchToolCall({name:'reverse_decode_literal',arguments:{encoding:'base64',text:'SGVsbG8='}})
assert.equal(routed.structuredContent.utf8,'Hello')
const root=await mkdtemp(join(tmpdir(),'dsh-reverse-test-'))
try {
 const binary=join(root,'sample.bin');await writeFile(binary,Buffer.alloc(16384,65))
 const ent=await reverseAssistCall('reverse_file_entropy',{path:binary,windows:3,windowBytes:512})
 assert.equal(ent.windows.length,3);assert.ok(ent.windows.every(x=>x.entropy===0))
 const map=join(root,'sample.js.map')
 await writeFile(map,JSON.stringify({version:3,sources:['src/original.js'],sourcesContent:['const a = 1;'],mappings:'AAAA'}))
 const result=await reverseAssistCall('reverse_sourcemap_inspect',{path:map,includeSourcePreviews:true})
 assert.equal(result.totalSources,1);assert.equal(result.sources[0].preview,'const a = 1;')
 const pathScan=await reverseAssistCall('reverse_scan_obfuscation',{path:map})
 assert.equal(pathScan.path,map)
} finally {await rm(root,{recursive:true,force:true})}
console.log('[DSH] reverse assist six-tool dispatch regression: OK')
