#!/usr/bin/env node
/**
 * Published 0.2.2-rc.5 DSH Cordis/MCP/ToolRuntime wire acceptance.
 *
 * Real SDK stdio child + Streamable HTTP endpoint, no fake Client or
 * synthetic tool responses. This is a Node integration test: Android app-UID
 * linker64/WebView and a real LLM invocation still require device acceptance.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const graph = process.argv[2]
const fixtureRoot = process.env.DSH_MCP_WIRE_FIXTURE_ROOT
if (!graph || !fixtureRoot) {
  console.error('usage: DSH_MCP_WIRE_FIXTURE_ROOT=<sdk root> node test-android-official-mcp-wire-parity.mjs <node_modules-dir>')
  process.exit(2)
}
const installed = name => join(resolve(graph), name)
const entry = name => {
  const pkg = JSON.parse(readFileSync(join(installed(name), 'package.json'), 'utf8'))
  assert.equal(pkg.version === '0.2.2-rc.5' || name === '@deepseek-ai/cordis', true, name + ' release mismatch')
  const declaration = pkg.exports?.['.'] ?? pkg.main
  const file = typeof declaration === 'string' ? declaration : declaration?.default ?? declaration?.import
  assert.equal(typeof file, 'string', name + ' missing compiled entry')
  return pathToFileURL(resolve(installed(name), file)).href
}
const fixtureRequire = createRequire(join(resolve(fixtureRoot), 'package.json'))
const fixtureImport = name => import(pathToFileURL(fixtureRequire.resolve(name)).href)
const [
  { Context }, SystemPrompt, ToolRuntime, NativeToolExecutor,
  { ToolCallId }, { executeToolFixture }, MCP,
  { McpServer, createMcpHandler }, { serveStdio }, { toNodeHandler }, { z },
] = await Promise.all([
  import(entry('@deepseek-ai/cordis')),
  import(entry('@deepseek-ai/dsh-system-prompt')).then(m => m.default),
  import(entry('@deepseek-ai/dsh-tools')).then(m => m.default),
  import(entry('@deepseek-ai/dsh-tool-executor-native')),
  import(entry('@deepseek-ai/dsh-llm')),
  import(entry('@deepseek-ai/dsh-tool-testkit')),
  import(entry('@deepseek-ai/dsh-mcp-client')),
  fixtureImport('@modelcontextprotocol/server'),
  fixtureImport('@modelcontextprotocol/server/stdio').then(m => ({ serveStdio: m.serveStdio })),
  fixtureImport('@modelcontextprotocol/node'),
  fixtureImport('zod'),
])
assert.equal(typeof serveStdio, 'function', 'published MCP SDK stdio server missing')
assert.equal(typeof toNodeHandler, 'function', 'published MCP SDK Node handler missing')

const root = await mkdtemp(join(tmpdir(), 'dsh-android-mcp-official-'))
let http, handler, ctx
try {
  // This script is executed as a real stdio MCP server by the SDK, including
  // its initial negotiation probe and the serving generation. It reads the
  // explicit per-server environment (the parent's DSH_* keys are scrubbed).
  const serverPath = join(resolve(fixtureRoot), 'parity-stdio-server.mjs')
  const serverSource = [
    "import { McpServer } from '@modelcontextprotocol/server'",
    "import { serveStdio } from '@modelcontextprotocol/server/stdio'",
    "import { z } from 'zod'",
    "const server = new McpServer({ name: 'android-parity-stdio', version: '1.0.0' }, { capabilities: { tools: {} } })",
    "server.registerTool('sum', { description: 'Sum with explicit environment offset', inputSchema: z.object({ a:z.number(), b:z.number() }) },",
    "  async ({ a, b }) => ({ content: [{ type:'text', text: String(a+b+Number(process.env.DSH_PARITY_OFFSET || '0')) }] }))",
    "server.registerTool('broken', { description: 'Reports MCP isError', inputSchema: z.object({}) },",
    "  async () => ({ isError: true, content: [{ type:'text', text:'actual upstream server error' }] }))",
    "serveStdio(server)",
  ].join('\n') + '\n'
  await writeFile(serverPath, serverSource, { flag: 'wx' })

  const authorization = []
  const customHeaders = []
  const calls = []
  handler = createMcpHandler(() => {
    const server = new McpServer(
      { name:'android-parity-http', version:'1.0.0' },
      { capabilities:{ tools:{} } },
    )
    server.registerTool('echo', {
      description:'Echo real request through Streamable HTTP',
      inputSchema:z.object({ value:z.string() }),
    }, async ({ value }) => {
      calls.push(value)
      return { content:[{ type:'text', text:'remote:' + value }] }
    })
    return server
  })
  const handleNode = toNodeHandler(handler)
  http = createServer((req,res) => {
    authorization.push(req.headers.authorization)
    customHeaders.push(req.headers['x-dsh-parity'])
    Promise.resolve(handleNode(req,res)).catch(err => {
      if (!res.headersSent) res.writeHead(500)
      res.end(String(err))
    })
  })
  await new Promise((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, '127.0.0.1', resolve)
  })
  const address = http.address()
  assert.ok(address && typeof address !== 'string', 'HTTP MCP server address missing')

  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)

  const stdio = MCP.Config({
    serverName:'android_stdio', transport:'stdio',
    command:process.execPath, args:[serverPath],
    env:{ DSH_PARITY_OFFSET:'17' }, cwd:root,
    toolCallTimeoutMs:15000, startupTimeoutMs:30000, failOnStartupError:true,
    reconnect:{enabled:false},
  })
  const streamable = MCP.Config({
    serverName:'android_http', transport:'streamable-http',
    url:'http://127.0.0.1:' + address.port + '/mcp',
    headers:{ Authorization:'Bearer parity-fixture-token', 'X-DSH-Parity':'wire-value' },
    toolCallTimeoutMs:15000, startupTimeoutMs:30000, failOnStartupError:true,
    reconnect:{enabled:false},
  })
  const stdioFiber = ctx.plugin({ name:'android-stdio-fixture', inject:['tools'], apply:MCP.apply }, stdio)
  const httpFiber = ctx.plugin({ name:'android-http-fixture', inject:['tools'], apply:MCP.apply }, streamable)
  await Promise.all([stdioFiber.await(), httpFiber.await()])
  const names = ctx.tools.schemas().map(item => item.name)
  for (const name of ['mcp__android_stdio__sum', 'mcp__android_stdio__broken', 'mcp__android_http__echo']) {
    assert.ok(names.includes(name), 'tool not discovered: ' + name)
  }
  assert.equal(new Set(names).size, names.length, 'duplicate model-facing tool registration')

  let seq = 0
  const execute = (name, args) => executeToolFixture(ctx, {
    name, arguments:args, signal:new AbortController().signal, callId:ToolCallId('android-wire-' + ++seq),
  })
  const sum = await execute('mcp__android_stdio__sum', { a:2, b:5 })
  assert.equal(sum.isError,false)
  assert.deepEqual(sum.content[0], {type:'text',text:'24'})
  assert.equal(sum.value?.content?.[0]?.text,'24', 'canonical MCP output was lost')
  const err = await execute('mcp__android_stdio__broken', {})
  assert.equal(err.isError,true, 'MCP isError must reach model tool error')
  assert.match(JSON.stringify(err.content),/actual upstream server error/)
  const echo = await execute('mcp__android_http__echo', {value:'roundtrip'})
  assert.equal(echo.isError,false)
  assert.deepEqual(echo.content[0], {type:'text',text:'remote:roundtrip'})
  assert.deepEqual(calls,['roundtrip'], 'HTTP tool handler was not executed')
  assert.ok(authorization.length > 0, 'HTTP did not send requests')
  assert.ok(authorization.every(x=>x==='Bearer parity-fixture-token'),'Authorization was lost')
  assert.ok(customHeaders.every(x=>x==='wire-value'),'custom HTTP header was lost')

  await stdioFiber.dispose()
  assert.equal(ctx.tools.get('mcp__android_stdio__sum'),undefined,'stdio tool leaked after plugin disable')
  assert.ok(ctx.tools.get('mcp__android_http__echo'),'unrelated HTTP tool was removed')
  const second = await execute('mcp__android_http__echo',{value:'still-alive'})
  assert.equal(second.isError,false)
  assert.deepEqual(calls,['roundtrip','still-alive'])
  await httpFiber.dispose()
  assert.equal(ctx.tools.get('mcp__android_http__echo'),undefined,'HTTP tool leaked after plugin disable')
  console.log('[DSH] Published MCP stdio/HTTP real protocol + ToolRuntime calls/headers/env/disposal: OK')
} finally {
  if (ctx) await ctx.fiber.dispose().catch(()=>{})
  if (handler) await handler.close().catch(()=>{})
  if (http) await new Promise(resolve => http.close(()=>resolve()))
  await rm(root,{recursive:true,force:true})
}
