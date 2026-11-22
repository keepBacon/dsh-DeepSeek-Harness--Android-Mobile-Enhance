/**
 * dsh-today-connector — 把 Today 注册成 DSH 模型提供方
 *
 * 已验证（2026-11-18）：
 *   - Cookie 换 JWT：纯 cookie 调 /api/token，无需手机
 *   - 发消息：POST /v1/messages → 202，助手回复自动触发
 *   - 读回复：GET /v1/conversations/messages
 *   - 模型切换：PUT /v1/pricing/model-option
 *
 * 如实限制：
 *   - 无原生 tool-call（part 只有 text/image/file/voice/link）
 *   - 无真流式（提交后轮询）
 *   - 无 system role（拼进 user 文本）
 *   - 单会话（mainConversationId = 账号 ID），已串行化
 *
 * @module index.js
 */

import z from '@deepseek-ai/schemastery'
import { RetryPolicySchema, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'

import { TodayAdapter } from './adapter.js'
import { TodaySession } from './auth.js'
import { registerTodayAuthRpc } from './auth-rpc.js'

export const name = 'dsh-today-mobile'

/** llm 承载模型提供方注册 */
export const inject = ['llm', 'credentials', 'webServer', 'connection']

const MODEL_PRESETS = [
  { id: 'model.deepseek-v4.1-flash', name: 'Today · DeepSeek V4.1 Flash', contextWindow: 128000 },
  { id: 'model.minimax-m31-flash', name: 'Today · MiniMax M3.1 Flash', contextWindow: 128000 },
  { id: 'model.glm-5.3-flash', name: 'Today · GLM 5.3 Flash', contextWindow: 128000 },
  { id: 'model.glm-5.3', name: 'Today · GLM 5.3（4x 额度）', contextWindow: 128000 },
]

export const Config = z.object({
  enabled: z.boolean().default(true).description('总开关'),
  provider: z.string().default('today').description('提供方路由 id'),
  displayName: z.string().default('Today（第三方客户端）').description('提供方显示名'),

  // Login session is persisted in DSH Credentials, never in plugin profile YAML.
  deviceId: z.string().default('')
    .description('x-device-id，形如 web_<uuid>；留空则用内置固定值'),

  webBase: z.string().default('https://todayai.cn').description('Web 站点基址（换 token 用）'),
  apiBase: z.string().default('https://api.todayai.cn').description('API 基址'),
  origin: z.string().default('https://todayai.cn').description('Origin 头'),
  apiAudience: z.string().default('https://api.todayai.cn').description('token 的 audience'),
  appVersion: z.string().default('2.0.0').description('x-app-version'),
  tokenTtlSeconds: z.number().step(1).min(300).max(86400).default(3600).description('JWT 有效期（秒）'),

  models: z.array(z.object({
    id: z.string().required(),
    name: z.string(),
    contextWindow: z.number().step(1).min(1),
    maxTokens: z.number().step(1).min(1),
  })).default(MODEL_PRESETS.map((m) => ({ ...m })))
    .description('静态模型清单（零上游轮询）'),
  defaultContextWindow: z.number().step(1).min(1).default(128000).description('默认上下文窗口'),
  maxTokens: z.number().step(1).min(1).default(8192).description('默认 max_tokens'),

  simulateTools: z.boolean().default(true).description('用文本标记模拟 tool-call（今日模型实测可遵循 <<TOOL>> 格式），让 DSH 的工具循环可用'),
  schemaMaxDepth: z.number().step(1).min(0).max(8).default(2).description('工具参数 schema 折叠深度：超过该层的 object 只留 type+description（解决工具多导致 413 Payload too large），移植自 qwen_schema_proxy.py'),
  schemaDescMax: z.number().step(1).min(20).max(4000).default(200).description('工具描述/参数 description 最大字符数，超出截断'),
  maxTools: z.number().step(1).min(0).max(500).default(0).description('单次最多注入几个工具定义到 prompt（0=不限；工具极多时设 40~80 降体积）'),
  includeHistory: z.boolean().default(true).description('把此前对话压进 prompt（Today 无独立会话）'),
  historyTurns: z.number().step(1).min(0).max(50).default(8).description('最多带几轮历史'),
  historyLimit: z.number().step(1).min(1).max(100).default(12).description('读取历史条数上限'),

  pollIntervalMs: z.number().step(1).min(500).max(15000).default(2500).description('轮询间隔（毫秒）'),
  replyTimeoutMs: z.number().step(1).min(10000).max(600000).default(150000).description('等待回复超时（毫秒）'),
  sendTimeoutMs: z.number().step(1).min(5000).max(120000).default(60000).description('发送超时（毫秒）'),
  readTimeoutMs: z.number().step(1).min(3000).max(60000).default(20000).description('读取超时（毫秒）'),

  noRetry: z.boolean().default(true).description('默认不自动重试（429 期间避免撞门）'),
  retryPolicy: RetryPolicySchema,
  echoToolNote: z.boolean().default(false).description('日志里提示已提交（调试用）'),
})

/** 内置默认 deviceId（无配置时的兜底，不影响鉴权） */
const FALLBACK_DEVICE = 'web_' + globalThis.crypto.randomUUID()

export function resolveOptions(config) {
  const noRetry = config.noRetry !== false
  const cookie = typeof config.sessionCookie === 'string' ? config.sessionCookie.trim() : ''
  const models = (Array.isArray(config.models) ? config.models : [])
    .filter((m) => typeof m?.id === 'string' && m.id !== '')
    .map((m) => ({
      id: m.id,
      ...(typeof m.name === 'string' && m.name !== '' ? { name: m.name } : {}),
      ...(Number.isFinite(m.contextWindow) ? { contextWindow: m.contextWindow } : {}),
      ...(Number.isFinite(m.maxTokens) ? { maxTokens: m.maxTokens } : {}),
    }))

  return {
    enabled: config.enabled !== false,
    provider: (typeof config.provider === 'string' && config.provider.trim() !== '') ? config.provider.trim() : 'today',
    displayName: (typeof config.displayName === 'string' && config.displayName.trim() !== '') ? config.displayName.trim() : 'Today（第三方客户端）',
    sessionCookie: cookie,
    deviceId: (typeof config.deviceId === 'string' && config.deviceId.trim() !== '') ? config.deviceId.trim() : FALLBACK_DEVICE,
    webBase: (typeof config.webBase === 'string' && config.webBase.trim() !== '') ? config.webBase.trim().replace(/\/+$/, '') : 'https://todayai.cn',
    apiBase: (typeof config.apiBase === 'string' && config.apiBase.trim() !== '') ? config.apiBase.trim().replace(/\/+$/, '') : 'https://api.todayai.cn',
    origin: (typeof config.origin === 'string' && config.origin.trim() !== '') ? config.origin.trim() : 'https://todayai.cn',
    apiAudience: (typeof config.apiAudience === 'string' && config.apiAudience.trim() !== '') ? config.apiAudience.trim() : 'https://api.todayai.cn',
    appVersion: (typeof config.appVersion === 'string' && config.appVersion.trim() !== '') ? config.appVersion.trim() : '2.0.0',
    tokenTtlSeconds: Number.isSafeInteger(config.tokenTtlSeconds) ? config.tokenTtlSeconds : 3600,
    models: models.length > 0 ? models : MODEL_PRESETS.map((m) => ({ ...m })),
    defaultContextWindow: Number.isSafeInteger(config.defaultContextWindow) ? config.defaultContextWindow : 128000,
    maxTokens: Number.isSafeInteger(config.maxTokens) ? config.maxTokens : 8192,
    simulateTools: config.simulateTools !== false,
    schemaMaxDepth: Number.isSafeInteger(config.schemaMaxDepth) ? config.schemaMaxDepth : 2,
    schemaDescMax: Number.isSafeInteger(config.schemaDescMax) ? config.schemaDescMax : 200,
    maxTools: Number.isSafeInteger(config.maxTools) ? config.maxTools : 0,
    includeHistory: config.includeHistory !== false,
    historyTurns: Number.isSafeInteger(config.historyTurns) ? config.historyTurns : 8,
    historyLimit: Number.isSafeInteger(config.historyLimit) ? config.historyLimit : 12,
    pollIntervalMs: Number.isSafeInteger(config.pollIntervalMs) ? config.pollIntervalMs : 2500,
    replyTimeoutMs: Number.isSafeInteger(config.replyTimeoutMs) ? config.replyTimeoutMs : 150000,
    sendTimeoutMs: Number.isSafeInteger(config.sendTimeoutMs) ? config.sendTimeoutMs : 60000,
    readTimeoutMs: Number.isSafeInteger(config.readTimeoutMs) ? config.readTimeoutMs : 20000,
    noRetry,
    retryPolicy: noRetry === true
      ? resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'today-connector: retryPolicy')
      : resolveRetryPolicy(config.retryPolicy, 'today-connector: retryPolicy'),
    echoToolNote: config.echoToolNote === true,
  }
}

