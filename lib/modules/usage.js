/**
 * usage — API 用量与账户余额宿主模块（实时数据源）。
 *
 * 用量数据源（按优先级）：
 *   1. **DSH 自身会话日志**：$DSH_HOME/sessions/<ws>/session-<id>/session.vN.jsonl.zstd
 *      中的 assistant/message 事件带 usage（token 桶）与 message.source
 *      （provider/model）——实时、准确、无需第三方。见 lib/usage-logs.js。
 *   2. 旧版外部台账 $DSH_HOME/dsh-usage/usage-ledger.json（社区插件产物，
 *      常已冻结）——仅作兜底。
 *
 * 余额数据源：
 *   1. **DSH 账户服务**（cordis 服务 `deepseekAccount`）：`getState()` 取登录
 *      状态与充值/用量链接，`getBalance()` 取**实时**钱包余额（充值钱包 +
 *      赠送钱包）。插件只调用服务、**从不读取 API Key 或凭据文件**（安全审查
 *      「零密钥读取」承诺）。未登录时服务返回 null → 界面明确提示，而不是拿旧
 *      快照冒充实时。
 *   2. 仅当账户服务不可用时，才回退到 provider-snapshots.json 并标注为过期快照。
 *
 * 说明：钱包余额是**供应商能力**——目前只有 DeepSeek 官方平台提供查询接口，
 * 其它供应商没有公开余额 API。因此本模块同时输出各供应商的 balanceSupported
 * 标记，界面据此说明"该供应商无余额接口"，绝不伪造数字。
 *
 * 契约脆弱性对策（对抗式审查 F8）：所有外部读取严格校验 shape，不认识就安全
 * 忽略并给出原因，绝不抛错、绝不半渲染。
 * @module dsh-harness-toolbox/modules/usage
 */
import fs from 'node:fs'
import path from 'node:path'
import { denyIfNotLoopback, writeJson } from '../http.js'
import { API_PREFIX } from '../prefix.js'
import { dshHome, toolboxStateDir } from '../paths.js'
import { aggregateLogs, dayKey, readLegacyLedger } from '../usage-logs.js'

const PREFIX = API_PREFIX
const SNAPSHOT_VERSION = 1
const BUCKETS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
const TREND_DAYS = 30
const STALE_BALANCE_MS = 6 * 60 * 60 * 1000
const BALANCE_TTL_MS = 60_000
const LIVE_BALANCE_TIMEOUT_MS = 10_000
/** DeepSeek 官方余额接口（固定 URL，不接受任何外部输入）。 */
const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'
/** 解析 DeepSeek API Key 时依次尝试的凭据引用名。 */
const DEEPSEEK_KEY_REFS = ['DEEPSEEK_API_KEY']

/** 提供钱包余额查询的供应商（供应商能力，不是所有供应商都有公开接口）。 */
const BALANCE_PROVIDERS = new Set(['deepseek-official'])

/** 读 JSON，任何失败返回 undefined。 */
function readJson(target) {
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'))
  } catch {
    return undefined
  }
}

/** 近 N 天的本地日期串（含今天），升序。 */
function recentDays(count) {
  const days = []
  const now = new Date()
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    days.push(dayKey(d.getTime()))
  }
  return days
}

/** 空的分桶合计。 */
function emptyBuckets() {
  return Object.fromEntries(BUCKETS.map((key) => [key, 0]))
}

const rowTotal = (row) => row.input + row.output + row.cacheRead + row.cacheWrite

/**
 * 把「天/供应商/模型」聚合行整理成界面契约。
 * @param {object[]} rows - { day, provider, model, input, output, cacheRead, cacheWrite, reasoning, calls }
 */
