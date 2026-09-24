/**
 * diagnose — 环境体检宿主模块。
 *
 * 两块：
 *   - 环境信息卡（Node/系统/安装形态/路径/端口/内存）；
 *   - npm registry 连通性与延迟（registry 取自 `npm config get`，尊重镜像）
 *     + 代理环境变量存在性（只报存在与变量名，绝不回传值——代理 URL 常带
 *     密码，对抗式审查 F4）。
 * 所有外部探测 5s 超时，失败降级为 { ok:false } 行，不阻塞整体响应。
 * @module dsh-harness-toolbox/modules/diagnose
 */
import { execFile } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import { promisify } from 'node:util'
import { denyIfNotLoopback, writeJson } from '../http.js'
import { API_PREFIX } from '../prefix.js'
import { currentHarnessVersion, dshHome, installMode, launcherDir, newestWebLog, runtimeDir } from '../paths.js'

const execFileAsync = promisify(execFile)
const PREFIX = API_PREFIX

/** npm 当前生效的 registry（尊重 .npmrc 镜像）；Windows 下经 cmd shim 需 shell。 */
async function npmRegistry() {
  try {
    const { stdout } = await execFileAsync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['config', 'get', 'registry'],
      { timeout: 5000, windowsHide: true, shell: process.platform === 'win32' },
    )
    const value = stdout.trim().split(/\r?\n/).at(-1)
    return value && value.startsWith('http') ? value : null
  } catch {
    return null
  }
}

/** 首字节延迟探测；失败返回 ok:false 与错误摘要。 */
async function probeRegistry(registryUrl) {
  if (!registryUrl) return { ok: false, error: 'registry 未知' }
  const started = Date.now()
  try {
    const url = new URL(registryUrl)
    const lib = url.protocol === 'https:' ? https : http
    const status = await new Promise((resolve, reject) => {
      const request = lib.request(url, { method: 'HEAD', timeout: 5000 }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      request.on('timeout', () => request.destroy(new Error('timeout')))
      request.on('error', reject)
      request.end()
    })
    return { ok: true, status, latencyMs: Date.now() - started, url: url.origin + '/' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), url: registryUrl }
  }
}

/** 代理环境变量存在性（只报布尔与变量名，绝不回传值）。 */
function proxyPresence() {
  const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']
  const present = names.filter((name) => typeof process.env[name] === 'string' && process.env[name].length > 0)
  return { variables: present, hasProxy: present.some((n) => n.toUpperCase() !== 'NO_PROXY') }
}

/** 组装环境信息。 */
async function collect(port) {
  const registry = await npmRegistry()
  const probe = await probeRegistry(registry)
  const runtime = runtimeDir()
  return {
    ok: true,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    osRelease: `${os.type()} ${os.release()}`,
    harness: {
      version: currentHarnessVersion(),
      installMode: installMode(),
      runtimeDir: runtime,
      launcherDir: launcherDir(),
      latestLog: newestWebLog(),
    },
    paths: {
      dshHome: dshHome(),
      cwd: process.cwd(),
    },
    server: { port },
    proxy: proxyPresence(),
    registry,
    probe,
    memory: {
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      systemTotalMb: Math.round(os.totalmem() / 1024 / 1024),
      systemFreeMb: Math.round(os.freemem() / 1024 / 1024),
    },
    readAt: Date.now(),
  }
}

/**
 * 注册体检路由。
 * @param ctx - 宿主上下文（需 webServer）。
 * @returns disposer。
 */
export function registerDiagnose(ctx) {
  // 注册时（纤维必然 active）捕获端口：handler 在请求时访问 ctx 服务，
  // 一旦纤维转 inactive 会抛 "cannot get required service in inactive context"。
  const port = ctx.webServer.port
  const dispose = ctx.webServer.register({
    kind: 'exact',
    path: PREFIX + '/diagnose',
    handler: async (request, response) => {
      if (denyIfNotLoopback(request, response)) return
      try {
        writeJson(response, 200, await collect(port))
      } catch (error) {
        writeJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
  return dispose
}
