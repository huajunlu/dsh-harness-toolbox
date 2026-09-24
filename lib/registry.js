/**
 * registry — 工具箱宿主模块注册表（可扩展性核心）。
 *
 * 新增一个功能 = 在 modules/ 下加一个文件夹 + 在下方数组加一行。
 * 每个模块形如 { id, register(ctx) → disposer }；注册表对每个模块独立
 * try/catch（对抗式审查 F12）：单模块故障只降级自身，绝不拖垮宿主启动
 * 或其他页签。模块间禁止直接 import 彼此内部，共享逻辑只能放 lib/ 根。
 * @module dsh-harness-toolbox/registry
 */
import { registerUpdater } from './modules/updater.js'
import { registerUsage } from './modules/usage.js'
import { registerDiagnose } from './modules/diagnose.js'
import { registerService } from './modules/service.js'
import { registerAbout } from './modules/about.js'

/** 模块清单：顺序即注册顺序（也是客户端页签顺序的服务端镜像）。 */
const MODULES = [
  { id: 'updater', label: '更新中心', register: registerUpdater },
  { id: 'usage', label: 'API 用量', register: registerUsage },
  { id: 'diagnose', label: '环境体检', register: registerDiagnose },
  { id: 'service', label: '服务工具', register: registerService },
  { id: 'about', label: '关于', register: registerAbout },
]

/**
 * 注册全部模块。
 *
 * 隔离与竞态双重策略（F12 + HMR 实测教训）：
 *   - 每个模块独立 try/catch：真错误只降级自身，不拖垮宿主与其他页签；
 *   - **duplicate 竞态例外**：patch/HMR 重组时旧纤维注销路由与新纤维注册
 *     存在时序窗口，(kind,path) 撞车会抛 Duplicate——这不是模块故障，短暂
 *     延迟后重试即可（等旧路由让位）。上限 10 次 × 500ms，超限按真错误隔离。
 * @param ctx - 宿主根上下文（需暴露 webServer）。
 * @returns disposer，逆序回收已注册模块并取消挂起的重试定时器。
 */
export function mountModules(ctx) {
  const disposers = []
  const pending = new Set()
  const failed = []
  let closed = false

  const tryRegister = (mod, attempt) => {
    if (closed) return
    try {
      const dispose = mod.register(ctx)
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/duplicate/i.test(message) && attempt < 10) {
        const timer = setTimeout(() => {
          pending.delete(timer)
          tryRegister(mod, attempt + 1)
        }, 500)
        pending.add(timer)
        return
      }
      failed.push(mod.id)
      ctx.logger?.warn?.(`[dsh-harness-toolbox] 模块 "${mod.id}" 注册失败（已隔离）：${message}`)
    }
  }

  for (const mod of MODULES) tryRegister(mod, 0)

  if (failed.length > 0) {
    ctx.logger?.warn?.(`[dsh-harness-toolbox] 已降级运行，失败模块：${failed.join(', ')}`)
  }
  return () => {
    closed = true
    for (const timer of pending) clearTimeout(timer)
    pending.clear()
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        // 回收竞态：该模块的路由纤维已随宿主关闭。
      }
    }
  }
}

/** 对外暴露的模块元数据（关于页展示 + 客户端页签的服务端真源）。 */
export function moduleMeta() {
  return MODULES.map(({ id, label }) => ({ id, label }))
}
