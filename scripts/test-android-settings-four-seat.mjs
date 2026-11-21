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
 "queueMicrotask(() => openDshSurface(",
 "parts.header.querySelector(':scope > button:last-of-type')",
 "content.scrollTop = 0",
 "modal.dataset.dshMobileSection !== section",
 "const globalNav = Array.from(document.querySelectorAll(",
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
assert.equal(found.navButtons.length,labels.length)
// Exercise the actual click route: Settings > Built-in plugins has a
// dedicated control that closes the modal and selects the *separate* Plugins
// page, not the settings inventory, and never duplicates the control.
const configStart=source.indexOf('        const openOfficialPluginConfig = (parts) => {')
const configEnd=source.indexOf('        let skillSettingsActive = false;',configStart)
assert.ok(configStart>=0 && configEnd>configStart,'official plugin route missing')
let navClicks=0,closeClicks=0,toolsOpens=0,created=0,routeFallbacks=0
let link=null
const close={click(){closeClicks++},before(node){link=node}}
const pluginNav={
 textContent:'插件', getAttribute(key){return key==='aria-label'?'插件':null},
 closest(){return null},click(){navClicks++}
}
const headerNode={
 querySelector(sel){
  if(sel==='[data-dsh-mobile-plugin-config-link]')return link
  if(sel===':scope > button:last-of-type')return close
  return null
 },appendChild(node){link=node}
}
const selectedPlugin={
 textContent:'内置插件',
 getAttribute(key){return key==='aria-current'?'true':null},
 hasAttribute(key){return key==='aria-current'}
}
const pluginParts={header:headerNode,navButtons:[selectedPlugin]}
let availableControls=[pluginNav]
const globalNav={
 getAttribute(key){return key==='aria-label'?'Global panels':null},
 contains(node){return node===pluginNav}
}
const dom={
 querySelectorAll(sel){return sel==='nav, [role="navigation"]'?[globalNav]:availableControls},
 documentElement:{lang:'zh'},
 createElement(){
  created++
  return {
   type:'',textContent:'',
   setAttribute(){},addEventListener(type,callback){this.onClick=callback},
   remove(){link=null}
  }
 }
}
const config=new Function('document','TOOLS_PANEL_ID','openToolsPanel',
 'closeSidebar','queueMicrotask','findSettingsParts','navigator','openDshSurface','DSH_SURFACE_DEFS','window',source.slice(configStart,configEnd)+
 'return {openOfficialPluginConfig,syncOfficialPluginConfigLink}')
let sidebarCloses=0
const handlers=config(dom,'dsh-tools',()=>{toolsOpens++},()=>{sidebarCloses++},
 callback=>callback(),()=>pluginParts,{language:'zh-CN'},
 surface=>{assert.equal(surface.id,'plugins');routeFallbacks++},[{id:'plugins'}],{alert:()=>{throw new Error('missing native plugin page')}})
handlers.syncOfficialPluginConfigLink(pluginParts)
handlers.syncOfficialPluginConfigLink(pluginParts)
assert.equal(created,1,'one navigation control per dialog')
assert.equal(link.textContent,'插件配置')
link.onClick()
assert.equal(closeClicks,1)
assert.equal(navClicks,1)
assert.equal(sidebarCloses,1)
availableControls=[]
handlers.openOfficialPluginConfig(pluginParts)
assert.equal(routeFallbacks,1,'missing sidebar must route through official Plugins surface')
assert.equal(toolsOpens,0,'plugin route must never open Android Tools panel')
assert.equal(closeClicks,2,'settings modal must close before both plugin navigation paths')

console.log('[DSH] DSH 0.2.2 mobile settings: four-seat layout and Plugins configuration navigation OK')