function shape(rows) {
  const today = recentDays(1)[0]
  const days = new Set(recentDays(TREND_DAYS))

  const todayBuckets = emptyBuckets()
  const todayByProvider = {}
  let todayCalls = 0
  const trendTotals = new Map()
  const byModel = new Map()
  const byProvider = new Map()

  for (const row of rows) {
    if (row.day === today) {
      todayBuckets.inputTokens += row.input
      todayBuckets.outputTokens += row.output
      todayBuckets.cacheReadTokens += row.cacheRead
      todayBuckets.cacheWriteTokens += row.cacheWrite
      todayBuckets.reasoningTokens += row.reasoning
      todayCalls += row.calls
      const provider = todayByProvider[row.provider] ??= { ...emptyBuckets(), calls: 0 }
      provider.inputTokens += row.input
      provider.outputTokens += row.output
      provider.cacheReadTokens += row.cacheRead
      provider.cacheWriteTokens += row.cacheWrite
      provider.reasoningTokens += row.reasoning
      provider.calls += row.calls
    }
    if (days.has(row.day)) {
      const acc = trendTotals.get(row.day) ?? { total: 0, calls: 0 }
      acc.total += rowTotal(row)
      acc.calls += row.calls
      trendTotals.set(row.day, acc)

      const key = `${row.provider} / ${row.model}`
      const model = byModel.get(key) ?? { provider: row.provider, model: row.model, total: 0, calls: 0 }
      model.total += rowTotal(row)
      model.calls += row.calls
      byModel.set(key, model)

      let prov = byProvider.get(row.provider)
      if (!prov) {
        prov = { provider: row.provider, total: 0, calls: 0, models: new Set() }
        byProvider.set(row.provider, prov)
      }
      prov.total += rowTotal(row)
      prov.calls += row.calls
      prov.models.add(row.model)
    }
  }

  const trend = [...days].sort().map((day) => ({ day, total: trendTotals.get(day)?.total ?? 0, calls: trendTotals.get(day)?.calls ?? 0 }))
  const models = [...byModel.values()].sort((a, b) => b.total - a.total).slice(0, 20)
  const providers = [...byProvider.values()]
    .map((p) => ({
      provider: p.provider,
      total: p.total,
      calls: p.calls,
      models: [...p.models].sort(),
      balanceSupported: BALANCE_PROVIDERS.has(p.provider),
    }))
    .sort((a, b) => b.total - a.total)

  return {
    today: { day: today, buckets: todayBuckets, calls: todayCalls, byProvider: todayByProvider },
    trend,
    models,
    providers,
  }
}

/**
 * 把 `deepseekAccount.getBalance()` 的返回值映射为界面余额项（纯函数，便于测试）。
 * @param {{status:string, value?:Array, bonusWallets?:Array}|null} result
 */
export function mapWalletBalances(result) {
  if (!result || result.status !== 'ready') return []
  const wallets = [
    ...(Array.isArray(result.value) ? result.value : []).map((w) => ({ w, bonus: false })),
    ...(Array.isArray(result.bonusWallets) ? result.bonusWallets : []).map((w) => ({ w, bonus: true })),
  ]
  const now = Date.now()
  return wallets
    .filter(({ w }) => w && typeof w === 'object')
    .map(({ w, bonus }) => ({
      provider: 'deepseek-official',
      displayName: bonus ? 'DeepSeek（赠送）' : 'DeepSeek',
      currency: String(w.currency ?? ''),
      totalBalance: String(w.balance ?? ''),
      updatedAt: now,
      ageMs: 0,
      stale: false,
      live: true,
      bonus,
    }))
}

/** 余额查询缓存（平台请求有网络开销；fresh=1 绕过）。 */
let balanceCache = { at: 0, payload: null }

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`余额查询超时（${ms}ms）`)), ms)),
  ])
}

/**
 * 经 DSH 账户服务查询**实时**钱包余额。
 * 插件只调用服务，不读取任何凭据文件（零密钥读取承诺）。
 * @param {object} ctx - 宿主上下文
 * @param {{fresh?: boolean}} [options]
 */
