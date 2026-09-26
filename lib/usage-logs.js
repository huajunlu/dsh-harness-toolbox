/**
 * usage-logs — 从 DSH 自身的会话日志统计 API 用量（自给自足的数据源）。
 *
 * 背景（2026-09-26 排查）：工具箱原先读取 `$DSH_HOME/dsh-usage/usage-ledger.json`
 * ——那是一个**社区用量插件**写的台账。该插件在 profile 重建后不复存在，
 * 台账自 9-24 起冻结，于是界面显示"用量迟迟不更新"。而 DSH 自己**一直在写**
 * 会话日志（`$DSH_HOME/sessions/<workspace>/session-<id>/session.vN.jsonl.zstd`），
 * 其中的 `assistant/message` 事件带 `usage`（token 桶）与 `message.source`
 * （provider/model），事件还带毫秒时间戳。本模块直接聚合这些日志，
 * 不再依赖任何外部记录方。
 *
 * 读取要点（实测）：
 * - 日志是**多帧 zstd 追加**文件：Node 的 `zstdDecompressSync` 只解第一帧，
 *   流式解码遇到第二帧报 "Unknown frame descriptor"。因此按 zstd 魔数
 *   (28 B5 2F FD) 切出帧边界，逐帧解压；魔数可能出现在压缩数据内部，
 *   该切片解压失败时与下一帧合并重试。
 * - 文件为追加写，读取时可能撞上半截帧（torn tail）→ 解压失败的帧直接跳过。
 * - 每个会话目录可能同时存在 v3/v4 两代日志；v4 是迁移后的**完整**日志，
 *   故取各会话的最高版本。
 *
 * 性能：单个 3 MB 日志（445 帧 / 1.3 万行）约 220 ms。按文件 size+mtime
 * 缓存聚合结果于 `$DSH_HOME/dsh-harness-toolbox/usage-log-cache.json`，
 * 只有变化的文件才重新解析（`fresh: true` 可强制全量重扫）。
 * @module dsh-harness-toolbox/usage-logs
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const CACHE_VERSION = 2

/** 返回 zstd 帧起点（连续魔数偏移）。 */
export function frameStarts(buf) {
  const starts = []
  let i = 0
  while (i < buf.length) {
    const at = buf.indexOf(MAGIC, i)
    if (at < 0) break
    starts.push(at)
    i = at + 4
  }
  return starts
}

/**
 * 逐帧解压为文本。魔数误判（出现在压缩数据内部）时与后续帧合并重试；
 * 追加写造成的半截帧解压失败则跳过。
 */
export function decodeFrames(buf) {
  const starts = frameStarts(buf)
  const parts = []
  let failed = 0
  let i = 0
  while (i < starts.length) {
    const from = starts[i]
    const to = i + 1 < starts.length ? starts[i + 1] : buf.length
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(from, to)).toString('utf8'))
      i += 1
    } catch {
      // 边界误判或半截帧：先尝试吃掉下一帧再试一次
      if (i + 1 < starts.length) {
        const to2 = i + 2 < starts.length ? starts[i + 2] : buf.length
        try {
          parts.push(zlib.zstdDecompressSync(buf.subarray(from, to2)).toString('utf8'))
          i += 2
          continue
        } catch { /* 落到下面计数 */ }
      }
      failed += 1
      i += 1
    }
  }
  return { text: parts.join(''), frames: starts.length, failed }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/** 从一条事件里取出用量行；不含量用时返回 null。 */
export function usageRowOf(event) {
  const usage = event?.data?.usage
  if (!usage || typeof usage !== 'object') return null
  if (typeof event.time !== 'number' || event.time <= 0) return null
  const source = event?.data?.message?.source ?? {}
  const provider = typeof source.provider === 'string' && source.provider ? source.provider : 'unknown'
  const model = typeof source.model === 'string' && source.model ? source.model : 'unknown'
  const input = num(usage.inputTokens ?? usage.uncachedInputTokens ?? usage.promptTokens)
  const output = num(usage.outputTokens ?? usage.completionTokens)
  // 部分供应商只报 total：用 total - output 兜底还原输入侧。
  const total = num(usage.totalTokens)
  const inputFinal = input || (total > output ? total - output : 0)
  return {
    time: event.time,
    provider,
    model,
    input: inputFinal,
    output,
    cacheRead: num(usage.cacheReadTokens),
    cacheWrite: num(usage.cacheWriteTokens),
    reasoning: num(usage.reasoningTokens),
  }
}

/** 把一段 jsonl 文本解析为按 天/供应商/模型 聚合的行。 */
export function aggregateText(text) {
  const rows = new Map() // key: day|provider|model
  let events = 0
  let usageEvents = 0
  for (const line of text.split('\n')) {
    if (!line) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    events += 1
    const row = usageRowOf(event)
    if (!row) continue
    usageEvents += 1
    const day = dayKey(row.time)
    const key = `${day}|${row.provider}|${row.model}`
    const acc = rows.get(key) ?? { day, provider: row.provider, model: row.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0 }
    acc.input += row.input
    acc.output += row.output
    acc.cacheRead += row.cacheRead
    acc.cacheWrite += row.cacheWrite
    acc.reasoning += row.reasoning
    acc.calls += 1
    rows.set(key, acc)
  }
  return { rows: [...rows.values()], events, usageEvents }
}

