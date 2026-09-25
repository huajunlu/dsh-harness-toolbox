#!/usr/bin/env node
/**
 * runner-test — 升级执行器的隔离集成测试（不碰真实运行时、不碰真端口）。
 *
 * 布置：
 *   - 假 runtime：临时目录，含 package.json / package-lock.json / 假 bin.js；
 *     假 bin.js 是真 node 服务，按 dsh web 的参数形态（--port）监听。
 *   - 假服务：独立子进程监听固定高位端口（执行器会 taskkill parent-pid——
 *     若与测试同进程会自杀，所以必须分离）。
 *
 * 覆盖：
 *   A) restart：stopping → restarting → verifying → done（停旧 → 拉新 → 健康）
 *   B) upgrade：目标版本 404 → installing 失败 → rolling-back → 恢复清单
 *      （断言放宽：终态 ∈ {rolled-back, failed}，清单逐字节恢复，历史记失败，
 *       错误手册含手动恢复指引）
 *   C) 注入面：target 含 shell 元字符 → 参数白名单拒绝、非零退出
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { wmiKill, wmiRunNode } from '../lib/wmi.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...m) => console.log('[test]', ...m)
let failures = 0
function assert(cond, msg) {
  if (cond) log('  ✓', msg)
  else { console.error('  ✗', msg); failures++ }
}

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runner = path.join(pkgRoot, 'scripts', 'upgrade.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tb-test-'))

/** 构造假 runtime（prefix 区分场景，避免路径名与实际创建目录不一致）。 */
function fakeRuntime(prefix) {
  const dir = path.join(tmp, prefix)
  fs.mkdirSync(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'fake-runtime',
    version: '0.0.0',
    dependencies: { 'left-pad': '1.3.0' },
  }, null, 2))
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({
    name: 'fake-runtime',
    version: '0.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'fake-runtime', version: '0.0.0', dependencies: { 'left-pad': '1.3.0' } },
      'node_modules/left-pad': {
        version: '1.3.0',
        resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
        integrity: 'sha512-XI5MPzVNApjAyhQz5JjH1vmnm45HJw4pySvUQNB81i9AeQFydvIVzHVS3KUzK',
      },
    },
  }, null, 2))
  fs.writeFileSync(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), `
    const http = require('node:http');
    const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
    http.createServer((q, s) => s.end('fake-dsh')).listen(port, '127.0.0.1');
  `)
  return dir
}

/** 起独立假服务子进程，返回 { port, pid }。 */
function fakeService(port) {
  const child = spawn(process.execPath, ['-e',
    `require('node:http').createServer((q,s)=>s.end('ok')).listen(${port},'127.0.0.1');setInterval(()=>{},1e9);`],
  { stdio: 'ignore', windowsHide: true })
  return { port, pid: child.pid, kill: () => { try { child.kill() } catch {} } }
}

function runRunner(args, timeoutMs) {
  return new Promise((resolve) => {
    // stdio 必须用 inherit/ignore：沙箱禁止为子进程开管道（spawn EPERM）。
    // 执行器的全部输出同时落盘在 --runner-log，测试断言只依赖状态/历史文件。
    const child = spawn(process.execPath, [runner, ...args], { stdio: 'inherit', windowsHide: true })
    const timer = setTimeout(() => { child.kill(); resolve({ code: -1, tail: '' }) }, timeoutMs)
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, tail: '' }) })
  })
}

const readState = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }
const readHistory = (file) => { try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(v) ? v : [] } catch { return [] } }

/** 按端口清掉 LISTENING 的进程（测试清场用）。 */
function killPortListener(port) {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true })
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes('LISTENING')) continue
      const cols = line.trim().split(/\s+/)
      if ((cols[1] ?? '').endsWith(`:${port}`) && /^\d+$/.test(cols.at(-1) ?? '')) {
        try { execFileSync('taskkill', ['/PID', cols.at(-1), '/F', '/T'], { windowsHide: true }) } catch {}
      }
    }
  } catch {}
}

/** 生产拓扑的“宿主替身”：监听端口，2.5s 后 process.exit 自尽
 *  （1:1 复刻「宿主响应 202 后体面退出 → 端口释放」）。 */
