/**
 * http — 宿主路由的 JSON 读写与受保护动作分发helper。
 * @module dsh-harness-toolbox/http
 */
import { isJsonContentType, isLoopbackRequest } from './security.js'

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
}

/** 写一个 JSON 响应。 */
export function writeJson(res, status, body, headers = {}) {
  res.writeHead(status, { ...JSON_HEADERS, ...headers })
  res.end(JSON.stringify(body))
}

/** 读取有上限的 JSON 请求体；超限或非法返回 null。 */
export async function readJsonBody(request, maxBytes = 8 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBytes) return null
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return null
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 只读 GET 动作的统一围栏：回环校验失败 403。
 * @returns {boolean} 是否已拦截（true = 已写 403，调用方直接 return）。
 */
export function denyIfNotLoopback(request, res) {
  if (isLoopbackRequest(request)) return false
  writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
  return true
}

/**
 * 破坏性 POST 动作的统一围栏：回环 + JSON content-type。
 * @returns {boolean} 是否已拦截。
 */
export function denyUnsafePost(request, res) {
  if (!isLoopbackRequest(request)) {
    writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
    return true
  }
  if (!isJsonContentType(request)) {
    writeJson(res, 415, { ok: false, error: 'expected application/json' })
    return true
  }
  return false
}
