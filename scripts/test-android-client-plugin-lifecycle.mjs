#!/usr/bin/env node
/**
 * Use the exact published DSH browser module system, Cordis and SlotRegistry
 * against a third-party plugin fixture. No Android-side fake slot container.
 *
 * This is a Node/browser-module integration test. Android WebView rendering,
 * Host RPC, credentials and real device interaction require separate E2E.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const modulesDir = process.argv[2]
if (!modulesDir) {
  console.error('usage: test-android-client-plugin-lifecycle.mjs <node_modules-dir>')
  process.exit(2)
}
const installed = (name) => join(resolve(modulesDir), name)
const manifest = (name) => JSON.parse(readFileSync(join(installed(name), 'package.json'), 'utf8'))
const publishedEntry = (name, subpath) => {
  const exp = manifest(name).exports?.[subpath]
  const file = typeof exp === 'string' ? exp : exp?.import ?? exp?.default
  assert.equal(typeof file, 'string', name + ' missing published ' + subpath)
  return resolve(installed(name), file)
}
const { Context } = await import(pathToFileURL(publishedEntry('@deepseek-ai/cordis', '.')).href)

// The official ./client bundle is NOT an ES module exporting named symbols.
// It is a classic script that calls window.__ModuleLoader__.load({id,factory}).
// Use that exact protocol, and only seed its legitimate imports from the
// installed Node package tree; do not replace the upstream loader/renderer.
const facade = {
  mode: 'queue', pendingQueue: [],
  load(registration) { this.pendingQueue.push(registration) },
}
globalThis.window = { __ModuleLoader__: facade }
async function bundle(name) {
  await import(pathToFileURL(publishedEntry(name, './client')).href)
  const found = facade.pendingQueue.find(item => item.id === name)
  assert.ok(found, name + ' did not call the official __ModuleLoader__.load protocol')
  return found
}
function materialize(name, registration) {
  const requireNode = createRequire(join(installed(name), 'package.json'))
  const requireBundle = (specifier) => requireNode(specifier)
  requireBundle.async = async (specifier) => import(specifier)
  requireBundle.asset = (value) => value
  return registration.factory(requireBundle)
}
const moduleRegistration = await bundle('@deepseek-ai/dsh-client-modules')
const rendererRegistration = await bundle('@deepseek-ai/dsh-client-ui-renderer')
const { createClientModuleSystem } = materialize('@deepseek-ai/dsh-client-modules', moduleRegistration)
const { SlotRegistry } = materialize('@deepseek-ai/dsh-client-ui-renderer', rendererRegistration)

const SHELL = '@deepseek-ai/dsh-client-modules'
const ID = '@parity-fixture/client-ui'
const BUNDLE = '@parity-fixture/configurable'
const makeUrl = (id, rev) => '/??' + id + '/client.js&rev=' + rev
const wire = {
  rev: 'fixture-1',
  release: { version: '0.2.2-rc.5' },
  entries: [
    { id: SHELL, rev: 'shell', url: makeUrl(SHELL, 'shell'), immediately: true },
    { id: ID, rev: 'v1', url: makeUrl(ID, 'v1') },
  ],
  batches: [
    { phase: 'bootstrap', url: makeUrl(SHELL, 'shell'), rev: 'shell', entries: [SHELL] },
    { phase: 'application', url: makeUrl(ID, 'v1'), rev: 'v1', entries: [ID] },
  ],
}
let builds = 0
const registrations = []
const modules = createClientModuleSystem(
  facade, { id: SHELL, exports: { createClientModuleSystem } }, {
    boot: wire, staticModules: {},
    async loadBundle(url) {
      assert.match(url, /@parity-fixture\/client-ui\/client\.js/)
      builds++
      const version = url.includes('rev=v2') ? 2 : 1
      facade.load({
        id: ID,
        factory: () => ({
          name: 'fixture-plugin-client-v' + version,
          inject: ['slots'],
          apply(ctx) {
            // The owner declares these real slot contracts at runtime.
            // Third-party bundles only contribute to them, without Android UI.
            ctx.slots.inject('settings.section', () => ctx.slots.register({
              name: 'settings.section', id: 'parity-fixture', order: 42,
              label: 'Fixture settings',
            }, () => null))
            ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
              name: 'plugins.bundle.config', key: BUNDLE,
            }, () => null))
            registrations.push('activated-v' + version)
            ctx.effect(() => () => { registrations.push('disposed-v' + version) })
          },
        }),
      })
    },
  },
)
assert.equal(facade.mode, 'live', 'real client loader must own facade registrations')
const root = new Context()
new SlotRegistry(root)
const owner = root.plugin({
  name: 'fixture-shell-slot-owner', inject: ['slots'],
  apply(ctx) {
    ctx.slots.register({
      name: 'root',
      children: {
        'settings.section': { kind: 'list', scope: 'root' },
        'plugins.bundle.config': { kind: 'keyed', scope: 'root' },
      },
    }, () => null)
  },
})
await owner.await()

function slots(name) { return root.slots.entries(name) }
const before = root.slots.getVersion('settings.section')
const first = await modules.import(ID + '/client', '', {})
assert.equal(first.name, 'fixture-plugin-client-v1')
const firstFiber = root.plugin(first)
await firstFiber.await()
assert.equal(builds, 1, 'fixture client bundle must load once per revision')
assert.deepEqual(slots('settings.section').map(e => e.options.id), ['parity-fixture'])
assert.deepEqual(slots('plugins.bundle.config').map(e => e.options.key), [BUNDLE])
assert.ok(root.slots.getVersion('settings.section') > before)
assert.deepEqual(registrations, ['activated-v1'])

// Disabling a package must *dispose* both UI seats, including registrations
// behind slots.inject(). React will unsubscribe from their actual ledger.
root.registry.delete(first)
while (firstFiber.inertia) await firstFiber.inertia
assert.equal(slots('settings.section').length, 0)
assert.equal(slots('plugins.bundle.config').length, 0)
assert.ok(registrations.includes('disposed-v1'))

modules.invalidate(ID, 'v2')
const second = await modules.import(ID, '', {})
assert.equal(second.name, 'fixture-plugin-client-v2')
assert.notStrictEqual(second, first)
const secondFiber = root.plugin(second)
await secondFiber.await()
assert.equal(builds, 2, 'new revision must load a new bundle factory')
assert.equal(slots('settings.section').length, 1)
assert.equal(slots('plugins.bundle.config').length, 1)
root.registry.delete(second)
while (secondFiber.inertia) await secondFiber.inertia
assert.equal(slots('settings.section').length, 0)
assert.equal(slots('plugins.bundle.config').length, 0)
assert.ok(registrations.includes('disposed-v2'))
root.registry.delete(owner)
while (owner.inertia) await owner.inertia
console.log('[DSH] Published ClientModuleSystem + Cordis + SlotRegistry third-party lifecycle: OK')