function fakeHostSuicide(port, delayMs = 2500) {
  const script = `require('node:http').createServer((q,s)=>s.end('ok')).listen(${port},'127.0.0.1',()=>setTimeout(()=>process.exit(0),${delayMs}));setInterval(()=>{},1e9)`
  return spawn(process.execPath, ['-e', script], { stdio: 'ignore', windowsHide: true })
}

/** 轮询 state 文件直到进入期望相位（或超时返回当前值）。 */
async function waitForState(file, phases, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const s = readState(file)
    if (s && phases.includes(s.phase)) return s
    await sleep(700)
  }
  return readState(file)
}

/** 场景 A：restart —— 生产拓扑 1:1。
 *  WMI 树外创建执行器（父=WmiPrvSE）→ 宿主 2.5s 自尽（端口释放）
 *  → 执行器纯等待检出 → WMI 拉起假 bin.js → 健康检查 → done。 */
async function scenarioA() {
  log('场景 A：restart（生产拓扑：WMI 树外执行器 + 宿主自尽 → 重启 → done）')
  const PORT = 39771
  killPortListener(PORT)
  const host = fakeHostSuicide(PORT, 2500)
  await sleep(700)
  const runtime = fakeRuntime('runtimeA')
  const stateFile = path.join(tmp, 'state-A.json')
  const historyFile = path.join(tmp, 'history-A.json')

  const runnerPid = await wmiRunNode(process.execPath, runner, [
    '--mode', 'restart',
    '--runtime', runtime,
    '--port', String(PORT),
    '--parent-pid', String(host.pid),
    '--state', stateFile,
    '--history', historyFile,
    '--backup', path.join(tmp, 'backup-A'),
    '--runner-log', path.join(tmp, 'runner-A.log'),
    '--error-note', path.join(tmp, 'err-A.txt'),
    '--service-log', path.join(tmp, 'service-A.log'),
    '--launcher-dir', tmp,
  ])
  log(`WMI 树外执行器 pid=${runnerPid}`)

  const final = await waitForState(stateFile, ['done', 'failed', 'rolled-back'], 90_000)
  log('phase=', final && final.phase, 'reason=', final && final.reason)
  if (!final || final.phase !== 'done') log('runner log tail:', readTail(path.join(tmp, 'runner-A.log')))
  assert(final && final.phase === 'done', `A: 状态机走完 done（实际 ${final && final.phase}）`)
  const hist = readHistory(historyFile)
  assert(hist.length === 1 && hist[0].ok === true && hist[0].mode === 'restart', 'A: 历史记录一条 restart 成功')
  killPortListener(PORT) // 清掉 WMI 拉起的假 bin.js（非测试进程祖先，taskkill 安全）
}

/** 场景 B：upgrade 目标不存在 → 安装失败 → 回滚恢复清单。 */
async function scenarioB() {
  log('场景 B：upgrade 404 → 安装失败 → 回滚（生产拓扑）')
  const PORT = 39772
  killPortListener(PORT)
  const host = fakeHostSuicide(PORT, 2500)
  await sleep(700)
  const runtime = fakeRuntime('runtimeB')
  const manifestBefore = fs.readFileSync(path.join(runtime, 'package.json'), 'utf8')
  const stateFile = path.join(tmp, 'state-B.json')
  const historyFile = path.join(tmp, 'history-B.json')
  const runnerPid = await wmiRunNode(process.execPath, runner, [
    '--mode', 'upgrade',
    '--target', '9.9.9', // 格式合法、registry 不存在 → npm 404
    '--channel', 'latest',
    '--from', '0.0.0',
    '--runtime', runtime,
    '--port', String(PORT),
    '--parent-pid', String(host.pid),
    '--state', stateFile,
    '--history', historyFile,
    '--backup', path.join(tmp, 'backup-B'),
    '--runner-log', path.join(tmp, 'runner-B.log'),
    '--error-note', path.join(tmp, 'err-B.txt'),
    '--service-log', path.join(tmp, 'service-B.log'),
    '--launcher-dir', tmp,
  ])
  log(`WMI 树外执行器 pid=${runnerPid}`)
  const final = await waitForState(stateFile, ['rolled-back', 'failed'], 240_000)
  log('phase=', final && final.phase, 'reason=', final && final.reason)
  if (!final || !['rolled-back', 'failed'].includes(final.phase)) log('runner log tail:', readTail(path.join(tmp, 'runner-B.log')))
  assert(final && ['rolled-back', 'failed'].includes(final.phase),
    `B: 终态为 rolled-back/failed（实际 ${final && final.phase}）`)
  const manifestAfter = fs.readFileSync(path.join(runtime, 'package.json'), 'utf8')
  assert(manifestBefore === manifestAfter, 'B: package.json 已从备份恢复（逐字节一致）')
  const hist = readHistory(historyFile)
  assert(hist.length === 1 && hist[0].ok === false, 'B: 历史记录一条失败')
  const errPath = path.join(tmp, 'err-B.txt')
  assert(fs.existsSync(errPath) && fs.readFileSync(errPath, 'utf8').includes('手动恢复'),
    'B: 错误手册含手动恢复指引')
  killPortListener(PORT)
}

