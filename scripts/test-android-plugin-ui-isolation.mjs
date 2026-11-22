#!/usr/bin/env node
// Guard Android WebView SettingsRoot adaptation against third-party dialog
// collisions. This executes the actual injected findSettingsParts function.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const activity = readFileSync(new URL('../app/src/main/java/com/dshmobile/shell/MainActivity.kt', import.meta.url), 'utf8')
const from = activity.indexOf('        const findSettingsParts = () => {')
const until = activity.indexOf('        const tagSettings = () => {', from)
assert.ok(from >= 0 && until > from, 'actual SettingsRoot resolver unavailable')
const source = activity.slice(from, until)
assert.match(source, /data-shortcut-modal="settings"/)
assert.doesNotMatch(source, /querySelectorAll\('\[role="dialog"\]\[aria-modal="true"\],/)
const node = (label, attrs = {}) => ({
  textContent: label, id: '',
  getAttribute: key => attrs[key] ?? null,
})
function dialog(type) {
  const buttons = ['General', 'Models', 'Plugins'].map(x => node(x))
  const title = { id: type + '-title' }, header = { id: type + '-header' }
  const options = { id: type + '-options' }
  const nav = { querySelectorAll: sel => {
    assert.equal(sel, 'button')
    return buttons
  }}
  const modal = {
    type, children: [title, nav, header, options],
    querySelector: sel => sel === 'nav' ? nav : null,
  }
  return {modal, title, nav, header, options}
}
const official = dialog('official')
const plugin = dialog('third-party')
const find = new Function('document', 'SKILL_NAV_ID', 'SKILL_PANEL_ID', 'commonAncestor',
  source + '\nreturn findSettingsParts()')
const docs = {
  both: { querySelectorAll: sel => {
    assert.match(sel, /data-shortcut-modal="settings"/)
    return [official.modal] // Third-party dialog does not own this marker.
  }},
  onlyPlugin: { querySelectorAll: sel => {
    assert.match(sel, /data-shortcut-modal="settings"/)
    return []
  }},
}
const ancestor = (_buttons, nav) => nav
const match = find(docs.both, 'dsh-skill-nav', 'dsh-skill-panel', ancestor)
assert.equal(match?.modal, official.modal)
assert.equal(match?.content, official.options)
assert.equal(match?.header, official.header)
assert.equal(find(docs.onlyPlugin, 'dsh-skill-nav', 'dsh-skill-panel', ancestor), null)
assert.match(activity, /ctx\.slots|findSettingsParts|openDshSurface/)
console.log('[DSH] Android SettingsRoot does not capture third-party plugin dialogs: OK')
