/**
 * paths — 工具箱的路径与安装形态发现。
 *
 * 全部为只读探测：不猜测 registry，不写任何配置。安装形态决定升级功能
 * 是否可用（v0.1 仅支持本地运行时模式，即 dsh-launch.bat 的 local 形态）。
 * @module dsh-harness-toolbox/paths
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** $DSH_HOME：会话、设置与本插件状态目录的根。 */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** 插件自己的状态目录：升级状态 / 历史 / 备份 / 诊断缓存。 */
export function toolboxStateDir() {
  return path.join(dshHome(), 'dsh-harness-toolbox')
}

/**
 * 本地运行时目录（含 package.json 的 runtime 根）。
 * 发现顺序：显式环境变量 → 进程入口反推 → 启动器约定位置。
 * @returns {string|null} runtime 根；无法确定时 null（升级功能降级为不可用）。
 */
export function runtimeDir() {
  const forced = process.env.DSH_TOOLBOX_RUNTIME
  if (forced && isRuntimeDir(forced)) return forced
  const fromArgv = runtimeDirFromArgv()
  if (fromArgv) return fromArgv
  const sibling = path.join(path.dirname(dshHome()), '.dsh-web-launcher', 'runtime')
  if (isRuntimeDir(sibling)) return sibling
  return null
}

/** dsh 启动器目录（runtime 的父目录；日志与 state.txt 所在）。 */
export function launcherDir() {
  const runtime = runtimeDir()
  if (!runtime) return null
  const parent = path.dirname(runtime)
  // 仅当 runtime 确实位于 .dsh-web-launcher 下时，父目录才是启动器目录。
  return path.basename(parent) === '.dsh-web-launcher' ? parent : runtime
}

/** 判定一个目录是否为 dsh 本地运行时根。 */
function isRuntimeDir(dir) {
  try {
    const manifest = path.join(dir, 'package.json')
    const raw = fs.readFileSync(manifest, 'utf8')
    return raw.includes('@deepseek-ai/dsh')
  } catch {
    return false
  }
}

/** 从 `node .../runtime/node_modules/@deepseek-ai/dsh/lib/bin.js web` 反推 runtime 根。 */
function runtimeDirFromArgv() {
  const argv1 = process.argv[1]
  if (!argv1) return null
  const match = argv1.match(/^(.*[\\/])runtime[\\/]node_modules[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/i)
  if (!match) return null
  // match[1] 是 runtime 的父目录（含结尾分隔符），补回 runtime 段才是运行时根。
  return path.join(match[1].replace(/[\\/]+$/, ''), 'runtime')
}

/** 安装形态：local（可升级）/ global / npx / unknown。 */
export function installMode() {
  if (runtimeDir()) return 'local'
  const argv1 = process.argv[1] || ''
  if (/[\\/]AppData[\\/]Roaming[\\/]npm[\\/]/i.test(argv1)) return 'global'
  if (/[\\/]npx[\\/]|[\\/]_npx[\\/]/i.test(argv1)) return 'npx'
  return 'unknown'
}

/** 当前已安装的 @deepseek-ai/dsh 版本；读不到返回 null。 */
export function currentHarnessVersion() {
  const runtime = runtimeDir()
  if (!runtime) return null
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
}

/** 启动器目录里最新的 web-*.log；找不到返回 null。 */
export function newestWebLog() {
  const dir = launcherDir()
  if (!dir) return null
  try {
    const candidates = fs.readdirSync(dir)
      .filter((name) => /^web-.*\.log$/i.test(name))
      .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    return candidates.length > 0 ? path.join(dir, candidates[0].name) : null
  } catch {
    return null
  }
}

/** 可被服务工具打开的目录白名单（服务端决定路径，客户端只发动作名）。 */
export function openTargets() {
  const runtime = runtimeDir()
  const targets = { home: dshHome() }
  if (runtime) {
    targets.runtime = runtime
    targets.launcher = path.dirname(runtime)
  }
  return targets
}
