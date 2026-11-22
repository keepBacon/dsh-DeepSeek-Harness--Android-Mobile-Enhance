#!/usr/bin/env node
// Real pinned Cordis runtime lifecycle contract, not an emulated container.
// Uses published package installed in the same NPM graph as the Android APK.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const rootDir = process.argv[2]
if (!rootDir) {
  console.error('usage: node test-android-cordis-runtime-parity.mjs <installed-node_modules>')
  process.exit(2)
}
const modules = resolve(rootDir)
const dir = join(modules, '@deepseek-ai/cordis')
const packageJson = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
const entry = packageJson.exports?.['.']?.default ?? packageJson.main
assert.equal(typeof entry, 'string', 'published Cordis JS entry must exist')
const { Context } = await import(pathToFileURL(resolve(dir, entry)).href)
assert.equal(typeof Context, 'function', 'use actual published Cordis context')

const root = new Context()
const events = []
const probe = { ping: () => 'live-cordis-service' }
const provider = {
  name: 'android-parity-provider',
  apply(ctx) {
    ctx.provide('androidParityProbe', probe)
    ctx.effect(() => () => { events.push('provider-disposed') })
  },
}
const consumer = {
  name: 'android-parity-consumer',
  inject: ['androidParityProbe'],
  apply(ctx) {
    assert.equal(ctx.get('androidParityProbe'), probe)
    assert.equal(ctx.androidParityProbe.ping(), 'live-cordis-service')
    events.push('consumer-loaded')
    ctx.effect(() => () => { events.push('consumer-disposed') })
  },
}
const providerFiber = root.plugin(provider)
await providerFiber.await()
assert.equal(root.get('androidParityProbe'), probe,
  'published Cordis must expose active service')
const consumerFiber = root.plugin(consumer)
await consumerFiber.await()
assert.ok(events.includes('consumer-loaded'), 'dependency injection must activate consumer')
assert.ok(root.registry.has(provider), 'provider must have an active registry record')
root.registry.delete(consumer)
root.registry.delete(provider)
await consumerFiber.await().catch(() => {})
await providerFiber.await().catch(() => {})
assert.ok(events.includes('provider-disposed'), 'fiber disposal must clean up provider')
assert.ok(events.includes('consumer-disposed'), 'fiber disposal must clean up consumer')
assert.equal(root.get('androidParityProbe'), undefined,
  'disposed service must not remain visible')
console.log('[DSH] Published Cordis provide/get/inject/fiber cleanup: OK')