async function liveBalances(ctx, { fresh = false } = {}) {
  if (!fresh && balanceCache.payload && Date.now() - balanceCache.at < BALANCE_TTL_MS) return balanceCache.payload

  let account = null
  try { account = typeof ctx?.get === 'function' ? ctx.get('deepseekAccount') : null } catch { account = null }
  if (!account || typeof account.getBalance !== 'function') {
    return { live: false, reason: 'service-absent', balances: null, links: null, checkedAt: Date.now() }
  }

  let payload
  try {
    const statePromise = typeof account.getState === 'function'
      ? withTimeout(Promise.resolve(account.getState()), LIVE_BALANCE_TIMEOUT_MS).catch(() => null)
      : Promise.resolve(null)
    const [state, result] = await Promise.all([
      statePromise,
      withTimeout(Promise.resolve(account.getBalance()), LIVE_BALANCE_TIMEOUT_MS),
    ])
    const links = state?.links
      ? { status: state.status ?? null, usageUrl: state.links.usageUrl ?? null, topUpUrl: state.links.topUpUrl ?? null }
      : null
    if (result === null) {
      payload = { live: true, signedOut: true, balances: [], links, checkedAt: Date.now() }
    } else if (result.status !== 'ready') {
      payload = { live: true, failed: true, balances: [], links, checkedAt: Date.now() }
    } else {
      payload = { live: true, signedOut: false, balances: mapWalletBalances(result), links, checkedAt: Date.now() }
    }
  } catch (error) {
    payload = { live: false, reason: error instanceof Error ? error.message : String(error), balances: null, links: null, checkedAt: Date.now() }
  }

  balanceCache = { at: Date.now(), payload }
  return payload
}

/**
 * 把 DeepSeek 官方余额接口的响应映射为界面余额项（纯函数，便于测试）。
 * 接口：GET https://api.deepseek.com/user/balance
 * 响应：{ is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
 */
export function mapApiKeyBalances(payload) {
  const infos = Array.isArray(payload?.balance_infos) ? payload.balance_infos : []
  const now = Date.now()
  return infos
    .filter((info) => info && typeof info === 'object')
    .map((info) => ({
      provider: 'deepseek-official',
      displayName: 'DeepSeek',
      currency: String(info.currency ?? ''),
      totalBalance: String(info.total_balance ?? ''),
      granted: info.granted_balance === undefined || info.granted_balance === null ? null : String(info.granted_balance),
      toppedUp: info.topped_up_balance === undefined || info.topped_up_balance === null ? null : String(info.topped_up_balance),
      available: payload?.is_available !== false,
      updatedAt: now,
      ageMs: 0,
      stale: false,
      live: true,
      source: 'api-key',
    }))
}

/** API Key 余额查询缓存（与平台会话查询相互独立）。 */
let apiKeyCache = { at: 0, payload: null }

/**
 * 用凭据服务解析出的 DeepSeek API Key 直连官方余额接口（平台未授权时的实时来源）。
 *
 * 安全边界（同步记录于 SECURITY.md）：密钥经 `ctx.credentials.resolve` 这一
 * 官方 seam 解析，**不读取 .credentials.yaml 文件**；仅在本函数内用于一次
 * 固定 URL 的 HTTPS GET；不写入日志、不进入任何响应、不落盘、不缓存明文
 * （缓存里只存映射后的数字）。
 * @param {object} ctx - 宿主上下文
 * @param {{fresh?: boolean}} [options]
 */
