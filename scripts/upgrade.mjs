#!/usr/bin/env node
/**
 * upgrade.mjs — 升级/重启执行器（对抗式审查 F2/F3 的落地）。
 *
 * 以分离进程从宿主拉起，宿主随后被停掉也不影响本进程。状态机：
 *
 *   stopping → backing-up → installing → restarting → verifying → done
 *        │          │            │            │           │
 *        └──────────┴────────────┴────────────┴───────────┴→ rolling-back → rolled-back / failed
 *
 * 安全性质：
 *   - 停服用 taskkill /F /T（Windows 控制台服务不吃无 /F 的优雅信号），
 *     确认端口释放才继续 —— 不在服务运行时原地 npm install（Windows 文件锁
 *     会 EPERM，F2）；
 *   - 安装前备份 runtime 的 package.json + package-lock.json，失败原样恢复
 *     并 npm ci 重装旧树，再重启验证 —— 界面挂了也能自己爬起来（F3）；
 *   - 健康检查 = 能拿到任何 HTTP 应答（含 401，令牌轮换不影响“活着”判定）；
 *   - 每一步落盘 upgrade-state.json，全部输出写 runner 日志；
 *   - 手动恢复指引写 last-upgrade-error.txt，与启动器的 last-error.txt 同风格。
 *
 * 用法（由 updater 模块生成参数，勿手拼）：
 *   node upgrade.mjs --mode upgrade|restart --runtime D --port P --parent-pid N
 *     --state F --history F --backup D --runner-log F --error-note F
 *     --service-log F --launcher-dir D [--target V --channel C --from V]
 * @module dsh-harness-toolbox/scripts/upgrade
 */
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/* ────────────────────────── 参数解析（严格白名单） ────────────────────────── */

