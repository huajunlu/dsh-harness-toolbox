/**
 * restart-host — 延迟冷启动 DSH 宿主（运维工具，随包分发）。
 *
 * 为什么需要它：本机 0.1.7-alpha.2 宿主上，profile 补丁的**热重组不可靠**
 * ——改 `cordis.patch.yml` 不一定重新导入插件，而一次失败的重组会把运行实例
 * 的路由清空（表现为工具箱在 GUI 中全部 401）。此时唯一可靠的恢复方式是
 * **冷启动宿主**；但宿主进程正是当前会话的载体，立即重启会掐断正在进行的
 * 回合。于是：先延迟，再经 WMI 树外拉起工具箱自带的 restart 执行器
 * （`scripts/upgrade.mjs --mode restart`，其「等待端口释放 → 60s 兜底代杀 →
 * WMI 拉起新宿主 → 健康检查 → 写回 state.txt 新令牌地址」已在实战中验证）。
 *
 * 树外性很关键：本机父子进程共生（父退=子陪葬），本脚本必须由 WMI
 * (`Win32_Process.Create`) 创建，父进程为系统服务 WmiPrvSE，宿主退出才不
 * 会把它一起带走。`deploy.mjs --restart` 正是这样启动它的。
 *
 * 用法：node scripts/restart-host.mjs [--delay 180] [--log <path>]
 * @module dsh-harness-toolbox/scripts/restart-host
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { wmiCreate, wmiRunNode } from '../lib/wmi.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(HERE, '..')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const LAUNCHER_DIR = process.env.DSH_LAUNCHER_DIR || path.join(path.dirname(DSH_HOME), '.dsh-web-launcher')
const RUNTIME_DIR = path.join(LAUNCHER_DIR, 'runtime')
const STATE_DIR = path.join(DSH_HOME, 'dsh-harness-toolbox')
const WORKDIR = process.env.DSH_WORKDIR || os.homedir()

function argOf(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}

const DELAY_SEC = Math.max(0, Number(argOf('--delay', '180')) || 0)
const PORT = Number(argOf('--port', '3080')) || 3080
const LOG = argOf('--log', path.join(os.tmpdir(), 'dsh-restart-host.log'))

const log = (m) => {
  const line = `[${new Date().toISOString()}] ${m}\n`
  try { fs.appendFileSync(LOG, line) } catch { /* 日志失败不影响主流程 */ }
}

/** 最新一个 web-*.log（新宿主把 stdout/stderr 追加上去）。 */
function newestWebLog() {
  try {
    const files = fs.readdirSync(LAUNCHER_DIR)
      .filter((f) => /^web-.*\.log$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(LAUNCHER_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    if (files.length > 0) return path.join(LAUNCHER_DIR, files[0].f)
  } catch { /* 落到默认值 */ }
  return path.join(STATE_DIR, 'web.log')
}

function portAlive() {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/', timeout: 1200 }, (res) => { res.resume(); resolve(true) })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.end()
  })
}

log(`armed: cold restart in ${DELAY_SEC}s (port ${PORT}, runtime ${RUNTIME_DIR})`)
await sleep(DELAY_SEC * 1000)

const serviceLog = newestWebLog()
log(`using service log: ${serviceLog}`)

try {
  const pid = await wmiRunNode(process.execPath, path.join(PKG_ROOT, 'scripts', 'upgrade.mjs'), [
    '--mode', 'restart',
    '--runtime', RUNTIME_DIR,
    '--port', String(PORT),
    '--parent-pid', '1',
    '--state', path.join(STATE_DIR, 'upgrade-state.json'),
    '--history', path.join(STATE_DIR, 'upgrade-history.json'),
    '--backup', path.join(STATE_DIR, 'backup'),
    '--runner-log', path.join(STATE_DIR, 'upgrade-runner.log'),
    '--error-note', path.join(STATE_DIR, 'last-upgrade-error.txt'),
    '--service-log', serviceLog,
    '--launcher-dir', LAUNCHER_DIR,
    '--workdir', WORKDIR,
  ])
  log(`restart executer launched via WMI pid=${pid}`)
} catch (error) {
  log(`executer launch failed: ${error.message}`)
}

// 兜底：等端口恢复（最多 240s）；仍未恢复则直接经 WMI 拉起宿主。
let recovered = false
for (let i = 0; i < 120; i++) {
  if (await portAlive()) { log(`port alive after ~${i * 2}s — restart verified OK`); recovered = true; break }
  await sleep(2000)
}
if (!recovered) {
  log('port still dead — trying direct WMI host start fallback')
  try {
    const binJs = path.join(RUNTIME_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const cmd = `cmd.exe /c cd /d ${WORKDIR} && node "${binJs}" web --no-open --port ${PORT} >> "${serviceLog}" 2>&1`
    const pid = await wmiCreate(cmd)
    log(`fallback host launched via WMI pid=${pid}`)
  } catch (error) {
    log(`fallback start failed: ${error.message}`)
  }
}
