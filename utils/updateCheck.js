/**
 * 后台「检查更新」：从 GitHub 上的 package.json 读最新版本号，跟当前版本比。
 *
 * 两条规则，都是因为镜像会给旧缓存：
 * - 只有远端版本**更高**才算有更新。以前用 `!==` 判断，镜像返回旧版本时，旧版本也会显示成「发现新版本」。
 * - 某个镜像返回的版本比当前版本低，说明它的缓存过期了（正在运行的版本不会比 main 上的新），
 *   换下一个镜像继续问。jsDelivr 对 `@main` 这种按分支取的地址会缓存几个小时，国内连不上
 *   raw.githubusercontent.com 时常常落到它上面：v4.79.0 发版后，gcore.jsdelivr.net 还在返回 4.78.0。
 */

/** 按数字逐段比较 4.79.0 这类版本号，前面的 v 忽略。a 更高返回正数，相同返回 0。 */
export function compareVersions(a, b) {
  const parts = (v) => String(v).trim().replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0)
  const pa = parts(a)
  const pb = parts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * 依次问各个镜像，返回 { currentVersion, latestVersion, hasUpdate }。
 *
 * 遇到版本不低于当前版本的回答就停下。所有镜像都失败时抛出最后一个错误；
 * 能回答的镜像都只给出更旧的版本时，按「已是最新」处理，latestVersion 填当前版本。
 *
 * @param {string} currentVersion
 * @param {object} opts
 * @param {string} opts.rawUrl          raw.githubusercontent.com 上的 package.json 地址
 * @param {Array<(url: string) => string>} opts.mirrors  地址改写函数，按顺序尝试
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]     每个镜像的超时
 * @param {(url: string, error: Error) => void} [opts.onMirrorError]
 * @param {(url: string, version: string) => void} [opts.onStaleMirror]
 */
export async function checkForUpdate(currentVersion, {
  rawUrl,
  mirrors,
  fetchImpl = fetch,
  timeoutMs = 5000,
  onMirrorError = () => {},
  onStaleMirror = () => {},
} = {}) {
  let lastError = null
  let answered = false

  for (const transform of mirrors) {
    const url = transform(rawUrl)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let version
    try {
      const resp = await fetchImpl(url, {
        headers: { 'User-Agent': 'iptv-update-checker' },
        signal: controller.signal
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const pkg = await resp.json()
      version = typeof pkg?.version === 'string' ? pkg.version.trim() : ''
      if (!version) throw new Error('package.json 里没有 version')
    } catch (e) {
      lastError = e
      onMirrorError(url, e)
      continue
    } finally {
      clearTimeout(timer)
    }

    answered = true
    if (compareVersions(version, currentVersion) < 0) {
      onStaleMirror(url, version)
      continue
    }
    return { currentVersion, latestVersion: version, hasUpdate: compareVersions(version, currentVersion) > 0 }
  }

  if (answered) return { currentVersion, latestVersion: currentVersion, hasUpdate: false }
  throw lastError || new Error('所有镜像均不可用')
}
