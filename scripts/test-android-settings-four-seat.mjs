#!/usr/bin/env node
// Regression: DSH 0.2.2 SettingsRoot has four *sibling* seats. The Android
// bridge must never tag navTitle as the main content (blank half-screen bug).
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const source=readFileSync('app/src/main/java/com/dshmobile/shell/MainActivity.kt','utf8')
const must=(fragment,description)=>assert.ok(source.includes(fragment),description)
for(const token of [
 'grid-template-rows: auto auto auto minmax(0, 1fr)',
 'grid-template-areas: "title" "nav" "header" "options"',
 'grid-area: title !important',
 'grid-area: nav !important',
 'grid-area: header !important',
 'grid-area: options !important',
 "const navTitle = children[navIndex - 1]",
 "const header = children[navIndex + 1]",
 "const content = children[navIndex + 2]",
 "header.setAttribute('data-dsh-mobile-settings-header'",
 "content.setAttribute('data-dsh-mobile-settings-content'",
 "content.setAttribute('data-dsh-mobile-settings-options'",
 "const openOfficialPluginConfig = (parts) => {",
 "const syncOfficialPluginConfigLink = (parts) => {",
 "syncOfficialPluginConfigLink(parts)",
 "const current = findSettingsParts()",
 "queueMicrotask(() => target.click())",
 "queueMicrotask(openToolsPanel)",
 "parts.header.querySelector(':scope > button:last-of-type')",
 "content.scrollTop = 0",
 "modal.dataset.dshMobileSection !== section",
 "label === '插件' || label === 'plugins'",
 "'内置插件'", "'Built-in plugins'"
]) must(token,'missing 0.2.2 settings contract: '+token)
assert.ok(!source.includes("const header = content.firstElementChild;"),
 'the dialog title must not be used as a fake section container')
assert.ok(!source.includes("const options = content.lastElementChild;"),
 'the 0.2.2 settings content is already a direct grid seat')

// Exercise real source parser with a tiny four-sibling DOM fixture.
const start=source.indexOf('        const findSettingsParts = () => {')
const end=source.indexOf('        const tagSettings = () => {',start)
assert.ok(start>=0 && end>start,'settings source function not located')
const sourceFunction=source.slice(start,end)
const labels=['通用设置','模型','内置插件','Agent 预设','规则设定']
const buttons=labels.map(text=>({
 textContent:text,
 id:'',
 getAttribute(key){return key==='aria-label'?'':null}
}))
const title={id:'title'},header={id:'header'},options={id:'options'}
const nav={
 id:'nav', querySelectorAll(selector){
  assert.equal(selector,'button')
  return buttons
 }
}
const modal={
 children:[title,nav,header,options],
 querySelector(selector){return selector==='nav'?nav:null}
}
const document={querySelectorAll:()=>[modal]}
const commonAncestor=()=>({id:'nav-list'})
const find=new Function('document','SKILL_NAV_ID','SKILL_PANEL_ID','commonAncestor',
  sourceFunction+'return findSettingsParts()')
const found=find(document,'skill-button','skill-panel',commonAncestor)
assert.equal(found.navTitle,title)
assert.equal(found.nav,nav)
assert.equal(found.header,header)
assert.equal(found.content,options)
assert.equal(found.navButtons.length,4)
console.log('[DSH] DSH 0.2.2 mobile settings: four-seat layout and Plugins configuration navigation OK')
