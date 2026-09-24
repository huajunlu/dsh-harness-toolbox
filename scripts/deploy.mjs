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
 * 用法：node scripts/deploy.mjs [--no-probe]
 *   环境：DSH_HOME（默认 ~/.dsh），profile 默认 web，端口读启动器 state.txt。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const BASE = 'dsh-harness-toolbox'
const args = process.argv.slice(2)
const doProbe = !args.includes('--no-probe')

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

/** 复制源码 + 把 client.js 的 id/NS/API 全部对齐到指定包名。 */
function materialize(dir, packageId) {
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

/** 活实例：最新代码 + 最新包名。 */
function stageLive(dir, liveName) {
  materialize(dir, liveName)
  log(`staged live -> ${dir}`)
}

/**
 * 历史目录 → 转发壳：内容=最新代码，package.json name=活名（buildId 一致），
 * factory id/NS=历史名（匹配启动图装载键），API 前缀=活前缀（请求打活路由）。
 */
function healShell(dir, histName, liveName) {
  materialize(dir, liveName) // 先整体对齐活名（含 API 前缀）
  const clientPath = path.join(dir, 'lib', 'client.js')
  let client = fs.readFileSync(clientPath, 'utf8')
  // 把 id 与 NS 改回历史名；API 前缀保持活名不动。
  client = client.replace(`id: "${liveName}"`, `id: "${histName}"`)
  client = client.replace(`const NS = "${liveName}"`, `const NS = "${histName}"`)
  fs.writeFileSync(clientPath, client)
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

const name = nextName()
log(`deploying as ${name}`)
// 先记录（把已知历史 dev3-dev8 都 seed 进去也无妨——缺目录才补），
// 再落活包、改 patch、补壳。
recordDeployed(name)
stageLive(path.join(nmDir, name), name)
rewritePatch(name)
healAllExcept(name)
healMissingFromHistory(name)
if (doProbe) {
  const ok = await probe(servicePort(), name)
  if (!ok) {
    console.error('[deploy] WARN: 60s 内新实例未接管——检查 loader 日志；旧实例仍在服务（安全降级，但代码未更新）。')
    process.exit(2)
  }
}
log('DONE')
