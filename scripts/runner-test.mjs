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

/** 场景 A：restart —— 停旧服务 → 拉起假 bin.js → 健康检查 → done。 */
async function scenarioA() {
  log('场景 A：restart（停旧 → 拉新 → 健康检查）')
  const PORT = 39771
  killPortListener(PORT)
  const svc = fakeService(PORT)
  await sleep(800)
  const runtime = fakeRuntime('runtimeA')
  const stateFile = path.join(tmp, 'state-A.json')
  const historyFile = path.join(tmp, 'history-A.json')
  const { code } = await runRunner([
    '--mode', 'restart',
    '--runtime', runtime,
    '--port', String(PORT),
    '--parent-pid', String(svc.pid),
    '--state', stateFile,
    '--history', historyFile,
    '--backup', path.join(tmp, 'backup-A'),
    '--runner-log', path.join(tmp, 'runner-A.log'),
    '--error-note', path.join(tmp, 'err-A.txt'),
    '--service-log', path.join(tmp, 'service-A.log'),
    '--launcher-dir', tmp,
  ], 120_000)
  const final = readState(stateFile)
  log('runner exit=', code, 'phase=', final && final.phase, 'reason=', final && final.reason)
  if (!final || final.phase !== 'done') log('runner log tail:', readTail(path.join(tmp, 'runner-A.log')))
  assert(final && final.phase === 'done', `A: 状态机走完 done（实际 ${final && final.phase}）`)
  const hist = readHistory(historyFile)
  assert(hist.length === 1 && hist[0].ok === true && hist[0].mode === 'restart', 'A: 历史记录一条 restart 成功')
  killPortListener(PORT) // 清掉被拉起的假 bin.js
}

/** 场景 B：upgrade 目标不存在 → 安装失败 → 回滚恢复清单。 */
async function scenarioB() {
  log('场景 B：upgrade 404 → 安装失败 → 回滚')
  const PORT = 39772
  killPortListener(PORT)
  const svc = fakeService(PORT)
  await sleep(800)
  const runtime = fakeRuntime('runtimeB')
  const manifestBefore = fs.readFileSync(path.join(runtime, 'package.json'), 'utf8')
  const stateFile = path.join(tmp, 'state-B.json')
  const historyFile = path.join(tmp, 'history-B.json')
  const { code } = await runRunner([
    '--mode', 'upgrade',
    '--target', '9.9.9', // 格式合法、registry 不存在 → npm 404
    '--channel', 'latest',
    '--from', '0.0.0',
    '--runtime', runtime,
    '--port', String(PORT),
    '--parent-pid', String(svc.pid),
    '--state', stateFile,
    '--history', historyFile,
    '--backup', path.join(tmp, 'backup-B'),
    '--runner-log', path.join(tmp, 'runner-B.log'),
    '--error-note', path.join(tmp, 'err-B.txt'),
    '--service-log', path.join(tmp, 'service-B.log'),
    '--launcher-dir', tmp,
  ], 300_000)
  const final = readState(stateFile)
  log('runner exit=', code, 'phase=', final && final.phase, 'reason=', final && final.reason)
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
  svc.kill()
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
} finally {
  killPortListener(39771)
  killPortListener(39772)
}

log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