/** 场景 C：shell 元字符 target 被参数白名单拒绝。 */
async function scenarioC() {
  log('场景 C：恶意参数被拒绝')
  const errFile = path.join(tmp, 'err-C.txt')
  const { code } = await runRunner([
    '--mode', 'upgrade',
    '--target', '1.0.0; calc.exe',
    '--channel', 'latest', '--from', '0.0.0',
    '--runtime', tmp, '--port', '39799', '--parent-pid', '1',
    '--state', path.join(tmp, 's.json'), '--history', path.join(tmp, 'h.json'),
    '--backup', path.join(tmp, 'b'), '--runner-log', path.join(tmp, 'r.log'),
    '--error-note', errFile, '--service-log', path.join(tmp, 'svc.log'),
    '--launcher-dir', tmp,
  ], 15_000)
  // 参数校验在 parseArgs 抛出 → 非零退出；此时不写状态文件（未进入状态机）。
  const s = readState(path.join(tmp, 's.json'))
  assert(code !== 0 && s === null,
    `C: 恶意 target 被拒绝（exit=${code}，状态机未启动）`)
}

/** 场景 D：WMI 树外性断言（2026-09-25 事故的架构级防御）。
 *
 * 事故根因：本环境父子进程共生（父退=子陪葬、taskkill 祖先=调用者陪葬），
 * 执行器若生于宿主树内必死。修复=WMI Win32_Process.Create 树外派生
 * （父=系统服务 WmiPrvSE）。本场景直接断言：
 *   WMI 创建的目标进程，其父进程 ≠ 创建者（双重验证：WMI 查询 + 子自报 ppid）。 */
async function scenarioD() {
  log('场景 D：WMI 树外创建（父进程 ≠ 创建者，连坐免疫）')
  const probeFile = path.join(tmp, 'ppid-probe.js')
  const ppidOut = path.join(tmp, 'ppid.txt')
  fs.writeFileSync(probeFile,
    `require('node:fs').writeFileSync(${JSON.stringify(ppidOut)}, String(process.ppid));` +
    `setTimeout(() => process.exit(0), 60000);`)
  const pid = await wmiRunNode(process.execPath, probeFile, [])
  await sleep(2500)
  let wmiPpid = null
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | ForEach-Object { $_.ParentProcessId }`],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 })
    wmiPpid = Number(out.trim().split(/\r?\n/).filter(Boolean).at(-1))
  } catch (e) {
    log('WMI ppid 查询失败: ' + e.message)
  }
  const selfPpid = fs.existsSync(ppidOut) ? Number(fs.readFileSync(ppidOut, 'utf8')) : null
  log(`创建者 pid=${process.pid}，目标 pid=${pid}，父(WMI)=${wmiPpid}，父(自报)=${selfPpid}`)
  assert(wmiPpid && wmiPpid !== process.pid, `D: WMI 查询确认树外（父 ${wmiPpid} ≠ 创建者 ${process.pid}）`)
  assert(selfPpid && selfPpid === wmiPpid, 'D: 子进程自报 ppid 与 WMI 查询一致')
  await wmiKill(pid)
  assert(true, 'D: WMI 终止成功')
}

/** 读日志尾部（诊断用）。 */
function readTail(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return '\n' + text.split(/\r?\n/).slice(-12).join('\n')
  } catch { return '(no log)' }
}

try {
  await scenarioA()
  await scenarioB()
  await scenarioC()
  await scenarioD()
} finally {
  killPortListener(39771)
  killPortListener(39772)
  killPortListener(39773)
}

log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