/** 本地日期键 YYYY-MM-DD（界面按用户本地时区展示"今天"）。 */
export function dayKey(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 列出各会话的最高版本日志（跳过 v3 等历史代，v4 为完整迁移结果）。 */
export function sessionLogFiles(homeDir) {
  const root = path.join(homeDir, 'sessions')
  const out = []
  let workspaces = []
  try { workspaces = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()) } catch { return out }
  for (const ws of workspaces) {
    const wsDir = path.join(root, ws.name)
    let sessions = []
    try { sessions = fs.readdirSync(wsDir, { withFileTypes: true }).filter((e) => e.isDirectory()) } catch { continue }
    for (const session of sessions) {
      const dir = path.join(wsDir, session.name)
      let files = []
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl.zstd')) } catch { continue }
      let best = null
      for (const f of files) {
        const ver = Number((f.match(/\.v(\d+)\./) || [])[1] ?? 0)
        if (!best || ver > best.ver) best = { file: path.join(dir, f), ver }
      }
      if (!best) continue
      try {
        const st = fs.statSync(best.file)
        out.push({ file: best.file, version: best.ver, size: st.size, mtimeMs: st.mtimeMs, session: session.name, workspace: ws.name })
      } catch { /* 竞态：文件刚被移走，忽略 */ }
    }
  }
  return out
}

function readCache(cachePath) {
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
    if (cached?.version === CACHE_VERSION && cached.files && typeof cached.files === 'object') return cached
  } catch { /* 首次或损坏：重建 */ }
  return { version: CACHE_VERSION, files: {} }
}

function writeCache(cachePath, cache) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true })
    fs.writeFileSync(cachePath, JSON.stringify(cache))
  } catch { /* 缓存写失败不影响本次结果 */ }
}

/**
 * 聚合所有会话日志的用量。
 * @param {string} homeDir DSH_HOME
 * @param {{ cachePath?: string, fresh?: boolean }} [options]
 * @returns {{ rows: object[], scanned: object, files: number, frames: number, events: number, usageEvents: number, cacheHits: number }}
 */
export function aggregateLogs(homeDir, { cachePath = null, fresh = false } = {}) {
  const files = sessionLogFiles(homeDir)
  const cache = cachePath ? readCache(cachePath) : { version: CACHE_VERSION, files: {} }
  const nextCache = { version: CACHE_VERSION, files: {} }
  const rows = []
  let frames = 0
  let events = 0
  let usageEvents = 0
  let cacheHits = 0
  let failedFrames = 0

  for (const entry of files) {
    const key = entry.file
    const cached = fresh ? null : cache.files[key]
    if (cached && cached.size === entry.size && cached.mtimeMs === entry.mtimeMs) {
      nextCache.files[key] = cached
      rows.push(...cached.rows)
      frames += cached.frames ?? 0
      events += cached.events ?? 0
      usageEvents += cached.usageEvents ?? 0
      failedFrames += cached.failedFrames ?? 0
      cacheHits += 1
      continue
    }
    let parsed
    try {
      const decoded = decodeFrames(fs.readFileSync(entry.file))
      parsed = aggregateText(decoded.text)
      frames += decoded.frames
      failedFrames += decoded.failed
    } catch {
      continue // 读不到就跳过这个会话，不影响整体
    }
    events += parsed.events
    usageEvents += parsed.usageEvents
    nextCache.files[key] = {
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      rows: parsed.rows,
      frames: 0,
      events: parsed.events,
      usageEvents: parsed.usageEvents,
      failedFrames: 0,
    }
    rows.push(...parsed.rows)
  }

  if (cachePath) writeCache(cachePath, nextCache)
  return {
    rows,
    files: files.length,
    frames,
    events,
    usageEvents,
    failedFrames,
    cacheHits,
    sessions: new Set(files.map((f) => f.session)).size,
  }
}

/** 旧版外部台账（社区插件产物，可能已停止更新）——仅作兜底数据源。 */
export function readLegacyLedger(homeDir) {
  const file = path.join(homeDir, 'dsh-usage', 'usage-ledger.json')
  try {
    const ledger = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (ledger?.version !== 1 || !ledger.days) return null
    const rows = []
    for (const [day, providers] of Object.entries(ledger.days)) {
      for (const [provider, models] of Object.entries(providers ?? {})) {
        for (const [model, v] of Object.entries(models ?? {})) {
          rows.push({
            day,
            provider,
            model,
            input: num(v.inputTokens),
            output: num(v.outputTokens),
            cacheRead: num(v.cacheReadTokens),
            cacheWrite: num(v.cacheWriteTokens),
            reasoning: num(v.reasoningTokens),
            calls: num(v.calls),
          })
        }
      }
    }
    return { rows, mtimeMs: fs.statSync(file).mtimeMs }
  } catch {
    return null
  }
}
