#!/usr/bin/env node
/**
 * deploy — 开发热部署（不重启服务、不打断会话）。
 *
 * 三个机制叠加，缺一不可（均为实战踩坑的产物）：
 *
 * 1. **name 轮换强制 re-import**：cordis loader 只在条目 name 变化时重新
 *    import 插件（entry.ts: diff.includes("name") → tree.import），而 ESM
 *    loadCache 以 file URL 为键——同名包永远命中旧模块。每次部署同步到新
 *    目录名（base-devN）并改写 patch 行 name，新代码连同依赖图即刻加载。
 *
 * 2. **历史目录重建为转发壳**：boot graph 与 client-modules 的条目扫描是
 *    增量只增不减的——历史 -devN 条目会一直留在启动图里，浏览器仍可能装配
 *    历史 factory。直接删除目录会让那些 bundle 变成死引用（v0.0.0 /
 *    inactive context 乱象）。因此每个历史目录被重建为「转发壳」：
 *    id 与 locale NS 保留历史名（匹配启动图装载），**API 前缀指向最新活
 *    实例**——浏览器装配任何 factory，请求都打到活代码。宿主进程重启后
 *    启动图自然收敛，壳目录即可安全删除。
 *
 * 3. **精确探针**：/status 的 current 字段无法区分新旧实例（都是修复后的
 *    代码，假阳性）；/about 的 plugin.name 是按目录名（package.json name）
 *    推导的精确 buildId，probe 校验它才算真正接管。
 *
 * 4. **原子落地 + 落地前自检 + 失败回滚**（2026-09-25 事故后补强）：
 *    原先直接 `rmSync + cpSync` 原地重写活动目录，宿主文件监视可能在半写状态
 *    触发 import → 重组失败 → 运行实例路由被清空（工具箱在 GUI 中全部 401）。
 *    现在：先构建到临时目录 → 静态自检（清单/入口/API 前缀/`node --check`）
 *    → 旧目录改名备份、新目录改名就位（窗口极短）→ 探针确认活实例接管
 *    → **只有确认接管后才重建转发壳**；探针失败则把补丁回滚到部署前内容，
 *    避免 profile 指向一个不服务的名字。
 *
 * 5. **冷启动兜底**：本机 0.1.7 宿主上补丁热重组不可靠（改 patch 不一定
 *    re-import）。`--restart` 会在探针失败时经 WMI 树外启动
 *    `scripts/restart-host.mjs`，延迟冷启动宿主（宿主重启会掐断当前会话，
 *    所以默认延迟 180s，先把控制权交回用户）。
 *
 * 用法：node scripts/deploy.mjs [--no-probe] [--as <name>] [--restart]
 *   环境：DSH_HOME（默认 ~/.dsh），profile 默认 web，端口读启动器 state.txt。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const BASE = 'dsh-harness-toolbox'
const args = process.argv.slice(2)
const doProbe = !args.includes('--no-probe')
// --as <name>：显式指定活名（不递增）。用于「回退」——当宿主上的 HMR 重组
// 未生效时，运行实例仍是旧名，此时必须把补丁与全部转发壳对齐到**运行中的
// 那个名字**，磁盘与内存才能一致（否则壳的 API 前缀指向不存在的新前缀 → 401）。
const asIndex = args.indexOf('--as')
const explicitName = asIndex >= 0 ? (args[asIndex + 1] ?? null) : null

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const profileDir = process.env.DSH_PROFILE_DIR || path.join(dshHome, 'profiles', 'web')
const nmDir = path.join(profileDir, 'node_modules')
const patchFile = path.join(profileDir, 'cordis.patch.yml')
const sourceDir = path.resolve(decodeURIComponent(path.dirname(fileURLToPath(import.meta.url))), '..')

const log = (...m) => console.log('[deploy]', ...m)
const fail = (m) => { console.error('[deploy] FAILED:', m); process.exit(1) }

/** 现有 dev 目录的最大序号。 */
function nextName() {
  let max = 0
  for (const entry of fs.readdirSync(nmDir)) {
    const m = entry.match(new RegExp(`^${BASE}-dev(\\d+)$`))
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `${BASE}-dev${max + 1}`
}

/** 在指定目录构建一份包内容（不触碰目标目录，供原子替换使用）。 */
function buildInto(dir, packageId) {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  for (const item of ['lib', 'scripts', 'cordis.patch.yml', 'LICENSE', 'README.md', 'SECURITY.md']) {
    const src = path.join(sourceDir, item)
    if (fs.existsSync(src)) fs.cpSync(src, path.join(dir, item), { recursive: true })
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf8'))
  manifest.name = packageId
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  const clientPath = path.join(dir, 'lib', 'client.js')
  let client = fs.readFileSync(clientPath, 'utf8')
  const before = client
  client = client.replaceAll(BASE, packageId)
  if (client === before) log('warn: client.js 未找到可替换的包名子串')
  fs.writeFileSync(clientPath, client)
}

/**
 * 落地前自检——把半成品挡在 swap 之前（事故教训：半写目录一旦被宿主 import
 * 就会清空运行实例的路由）。校验清单名、必需入口、client API 前缀与 id/NS，
 * 并对关键文件跑 `node --check` 语法自检。
 * @returns {string[]} 问题列表（空数组 = 通过）
 *
 * 注意：本机沙箱会拒掉带管道 stdio 的子进程（spawn EPERM），所以语法检查把
 * stderr 重定向到临时文件再读回来，而不是用 encoding/pipe 捕获。
 */
function validateBuild(dir, packageId, expectIds) {
  const problems = []
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    if (manifest.name !== packageId) problems.push(`package.json name=${manifest.name} ≠ ${packageId}`)
  } catch (error) {
    problems.push(`package.json 不可解析：${error.message}`)
  }
  for (const rel of ['lib/index.js', 'lib/client.js', 'lib/registry.js', 'cordis.patch.yml']) {
    if (!fs.existsSync(path.join(dir, rel))) problems.push(`缺少 ${rel}`)
  }
  const clientPath = path.join(dir, 'lib', 'client.js')
  if (fs.existsSync(clientPath)) {
    const client = fs.readFileSync(clientPath, 'utf8')
    const api = (client.match(/const API = "([^"]+)"/) || [])[1]
    if (api !== `/api/${packageId}`) problems.push(`client API=${api} ≠ /api/${packageId}`)
    if (expectIds) {
      const id = (client.match(/id: "([^"]+)"/) || [])[1]
      if (id !== expectIds.id) problems.push(`client id=${id} ≠ ${expectIds.id}`)
      const ns = (client.match(/const NS = "([^"]+)"/) || [])[1]
      if (ns !== expectIds.ns) problems.push(`client NS=${ns} ≠ ${expectIds.ns}`)
    }
  }
  const files = ['lib/index.js', 'lib/client.js', 'lib/wmi.js', 'lib/registry.js', 'scripts/upgrade.mjs', 'scripts/restart-host.mjs']
  for (const rel of files) {
    const target = path.join(dir, rel)
    if (!fs.existsSync(target)) continue
    const errFile = path.join(os.tmpdir(), `dsh-deploy-check-${process.pid}-${problems.length}.log`)
    let fd = null
    try {
      fd = fs.openSync(errFile, 'w')
      const r = spawnSync(process.execPath, ['--check', target], { stdio: ['ignore', 'ignore', fd], windowsHide: true })
      fs.closeSync(fd)
      fd = null
      if (r.status !== 0) {
        const detail = (() => { try { return fs.readFileSync(errFile, 'utf8').slice(0, 300) } catch { return '' } })()
        problems.push(`${rel} 语法检查未通过（exit=${r.status}）${detail ? '\n' + detail : ''}`)
      }
    } catch (error) {
      problems.push(`${rel} 语法检查无法执行：${error.message}`)
    } finally {
      if (fd !== null) { try { fs.closeSync(fd) } catch { /* 已关闭 */ } }
      try { fs.rmSync(errFile, { force: true }) } catch { /* 临时文件清理失败无妨 */ }
    }
  }
  return problems
}

/** 原子替换目录：旧目录先改名备份，新目录改名就位（缺失窗口只有两次 rename）。 */
function swapDir(stageDir, targetDir) {
  const prevDir = path.join(nmDir, `.prev-${path.basename(targetDir)}-${process.pid}`)
  fs.rmSync(prevDir, { recursive: true, force: true })
  if (fs.existsSync(targetDir)) fs.renameSync(targetDir, prevDir)
  try {
    fs.renameSync(stageDir, targetDir)
  } catch (error) {
    fs.rmSync(targetDir, { recursive: true, force: true })
    if (fs.existsSync(prevDir)) fs.renameSync(prevDir, targetDir) // 就地回滚
    throw error
  }
  fs.rmSync(prevDir, { recursive: true, force: true })
}

/** 活实例：原子落地 + 自检（最新代码 + 最新包名）。 */
function buildLive(targetDir, liveName) {
  const stageDir = path.join(nmDir, `.stage-${liveName}-${process.pid}`)
  buildInto(stageDir, liveName)
  const problems = validateBuild(stageDir, liveName, { id: liveName, ns: liveName })
  if (problems.length > 0) {
    fs.rmSync(stageDir, { recursive: true, force: true })
    fail(`构建自检未通过（暂存目录已清理，profile 未改动）：\n  - ${problems.join('\n  - ')}`)
  }
  swapDir(stageDir, targetDir)
  log(`staged live -> ${targetDir}（原子替换 + 自检通过）`)
}

/**
 * 历史目录 → 转发壳：内容=最新代码，package.json name=活名（buildId 一致），
 * factory id/NS=历史名（匹配启动图装载键），API 前缀=活前缀（请求打活路由）。
 */
function healShell(dir, histName, liveName) {
  const stageDir = path.join(nmDir, `.stage-shell-${histName}-${process.pid}`)
  buildInto(stageDir, liveName) // 先整体对齐活名（含 API 前缀）
  const clientPath = path.join(stageDir, 'lib', 'client.js')
  let client = fs.readFileSync(clientPath, 'utf8')
  // 把 id 与 NS 改回历史名；API 前缀保持活名不动。
  client = client.replace(`id: "${liveName}"`, `id: "${histName}"`)
  client = client.replace(`const NS = "${liveName}"`, `const NS = "${histName}"`)
  fs.writeFileSync(clientPath, client)
  const problems = validateBuild(stageDir, liveName, { id: histName, ns: histName })
  if (problems.length > 0) {
    fs.rmSync(stageDir, { recursive: true, force: true })
    fail(`转发壳自检未通过（${histName}，暂存目录已清理）：\n  - ${problems.join('\n  - ')}`)
  }
  swapDir(stageDir, dir)
  log(`healed shell <- ${histName} (forwards to ${liveName})`)
}

/** 把所有历史 base 与 base-devN 目录重建为转发壳（活目录除外）。 */
function healAllExcept(liveName) {
  for (const entry of fs.readdirSync(nmDir)) {
    if (entry === liveName) continue
    if (entry === BASE || entry.startsWith(`${BASE}-dev`)) {
      healShell(path.join(nmDir, entry), entry, liveName)
    }
  }
}

/**
 * 持久化部署历史补壳：boot graph 条目增量只增不减，历史 id 即使目录被删
 * 也会留在 graph 里（死引用）。从持久历史（而非页面——token URL 的
 * Set-Cookie 在 fetch 重定向链中不回传，拿不到 graph）读取所有用过的 id，
 * 对缺失目录补建转发壳，宿主文件监视触发 rebuilt 后浏览器装配旧 id
 * 也打活前缀。历史文件随 profile 存放，跨会话有效。
 */
const historyFile = path.join(nmDir, '.dsh-toolbox-deployed.json')

function recordDeployed(id) {
  let list = []
  try { list = JSON.parse(fs.readFileSync(historyFile, 'utf8')) } catch {}
  if (!Array.isArray(list)) list = []
  // seed：首 run 追加已知的早期部署名（graph 反查不可用，见 healMissing 注释）。
  for (const seed of [BASE, 'dsh-harness-toolbox-dev3', 'dsh-harness-toolbox-dev4',
    'dsh-harness-toolbox-dev5', 'dsh-harness-toolbox-dev6', 'dsh-harness-toolbox-dev7',
    'dsh-harness-toolbox-dev8']) {
    if (!list.includes(seed)) list.push(seed)
  }
  if (!list.includes(id)) list.push(id)
  fs.writeFileSync(historyFile, JSON.stringify(list, null, 2))
  return list
}

function healMissingFromHistory(liveName) {
  let list = []
  try { list = JSON.parse(fs.readFileSync(historyFile, 'utf8')) } catch {}
  for (const id of Array.isArray(list) ? list : []) {
    if (id === liveName) continue
    const dir = path.join(nmDir, id)
    if (!fs.existsSync(dir)) {
      healShell(dir, id, liveName)
      log(`rebuilt missing historical shell <- ${id}`)
    }
  }
}

/** 改写 profile cordis.patch.yml 中 harness-toolbox 行的 name 与 revision；行丢失则整段重建。 */
function rewritePatch(name) {
  const current = fs.readFileSync(patchFile, 'utf8')
  let next
  if (/id: harness-toolbox/.test(current)) {
    next = current.replace(/(- id: harness-toolbox\n\s+name: ).*/, `$1${name}`)
    const rev = next.match(/revision:\s*(\d+)/)
    const bumped = rev ? Number(rev[1]) + 1 : 1
    if (rev) next = next.replace(/revision:\s*\d+/, `revision: ${bumped}`)
    else next = next.replace(/(id: harness-toolbox[\s\S]*?config: \{)/, `$1 revision: ${bumped}`)
    log(`patch row -> ${name} (revision ${bumped})`)
  } else {
    // 行被外力移除（或从未写入成功）：在文件末尾重建完整 insert 段。
    const block = [
      '- insert:',
      '    - id: harness-toolbox',
      `      name: ${name}`,
      '      config: { revision: 1 }',
      '',
    ].join('\n')
    next = current.replace(/^\s*\[\s*\]\s*$/m, '')
    next = next.replace(/\s*$/, '\n') + block
    log(`patch row REBUILT -> ${name}`)
  }
  if (next === current) fail('patch 改写未产生变化')
  fs.writeFileSync(patchFile, next)
}

/** 读启动器 state.txt 拿端口。 */
function servicePort() {
  try {
    const state = fs.readFileSync(path.join(path.dirname(dshHome), '.dsh-web-launcher', 'state.txt'), 'utf8')
    const m = state.match(/^PORT=(\d+)/m)
    return m ? m[1] : '3080'
  } catch { return '3080' }
}

/** 精确探针：/about 的 plugin.name（按活包名推导）必须上线且版本非兜底。 */
async function probe(port, expectedName) {
  const url = `http://127.0.0.1:${port}/api/${expectedName}/about`
  for (let i = 1; i <= 30; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
      const body = await res.json()
      const actual = body?.plugin?.name
      if (actual === expectedName && body?.plugin?.version !== '0.0.0') {
        log(`probe OK (${i * 2}s): buildId=${actual} v${body.plugin.version}`)
        return true
      }
      log(`probe ${i}: serving=${actual}（等待 ${expectedName} 接管）`)
    } catch (e) {
      log(`probe ${i}: ${e.message}`)
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return false
}

/** 单次探针：活实例是否在指定前缀服务（用于失败回滚时确认旧实例仍在）。 */
async function probeOnce(port, expectedName) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/${expectedName}/about`, { signal: AbortSignal.timeout(3000) })
    const body = await res.json()
    return body?.plugin?.name === expectedName
  } catch {
    return false
  }
}

/**
 * 经 WMI 树外启动 `scripts/restart-host.mjs`（延迟冷启动宿主）。
 * 为什么树外：本机父子进程共生，宿主退出会连坐清掉普通子进程；WMI 创建的
 * 进程父为 WmiPrvSE，宿主重启后它照常把新宿主拉起来。默认延迟 180s，先把
 * 控制权交回用户（宿主重启会掐断正在进行的会话）。
 */
function scheduleColdRestart(delaySec = 180) {
  const helper = path.join(sourceDir, 'scripts', 'restart-host.mjs')
  if (!fs.existsSync(helper)) {
    console.error('[deploy] 未找到 scripts/restart-host.mjs，无法安排冷启动')
    return false
  }
  if (helper.includes("'")) {
    console.error('[deploy] 路径含单引号，无法经 PowerShell 字面量传递')
    return false
  }
  const command = `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='node "${helper}" --delay ${delaySec}'} | ForEach-Object { "$($_.ReturnValue) $($_.ProcessId)" }`
  // 沙箱会拒掉管道 stdio 的子进程 → 同样把输出重定向到临时文件再读。
  const outFile = path.join(os.tmpdir(), `dsh-deploy-wmi-${process.pid}.log`)
  let fd = null
  let stdout = ''
  try {
    fd = fs.openSync(outFile, 'w')
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      stdio: ['ignore', fd, fd], windowsHide: true, timeout: 30_000,
    })
    fs.closeSync(fd)
    fd = null
    stdout = (() => { try { return fs.readFileSync(outFile, 'utf8') } catch { return '' } })()
    const m = stdout.match(/(\d+)\s+(\d+)/)
    if (r.status === 0 && m && m[1] === '0') {
      log(`已安排 ${delaySec}s 后冷启动宿主（树外助手 pid=${m[2]}）`)
      return true
    }
    console.error('[deploy] 冷启动助手启动失败：', stdout.trim() || `exit=${r.status}`)
  } catch (error) {
    console.error('[deploy] 冷启动助手异常：', error.message)
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* 已关闭 */ } }
    try { fs.rmSync(outFile, { force: true }) } catch { /* 清理失败无妨 */ }
  }
  return false
}

const name = explicitName || nextName()
if (explicitName && !/^dsh-harness-toolbox(-dev\d+)?$/.test(explicitName)) {
  fail(`--as 名称非法：${explicitName}（须为 dsh-harness-toolbox 或 dsh-harness-toolbox-devN）`)
}
log(explicitName ? `rolling back to explicit live name ${name}` : `deploying as ${name}`)

// 部署前的补丁快照：探针失败时原样回滚，绝不把 profile 留在
// 「指向一个不服务的名字」的状态（2026-09-25 事故的直接教训）。
const prevPatch = fs.readFileSync(patchFile, 'utf8')
const prevLive = (prevPatch.match(/- id: harness-toolbox\s*[\r\n]+\s*name:\s*(\S+)/) || [])[1] || null

// 先记录（把已知历史 dev3-dev8 都 seed 进去也无妨——缺目录才补），
// 再原子落活包、改 patch；壳留到探针确认接管之后再补。
recordDeployed(name)
buildLive(path.join(nmDir, name), name)
rewritePatch(name)

if (doProbe) {
  const port = servicePort()
  const ok = await probe(port, name)
  if (!ok) {
    fs.writeFileSync(patchFile, prevPatch)
    log('探针未通过 → 补丁已回滚到部署前状态')
    if (prevLive) {
      const alive = await probeOnce(port, prevLive)
      log(alive
        ? `上一个实例 ${prevLive} 仍在服务 —— 界面不受影响，可稍后重试`
        : `上一个实例 ${prevLive} 已不在服务 —— 需要冷启动宿主才能恢复（旧壳仍指向 ${prevLive}，冷启动后自洽）`)
    }
    if (args.includes('--restart')) {
      scheduleColdRestart()
    } else {
      console.error('[deploy] 本机宿主可能不会热应用补丁；加 --restart 可自动安排树外冷启动。')
    }
    process.exit(2)
  }
}

// 确认活实例接管后才重建转发壳（否则壳会指向死前缀，浏览器全 401）。
healAllExcept(name)
healMissingFromHistory(name)
log('DONE')