const KNOWN = new Set([
  'mode', 'runtime', 'port', 'parent-pid', 'state', 'history', 'backup',
  'runner-log', 'error-note', 'service-log', 'launcher-dir',
  'target', 'channel', 'from',
])

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '')
    if (!KNOWN.has(key) || argv[i + 1] === undefined) {
      throw new Error(`未知或残缺参数：${argv[i] ?? '(空)'}`)
    }
    out[key] = argv[i + 1]
  }
  if (!['upgrade', 'restart'].includes(out.mode)) throw new Error('mode 必须是 upgrade 或 restart')
  if (!/^\d+$/.test(out.port)) throw new Error('port 非法')
  if (!/^\d+$/.test(out['parent-pid'])) throw new Error('parent-pid 非法')
  if (out.mode === 'upgrade') {
    // 目标版本：三段数字 + 可选预发布，禁一切 shell 元字符。
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(out.target)) throw new Error('target 版本格式非法')
    if (!['latest', 'next', 'alpha'].includes(out.channel)) throw new Error('channel 非法')
  }
  for (const dirKey of ['runtime', 'state', 'history', 'backup', 'runner-log', 'error-note', 'service-log', 'launcher-dir']) {
    if (typeof out[dirKey] !== 'string' || out[dirKey].length === 0) throw new Error(`缺少 ${dirKey}`)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const PORT = Number(args.port)
const PARENT_PID = Number(args['parent-pid'])

/* ────────────────────────── 日志与状态 ────────────────────────── */

// 自身日志：追加写，带时间戳；宿主被杀后依然可用。
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`
  try {
    fs.appendFileSync(args['runner-log'], line)
  } catch {
    // 日志写不进不阻断状态机。
  }
}

// 状态落盘：tmp + rename 保证读端永远看到完整 JSON。
function setState(patch) {
  const next = { ...state, ...patch, updatedAt: Date.now() }
  state = next
  try {
    const tmp = args.state + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
    fs.renameSync(tmp, args.state)
  } catch (error) {
    log(`状态写入失败：${error.message}`)
  }
}

let state = {
  phase: 'stopping',
  mode: args.mode,
  startedAt: Date.now(),
}

// 失败手册：每条都是用户可直接执行的恢复命令。
function writeErrorNote(lines) {
  try {
    fs.writeFileSync(
      args['error-note'],
      [
        `[${new Date().toISOString()}] 升级执行器报告问题（模式：${args.mode}）`,
        ...lines.map((l) => `  ${l}`),
        '',
        `运行时目录：${args.runtime}`,
        `执行器日志：${args['runner-log']}`,
        `服务日志：  ${args['service-log']}`,
        '',
        '手动恢复：',
        `  cd /d "${args.runtime}"`,
        `  npm install @deepseek-ai/dsh@${args.from === 'unknown' ? '<原版本>' : args.from}`,
        '  然后重新运行 DeepSeek Harness 启动器快捷方式',
        '',
      ].join('\r\n'),
    )
  } catch {
    // 连错误手册都写不进时只能靠 runner 日志。
  }
}

function appendHistory(entry) {
  try {
    let list = []
    if (fs.existsSync(args.history)) {
      const parsed = JSON.parse(fs.readFileSync(args.history, 'utf8'))
      if (Array.isArray(parsed)) list = parsed
    }
    list.push(entry)
    while (list.length > 50) list.shift()
    const tmp = args.history + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2))
    fs.renameSync(tmp, args.history)
  } catch (error) {
    log(`历史写入失败：${error.message}`)
  }
}

/* ────────────────────────── 基础动作 ────────────────────────── */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 端口是否已有监听（能建立 TCP 连接 = 服务活着）。 */
function portAlive() {
  return new Promise((resolve) => {
    const socket = http.request({ host: '127.0.0.1', port: PORT, path: '/', timeout: 1500 }, (res) => {
      res.resume()
      resolve(true) // 任何应答（含 401/303/404）都算活
    })
    socket.on('error', () => resolve(false))
    socket.on('timeout', () => { socket.destroy(); resolve(false) })
    socket.end()
  })
}

/** 停掉监听本端口的进程：Windows 控制台进程不响应无 /F 的 WM_CLOSE，
 *  优雅停止对 node 控制台服务形同虚设（实测白等 20s），直接 /F /T 强停。 */
async function stopService() {
  const pidTargets = [PARENT_PID].filter((pid) => pid > 0 && pid !== process.pid)
  for (const pid of pidTargets) {
    try {
      await execFileAsync('taskkill', ['/PID', String(pid), '/F', '/T'], { windowsHide: true, timeout: 15_000 })
      log(`已停止 PID ${pid} 进程树`)
    } catch (error) {
      log(`停止 PID ${pid}：${error.message}（可能已退出，转端口清场）`)
    }
  }
  // 等端口释放，最多 15s；未释放则按端口找出残余 PID 强制清场。
  for (let i = 0; i < 30; i++) {
    if (!(await portAlive())) {
      log('端口已释放')
      return
    }
    await sleep(500)
  }
  log('端口仍被占用，按端口强制清场')
  try {
    const { stdout } = await execFileAsync('netstat', ['-ano'], { windowsHide: true, timeout: 15_000 })
    const pids = new Set()
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.includes('LISTENING')) continue
      const cols = line.trim().split(/\s+/)
      const local = cols[1] ?? ''
      if (local.endsWith(`:${PORT}`) && /^\d+$/.test(cols.at(-1) ?? '')) pids.add(cols.at(-1))
    }
    for (const pid of pids) {
      if (pid === String(process.pid)) continue
      await execFileAsync('taskkill', ['/PID', pid, '/F', '/T'], { windowsHide: true, timeout: 15_000 }).catch(() => {})
      log(`已强制结束 PID ${pid}`)
    }
  } catch (error) {
    log(`netstat 清场失败：${error.message}`)
  }
  for (let i = 0; i < 20 && await portAlive(); i++) await sleep(500)
  if (await portAlive()) throw new Error(`端口 ${PORT} 无法释放`)
}

/** 定位 npm-cli.js（与宿主同策略：不经过 shell）。 */
async function npmCli() {
  const beside = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (fs.existsSync(beside)) return beside
  const which = process.platform === 'win32' ? 'where' : 'which'
  const { stdout } = await execFileAsync(which, ['npm'], { windowsHide: true, timeout: 10_000 })
  const first = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
  if (!first) throw new Error('npm 未找到')
  const base = first.replace(/\.cmd$|\.bat$/i, '')
  const candidates = [
    path.join(path.dirname(base), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(base), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  const hit = candidates.find((p) => fs.existsSync(p))
  if (!hit) throw new Error('npm-cli.js 未找到')
  return hit
}

/** npm install/ ci 执行器：10 分钟超时，输出进 runner 日志。 */
async function runNpm(npmArgs) {
  const cli = await npmCli()
  log(`npm ${npmArgs.join(' ')}`)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...npmArgs], {
      cwd: args.runtime,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('npm 超时（10 分钟）'))
    }, 10 * 60 * 1000)
    const drain = (stream) => {
      let buffer = ''
      stream.on('data', (chunk) => {
        buffer += chunk.toString()
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines.slice(0, 40)) log(`  npm| ${line.trim()}`)
      })
    }
    drain(child.stdout)
    drain(child.stderr)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      code === 0 ? resolve() : reject(new Error(`npm 退出码 ${code}`))
    })
  })
}

/** 备份 runtime 根的两个清单文件（只备份清单：npm ci 可由 lock 重建树）。 */
function backupManifests() {
  fs.mkdirSync(args.backup, { recursive: true })
  for (const name of ['package.json', 'package-lock.json']) {
    const src = path.join(args.runtime, name)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(args.backup, name))
  }
  // 同时备份当前版本号，供恢复时精确回到原版本。
  fs.writeFileSync(path.join(args.backup, 'FROM_VERSION'), args.from)
  log(`清单已备份到 ${args.backup}`)
}

function restoreManifests() {
  for (const name of ['package.json', 'package-lock.json']) {
    const src = path.join(args.backup, name)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(args.runtime, name))
  }
  log('清单已从备份恢复')
}

/** 重启服务：经 cmd 起 node bin.js web（与 server.vbs 同形态），追加到服务日志。 */
function startService() {
  const binJs = path.join(args.runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!fs.existsSync(binJs)) throw new Error(`找不到入口：${binJs}`)
  const fd = fs.openSync(args['service-log'], 'a')
  const child = spawn(process.execPath, [binJs, 'web', '--no-open', '--port', String(PORT)], {
    cwd: args['launcher-dir'],
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  })
  child.unref()
  log(`服务已拉起（PID ${child.pid}），日志追加至 ${args['service-log']}`)
}

/** 健康检查：90s 内拿到任意 HTTP 应答即成功。 */
async function waitForHealthy() {
  for (let i = 0; i < 90; i++) {
    if (await portAlive()) return true
    await sleep(1000)
  }
  return false
}

/* ────────────────────────── 主流程 ────────────────────────── */

async function rollback(reason) {
  log(`进入回滚：${reason}`)
  setState({ phase: 'rolling-back', reason })
  try {
    restoreManifests()
    await runNpm(['ci', '--no-audit', '--no-fund', '--loglevel', 'error'])
    log('旧依赖树已按备份 lock 重建')
  } catch (error) {
    log(`回滚重装失败：${error.message}`)
    setState({ phase: 'failed', reason: `${reason}；回滚亦失败：${error.message}` })
    writeErrorNote([`失败原因：${reason}`, `回滚失败：${error.message}`, '建议：确认网络后手动 npm ci'])
    appendHistory({ at: Date.now(), mode: args.mode, target: args.target ?? null, ok: false, reason: `${reason}（回滚失败）` })
    return
  }
  setState({ phase: 'restarting' })
  startService()
  const healthy = await waitForHealthy()
  if (healthy) {
    setState({ phase: 'rolled-back', reason })
    log('回滚完成，服务已恢复旧版本')
    writeErrorNote([`升级失败已自动回滚：${reason}`, '当前运行的是升级前版本，可稍后重试'])
    appendHistory({ at: Date.now(), mode: args.mode, target: args.target ?? null, ok: false, reason: `已回滚：${reason}` })
  } else {
    setState({ phase: 'failed', reason: `${reason}；回滚后服务仍未起来` })
    writeErrorNote([`失败原因：${reason}`, '回滚后服务仍未监听端口', '请检查服务日志尾部'])
    appendHistory({ at: Date.now(), mode: args.mode, target: args.target ?? null, ok: false, reason: `${reason}（回滚后仍失败）` })
  }
}

async function main() {
  log(`执行器启动：mode=${args.mode} target=${args.target ?? '-'} port=${PORT}`)
  fs.mkdirSync(path.dirname(args.state), { recursive: true })

  // 1) 停服
  setState({ phase: 'stopping' })
  await stopService()

  if (args.mode === 'upgrade') {
    // 2) 备份
    setState({ phase: 'backing-up' })
    backupManifests()

    // 3) 安装目标版本
    setState({ phase: 'installing' })
    try {
      await runNpm(['install', `@deepseek-ai/dsh@${args.target}`, '--no-audit', '--no-fund', '--save-exact', '--loglevel', 'error'])
    } catch (error) {
      await rollback(`安装失败：${error.message}`)
      return
    }

    // 4) 重启
    setState({ phase: 'restarting' })
    try {
      startService()
    } catch (error) {
      await rollback(`拉起服务失败：${error.message}`)
      return
    }

    // 5) 健康检查
    setState({ phase: 'verifying' })
    if (!(await waitForHealthy())) {
      await rollback('新版本服务 90s 内未监听端口')
      return
    }

    setState({ phase: 'done', finishedAt: Date.now() })
    log('升级完成，服务健康')
    appendHistory({ at: Date.now(), mode: 'upgrade', from: args.from, target: args.target, channel: args.channel, ok: true })
    return
  }

  // restart 模式：停服后直接拉起。
  setState({ phase: 'restarting' })
  try {
    startService()
  } catch (error) {
    setState({ phase: 'failed', reason: error.message })
    writeErrorNote([`重启失败：${error.message}`, '原服务已停止，请手动启动'])
    appendHistory({ at: Date.now(), mode: 'restart', ok: false, reason: error.message })
    return
  }
  setState({ phase: 'verifying' })
  if (await waitForHealthy()) {
    setState({ phase: 'done', finishedAt: Date.now() })
    log('重启完成')
    appendHistory({ at: Date.now(), mode: 'restart', ok: true })
  } else {
    setState({ phase: 'failed', reason: '重启后 90s 未监听端口' })
    writeErrorNote(['重启后服务未监听端口', '请检查服务日志尾部'])
    appendHistory({ at: Date.now(), mode: 'restart', ok: false, reason: '重启后未监听端口' })
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  log(`执行器崩溃：${message}`)
  setState({ phase: 'failed', reason: message })
  writeErrorNote([`执行器异常：${message}`])
  appendHistory({ at: Date.now(), mode: args.mode, target: args.target ?? null, ok: false, reason: message })
  process.exitCode = 1
})
