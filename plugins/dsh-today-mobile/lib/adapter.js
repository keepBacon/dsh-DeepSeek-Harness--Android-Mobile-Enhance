/**
 * Today 适配器（Host 半身）
 *
 * 把 DSH 的消息词表转成 Today canonical-v1，把轮询/WS 到的回复转回 DSH 流事件。
 *
 * 已验证的协议事实（见 base_analysis/TODAY_WORKING_CLIENT.md）：
 *   - 认证：Cookie __Secure-better-auth.session_token → POST /api/token 换 1h JWT
 *   - 发送：POST /v1/messages {body:{parts:[{id,type:"text",text}]},clientMessageId,isMainChat:true} → 202
 *   - 读取：GET /v1/conversations/messages?isMainChat=true（parts 用 messageType+content）
 *   - 模型：PUT /v1/pricing/model-option {optionId}
 *
 * 如实限制（不掩饰）：
 *   - 无原生 tool-call：part 只有 text/image/file/voice/link
 *   - 无真流式：提交后轮询 history，只能整段返回
 *   - 无 system role：system 拼进第一条 user 文本
 *   - 单会话：mainConversationId = 账号 ID，并发会互相污染，故串行化
 *
 * @module lib/adapter.js
 */

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'

/** 429 额度/限流的错误体特征 */
const QUOTA_MARKERS = ['quota_denied', 'rate_limited', 'too_many_requests']

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** content 既可能是字符串也可能是块数组 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && typeof b === 'object' && b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
}

/** Today 消息 → 纯文本（只认 messageType==='text'） */
function todayTextOf(msg) {
  const parts = msg?.body?.parts
  if (!Array.isArray(parts)) return ''
  return parts
    .filter((p) => p && p.messageType === 'text')
    .map((p) => p?.content?.text ?? '')
    .join('')
}

/** 串行闸门：Today 是单会话，必须一次只跑一个请求 */
class Mutex {
  constructor() { this._tail = Promise.resolve() }

  /** 占位，返回释放函数 */
  async acquire() {
    const prev = this._tail
    let release
    this._tail = new Promise((resolve) => { release = resolve })
    await prev
    let done = false
    return () => {
      if (done === true) return
      done = true
      release()
    }
  }
}

/** 从会话历史里挑出最后一条非空 assistant 文本，且晚于指定的用户消息 id */
function pickReply(items, sendAtMs) {
  const list = Array.isArray(items) ? items : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i]
    if (m?.role !== 'assistant') continue
    const text = todayTextOf(m)
    if (text.trim() === '') continue
    const at = Date.parse(m?.createdAt ?? '')
    if (Number.isFinite(at) && at < sendAtMs - 2000) continue
    return text
  }
  return undefined
}

export class TodayAdapter extends LlmAdapter {
  /**
   * @param options () => resolvedOptions()
   * @param logger 结构化日志（绝不打印 cookie / token）
   */
  constructor({ options, logger }) {
    super()
    this._options = options
    this._logger = logger ?? console
    this._mutex = new Mutex()
    this._token = undefined
    this._tokenExp = 0
  }

  providerInfo(provider) {
    return { id: provider, name: this._options().displayName ?? 'Today' }
  }

  providerRetryPolicy() {
    return this._options().retryPolicy
  }

