#!/usr/bin/env node
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {androidUnchangedIncompatiblePlugins} from './dsh-android-plugin-update-preflight.mjs'

const manifest = (name, version, dshRange, bundle=true) => JSON.stringify({
 name, version, peerDependencies:{'@deepseek-ai/dsh-agent':dshRange},
 ...(bundle?{dsh:{bundle:{patch:'./cordis.patch.yml'}}}:{}),
})
const previous=new Map([
 ['dsh-better-sidebar',manifest('dsh-better-sidebar','0.19.1','^0.1.5-rc.1')],
 ['@tnnevol/dsh-zcode',manifest('@tnnevol/dsh-zcode','8.1.155','^0.2.2-rc.2')],
])
const deps={'dsh-better-sidebar':'0.19.1','@tnnevol/dsh-zcode':'8.1.155'}
const parseSpec=raw=>{
 const at=raw.lastIndexOf('@')
 return {kind:'registry',name:at>0?raw.slice(0,at):raw}
}
const evaluate=(m,exemptions)=>{
 const range=m.peerDependencies?.['@deepseek-ai/dsh-agent']
 if(!range||range.startsWith('^0.2.2'))return undefined
 return {name:m.name,version:m.version,requirements:range,exempted:!!exemptions[m.name+'@'+m.version]}
}
let found=androidUnchangedIncompatiblePlugins(
 deps,previous,['@tnnevol/dsh-zcode@8.3.0'],parseSpec,evaluate,{})
assert.equal(found.length,1)
assert.equal(found[0].name,'dsh-better-sidebar')
assert.equal(found[0].version,'0.19.1')
assert.equal(androidUnchangedIncompatiblePlugins(
 deps,previous,['dsh-better-sidebar@0.32.1'],parseSpec,evaluate,{}).length,0,
 'upgrading the old sidebar itself must not be blocked by the stale sidebar')
assert.equal(androidUnchangedIncompatiblePlugins(
 deps,previous,['@tnnevol/dsh-zcode@8.3.0'],parseSpec,evaluate,
 {'dsh-better-sidebar@0.19.1':true}).length,0)
assert.equal(androidUnchangedIncompatiblePlugins(
 deps,new Map([['dsh-better-sidebar',undefined]]),[],parseSpec,evaluate,{}).length,0)
const script=readFileSync(new URL('./android-runtime-patch.mjs',import.meta.url),'utf8')
const from=script.indexOf('// Upstream 0.2.2\'s plugin transaction')
const until=script.indexOf('// DSH 0.1.5-rc.2\'s /plugins',from)
assert.ok(from>=0&&until>from)
const injected=script.slice(from,until)
assert.match(injected,/androidUnchangedIncompatiblePlugins\(beforeDependencies, installedBefore/)
assert.match(injected,/namedSpecs\(args\)/)
assert.match(injected,/incompatible\.push\(incompatiblePlugin\(entry\.issue\)\)/)
assert.match(injected,/requiredIfPresent: true/)
console.log('[DSH] Android 0.2.2 plugin install preflight: untouched incompatible sidebar blocked, self-upgrade allowed')
