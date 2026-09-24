/**
 * security — 回环信任围栏 + 一次性升级 nonce。
 *
 * 围栏语义（对抗式审查 F1 的落地）：
 *   1. 套接字远端地址必须是回环（127/8、::1、::ffff:127/8），X-Forwarded-For 永不信；
 *   2. Host 头主机名必须是回环主机名；
 *   3. sec-fetch-site=cross-site 直接拒绝（浏览器跨站标记）；
 *   4. 带 Origin 的请求必须与 Host 同源；
 *   5. POST 额外要求 application/json（简单跨站表单发不出该类型，天然挡掉 CSRF 表单）；
 *   6. 破坏性操作（升级 / 重启）额外要求 10 分钟时效的进程内 nonce。
 * 客户端只传动作名，所有路径、包名、版本均由服务端解析。
 * @module dsh-harness-toolbox/security
 */
import { randomUUID } from 'node:crypto'

/** IPv4 127/8 判定。 */
function isIPv4Loopback(value) {
  const parts = value.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

/** 套接字远端地址是否回环。 */
function isLoopbackAddress(address) {
  if (!address) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice(7))
  return isIPv4Loopback(normalized)
}

/** Host 头主机名是否回环。 */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/** 请求级回环围栏：socket 权威 + Host + 浏览器同源标记。 */
export function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** POST 必须是 JSON：跨站 HTML 表单发不出 application/json。 */
export function isJsonContentType(request) {
  const type = request.headers['content-type'] || ''
  return typeof type === 'string' && type.toLowerCase().startsWith('application/json')
}

const NONCE_TTL_MS = 10 * 60 * 1000

/** 进程内 nonce 池：issue 发新码，consume 校验并作废（10 分钟过期）。 */
const nonces = new Map()

export function issueNonce() {
  pruneNonces()
  const token = randomUUID()
  nonces.set(token, Date.now() + NONCE_TTL_MS)
  return token
}

export function consumeNonce(token) {
  pruneNonces()
  if (typeof token !== 'string' || token.length === 0) return false
  const expiry = nonces.get(token)
  if (expiry === undefined) return false
  nonces.delete(token)
  return expiry >= Date.now()
}

function pruneNonces() {
  const now = Date.now()
  for (const [token, expiry] of nonces) {
    if (expiry < now) nonces.delete(token)
  }
}
