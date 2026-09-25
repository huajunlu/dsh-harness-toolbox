/**
 * updater — 更新中心宿主模块（对抗式审查 F1/F2/F3/F6/F11 的落地）。
 *
 * 职责：
 *   - 版本校验：`npm view dist-tags` 一次拿全 latest/next/alpha 三个通道，
 *     天然继承用户的 .npmrc 镜像与代理（F6）；结果缓存 6 小时（F11）。
 *   - 升级执行：POST 一次性 nonce + 回环 + JSON 围栏校验后，拉起分离进程
 *     scripts/upgrade.mjs（停服务 → 备份 → npm install → 重启 → 健康检查 →
 *     失败自动回滚，F2/F3），宿主自身随后被停掉，绝不原地装（F2）。
 *   - 状态与历史：脚本写 upgrade-state.json / upgrade-history.json，
 *     宿主只读并对外服务；进行中拒绝并发升级（409）。
 * @module dsh-harness-toolbox/modules/updater
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { moduleMeta } from '../registry.js'
import { denyIfNotLoopback, denyUnsafePost, readJsonBody, writeJson } from '../http.js'
import { consumeNonce, issueNonce } from '../security.js'
import { API_PREFIX } from '../prefix.js'
import { wmiRunNode } from '../wmi.js'
import { compareVersions, isValidVersion } from '../semver-lite.js'
import {
  currentHarnessVersion,
  installMode,
  newestWebLog,
  runtimeDir,
  toolboxStateDir,
} from '../paths.js'

const execFileAsync = promisify(execFile)

const PREFIX = API_PREFIX
const DIST_TAGS_TTL_MS = 6 * 60 * 60 * 1000
const CHANNELS = new Set(['latest', 'next', 'alpha'])
const ACTIVE_PHASES = new Set(['stopping', 'installing', 'rolling-back', 'restarting', 'verifying'])

/** 状态目录内的固定文件。 */
const files = () => {
  const dir = toolboxStateDir()
  return {
    dir,
    distTags: path.join(dir, 'dist-tags.json'),
    config: path.join(dir, 'config.json'),
    state: path.join(dir, 'upgrade-state.json'),
    history: path.join(dir, 'upgrade-history.json'),
    backup: path.join(dir, 'backup'),
    scriptLog: path.join(dir, 'upgrade-runner.log'),
    error: path.join(dir, 'last-upgrade-error.txt'),
  }
}

/** 确保状态目录存在。 */
function ensureStateDir() {
  const f = files()
  fs.mkdirSync(f.dir, { recursive: true })
  return f
}

/** 原子写 JSON（tmp + rename）。 */
function writeJsonFile(target, value) {
  const tmp = target + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  fs.renameSync(tmp, target)
}

