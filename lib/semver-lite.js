/**
 * semver-lite — 版本比较（含 rc 预发布语义），零依赖。
 *
 * 规则遵循 semver 2.0 的核心序：
 *   - 主.次.补 逐段数值比较；
 *   - 预发布标识（rc.N / alpha.N 等）小于同号正式版；
 *   - 预发布段按 . 分段：数字段数值比较且小于非数字段；
 *   - build 元数据（+...）不参与比较。
 * 覆盖本插件的真实需求：0.1.5-rc.3 > 0.1.5-rc.1，0.1.7-rc.1 > 0.1.5-rc.3。
 * @module dsh-harness-toolbox/semver-lite
 */

/** 拆解版本号；非法返回 null。 */
function parse(version) {
  if (typeof version !== 'string') return null
  const core = version.split('+')[0]
  const [releaseRaw, prereleaseRaw] = core.split('-')
  const release = releaseRaw.split('.').map((part) => Number(part))
  if (release.length === 0 || release.some((n) => !Number.isInteger(n) || n < 0)) return null
  const prerelease = prereleaseRaw === undefined ? null : prereleaseRaw.split('.')
  return { release, prerelease }
}

/** 预发布段比较：无预发布 > 有预发布。 */
function comparePrerelease(a, b) {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const left = a[i]
    const right = b[i]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNum = /^\d+$/.test(left)
    const rightNum = /^\d+$/.test(right)
    if (leftNum && rightNum) {
      const diff = Number(left) - Number(right)
      if (diff !== 0) return diff < 0 ? -1 : 1
    } else if (leftNum !== rightNum) {
      return leftNum ? -1 : 1
    } else if (left !== right) {
      return left < right ? -1 : 1
    }
  }
  return 0
}

/**
 * 比较两个版本。
 * @returns {-1|0|1} a < b → -1；a === b → 0；a > b → 1；任一非法 → 0（保守）。
 */
export function compareVersions(a, b) {
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) return 0
  const len = Math.max(left.release.length, right.release.length)
  for (let i = 0; i < len; i++) {
    const l = left.release[i] ?? 0
    const r = right.release[i] ?? 0
    if (l !== r) return l < r ? -1 : 1
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

/** a 是否严格新于 b；非法输入返回 false。 */
export function isNewer(a, b) {
  return compareVersions(a, b) > 0
}

/** 是否形如合法版本号（升级目标的最后防线）。 */
export function isValidVersion(version) {
  return parse(version) !== null
}