  /**
   * 折叠过深的 JSON Schema —— 移植自 C:/Users/qwe/.dsh/qwen_schema_proxy.py
   * 的 simplify_schema()。那个代理就是为解决「工具多 → 请求体过大 → 413」写的。
   * 规则：depth >= maxDepth 的 object 只留 type + 截断后的 description；
   *       description 超长截到 descMax；去掉 $schema。
   */
  _simplifySchema(obj, depth, maxDepth, descMax) {
    if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
      if (depth >= maxDepth && obj.type === 'object') {
        const out = { type: 'object' }
        if (typeof obj.description === 'string' && obj.description !== '') {
          out.description = obj.description.slice(0, descMax)
        }
        return out
      }
      const result = {}
      // properties/items 是 schema 容器，不算一层 object 嵌套；只有真正的
      // object 节点（带 type:'object'）才让深度 +1，语义贴近「折叠深度」。
      const containerKeys = new Set(['properties', 'items', 'additionalProperties', 'definitions', '$defs'])
      for (const [k, v] of Object.entries(obj)) {
        if (k === '$schema') continue
        if (k === 'description' && typeof v === 'string' && v.length > descMax) {
          result[k] = v.slice(0, descMax)
          continue
        }
        const isContainer = containerKeys.has(k)
        const childDepth = (isContainer || (v !== null && typeof v === 'object' && !Array.isArray(v) && v.type === 'object'))
          ? (isContainer ? depth : depth + 1)
          : depth
        result[k] = this._simplifySchema(v, childDepth, maxDepth, descMax)
      }
      return result
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => this._simplifySchema(item, depth, maxDepth, descMax))
    }
    return obj
  }

  /**
   * 构造工具调用指令（文本协议模拟 tool-call）
   * Today 无原生 tool-call，但实测模型能严格遵守 <<TOOL>>...<<END>> 标记。
   * 工具多时对参数 schema 做瘦身，避免 prompt 过大触发 413。
   */
  _toolInstructions(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return ''
    const cfg = this._options()
    const maxDepth = Number.isFinite(cfg.schemaMaxDepth) ? cfg.schemaMaxDepth : 2
    const descMax = Number.isFinite(cfg.schemaDescMax) ? cfg.schemaDescMax : 200
    const maxTools = Number.isFinite(cfg.maxTools) ? cfg.maxTools : 0 // 0 = 不限
    let offered = tools.filter((t) => t && typeof t.name === 'string' && t.name !== '' && t.deferLoading !== true)
    if (maxTools > 0 && offered.length > maxTools) offered = offered.slice(0, maxTools)
    const lines = offered.map((t) => {
      const desc = typeof t.description === 'string' && t.description !== ''
        ? t.description.slice(0, descMax)
        : ''
      const rawParams = t.parameters !== null && typeof t.parameters === 'object'
        ? t.parameters
        : {}
      const slim = this._simplifySchema(rawParams, 0, maxDepth, descMax)
      const params = JSON.stringify(slim)
      return `- name: ${t.name}\n  description: ${desc}\n  parameters: ${params}`
    })
    if (lines.length === 0) return ''
    return [
      '【可用工具】',
      ...lines,
      '',
      '调用规则：如果需要调用工具，只输出一行，格式严格如下，不要输出任何其它文字：',
      '<<TOOL>>{"name":"工具名","arguments":{参数对象}}<<END>>',
      '如果不需要工具，就正常回答。参数对象必须是合法 JSON。',
    ].join('\n')
  }

  /**
   * 从回复文本里解析工具调用标记（多方言打捞）。
   *
   * 经验来源：本机仓库 deepseek-web-bridge/lib/tools.mjs 与 diag_toolcall/。
   * 模型不总按要求的格式输出，实测/ocumented 的方言有：
   *   A. <<TOOL>>{"name":...}<<END>>          —— 本适配器提示词指定的格式
   *   B. <tool_call>{"name":...}</tool_call>  —— 通用文本形态
   *   C. <tool_call>NAME{...}</tool_call>     —— 名字前缀形态
   *   D. <tool_call>NAME</tool_call>          —— 无参形态
   *   E. <NAME</tool_call>                    —— 畸形开标签（现场观测）
   *   F. 裸 JSON {"name":...,"arguments":{}}  —— 大工具列表时的回退形态
   *   G. DSML 原生 <｜｜DSML｜｜ invoke name="x">...  —— DeepSeek 系模型原生工具 token
   *
   * 关键防误报（来自仓库经验）：只有 JSON 能解析 **且** 工具名在本次真正提供过的
   * 集合里才提升为调用，否则原样还原为文本。代价是"文本看起来怪"，而不是"整轮丢失"。
   *
   * 返回 { calls: [...], text } —— calls 是 DSH tool-call 块，text 是剩余可见文本。
   */
  _parseToolCalls(reply, tools) {
    const known = new Set(
      (Array.isArray(tools) ? tools : [])
        .filter((t) => t && typeof t.name === 'string' && t.name !== '')
        .map((t) => t.name),
    )
    const BAR = '\uFF5C\uFF5C' // 全角竖线双写，DeepSeek DSML 标记
    const NAME = '[A-Za-z0-9_.:-]{1,128}'

    const calls = []
    const spans = [] // 被成功提升的区间 [start, end)
    const seen = new Set() // 去重：名字+参数相同，避免重复执行

    const lift = (name, args, start, end) => {
      if (typeof name !== 'string' || name === '') return false
      if (known.size > 0 && !known.has(name)) return false // 未提供的工具名 → 不提升
      let a = args
      if (a === null || a === undefined) a = {}
      if (typeof a === 'string') {
        try { a = JSON.parse(a) } catch { a = { value: a } }
      }
      if (typeof a !== 'object') a = { value: a }
      const argStr = JSON.stringify(a)
      const key = `${name}\u0000${argStr}`
      if (seen.has(key)) return true // 重复调用吞掉但仍移除标记
      seen.add(key)
      calls.push({ name, arguments: argStr })
      spans.push([start, end])
      return true
    }

    // A: <<TOOL>>JSON<<END>>
    const reA = /<<TOOL>>([\s\S]*?)<<END>>/g
    let m
    while ((m = reA.exec(reply)) !== null) {
      let o
      try { o = JSON.parse(m[1].trim()) } catch { o = undefined }
      if (o !== undefined) {
        const n = o.name ?? o.tool ?? o.tool_name
        lift(n, o.arguments ?? o.args ?? o.input ?? o.parameters, m.index, m.index + m[0].length)
      }
    }

    // B/C/D: <tool_call>JSON</tool_call> | <tool_call>NAME{JSON}</tool_call> | <tool_call>NAME</tool_call>
    const reBCD = new RegExp(
      `<tool_call>\\s*(\\{[\\s\\S]*?\\})\\s*</tool_call>|<tool_call>\\s*(${NAME})\\s*(\\{[\\s\\S]*?\\})\\s*</tool_call>|<tool_call>\\s*(${NAME})\\s*</tool_call>`,
      'g',
    )
    while ((m = reBCD.exec(reply)) !== null) {
      if (m[1] !== undefined) {
        let o
        try { o = JSON.parse(m[1]) } catch { o = undefined }
        if (o !== undefined) {
          lift(o.name ?? o.tool ?? o.tool_name, o.arguments ?? o.args ?? o.input ?? o.parameters, m.index, m.index + m[0].length)
        }
      } else if (m[2] !== undefined) {
        let args = {}
        try { args = JSON.parse(m[3] ?? '{}') } catch { /* empty */ }
        lift(m[2], args, m.index, m.index + m[0].length)
      } else if (m[4] !== undefined) {
        lift(m[4], {}, m.index, m.index + m[0].length)
      }
    }

    // E: 畸形开标签 <NAME</tool_call>
    const reE = new RegExp(`<(${NAME})</tool_call>`, 'g')
    while ((m = reE.exec(reply)) !== null) {
      lift(m[1], {}, m.index, m.index + m[0].length)
    }

    // F: 裸 JSON —— 整段就是一个调用对象（不在代码围栏里时才认）
    let fenced = false
    for (const tick of reply.matchAll(/```/g)) fenced = !fenced
    if (!fenced) {
      const bare = reply.trim()
      if (bare.startsWith('{') && bare.endsWith('}')) {
        let o
        try { o = JSON.parse(bare) } catch { o = undefined }
        if (o !== undefined && !spans.some(([s, e]) => s === 0 && e === reply.length)) {
          lift(o.name ?? o.tool ?? o.tool_name, o.arguments ?? o.args ?? o.input ?? o.parameters, 0, reply.length)
        }
      }
    }

    // G: DSML 原生 invoke 块
    const invokeRe = new RegExp(`<${BAR}DSML${BAR} invoke name="(${NAME})"[^>]*>([\\s\\S]*?)</${BAR}DSML${BAR} invoke>`, 'g')
    while ((m = invokeRe.exec(reply)) !== null) {
      const name = m[1]
      const body = m[2]
      const args = {}
      const paramRe = new RegExp(`<${BAR}DSML${BAR} parameter name="(${NAME})"[^>]*>([\\s\\S]*?)</${BAR}DSML${BAR} parameter>`, 'g')
      let pm
      while ((pm = paramRe.exec(body)) !== null) {
        const raw = pm[2].trim()
        try { args[pm[1]] = JSON.parse(raw) } catch { args[pm[1]] = raw }
      }
      lift(name, args, m.index, m.index + m[0].length)
    }

    // 移除成功提升的区间，其余文本（含未提升的畸形块）原样保留
    let text = reply
    if (spans.length > 0) {
      spans.sort((a, b) => a[0] - b[0])
      let out = ''
      let last = 0
      for (const [s, e] of spans) {
        if (s < last) continue // 重叠区间跳过（优先先匹配的方言）
        out += reply.slice(last, s)
        last = e
      }
      out += reply.slice(last)
      text = out.trim()
    }
    return { calls, text }
  }

  /** 静态清单（防封：零上游轮询） */
  async listModels(provider) {
    const cfg = this._options()
    return (cfg.models ?? []).map((m) => ({
      provider,
      id: m.id,
      name: m.name ?? m.id,
      inputModalities: ['text'],
    }))
  }

  async resolveModel(provider, model) {
    const cfg = this._options()
    const entry = (cfg.models ?? []).find((m) => m.id === model)
    return {
      provider,
      id: model,
      name: entry?.name ?? model,
      inputModalities: ['text'],
      context: { contextWindow: entry?.contextWindow ?? cfg.defaultContextWindow },
      defaultMaxTokens: cfg.maxTokens,
    }
  }

  // ── 认证 ────────────────────────────────────────────────────────────────
  async _jwt() {
    const now = Date.now()
    if (this._token !== undefined && now < this._tokenExp - 60_000) return this._token
    const cfg = this._options()
    if (!cfg.sessionCookie) {
      throw new LlmError('Today 未配置 session cookie（在插件配置里填 __Secure-better-auth.session_token 的值）', 'PROVIDER')
    }
    const resp = await fetch(`${cfg.webBase}/api/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `__Secure-better-auth.session_token=${cfg.sessionCookie}`,
        origin: cfg.origin,
      },
      body: JSON.stringify({ audience: cfg.apiAudience, expiresIn: cfg.tokenTtlSeconds }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new LlmError(`Today 换 token 失败 HTTP ${resp.status}${body ? `：${body.slice(0, 160)}` : ''}（session cookie 可能已失效，需重新登录）`, 'AUTH')
    }
    const data = await resp.json()
    if (typeof data?.token !== 'string' || data.token === '') {
      throw new LlmError('Today 换 token 返回里没有 token 字段', 'AUTH')
    }
    this._token = data.token
    const exp = Date.parse(data?.expiresAt ?? '')
    this._tokenExp = Number.isFinite(exp) ? exp : now + (cfg.tokenTtlSeconds * 1000)
    this._logger.debug?.('today-connector: JWT 已刷新')
    return this._token
  }

  _headers(jwt, json = true) {
    const cfg = this._options()
    const h = {
      authorization: `Bearer ${jwt}`,
      'x-device-id': cfg.deviceId,
      'x-app-version': cfg.appVersion,
      'x-client-platform': 'web',
      origin: cfg.origin,
    }
    if (json) h['content-type'] = 'application/json'
    return h
  }

  // ── 发送 ────────────────────────────────────────────────────────────────
  async _send(text) {
    const jwt = await this._jwt()
    const cfg = this._options()
    const clientMessageId = globalThis.crypto.randomUUID()
    const body = {
      body: { parts: [{ id: globalThis.crypto.randomUUID(), type: 'text', text }] },
      clientMessageId,
      isMainChat: true,
    }
    const sentAt = Date.now()
    const resp = await fetch(`${cfg.apiBase}/v1/messages`, {
      method: 'POST',
      headers: this._headers(jwt),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.sendTimeoutMs),
    })
    const raw = await resp.text().catch(() => '')
    if (!resp.ok) {
      const quota = QUOTA_MARKERS.some((m) => raw.toLowerCase().includes(m))
      if (quota) {
        throw new LlmError(
          `Today 拒绝本次请求（HTTP ${resp.status}）：额度或限流。今天这个账号的额度已用尽，或触发了频率限制；不要立刻重试。原始返回：${raw.slice(0, 200)}`,
          'PROVIDER',
        )
      }
      if (resp.status === 401 || resp.status === 403) {
        throw new LlmError(`Today 鉴权失败 HTTP ${resp.status}：${raw.slice(0, 200)}`, 'AUTH')
      }
      throw new LlmError(`Today 发送失败 HTTP ${resp.status}：${raw.slice(0, 200)}`, 'PROVIDER')
    }
    let parsed
    try { parsed = JSON.parse(raw) } catch { parsed = undefined }
    return { clientMessageId, sentAt, parsed }
  }

  // ── 读取（轮询） ────────────────────────────────────────────────────────
  async _readHistory() {
    const jwt = await this._jwt()
    const cfg = this._options()
    const resp = await fetch(
      `${cfg.apiBase}/v1/conversations/messages?isMainChat=true&limit=${cfg.historyLimit}`,
      { headers: this._headers(jwt, false), signal: AbortSignal.timeout(cfg.readTimeoutMs) },
    )
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new LlmError(`Today 读历史失败 HTTP ${resp.status}：${body.slice(0, 160)}`, 'PROVIDER')
    }
    const data = await resp.json()
    return data?.data?.items ?? []
  }

  async *_streamLocked(options, cfg, signal) {
    // system 拼进第一条 user 文本（Today 无 system role）
    const list = Array.isArray(options.messages) ? options.messages : []
    const systemParts = []
    if (typeof options.system === 'string' && options.system.trim() !== '') systemParts.push(options.system)
    const turns = []
    for (const msg of list) {
      const role = msg?.role
      const text = textOf(msg?.content)
      if (role === 'system' || role === 'developer') {
        if (text.trim() !== '') systemParts.push(text)
        continue
      }
      if (role === 'user') turns.push({ role: 'user', text })
      else if (role === 'assistant') turns.push({ role: 'assistant', text })
      else if (role === 'tool') turns.push({ role: 'user', text: `[工具结果] ${text}` })
    }

    // Today 是单会话：把历史压成一段上下文，只发最后一次请求
    const lastUser = [...turns].reverse().find((t) => t.role === 'user')
    const prompt = lastUser?.text ?? ''
    if (prompt.trim() === '') throw new LlmError('Today 适配器收到空请求', 'BAD_REQUEST')

    const contextPrefix = []
    if (systemParts.length > 0) {
      contextPrefix.push(`【系统设定】\n${systemParts.join('\n\n')}`)
    }
    const priorTurns = turns.slice(0, Math.max(0, turns.length - 1))
    if (priorTurns.length > 0 && cfg.includeHistory) {
      const recent = priorTurns.slice(-cfg.historyTurns)
      contextPrefix.push(
        `【此前对话】\n${recent.map((t) => `${t.role === 'user' ? '用户' : '助手'}：${t.text}`).join('\n')}`,
      )
    }
    // 工具定义转成文本指令（Today 无原生 tool-call）
    const toolBlock = cfg.simulateTools === false ? '' : this._toolInstructions(options?.tools)
    const effectivePrompt = toolBlock !== ''
      ? `${prompt}\n\n${toolBlock}`
      : prompt

    const finalText = contextPrefix.length > 0
      ? `${contextPrefix.join('\n\n')}\n\n【本次请求】\n${effectivePrompt}`
      : effectivePrompt

    if (signal?.aborted === true) throw new LlmError('请求被调用方中止', 'ABORTED')

    // 发出去
    const { sentAt } = await this._send(finalText)
    if (cfg.echoToolNote) {
      this._logger.debug?.('today-connector: 已提交，等待回复')
    }

    // 轮询
    const deadline = Date.now() + cfg.replyTimeoutMs
    let reply
    while (Date.now() < deadline) {
      if (signal?.aborted === true) throw new LlmError('请求被调用方中止', 'ABORTED')
      await sleep(cfg.pollIntervalMs)
      const items = await this._readHistory()
      reply = pickReply(items, sentAt)
      if (reply !== undefined) break
    }
    if (reply === undefined) {
      throw new LlmError(
        `Today 在 ${Math.round(cfg.replyTimeoutMs / 1000)}s 内没有产生回复（可能上游还在处理，或账号额度受限）。历史里未找到新的 assistant 文本。`,
        'TIMEOUT',
      )
    }

    // 解析工具调用标记（文本协议模拟）
    const toolMode = cfg.simulateTools !== false
      && Array.isArray(options?.tools) && options.tools.length > 0
    const parsed = toolMode === true
      ? this._parseToolCalls(reply, options?.tools)
      : { calls: [], text: reply }
    let index = 0

    // 可见文本块
    if (parsed.text !== '') {
      yield { type: 'block-start', index, blockType: 'text' }
      const CHUNK = 400
      for (let i = 0; i < parsed.text.length; i += CHUNK) {
        yield { type: 'text-delta', index, text: parsed.text.slice(i, i + CHUNK) }
      }
      yield { type: 'block-end', index, block: { type: 'text', text: parsed.text } }
      index += 1
    }

    // 工具调用块（DSH agent loop 会执行它们，并把结果作为 role:tool 传回）
    for (const call of parsed.calls) {
      const callId = globalThis.crypto.randomUUID()
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield {
        type: 'block-end',
        index,
        block: { type: 'tool-call', id: callId, name: call.name, arguments: call.arguments },
      }
      index += 1
    }

    // openai-compatible 的 tool-call 必须带 finish reason 'tool_calls'
    const finishReason = parsed.calls.length > 0
      ? { kind: 'tool-calls' }
      : { kind: 'stop' }
    if (toolMode === true && parsed.calls.length === 0 && parsed.text === '') {
      this._logger.warn?.('today-connector: 工具模式下回复既无工具调用也无文本')
    }
    yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
    yield { type: 'finish', reason: finishReason }
  }

  async *stream(options) {
    const cfg = this._options()
    const signal = options?.signal

    // 会话标题本地生成：不消耗额度
    if (options?.purpose === 'session-title') {
      const list = Array.isArray(options.messages) ? options.messages : []
      let src = ''
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (list[i]?.role === 'user') {
          const t = textOf(list[i].content).trim()
          if (t !== '') { src = t; break }
        }
      }
      const title = (src || '新会话').replace(/\s+/g, ' ').slice(0, 24)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: title }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: title } }
      yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    // 单会话：串行执行，避免上下文互相污染
    const release = await this._mutex.acquire()
    try {
      yield* this._streamLocked(options, cfg, signal)
    } finally {
      release()
    }
  }
}