export async function apply(ctx, config) {
  const logger = ctx.logger ?? console
  const session = new TodaySession(ctx.credentials)
  await session.init()

  // 配置热更新容错：一次非法改动不打挂正在跑的插件
  let current = () => config
  let lastRaw
  let lastGood
  const options = () => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return { ...lastGood, sessionCookie: session.cookie }
    try {
      const next = resolveOptions(raw)
      lastRaw = raw
      lastGood = next
      return { ...next, sessionCookie: session.cookie }
    } catch (error) {
      if (lastGood === undefined) throw error
      lastRaw = raw
      logger.error?.('today-connector: 配置非法，继续使用上一份可用配置')
      logger.error?.(error)
      return { ...lastGood, sessionCookie: session.cookie }
    }
  }
  options()

  const entryNs = ctx.fiber?.entry?.options?.id ?? name
  const adapter = new TodayAdapter({ options, logger })
  ctx.effect(() => registerTodayAuthRpc(ctx, session, () => {
    adapter._token = undefined
    adapter._tokenExp = 0
  }), 'today-mobile: authenticated login RPC')

  if (options().enabled !== true) {
    logger.info?.('today-connector: enabled=false，未注册模型提供方')
    return
  }
  if (!session.cookie) logger.info?.('today-mobile: awaiting user login in Settings > Today AI');

  const providerId = options().provider
  ctx.llm.registerConfigurableProviders?.([{
    provider: providerId,
    displayName: options().displayName,
    settingsNs: entryNs,
    settingsPath: [],
  }])
  ctx.llm.registerAdapter([providerId], adapter)

  ctx.llm.registerModelDiscovery?.(entryNs, async () => {
    const cfg = options()
    return (cfg.models ?? []).map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      contextWindow: m.contextWindow ?? cfg.defaultContextWindow,
      maxTokens: m.maxTokens ?? cfg.maxTokens,
      inputModalities: ['text'],
    }))
  })

  logger.info?.(
    `today-connector: provider "${providerId}" 已注册；模型 ${options().models.length} 条；`
    + `限制：无原生工具调用、无真流式、单会话串行`,
  )
}

export { TodayAdapter }
export default { name, inject, Config, apply }
