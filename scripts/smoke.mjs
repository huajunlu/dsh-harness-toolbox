/**
 * smoke — 宿主端无界面冒烟测试（不碰网络、不碰运行时）。
 *
 * 覆盖：semver 比较、围栏判定、nonce 生命周期、模块 registry 的隔离性、
 * 台账聚合的防御路径。node scripts/smoke.mjs 即跑，退出码非 0 即失败。
 */
import assert from 'node:assert'
import http from 'node:http'
import zlib from 'node:zlib'
import { compareVersions, isNewer, isValidVersion } from '../lib/semver-lite.js'
import { consumeNonce, isLoopbackRequest, issueNonce } from '../lib/security.js'
import { moduleMeta } from '../lib/registry.js'
import { aggregateText, dayKey, decodeFrames, frameStarts, usageRowOf } from '../lib/usage-logs.js'

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

/** 异步用例必须走这个包装——否则断言在"✓"之后才失败，会被漏掉。 */
async function checkAsync(name, fn) {
  try {
    await fn()
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

console.log('usage logs (session-log source)')
check('zstd 多帧：两帧拼接都能解出', () => {
  const buf = Buffer.concat([
    zlib.zstdCompressSync(Buffer.from('{"a":1}\n')),
    zlib.zstdCompressSync(Buffer.from('{"b":2}\n')),
  ])
  assert.strictEqual(frameStarts(buf).length, 2)
  const { text, failed } = decodeFrames(buf)
  assert.strictEqual(failed, 0)
  assert.ok(text.includes('{"a":1}') && text.includes('{"b":2}'), '两帧内容都应解出')
})

check('半截帧（追加写竞态）被跳过而非抛错', () => {
  const good = zlib.zstdCompressSync(Buffer.from('{"complete":true}\n'))
  const torn = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from([0x01, 0x02, 0x03, 0x04])])
  const { text, failed } = decodeFrames(Buffer.concat([good, torn]))
  assert.ok(text.includes('"complete":true'), '完好帧必须解出')
  assert.strictEqual(failed, 1, '半截帧应计为失败并跳过')
})

check('用量事件聚合：按 天/供应商/模型 归并', () => {
  const at = new Date(2026, 8, 26, 10, 0, 0).getTime()
  const ev = (usage, provider, model) => JSON.stringify({
    type: 'assistant/message',
    time: at,
    data: { usage, message: { source: { provider, model } } },
  })
  const text = [
    ev({ inputTokens: 100, outputTokens: 20 }, 'p1', 'm1'),
    ev({ inputTokens: 50, outputTokens: 10 }, 'p1', 'm1'),
    ev({ totalTokens: 300, outputTokens: 100 }, 'p2', 'm2'),
    JSON.stringify({ type: 'tool/call', time: at, data: {} }),
  ].join('\n')
  const { rows, events, usageEvents } = aggregateText(text)
  assert.strictEqual(events, 4)
  assert.strictEqual(usageEvents, 3)
  const m1 = rows.find((r) => r.model === 'm1')
  assert.strictEqual(m1.day, '2026-09-26')
  assert.strictEqual(m1.calls, 2)
  assert.strictEqual(m1.input, 150)
  assert.strictEqual(m1.output, 30)
  // 只有 totalTokens 时用 total - output 还原输入侧
  assert.strictEqual(rows.find((r) => r.model === 'm2').input, 200)
})

check('缺时间戳/缺用量的行不计入', () => {
  assert.strictEqual(usageRowOf({ data: { usage: { inputTokens: 1 } } }), null)
  assert.strictEqual(usageRowOf({ time: 1, data: {} }), null)
})

check('dayKey 按本地时区（23:30 仍是当天）', () => {
  assert.strictEqual(dayKey(new Date(2026, 8, 26, 23, 30, 0).getTime()), '2026-09-26')
})

console.log('usage aggregation (defensive path)')
await checkAsync('用量路由：数据源不可读时 available 布尔且不抛错', async () => {
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
  await registered[0].handler(request, response)
  const parsed = JSON.parse(response.body)
  assert.strictEqual(parsed.ok, true)
  assert.strictEqual(typeof parsed.available, 'boolean')
  // 本机若存在会话日志，则应走实时源并带回扫描统计。
  if (parsed.available) {
    assert.ok(parsed.today && typeof parsed.today.calls === 'number')
    assert.strictEqual(Array.isArray(parsed.trend), true)
    assert.ok(parsed.source === 'session-logs' || parsed.source === 'legacy-ledger')
  }
  dispose()
})

console.log(process.exitCode ? '\n存在失败项' : `\n${passed} 项通过`)