async function apiKeyBalances(ctx, { fresh = false } = {}) {
  if (!fresh && apiKeyCache.payload && Date.now() - apiKeyCache.at < BALANCE_TTL_MS) return apiKeyCache.payload
  let payload
  try {
    let credentials = null
    try { credentials = typeof ctx?.get === 'function' ? ctx.get('credentials') : null } catch { credentials = null }
    if (!credentials || typeof credentials.resolve !== 'function') {
      payload = { available: false, reason: 'credentials-absent', balances: null }
    } else {
      let key = null
      for (const ref of DEEPSEEK_KEY_REFS) {
        try {
          const hit = await credentials.resolve(ref)
          if (hit && typeof hit.value === 'string' && hit.value.length > 0) { key = hit.value; break }
        } catch { /* 换下一个引用名继续尝试 */ }
      }
      if (!key) {
        payload = { available: false, reason: 'no-key', balances: null }
      } else {
        const response = await fetch(DEEPSEEK_BALANCE_URL, {
          headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
          signal: AbortSignal.timeout(LIVE_BALANCE_TIMEOUT_MS),
        })
        if (!response.ok) {
          // 只回报状态码——绝不含密钥或响应正文（正文可能回显凭据线索）。
          payload = { available: false, reason: `http-${response.status}`, balances: null }
        } else {
          const balances = mapApiKeyBalances(await response.json())
          payload = { available: balances.length > 0, reason: balances.length > 0 ? null : 'empty', balances }
        }
      }
    }
  } catch (error) {
    payload = { available: false, reason: error instanceof Error ? error.message : String(error), balances: null }
  }
  apiKeyCache = { at: Date.now(), payload }
  return payload
}

/** 旧余额快照（外部插件产物）：仅在实时查询不可用时兜底，并标注过期。 */
function snapshotBalances(home) {
  const snapshotPath = path.join(home, 'dsh-usage', 'provider-snapshots.json')
  const snapshot = readJson(snapshotPath)
  if (!snapshot || snapshot.version !== SNAPSHOT_VERSION || typeof snapshot.providers !== 'object') {
    return { balances: null, spend: null, snapshotAgeMs: null }
  }
  const balances = Object.values(snapshot.providers)
    .filter((p) => p && typeof p === 'object' && p.balance && typeof p.balance === 'object')
    .map((p) => {
      const updatedAt = typeof p.balance.updatedAt === 'number' ? p.balance.updatedAt : null
      const ageMs = updatedAt ? Date.now() - updatedAt : null
      return {
        provider: String(p.provider ?? ''),
        displayName: String(p.displayName ?? p.provider ?? ''),
        currency: String(p.balance.currency ?? ''),
        totalBalance: String(p.balance.totalBalance ?? ''),
        updatedAt,
        ageMs,
        stale: ageMs === null ? true : ageMs > STALE_BALANCE_MS,
        live: false,
      }
    })
  let spend = null
  if (snapshot.spendWatch && typeof snapshot.spendWatch === 'object') {
    spend = {
      accruedCny: Number(snapshot.spendWatch.accruedCny) || 0,
      since: typeof snapshot.spendWatch.since === 'number' ? snapshot.spendWatch.since : null,
    }
  }
  let snapshotAgeMs = null
  try { snapshotAgeMs = Date.now() - fs.statSync(snapshotPath).mtimeMs } catch { /* 忽略 */ }
  return { balances, spend, snapshotAgeMs }
}

/**
 * 组装余额区块。优先级：
 *   1. 平台账户服务（已登录 → 实时钱包余额，含充值/赠送钱包）
 *   2. **DeepSeek API Key 直连官方余额接口**（未登录时的实时来源）
 *   3. 旧快照（仅当前两者都不可用时，并保留过期标记）
 * @returns {Promise<{balances: object[]|null, balanceSource: string, balanceNote: string|null, accountLinks: object|null, spend: object|null}>}
 */
