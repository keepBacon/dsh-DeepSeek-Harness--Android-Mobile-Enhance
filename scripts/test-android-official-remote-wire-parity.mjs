#!/usr/bin/env node
/**
 * Published DSH 0.2.2-rc.5 Remote bridge acceptance, from real Browser Client
 * module handoffs to real Host /api requests and GoalService side effects.
 *
 * Based on the upstream packages/api/remotes/tests/built-lib.e2e.ts topology
 * at audited commit 9c2670d3bce5275e0d1610272958121af87787bb.
 * Only the irrelevant webServer listener and the credential storage backing
 * are local test infrastructure. Connection, auth, Gateway, Goal and Remote
 * are unmodified published DSH bundles. No RPC responses are fabricated.
 *
 * This executes in Linux CI, NOT in Android's WebView/app-UID context.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const graph = process.argv[2]
if (!graph) {
  console.error('usage: node test-android-official-remote-wire-parity.mjs <node_modules>')
  process.exit(2)
}
const root = resolve(graph)
const requireRoot = createRequire(join(root, 'package.json'))
const zod = requireRoot('zod')
const packageAt = name => join(root, name)
const packageJson = name => JSON.parse(readFileSync(join(packageAt(name), 'package.json'), 'utf8'))
function entry(name, subpath = '.') {
  const manifest = packageJson(name)
  assert.equal(manifest.version, name === '@deepseek-ai/cordis' ? '4.1.0' : '0.2.2-rc.5',
    'cross-release package in actual test graph: ' + name)
  const target = manifest.exports?.[subpath] ?? (subpath === '.' ? manifest.main : undefined)
  const file = typeof target === 'string' ? target : target?.default ?? target?.browser ?? target?.node
  assert.equal(typeof file, 'string', name + ' published export ' + subpath + ' missing')
  return pathToFileURL(resolve(packageAt(name), file)).href
}
const imports = {
  cordis: '@deepseek-ai/cordis',
  agent: '@deepseek-ai/dsh-agent',
  connectionHost: '@deepseek-ai/dsh-client-connection',
  gatewayHost: '@deepseek-ai/dsh-api-gateway',
  remoteAccess: '@deepseek-ai/dsh-api-remote-access',
  goal: '@deepseek-ai/dsh-goal',
  goalTypert: '@deepseek-ai/dsh-goal',
  session: '@deepseek-ai/dsh-session',
  projections: '@deepseek-ai/dsh-session-projection',
  registryHost: '@deepseek-ai/dsh-typert-registry',
}
const [
  cordis, agentModule, connectionHost, gatewayHost, remoteAccessModule,
  goalModule, goalTypert, sessionModule, projectionsModule, registryHostModule,
] = await Promise.all([
  import(entry(imports.cordis)),
  import(entry(imports.agent)),
  import(entry(imports.connectionHost)),
  import(entry(imports.gatewayHost)),
  import(entry(imports.remoteAccess)),
  import(entry(imports.goal)),
  import(entry(imports.goalTypert, './typert')),
  import(entry(imports.session)),
  import(entry(imports.projections)),
  import(entry(imports.registryHost)),
])
const { Context } = cordis
const host = new Context()
const routes = []
const credentialRecords = new Map()
let server
let client
let originalDocument
let originalLocation
let originalWindow
const originalFetch = globalThis.fetch
const restore = (key, descriptor) => {
  if (descriptor === undefined) delete globalThis[key]
  else Object.defineProperty(globalThis, key, descriptor)
}
try {
  // Plain HTTP route infrastructure; all handlers and authentication are the
  // actual published Host Connection and Gateway implementations.
  host.provide('webServer', {
    register(route) {
      routes.push(route)
      return () => {
        const pos = routes.indexOf(route)
        if (pos >= 0) routes.splice(pos, 1)
      }
    },
    tapIndex() { return () => {} },
    port: 0,
  })
  host.provide('credentials', {
    readRecord(key) { return Promise.resolve(credentialRecords.get(key)) },
    async modifyRecord(key, mutate) {
      const value = await mutate(credentialRecords.get(key))
      if (value !== undefined) credentialRecords.set(key, value)
      return value
    },
  })
  await host.plugin({ inject: connectionHost.inject, apply: connectionHost.apply })
  await host.plugin(registryHostModule.default)
  await host.plugin(projectionsModule.default)
  await host.plugin(agentModule.default)
  await host.plugin(remoteAccessModule.default)
  await host.plugin(gatewayHost.default)
  await host.plugin(goalModule.default)
  host.typert.register(goalTypert.TYPERT)

  const { Session, SessionId } = sessionModule
  const makeAgent = (name) => {
    const session = new Session(SessionId(name))
    return {
      id: session.id, options: {}, session, ctx: host.extend(),
      status: 'idle', acceptsNextStep: false,
      send() {}, updateInbox() { return 'not-found' },
      followup() {}, steer() { return { outcome: Promise.resolve({ status: 'rejected' }) } },
      inject(input) { session.append('user/message', input, { surfaceOp: 'append' }) },
      reserveTurnAdmission() {}, cancel() {},
      whenIdle() { return Promise.resolve() },
    }
  }
  const rootAgent = makeAgent('android-parity-root')
  const scopedAgent = makeAgent('android-parity-scoped')
  host.agents.register(rootAgent)
  host.agents.register(scopedAgent)

  const apiRoutes = routes.filter(route => route.path === '/api')
  assert.equal(apiRoutes.length, 1, 'Host did not install exactly one official /api route')
  const route = apiRoutes[0]
  server = createServer((req, res) => {
    if ((req.url ?? '/').startsWith('/?')) {
      if (host.connection.authorizeIndex(req, res)) {
        res.writeHead(200, { 'content-type':'text/html' })
        res.end('<body>DSH fixture shell</body>')
      }
      return
    }
    Promise.resolve(route.handler(req,res)).catch(error => {
      if (!res.headersSent) res.writeHead(500)
      res.end('fixture HTTP handler failure') // do not leak credentials
      console.error('[DSH remote] Host route error:', String(error))
    })
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string', 'Host /api did not bind TCP')
  const origin = 'http://127.0.0.1:' + address.port

  // Reject unauthenticated remote traffic. The browser must exchange the
  // exact startup URL for the official persistent HttpOnly auth cookie.
  const anonymous = await originalFetch(origin + '/api', {redirect:'manual'})
  assert.equal(anonymous.status,401,'untrusted browser was admitted to Host /api')
  const start = host.connection.authenticatedUrl(origin)
  assert.ok(start.includes('token='), 'Host did not mint a bootstrap URL')
  const login = await originalFetch(start, {redirect:'manual'})
  assert.equal(login.status,303,'Host bootstrap token exchange failed')
  const setCookie = login.headers.get('set-cookie')
  assert.ok(setCookie && setCookie.includes('HttpOnly'), 'browser auth cookie missing HttpOnly')
  const cookie = setCookie.split(';',1)[0]

  originalDocument = Object.getOwnPropertyDescriptor(globalThis,'document')
  originalWindow = Object.getOwnPropertyDescriptor(globalThis,'window')
  originalLocation = Object.getOwnPropertyDescriptor(globalThis,'location')
  globalThis.document = { baseURI: origin + '/' }
  globalThis.location = { hostname:'127.0.0.1', origin, search:'' }
  globalThis.fetch = (input, init = {}) => {
    const headers = new Headers(init.headers)
    headers.set('cookie',cookie)
    return originalFetch(new URL(input, document.baseURI), { ...init, headers })
  }
  const handoffs = new Map()
  globalThis.window = {
    __ModuleLoader__: {
      load(handoff) { handoffs.set(handoff.id, handoff) },
    },
  }
  // These are real published Browser/Client entrypoints. They register
  // themselves via the official __ModuleLoader__ ABI, not a mock registry.
  const bundles = [
    '@deepseek-ai/dsh-typert-registry',
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-api-gateway',
    '@deepseek-ai/dsh-api-remotes',
  ]
  for (const name of bundles) await import(entry(name,'./client'))
  const installBundle = (name) => {
    const handoff = handoffs.get(name)
    assert.ok(handoff, 'missing published Client module handoff: ' + name)
    return handoff.factory(specifier => {
      if (specifier === '@deepseek-ai/cordis') return cordis
      if (specifier === 'zod') return zod
      throw new Error('unexpected real Browser bundle dependency ' + specifier)
    })
  }
  client = new Context()
  for (const name of bundles) {
    const plugin = installBundle(name)
    await client.plugin({ inject: plugin.inject, apply: plugin.apply })
  }
  client.typert.contexts.registerClient('agent',{
    identity: candidate => 'parityAgentId' in candidate ? candidate.parityAgentId : undefined,
  })

  // Actual published GoalService state mutations prove the full
  // browser->HTTP->Gateway->Typert->GoalService->HTTP->browser roundtrip.
  const invalid = await client.remote.goals.create(rootAgent.id, {objective:12})
  assert.equal(invalid.ok,false,'invalid Remote input incorrectly accepted')
  assert.equal(invalid.error?.code,'gateway/input-invalid')
  const created = await client.remote.goals.create(rootAgent.id,{objective:'actual remote state'})
  assert.equal(created.ok,true,'real Remote goal creation failed: '+JSON.stringify(created))
  const edited = await client.remote.goals.edit(
    rootAgent.id,created.value.ref,{objective:'updated actual state'})
  assert.equal(edited.ok,true,'real Remote goal edit failed: '+JSON.stringify(edited))
  assert.equal(edited.value.objective,'updated actual state')
  const scopedContext = client.extend({parityAgentId:scopedAgent.id})
  const scoped = await scopedContext.remote.goals.create({objective:'scoped state',maxGoalRounds:3})
  assert.equal(scoped.ok,true,'real scoped Remote request failed: '+JSON.stringify(scoped))
  assert.equal(host.goals.get(rootAgent).objective,'updated actual state',
    'Host goal service did not change')
  assert.equal(host.goals.get(scopedAgent).objective,'scoped state',
    'Host scoped goal state did not change')
  assert.equal(rootAgent.session.snapshotEvents().length,2,
    'Host did not persist goal creation + update events')
  assert.equal(scopedAgent.session.snapshotEvents().length,1,
    'Host did not persist scoped goal event')

  await client.fiber.dispose()
  client = undefined
  // Host-side remote and /api route must clean up with their Cordis fibers.
  await host.fiber.dispose()
  assert.equal(routes.length,0,'Host /api route leaked after disposal')
  console.log('[DSH] Published Host/Browser Remote: real token-cookie /api RPC + goal state + scoped requests + cleanup OK')
} finally {
  if (client) await client.fiber.dispose().catch(()=>{})
  await host.fiber.dispose().catch(()=>{})
  if (server) {
    server.closeAllConnections()
    await new Promise(resolveClose => server.close(()=>resolveClose()))
  }
  if (originalDocument !== undefined) restore('document',originalDocument)
  if (originalWindow !== undefined) restore('window',originalWindow)
  if (originalLocation !== undefined) restore('location',originalLocation)
  globalThis.fetch = originalFetch
}
