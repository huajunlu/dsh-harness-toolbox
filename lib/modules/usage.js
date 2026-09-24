/**
 * usage — API 用量宿主模块（对抗式审查 F8：防御式读取第三方台账）。
 *
 * 数据源全部只读：
 *   - $DSH_HOME/dsh-usage/usage-ledger.json      （@linxin666/dsh-usage 的 token 台账）
 *   - $DSH_HOME/dsh-usage/provider-snapshots.json（余额/套餐探测快照）
 * 契约脆弱性对策：严格校验顶层 version 字段，schema 不认识 → 返回
 * available:false + 原因，绝不抛错、绝不半渲染（F8）。该插件不存在或被
 * 禁用时同样走 available:false 路径，客户端展示引导文案。
 * @module dsh-harness-toolbox/modules/usage
 */
import fs from 'node:fs'
import path from 'node:path'
import { denyIfNotLoopback, writeJson } from '../http.js'
import { API_PREFIX } from '../prefix.js'
import { dshHome } from '../paths.js'

const PREFIX = API_PREFIX
const LEDGER_VERSION = 1
const SNAPSHOT_VERSION = 1
const BUCKETS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']

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
    days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
  }
  return days
}

/** 空的分桶合计。 */
function emptyBuckets() {
  return Object.fromEntries(BUCKETS.map((key) => [key, 0]))
}

/**
 * 聚合台账：今日四桶 + 近 30 天趋势 + 分 provider/模型明细。
 * @returns {{available:boolean, reason?:string, ...}|{available:false, reason:string}}
 */
function aggregate() {
  const ledgerPath = path.join(dshHome(), 'dsh-usage', 'usage-ledger.json')
  const snapshotPath = path.join(dshHome(), 'dsh-usage', 'provider-snapshots.json')

  if (!fs.existsSync(ledgerPath)) {
    return { available: false, reason: 'no-ledger', hint: '未发现用量台账：@linxin666/dsh-usage 未安装或尚未产生数据。' }
  }
  const ledger = readJson(ledgerPath)
  if (!ledger || ledger.version !== LEDGER_VERSION || typeof ledger.days !== 'object' || ledger.days === null) {
    return { available: false, reason: 'schema-mismatch', hint: '台账格式与本插件不兼容（version ≠ 1），已安全忽略。' }
  }

  const today = recentDays(1)[0]
  const days30 = recentDays(30)

  // 今日分桶（按 provider → model 两级保留，互不相加的口径原样透传）。
  const todayBuckets = emptyBuckets()
  const todayByProvider = {}
  let todayCalls = 0
  const todaySource = ledger.days[today]
  if (todaySource && typeof todaySource === 'object') {
    for (const [provider, models] of Object.entries(todaySource)) {
      if (!models || typeof models !== 'object') continue
      const providerAgg = emptyBuckets()
      let providerCalls = 0
      for (const [model, counts] of Object.entries(models)) {
        if (!counts || typeof counts !== 'object') continue
        for (const bucket of BUCKETS) {
          const value = Number(counts[bucket])
          if (Number.isFinite(value) && value > 0) {
            todayBuckets[bucket] += value
            providerAgg[bucket] += value
          }
        }
        const calls = Number(counts.calls)
        if (Number.isFinite(calls) && calls > 0) {
          todayBuckets.calls = (todayBuckets.calls ?? 0) + calls
          providerAgg.calls = (providerAgg.calls ?? 0) + calls
          providerCalls += calls
        }
      }
      todayByProvider[provider] = providerAgg
      todayCalls += providerCalls
    }
  }

  // 近 30 天趋势：每天 totalTokens（四桶之和）+ calls。
  const trend = days30.map((day) => {
    const source = ledger.days[day]
    let total = 0
    let calls = 0
    if (source && typeof source === 'object') {
      for (const models of Object.values(source)) {
        if (!models || typeof models !== 'object') continue
        for (const counts of Object.values(models)) {
          if (!counts || typeof counts !== 'object') continue
          for (const bucket of BUCKETS) {
            const value = Number(counts[bucket])
            if (Number.isFinite(value) && value > 0) total += value
          }
          const n = Number(counts.calls)
          if (Number.isFinite(n) && n > 0) calls += n
        }
      }
    }
    return { day, total, calls }
  })

  // 分模型明细（近 30 天，按 total 降序取前 20）。
  const byModel = {}
  for (const day of days30) {
    const source = ledger.days[day]
    if (!source || typeof source !== 'object') continue
    for (const [provider, models] of Object.entries(source)) {
      if (!models || typeof models !== 'object') continue
      for (const [model, counts] of Object.entries(models)) {
        if (!counts || typeof counts !== 'object') continue
        const key = `${provider} / ${model}`
        const entry = byModel[key] ??= { provider, model, total: 0, calls: 0 }
        for (const bucket of BUCKETS) {
          const value = Number(counts[bucket])
          if (Number.isFinite(value) && value > 0) entry.total += value
        }
        const n = Number(counts.calls)
        if (Number.isFinite(n) && n > 0) entry.calls += n
      }
    }
  }
  const models = Object.values(byModel).sort((a, b) => b.total - a.total).slice(0, 20)

  // 余额快照：认识的 schema 才透出，脏数据整体忽略。
  let balances = null
  let spend = null
  const snapshot = readJson(snapshotPath)
  if (snapshot && snapshot.version === SNAPSHOT_VERSION && typeof snapshot.providers === 'object') {
    balances = Object.values(snapshot.providers)
      .filter((p) => p && typeof p === 'object' && p.balance && typeof p.balance === 'object')
      .map((p) => ({
        provider: String(p.provider ?? ''),
        displayName: String(p.displayName ?? p.provider ?? ''),
        currency: String(p.balance.currency ?? ''),
        totalBalance: String(p.balance.totalBalance ?? ''),
        updatedAt: typeof p.balance.updatedAt === 'number' ? p.balance.updatedAt : null,
      }))
    if (snapshot.spendWatch && typeof snapshot.spendWatch === 'object') {
      const watch = snapshot.spendWatch
      spend = {
        accruedCny: Number(watch.accruedCny) || 0,
        since: typeof watch.since === 'number' ? watch.since : null,
      }
    }
  }

  return {
    available: true,
    today: { day: today, buckets: todayBuckets, calls: todayCalls, byProvider: todayByProvider },
    trend,
    models,
    balances,
    spend,
    source: { ledgerPath, snapshotPath: fs.existsSync(snapshotPath) ? snapshotPath : null },
    readAt: Date.now(),
  }
}

/**
 * 注册用量路由。
 * @param ctx - 宿主上下文（需 webServer）。
 * @returns disposer。
 */
export function registerUsage(ctx) {
  const dispose = ctx.webServer.register({
    kind: 'exact',
    path: PREFIX + '/usage',
    handler: (request, response) => {
      if (denyIfNotLoopback(request, response)) return
      try {
        writeJson(response, 200, { ok: true, ...aggregate() })
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
  return dispose
}
