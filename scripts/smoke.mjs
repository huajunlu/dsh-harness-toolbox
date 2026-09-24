/**
 * smoke — 宿主端无界面冒烟测试（不碰网络、不碰运行时）。
 *
 * 覆盖：semver 比较、围栏判定、nonce 生命周期、模块 registry 的隔离性、
 * 台账聚合的防御路径。node scripts/smoke.mjs 即跑，退出码非 0 即失败。
 */
import assert from 'node:assert'
import http from 'node:http'
import { compareVersions, isNewer, isValidVersion } from '../lib/semver-lite.js'
import { consumeNonce, isLoopbackRequest, issueNonce } from '../lib/security.js'
import { moduleMeta } from '../lib/registry.js'

let passed = 0
function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    console.error(`  ✗ ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

console.log('semver-lite')
check('0.1.5-rc.3 > 0.1.5-rc.1', () => assert.ok(isNewer('0.1.5-rc.3', '0.1.5-rc.1')))
check('0.1.7-rc.1 > 0.1.5-rc.3', () => assert.ok(isNewer('0.1.7-rc.1', '0.1.5-rc.3')))
check('0.1.5 > 0.1.5-rc.3（正式版 > 预发布）', () => assert.ok(isNewer('0.1.5', '0.1.5-rc.3')))
check('相等版本不新', () => assert.ok(!isNewer('0.1.5-rc.1', '0.1.5-rc.1')))
check('非法输入保守返回', () => assert.ok(!isNewer('garbage', '0.1.5')))
check('版本格式校验', () => {
  assert.ok(isValidVersion('0.1.5-rc.3'))
  assert.ok(!isValidVersion('1.2.3; rm -rf /'))
  assert.ok(!isValidVersion('$(whoami)'))
})

console.log('security fence')
function fakeRequest({ remote = '127.0.0.1', host = '127.0.0.1:3080', site, origin } = {}) {
  const headers = {}
  if (host) headers.host = host
  if (site) headers['sec-fetch-site'] = site
  if (origin) headers.origin = origin
  return { socket: { remoteAddress: remote }, headers }
}
check('回环通过', () => assert.ok(isLoopbackRequest(fakeRequest())))
check('IPv4-mapped 回环通过', () => assert.ok(isLoopbackRequest(fakeRequest({ remote: '::ffff:127.0.0.1' }))))
check('LAN 地址拒绝', () => assert.ok(!isLoopbackRequest(fakeRequest({ remote: '192.168.1.50' }))))
check('cross-site 标记拒绝', () => assert.ok(!isLoopbackRequest(fakeRequest({ site: 'cross-site' }))))
check('异源 Origin 拒绝', () => assert.ok(!isLoopbackRequest(fakeRequest({ origin: 'http://evil.example' }))))
check('同源 Origin 通过', () => assert.ok(isLoopbackRequest(fakeRequest({ origin: 'http://127.0.0.1:3080' }))))
check('nonce 一次性', () => {
  const token = issueNonce()
  assert.ok(consumeNonce(token))
  assert.ok(!consumeNonce(token), '第二次必须失败')
})
check('nonce 伪造成败', () => assert.ok(!consumeNonce('forged-token')))

console.log('registry meta')
check('模块清单含 5 项且顺序正确', () => {
  const ids = moduleMeta().map((m) => m.id)
  assert.deepStrictEqual(ids, ['updater', 'usage', 'diagnose', 'service', 'about'])
})

console.log('usage aggregation (defensive path)')
check('台账缺失时 available:false 不抛错', async () => {
  const { registerUsage } = await import('../lib/modules/usage.js')
  const registered = []
  const ctx = {
    webServer: { register: (route) => { registered.push(route); return () => {} }, port: 3080 },
  }
  const dispose = registerUsage(ctx)
  assert.strictEqual(registered.length, 1)
  // 直接调 handler：伪造一个回环请求与 JSON 响应。
  const request = fakeRequest()
  const response = {
    code: null,
    body: null,
    writeHead(code) { this.code = code },
    end(payload) { this.body = payload },
  }
  // 本机没有 $DSH_HOME/dsh-usage 时走防御路径；有则 available 为 true。
  await registered[0].handler(request, response)
  const parsed = JSON.parse(response.body)
  assert.strictEqual(parsed.ok, true)
  assert.ok(typeof parsed.available === 'boolean')
  dispose()
})

// async check 包装：上面最后一个用例是 async，等一拍再总结。
setTimeout(() => {
  console.log(process.exitCode ? '\n存在失败项' : `\n${passed} 项通过`)
}, 50)