async function balanceSection(ctx, home, { fresh }) {
  const live = await liveBalances(ctx, { fresh })
  if (live.live && live.balances && live.balances.length > 0) {
    return {
      balances: live.balances,
      balanceSource: 'live',
      balanceNote: null,
      accountLinks: live.links ?? null,
      spend: null,
    }
  }

  // 平台侧不可用（未登录 / 查询失败 / 服务缺失）→ 用 API Key 直连官方余额接口
  const keyed = await apiKeyBalances(ctx, { fresh })
  if (keyed.available && keyed.balances && keyed.balances.length > 0) {
    return {
      balances: keyed.balances,
      balanceSource: 'live-api-key',
      // 平台未登录但用 Key 拿到了余额：既给数字，也保留登录入口（链接来自平台账户服务）。
      balanceNote: live.live && live.signedOut ? 'signed-out' : null,
      accountLinks: live.links ?? null,
      spend: null,
    }
  }

  if (live.live && live.signedOut) {
    return {
      balances: [],
      balanceSource: 'live-signed-out',
      balanceNote: keyed.reason === 'no-key' || keyed.reason === 'credentials-absent' ? 'signed-out-no-key' : 'signed-out',
      accountLinks: live.links ?? null,
      spend: null,
    }
  }
  if (live.live && live.failed) {
    return { balances: [], balanceSource: 'live-failed', balanceNote: 'failed', accountLinks: live.links ?? null, spend: null }
  }
  const snapshot = snapshotBalances(home)
  return {
    balances: snapshot.balances,
    balanceSource: snapshot.balances && snapshot.balances.length > 0 ? 'snapshot' : 'none',
    balanceNote: 'service-absent',
    accountLinks: null,
    spend: snapshot.spend,
    snapshotAgeMs: snapshot.snapshotAgeMs,
  }
}

/**
 * 聚合用量与余额。
 * @param {{fresh?: boolean, ctx?: object}} [options]
 */
export async function aggregateUsage({ fresh = false, ctx = null } = {}) {
  const home = dshHome()
  const started = Date.now()
  const scan = aggregateLogs(home, { cachePath: path.join(toolboxStateDir(), 'usage-log-cache.json'), fresh })
  const balances = await balanceSection(ctx, home, { fresh })
  const scanInfo = {
    files: scan.files,
    sessions: scan.sessions,
    frames: scan.frames,
    events: scan.events,
    usageEvents: scan.usageEvents,
    failedFrames: scan.failedFrames,
    cacheHits: scan.cacheHits,
    elapsedMs: Date.now() - started,
  }

  if (scan.rows.length > 0) {
    return {
      available: true,
      source: 'session-logs',
      sourceLabel: 'DSH 会话日志（实时）',
      ...shape(scan.rows),
      ...balances,
      scan: scanInfo,
      readAt: Date.now(),
    }
  }

  const legacy = readLegacyLedger(home)
  if (legacy) {
    return {
      available: true,
      source: 'legacy-ledger',
      sourceLabel: '外部台账（社区插件，可能已停止更新）',
      ...shape(legacy.rows),
      ...balances,
      scan: scanInfo,
      legacyUpdatedAt: legacy.mtimeMs,
      note: '未发现可读的会话日志，已回退到旧台账；其数据可能已冻结。',
      readAt: Date.now(),
    }
  }

  return {
    available: false,
    source: null,
    reason: 'no-usage-source',
    hint: '未找到任何用量数据源：既没有可读的会话日志，也没有外部台账。',
    scan: scanInfo,
    readAt: Date.now(),
  }
}

/**
 * 注册用量路由（GET，只读）。
 * @param ctx - 宿主上下文（需 webServer）
 * @returns disposer
 */
export function registerUsage(ctx) {
  return ctx.webServer.register({
    kind: 'exact',
    path: PREFIX + '/usage',
    handler: async (request, response) => {
      if (denyIfNotLoopback(request, response)) return
      const fresh = /[?&]fresh=1\b/.test(String(request.url ?? ''))
      try {
        writeJson(response, 200, { ok: true, ...(await aggregateUsage({ fresh, ctx })) })
      } catch (error) {
        writeJson(response, 200, {
          ok: true,
          available: false,
          reason: 'internal',
          hint: error instanceof Error ? error.message : String(error),
        })
      }
    },
  })
}
