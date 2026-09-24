/**
 * dsh-harness-toolbox — DeepSeek Harness 工具箱（非官方社区插件）宿主端入口。
 *
 * 职责边界：
 *   - 本入口只做装配：注入 webServer → 挂模块注册表 → 退出时逆序回收；
 *   - 全部业务在 lib/modules/*（每模块独立 try/catch 隔离，F12）；
 *   - 全部 /api/dsh-toolbox/* 路由受回环围栏保护，破坏性 POST 另加
 *     JSON content-type + 一次性 nonce（F1）；
 *   - 本包不读写任何凭据，不向浏览器透出代理密码与令牌（F4）。
 *
 * 新增功能模块的步骤见 lib/registry.js 顶部注释。
 * @module dsh-harness-toolbox
 */
import { mountModules } from './registry.js'
import { toolboxStateDir } from './paths.js'
import fs from 'node:fs'

export const name = 'dsh-harness-toolbox'
/** cordis 服务注入：路由注册需要 webServer。 */
export const inject = ['webServer']

/**
 * 宿主挂载。
 * @param ctx - 宿主根上下文。
 * @param config - 插件行配置；enabled:false 时整体不挂载。
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) {
    ctx.logger?.info?.('[dsh-harness-toolbox] 已被配置禁用')
    return
  }

  // 状态目录先就位（升级状态/历史/备份都写这里）。
  try {
    fs.mkdirSync(toolboxStateDir(), { recursive: true })
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-harness-toolbox] 状态目录创建失败：${error instanceof Error ? error.message : String(error)}`)
  }

  // 官方模式：ctx.effect 保证纤维销毁时同步回收路由（HMR/patch 重组时旧
  // 纤维必须先注销路由，新纤维才能注册同名路径——on('dispose') 的时序不保
  // 证这点，会造成 duplicate 吞错 + 陈旧 handler 泄漏）。
  ctx.effect(() => {
    const dispose = mountModules(ctx)
    ctx.logger?.info?.('[dsh-harness-toolbox] 已挂载：更新中心 / API 用量 / 环境体检 / 服务工具 / 关于')
    return dispose
  }, 'dsh-harness-toolbox: routes')
}
