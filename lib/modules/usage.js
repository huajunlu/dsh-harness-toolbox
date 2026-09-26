/**
 * usage — API 用量宿主模块（自给自足数据源 + 防御式读取）。
 *
 * 数据源（按优先级）：
 *   1. **DSH 自身会话日志**：$DSH_HOME/sessions/<ws>/session-<id>/session.vN.jsonl.zstd
 *      中的 assistant/message 事件带 usage（token 桶）与 message.source
 *      （provider/model）——实时、准确、无需第三方。见 lib/usage-logs.js。
 *   2. 旧版外部台账 $DSH_HOME/dsh-usage/usage-ledger.json（社区插件产物）。
 *      该插件常已不在此 profile 中、台账会冻结，故仅作兜底。
 *   3. 余额快照 $DSH_HOME/dsh-usage/provider-snapshots.json——同样来自该插件，
 *      可能已过期；响应携带 ageMs/stale，界面明确标注而非假装实时。
 *
 * 契约脆弱性对策（对抗式审查 F8）：所有读取严格校验 schema，不认识就安全
 * 忽略并走 available:false + 原因，绝不抛错、绝不半渲染。
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
    }
  }

  const trend = [...days].sort().map((day) => ({ day, total: trendTotals.get(day)?.total ?? 0, calls: trendTotals.get(day)?.calls ?? 0 }))
  const models = [...byModel.values()].sort((a, b) => b.total - a.total).slice(0, 20)

  return {
    today: { day: today, buckets: todayBuckets, calls: todayCalls, byProvider: todayByProvider },
    trend,
    models,
  }
}

/** 余额快照（外部插件产物）：透出但标注新鲜度，避免假装实时。 */
function balancesFrom(home) {
  const snapshotPath = path.join(home, 'dsh-usage', 'provider-snapshots.json')
  const snapshot = readJson(snapshotPath)
  if (!snapshot || snapshot.version !== SNAPSHOT_VERSION || typeof snapshot.providers !== 'object') {
    return { balances: null, spend: null, snapshotPath: null, snapshotAgeMs: null }
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
  return { balances, spend, snapshotPath, snapshotAgeMs }
}

/**
 * 聚合用量：优先会话日志，其次旧台账。
 * @param {{fresh?: boolean}} [options]
 */
export function aggregateUsage({ fresh = false } = {}) {
  const home = dshHome()
  const started = Date.now()
  const scan = aggregateLogs(home, { cachePath: path.join(toolboxStateDir(), 'usage-log-cache.json'), fresh })
  const balances = balancesFrom(home)

  if (scan.rows.length > 0) {
    return {
      available: true,
      source: 'session-logs',
      sourceLabel: 'DSH 会话日志（实时）',
      ...shape(scan.rows),
      ...balances,
      scan: {
        files: scan.files,
        sessions: scan.sessions,
        frames: scan.frames,
        events: scan.events,
        usageEvents: scan.usageEvents,
        failedFrames: scan.failedFrames,
        cacheHits: scan.cacheHits,
        elapsedMs: Date.now() - started,
      },
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
      scan: { files: 0, sessions: 0, frames: 0, events: 0, usageEvents: 0, failedFrames: 0, cacheHits: 0, elapsedMs: Date.now() - started },
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
    scan: { files: scan.files, sessions: scan.sessions, frames: scan.frames, events: scan.events, usageEvents: scan.usageEvents, elapsedMs: Date.now() - started },
    readAt: Date.now(),
  }
}

/**
 * 注册用量路由（GET，只读）。
 * @param ctx - 宿主上下文（需 webServer）。
 * @returns disposer
 */
export function registerUsage(ctx) {
  return ctx.webServer.register({
    kind: 'exact',
    path: PREFIX + '/usage',
    handler: (request, response) => {
      if (denyIfNotLoopback(request, response)) return
      const fresh = /[?&]fresh=1\b/.test(String(request.url ?? ''))
      try {
        writeJson(response, 200, { ok: true, ...aggregateUsage({ fresh }) })
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
