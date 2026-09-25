/**
 * service — 服务工具宿主模块。
 *
 * 动作（客户端只发动作名，路径全部由服务端白名单解析）：
 *   - open-log / open-runtime / open-home → explorer 定位打开；
 *   - restart → 复用 scripts/upgrade.mjs 的 restart 模式：分离进程执行
 *     停服 → 拉起 → 健康检查，执行器随后停掉宿主自身，所以响应先发出。
 * 安全：只读状态走回环围栏；动作 POST 走回环 + JSON + 一次性 nonce
 * （重启与升级同级，都是破坏性操作）。非 Windows 的 open 动作返回
 * 501（v0.1 范围声明）。
 * @module dsh-harness-toolbox/modules/service
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { denyIfNotLoopback, denyUnsafePost, readJsonBody, writeJson } from '../http.js'
import { consumeNonce, issueNonce } from '../security.js'
import { API_PREFIX } from '../prefix.js'
import { wmiRunNode } from '../wmi.js'
import { installMode, newestWebLog, openTargets, runtimeDir, toolboxStateDir } from '../paths.js'

const PREFIX = API_PREFIX
const OPEN_ACTIONS = new Set(['open-log', 'open-runtime', 'open-home'])

/** 用 explorer 打开（select 为 true 时定位到文件）。 */
function explorerOpen(target, select = false) {
  const child = spawn('explorer.exe', select ? ['/select,', target] : [target], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
}

/**
 * 注册服务工具路由。
 * @param ctx - 宿主上下文（需 webServer）。
 * @returns disposer。
 */
export function registerService(ctx) {
  // 注册时捕获端口：handler 请求时访问 ctx 服务在纤维 inactive 后会抛错。
  const port = ctx.webServer.port
  const disposers = [
    // 状态：发放重启 nonce，回传可打开目标的存在性。
    ctx.webServer.register({
      kind: 'exact',
      path: PREFIX + '/service-state',
      handler: (request, response) => {
        if (denyIfNotLoopback(request, response)) return
        const targets = openTargets()
        const log = newestWebLog()
        writeJson(response, 200, {
          ok: true,
          nonce: issueNonce(),
          platform: process.platform,
          installMode: installMode(),
          restartSupported: installMode() === 'local',
          targets: {
            log: Boolean(log),
            runtime: Boolean(targets.runtime),
            home: Boolean(targets.home),
          },
          logPath: log,
        })
      },
    }),

    // 动作执行。
    ctx.webServer.register({
      kind: 'exact',
      path: PREFIX + '/service',
      handler: async (request, response) => {
        if (denyUnsafePost(request, response)) return
        const body = await readJsonBody(request)
        const action = body?.action

        if (OPEN_ACTIONS.has(action)) {
          if (process.platform !== 'win32') {
            writeJson(response, 501, { ok: false, error: 'v0.1 仅支持 Windows' })
            return
          }
          const targets = openTargets()
          try {
            if (action === 'open-log') {
              const log = newestWebLog()
              if (!log) throw new Error('未找到服务日志')
              explorerOpen(log, true)
            } else if (action === 'open-runtime') {
              if (!targets.runtime) throw new Error('未找到运行时目录')
              explorerOpen(targets.runtime)
            } else {
              explorerOpen(targets.home)
            }
            writeJson(response, 200, { ok: true, action })
          } catch (error) {
            writeJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
          return
        }

        if (action === 'restart') {
          if (!consumeNonce(body?.nonce)) {
            writeJson(response, 403, { ok: false, error: 'nonce 无效或已过期' })
            return
          }
          if (installMode() !== 'local') {
            writeJson(response, 409, { ok: false, error: '当前安装形态不支持一键重启' })
            return
          }
          const runtime = runtimeDir()
          if (!runtime) {
            writeJson(response, 409, { ok: false, error: '无法定位本地运行时' })
            return
          }
          const stateDir = toolboxStateDir()
          fs.mkdirSync(stateDir, { recursive: true })
          const stateFile = path.join(stateDir, 'upgrade-state.json')
          const historyFile = path.join(stateDir, 'upgrade-history.json')
          const runnerLog = path.join(stateDir, 'upgrade-runner.log')
          const errorNote = path.join(stateDir, 'last-upgrade-error.txt')
          const serviceLog = newestWebLog() || path.join(stateDir, 'web.log')

          // 先落状态、先回响应，再拉执行器（执行器会把宿主停掉）。
          fs.writeFileSync(stateFile, JSON.stringify({
            phase: 'stopping',
            mode: 'restart',
            startedAt: Date.now(),
            pid: process.pid,
            port,
          }, null, 2))

          const here = path.dirname(fileURLToPath(import.meta.url))
          const script = path.join(here, '..', '..', 'scripts', 'upgrade.mjs')
          try {
            // 树外创建（WMI，父=WmiPrvSE）：执行器不被宿主随后的退出连坐。
            const executerPid = await wmiRunNode(process.execPath, script, [
              '--mode', 'restart',
              '--runtime', runtime,
              '--port', String(port),
              '--parent-pid', String(process.pid),
              '--state', stateFile,
              '--history', historyFile,
              '--backup', path.join(stateDir, 'backup'),
              '--runner-log', runnerLog,
              '--error-note', errorNote,
              '--service-log', serviceLog,
              '--launcher-dir', path.dirname(runtime),
              '--workdir', process.cwd(),
            ])
            writeJson(response, 202, { ok: true, restarting: true, executerPid })
            // 体面自尽：执行器等待端口释放（=本进程退出）后经 WMI 拉起新宿主。
            setTimeout(() => process.exit(0), 400)
          } catch (error) {
            try {
              const stale = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
              if (stale.phase === 'stopping') {
                stale.phase = 'failed'
                stale.reason = error.message
                stale.updatedAt = Date.now()
                fs.writeFileSync(stateFile, JSON.stringify(stale, null, 2))
              }
            } catch { /* 状态文件兜底失败不掩盖主错误 */ }
            writeJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
          return
        }

        writeJson(response, 400, { ok: false, error: '未知 action' })
      },
    }),
  ]
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 路由纤维已关闭。
      }
    }
  }
}
