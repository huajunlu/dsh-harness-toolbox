/**
 * prefix — 由本包 package.json 的 name 推导 API 路由前缀。
 *
 * 为什么前缀要跟着包名走（HMR 泄漏教训）：
 *   webServer 路由注册在根服务的扁平 map 里，其 disposer 只被插件纤维持有。
 *   patch 重组若出现「旧纤维已废但 disposer 未执行」的泄漏，同名路径会被
 *   **永久占用**——后续实例注册永远 duplicate，且泄漏 handler 引用 inactive
 *   上下文。让每次 dev 部署（name 带 -devN 后缀）使用独立前缀，新旧实例
 *   井水不犯河水；发布版 name 稳定，正常使用中不存在泄漏场景。
 *   客户端的 API 常量在部署时同步改写（deploy.mjs 按包名全文替换）。
 * @module dsh-harness-toolbox/prefix
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本包名（读取失败时退回无后缀基名——发布态的稳定前缀）。 */
function packageName() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const manifest = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'))
    const name = String(manifest.name ?? '')
    // 只允许 npm 包名字符进 URL；异常字符一律剔除，防路径注入。
    if (/^[a-z0-9][a-z0-9._-]*$/.test(name)) return name
  } catch {
    // 读不到清单：用基名兜底。
  }
  return 'dsh-harness-toolbox'
}

/** 本实例的 API 前缀，如 /api/dsh-harness-toolbox-dev5。 */
export const API_PREFIX = '/api/' + packageName()