/** 读 JSON；任何失败返回 null（防御式，F8 同款策略）。 */
function readJsonFile(target) {
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** 读 JSON 数组文件；失败返回 []。 */
function readJsonArray(target) {
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** 定位 npm-cli.js（避开 .cmd 无 shell 不可执行的问题，也杜绝 shell 注入）。 */
async function npmCliPath() {
  const beside = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (fs.existsSync(beside)) return beside
  const fallback = await execFileAsync(process.platform === 'win32' ? 'where' : 'which', ['npm'])
  const first = fallback.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
  if (!first) throw new Error('npm 未找到')
  if (first.endsWith('.cmd') || first.endsWith('.bat')) {
    const real = first.replace(/\.cmd$|\.bat$/i, '')
    const js = real + path.sep + 'node_modules' + path.sep + 'npm' + path.sep + 'bin' + path.sep + 'npm-cli.js'
    if (fs.existsSync(js)) return js
    throw new Error('npm-cli.js 未找到')
  }
  const js = path.join(path.dirname(first), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (fs.existsSync(js)) return js
  throw new Error('npm-cli.js 未找到')
}

/** 执行 `npm <args>`，120s 超时，20MB 输出上限。 */
async function runNpm(args, { timeout = 120_000 } = {}) {
  const cli = await npmCliPath()
  const { stdout } = await execFileAsync(process.execPath, [cli, ...args], {
    timeout,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
  })
  return stdout
}

/** 读/写用户通道偏好（默认 latest）。 */
function readChannel() {
  const config = readJsonFile(files().config)
  const channel = config?.channel
  return CHANNELS.has(channel) ? channel : 'latest'
}

function writeChannel(channel) {
  writeJsonFile(files().config, { channel })
}

/** 读取 dist-tags 缓存；过期返回 null。 */
function freshDistTags() {
  const cached = readJsonFile(files().distTags)
  if (!cached?.tags || typeof cached.checkedAt !== 'number') return null
  if (Date.now() - cached.checkedAt > DIST_TAGS_TTL_MS) return null
  return cached
}

/** 强制刷新 dist-tags（npm view，尊重镜像）。 */
async function refreshDistTags() {
  const raw = await runNpm(['view', '@deepseek-ai/dsh', 'dist-tags', '--json'], { timeout: 30_000 })
  const tags = JSON.parse(raw)
  const clean = {}
  for (const key of ['latest', 'next', 'alpha']) {
    if (typeof tags[key] === 'string' && isValidVersion(tags[key])) clean[key] = tags[key]
  }
  if (Object.keys(clean).length === 0) throw new Error('npm view 未返回可用 dist-tag')
  const record = { tags: clean, checkedAt: Date.now() }
  writeJsonFile(files().distTags, record)
  return record
}

/** 心跳超时：执行器每 15s 刷一次 updatedAt（见 scripts/upgrade.mjs 心跳段）。 */
const HEARTBEAT_TIMEOUT_MS = 120_000

/**
 * 升级是否进行中——心跳锁 + 死执行器自愈。
 *
 * 实战事故（2026-09-25）：执行器停服时树杀把自己杀掉，state 永远冻结在
 * stopping，30 分钟陈旧锁让后续每次点击都被 409 拒绝 → 用户看到的「点击
 * 后没反应」。双重修复：执行器侧已改为祖先单杀 + 15s 心跳；本侧以
 * 「120s 无心跳 = 执行器已死」判定，把僵尸相位**自愈改写为 failed**、
 * 记入历史并立即解锁——死执行器不再占用锁，用户下一次点击即可重试。
 */
function activeState() {
  const f = files()
  const state = readJsonFile(f.state)
  if (!state) return null
  if (!ACTIVE_PHASES.has(state.phase)) return null
  const last = typeof state.updatedAt === 'number' && state.updatedAt > 0
    ? state.updatedAt
    : (typeof state.startedAt === 'number' ? state.startedAt : 0)
  if (Date.now() - last <= HEARTBEAT_TIMEOUT_MS) return state
  // 心跳丢失 → 自愈：冻结相位改写为 failed + 记历史 + 解锁。
  try {
    writeJsonFile(f.state, {
      ...state,
      phase: 'failed',
      reason: '执行器心跳丢失（升级已中断，已自动解锁）',
      updatedAt: Date.now(),
    })
    const list = readJsonArray(f.history)
    list.push({
      at: Date.now(),
      mode: state.mode ?? 'upgrade',
      target: state.to ?? null,
      ok: false,
      reason: '执行器心跳丢失（升级中断，未安装任何变化）',
    })
    while (list.length > 50) list.shift()
    writeJsonFile(f.history, list)
  } catch {
    // 自愈写入失败：下次读取重试（锁判定本身已放行，不会卡住用户）。
  }
  return null
}

/** 组装 status 响应。 */
function statusBody() {
  const f = ensureStateDir()
  const cached = freshDistTags()
  const channel = readChannel()
  const tags = cached?.tags ?? null
  const current = currentHarnessVersion()
  const mode = installMode()
  const target = tags ? tags[channel] ?? null : null
  const running = activeState()
  const history = readJsonArray(f.history).slice(-10).reverse()
  return {
    ok: true,
    nonce: issueNonce(),
    current,
    installMode: mode,
    upgradeSupported: mode === 'local' && runtimeDir() !== null,
    channel,
    distTags: tags,
    checkedAt: cached?.checkedAt ?? null,
    stale: cached === null,
    target,
    updateAvailable: Boolean(target && current && compareVersions(target, current) > 0),
    latestAcrossTags: tags ? Object.values(tags).sort(compareVersions).at(-1) : null,
    upgrading: running,
    state: readJsonFile(f.state),
    history,
    modules: moduleMeta(),
  }
}

/**
 * 注册更新中心路由。
 * @param ctx - 宿主上下文（需 webServer）。
 * @returns disposer。
 */
export function registerUpdater(ctx) {
  // 注册时捕获端口：handler 请求时访问 ctx 服务在纤维 inactive 后会抛错。
  const port = ctx.webServer.port
  const disposers = [
    ctx.webServer.register({
      kind: 'exact',
      path: PREFIX + '/status',
      handler: (request, response) => {
        if (denyIfNotLoopback(request, response)) return
        writeJson(response, 200, statusBody())
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: PREFIX + '/check',
      handler: async (request, response) => {
        if (denyUnsafePost(request, response)) return
        try {
          await refreshDistTags()
          writeJson(response, 200, statusBody())
        } catch (error) {
          writeJson(response, 502, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            ...statusBody(),
          })
        }
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: PREFIX + '/channel',
      handler: async (request, response) => {
        if (denyUnsafePost(request, response)) return
        const body = await readJsonBody(request)
        const channel = body?.channel
        if (!CHANNELS.has(channel)) {
          writeJson(response, 400, { ok: false, error: 'channel 必须是 latest / next / alpha' })
          return
        }
        writeChannel(channel)
        writeJson(response, 200, statusBody())
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: PREFIX + '/upgrade',
      handler: async (request, response) => {
        if (denyUnsafePost(request, response)) return
        const body = await readJsonBody(request)
        if (!consumeNonce(body?.nonce)) {
          writeJson(response, 403, { ok: false, error: 'nonce 无效或已过期，请刷新状态后重试' })
          return
        }
        if (!installMode() || installMode() !== 'local') {
          writeJson(response, 409, { ok: false, error: '当前安装形态不支持一键升级（仅支持本地运行时）' })
          return
        }
        const running = activeState()
        if (running) {
          writeJson(response, 409, { ok: false, error: '已有升级在进行中', state: running })
          return
        }
        const cached = freshDistTags()
        const channel = readChannel()
        const target = cached?.tags?.[channel]
        if (!target || !isValidVersion(target)) {
          writeJson(response, 409, { ok: false, error: '目标版本不可用，请先检查更新' })
          return
        }
        const current = currentHarnessVersion()
        if (current && compareVersions(target, current) <= 0) {
          writeJson(response, 409, { ok: false, error: '已是该通道最新版本' })
          return
        }
        // 启动前先落一个初始状态，客户端立即可见“已受理”。
        const f = ensureStateDir()
        writeJsonFile(f.state, {
          phase: 'stopping',
          mode: 'upgrade',
          from: current,
          to: target,
          channel,
          startedAt: Date.now(),
          pid: process.pid,
          port,
        })
        try {
          const executerPid = await launchRunner({
            mode: 'upgrade',
            target,
            channel,
            from: current ?? 'unknown',
            port,
          })
          writeJson(response, 202, { ok: true, state: readJsonFile(f.state), executerPid })
          // **体面自尽**：执行器已在树外（WMI 父=WmiPrvSE，不被本进程退出
          // 连坐）→ 400ms（202 已刷出 socket）后宿主退出 = 停服完成，执行器
          // 随后走备份→安装→WMI 重启→健康检查→回滚兜底全链路。
          setTimeout(() => process.exit(0), 400)
        } catch (error) {
          // 受理失败必须立即把 stopping 相位改 failed（否则心跳锁白等 120s）。
          const stale = readJsonFile(f.state)
          if (stale && stale.phase === 'stopping') {
            writeJsonFile(f.state, { ...stale, phase: 'failed', reason: error.message, updatedAt: Date.now() })
          }
          writeJson(response, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: PREFIX + '/state',
      handler: (request, response) => {
        if (denyIfNotLoopback(request, response)) return
        const f = files()
        writeJson(response, 200, {
          ok: true,
          state: readJsonFile(f.state),
          history: readJsonArray(f.history).slice(-10).reverse(),
          errorNote: fs.existsSync(f.error) ? fs.readFileSync(f.error, 'utf8') : null,
        })
      },
    }),
  ]
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 路由纤维已随宿主关闭。
      }
    }
  }
}

/**
 * 拉起升级/重启执行器 —— 必须树外（WMI）。
 *
 * 2026-09-25 实测环境特性：**父子进程共生**——父退出（含正常 exit）连坐
 * 杀子、taskkill 祖先连坐杀调用者。因此执行器绝不能是宿主的子孙：
 * 经 WMI Win32_Process.Create 创建（父=WmiPrvSE），宿主随后体面自尽，
 * 执行器照常推进（备份→安装→WMI 重启→健康检查→回滚兜底）。
 * 全部参数为服务端解析的固定值或已过正则/semver 校验的值，无 shell 拼接。
 * @returns {Promise<number>} 执行器 pid
 */
async function launchRunner({ mode, target, channel, from, port }) {
  const f = ensureStateDir()
  const here = path.dirname(fileURLToPath(import.meta.url))
  const script = path.join(here, '..', '..', 'scripts', 'upgrade.mjs')
  const runtime = runtimeDir()
  if (!runtime) throw new Error('无法定位本地运行时目录')
  const log = newestWebLog() || path.join(f.dir, 'web.log')
  const args = [
    '--mode', mode,
    '--runtime', runtime,
    '--port', String(port),
    '--parent-pid', String(process.pid),
    '--state', f.state,
    '--history', f.history,
    '--backup', f.backup,
    '--runner-log', f.scriptLog,
    '--error-note', f.error,
    '--service-log', log,
    '--launcher-dir', path.dirname(runtime),
    '--workdir', process.cwd(),
  ]
  if (mode === 'upgrade') {
    if (!isValidVersion(target)) throw new Error('目标版本格式非法')
    args.push('--target', target, '--channel', channel, '--from', from)
  }
  return wmiRunNode(process.execPath, script, args)
}
