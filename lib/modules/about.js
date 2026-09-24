/**
 * about — 关于页宿主模块。
 *
 * 返回插件元数据 + 非官方声明（对抗式审查 F9）+ 模块清单。
 * 纯静态，无外部探测、无文件写入。
 * @module dsh-harness-toolbox/modules/about
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { denyIfNotLoopback, writeJson } from '../http.js'
import { moduleMeta } from '../registry.js'
import { API_PREFIX } from '../prefix.js'

const PREFIX = API_PREFIX

/** 读本包 package.json 的 name/version（找不到时兜底常量）。 */
function packageMeta() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const manifest = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'package.json'), 'utf8'))
    return { name: String(manifest.name ?? 'dsh-harness-toolbox'), version: String(manifest.version ?? '0.0.0') }
  } catch {
    return { name: 'dsh-harness-toolbox', version: '0.0.0' }
  }
}

/**
 * 注册关于路由。
 * @param ctx - 宿主上下文（需 webServer）。
 * @returns disposer。
 */
export function registerAbout(ctx) {
  const dispose = ctx.webServer.register({
    kind: 'exact',
    path: PREFIX + '/about',
    handler: (request, response) => {
      if (denyIfNotLoopback(request, response)) return
      const meta = packageMeta()
      writeJson(response, 200, {
        ok: true,
        plugin: meta,
        author: 'LHJ',
        license: 'MIT',
        unofficial: true,
        disclaimer: {
          zh: '本插件为社区开源作品，非 DeepSeek 官方出品；名称中的 DeepSeek Harness 指其所适配的宿主产品。',
          en: 'An unofficial community plugin. "DeepSeek Harness" refers to the host product it integrates with.',
        },
        repository: 'https://github.com/lhj-dev/dsh-harness-toolbox',
        security: 'https://github.com/lhj-dev/dsh-harness-toolbox/blob/main/SECURITY.md',
        modules: moduleMeta(),
        hostPid: process.pid,
      })
    },
  })
  return dispose
}
