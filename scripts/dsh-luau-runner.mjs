// Disposable child process. Only trusted bootstrap code receives a host callback.
// The guest environment contains Lua values/functions, never Node APIs or JS objects.
import { pathToFileURL } from 'node:url'

function luaValue(value, depth = 0) {
  if (depth > 8) throw Error('fixture nesting exceeds 8')
  if (value === null) return 'nil'
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string') return '"' + [...Buffer.from(value)].map(n => n >= 32 && n <= 126 && n !== 34 && n !== 92 ? String.fromCharCode(n) : '\\' + String(n).padStart(3, '0')).join('') + '"'
  if (Array.isArray(value)) return '{' + value.map(v => luaValue(v, depth + 1)).join(',') + '}'
  if (value && typeof value === 'object') return '{' + Object.entries(value).map(([k, v]) => '[' + luaValue(k) + ']=' + luaValue(v, depth + 1)).join(',') + '}'
  throw Error('fixtures must be JSON values')
}

function bootstrap(options) {
  return String.raw`
local sink = __dsh_sink
__dsh_sink = nil
local fixtures = ${luaValue(options.fixtures || {})}
local globals = ${luaValue(options.globals || {})}
local maxEvents, maxSteps, maxCapture = ${options.maxEvents}, ${options.maxSteps}, ${options.maxCaptureBytes}
local seq, steps, captures, stopped = 0, 0, 0, false
local function scalar(v)
  local t = type(v)
  if t == "string" then return string.sub(v, 1, 256) end
  if t == "number" then if v ~= v or v == math.huge or v == -math.huge then return "<nonfinite>" end; return v end
  if t == "boolean" then return v end
  return "<" .. t .. ">"
end
local function quote(s)
  return '"' .. string.gsub(s, '[%z\1-\31\\"]', function(c)
    if c == '"' then return '\\"' end
    if c == '\\' then return '\\\\' end
    return string.format('\\u%04x', string.byte(c))
  end) .. '"'
end
local function json(v, depth)
  depth = depth or 0
  if depth > 5 then return quote("<depth-limit>") end
  local t = type(v)
  if t == "nil" then return "null" end
  if t == "string" then return quote(v) end
  if t == "boolean" or t == "number" then return tostring(v) end
  if t ~= "table" then return quote("<" .. t .. ">") end
  local out, count = {}, 0
  for k, value in next, v do
    count += 1
    if count > 64 then break end
    table.insert(out, quote(tostring(k)) .. ":" .. json(value, depth + 1))
  end
  return "{" .. table.concat(out, ",") .. "}"
end
local function emit(kind, data)
  if stopped then error("DSH_EVENT_LIMIT", 0) end
  seq += 1
  if seq > maxEvents then
    stopped = true
    sink('{"kind":"limit","reason":"events"}')
    error("DSH_EVENT_LIMIT", 0)
  end
  data.kind, data.seq = kind, seq
  sink(json(data))
end
local function snapshot(value)
  local out, count, truncated = {}, 0, false
  if type(value) ~= "table" then return out, false end
  for k, v in next, value do
    if type(k) == "number" or type(k) == "string" then
      count += 1
      if count > 32 then truncated = true; break end
      if type(v) == "string" and #v > 256 then truncated = true end
      out[string.sub(tostring(k), 1, 128)] = scalar(v)
    end
  end
  return out, truncated
end
local function probe(pc, opcode, registers, instruction)
  steps += 1
  if steps > maxSteps then emit("limit", {reason="steps"}); error("DSH_STEP_LIMIT", 0) end
  local regs, truncated = snapshot(registers)
  local ins, insTruncated = snapshot(instruction)
  emit("vm_step", {pc=scalar(pc), opcode=scalar(opcode), registers=regs, registersTruncated=truncated, instruction=ins, instructionTruncated=insTruncated})
end
local function output(kind, ...)
  local parts = {}
  for i = 1, math.min(select('#', ...), 16) do table.insert(parts, tostring(scalar(select(i, ...)))) end
  emit(kind, {text=string.sub(table.concat(parts, '\t'), 1, 2048)})
end
local env = {}
local function offlineGet(url)
  if type(url) ~= "string" then error("HttpGet URL must be a string", 0) end
  local content = fixtures.http and fixtures.http[url]
  emit("http_get", {url=string.sub(url, 1, 4096), fixture=type(content)=="string"})
  if type(content) ~= "string" then error("DSH_MISSING_HTTP_FIXTURE: " .. string.sub(url, 1, 200), 0) end
  return content
end
local function capture(source, chunkname)
  if type(source) ~= "string" then error("loadstring source must be a string", 0) end
  captures += 1
  local captureId = captures
  if #source > maxCapture then emit("limit", {reason="capture-bytes", bytes=#source}); error("DSH_CAPTURE_LIMIT", 0) end
  local hex = string.gsub(source, '.', function(c) return string.format('%02x', string.byte(c)) end)
  emit("loadstring", {capture=captureId, sourceHex=hex, chunkname=scalar(chunkname), bytes=#source})
  return function(...) emit("captured_call", {capture=captureId, arguments=select('#', ...)}); return nil end
end
local function request(options)
  if type(options) ~= "table" then error("request expects a table", 0) end
  local method = options.Method or options.method or "GET"
  if method ~= "GET" then emit("unsupported", {api="request", method=scalar(method)}); error("DSH_ONLY_FIXTURE_GET", 0) end
  return {Body=offlineGet(options.Url or options.url), StatusCode=200, Success=true, Headers={}}
end
local function unsupported(api)
  emit("unsupported", {api=api}); error("DSH_UNSUPPORTED_API: " .. api, 0)
end
local game = {
  HttpGet=function(_, url) return offlineGet(url) end,
  HttpGetAsync=function(_, url) return offlineGet(url) end,
  GetService=function(_, name)
    emit("get_service", {name=scalar(name)})
    if fixtures.services and fixtures.services[name] then return fixtures.services[name] end
    return unsupported("game:GetService(" .. tostring(scalar(name)) .. ")")
  end,
}
for k, v in pairs(globals) do env[k] = v end
for k, v in pairs({assert=assert, error=error, ipairs=ipairs, pairs=pairs, next=next, pcall=pcall, xpcall=xpcall,
  select=select, tonumber=tonumber, tostring=tostring, type=type, typeof=typeof, unpack=unpack,
  rawequal=rawequal, rawget=rawget, rawset=rawset, rawlen=rawlen, setmetatable=setmetatable, getmetatable=getmetatable,
  math=math, string=string, table=table, bit32=bit32, utf8=utf8, buffer=buffer, vector=vector,
  coroutine=coroutine, print=function(...) output("print", ...) end, warn=function(...) output("warn", ...) end,
  loadstring=capture, game=game, Game=game, request=request, http_request=request, syn={request=request},
  require=function(module) emit("require", {module=scalar(module)}); return unsupported("require") end,
  os={clock=function() return 0 end, time=function() return 0 end}, tick=function() return 0 end,
  task={wait=function() return unsupported("task.wait") end, spawn=function() return unsupported("task.spawn") end},
}) do env[k] = v end
env._G = env
env.getfenv = function() return env end
env.getgenv = function() return env end
env[${luaValue(options.hook || '__dsh_unused_probe')}] = probe
math.randomseed(${options.seed})
return function(target)
  setfenv(target, env)
  local ok, result = pcall(target)
  return json({ok=ok, result=scalar(result), steps=steps, events=seq, captured=captures})
end
`
}

async function run(message) {
  const { LuauState } = await import(pathToFileURL(message.runtimePath).href)
  let bytes = 0, events = 0
  const state = await LuauState.createAsync({ __dsh_sink: payload => {
    if (typeof payload !== 'string' || Buffer.byteLength(payload) > 600000) throw Error('event exceeds limit')
    bytes += Buffer.byteLength(payload); events++
    if (bytes > 2 * 1024 * 1024 || events > message.options.maxEvents + 1) throw Error('event budget exceeded')
    const event = JSON.parse(payload)
    process.send({ type: 'event', event })
  } })
  try {
    const [runner] = await state.loadstring(bootstrap(message.options), '=dsh-analysis-bootstrap', true)()
    // Compile the sample separately: it cannot escape a source-code wrapper.
    const target = state.loadstring(message.source, '=analysis-sample', true)
    const [result] = await runner(target)
    process.send({ type: 'result', result: JSON.parse(result) })
  } finally { state.destroy() }
}
if (process.send) process.once('message', message => {
  run(message).catch(error => process.send({ type: 'result', result: { ok: false, error: String(error?.message || error).slice(0, 2048), phase: error?.name === 'CompileError' ? 'compile' : 'runtime' } }))
    .finally(() => process.disconnect())
})
