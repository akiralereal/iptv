/** 泉州广播电视台闽南语频道；播放时由官网接口签发短期 HLS 地址。 */
import { proxyAwareFetch } from '../../utils/systemProxy.js'

export const CHANNEL = Object.freeze({
  name: '泉州闽南语',
  ref: 'quanzhou-minnan-tv',
  // 官网首页「电视直播」区块的闽南语频道卡（QZTV-2 闽南语），路径不带哈希；官网没有单独的方形频道标
  logo: 'https://www.qztv.cn/index/images/home/crad-02.jpg',
})
export const PLAYER_PAGE = 'https://wxqz2.qztv.cn/index/Medias/index/media_id/wq95wqbDnMKyd8KiwqzChnt0w5nChcKofcKh/stream_name/mny.html'
export const PLAY_APIS = Object.freeze([
  'https://wxqz2.qztv.cn/index/medias/getLivepath',
  'https://www.qztv.cn/index/medias/getLivepath',
])
const MEDIA_ID = 'wq95wqbDnMKyd8KiwqzChnt0w5nChcKofcKh'
const MEDIA_HOST = 'live.qztv.cn'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const MAX_TEXT_BYTES = 512 * 1024
// 官网签名接口挂着阿里云 WAF，按出口 IP 的请求频率弹滑块验证；2026-09-26 实测同一出口十几秒内
// 第七八次就被拦，之后每分钟一次也 15 分钟以上不解封。所以签到的地址要在有效期内被所有刷新共用，
// 被拦后停一段时间不再请求（越打封得越久），滑块本身不去碰。
// auth_key 开头 10 位是时间戳：明显在未来就当过期时间，提前 1 分钟换；否则当签发时间，最多用 10 分钟
// （阿里云 CDN 鉴权默认有效 30 分钟）。CDN 拒绝旧地址时立刻重签。
const SIGN_REUSE_MS = 10 * 60_000
const SIGN_REUSE_MAX_MS = 30 * 60_000
const SIGN_EXPIRY_MARGIN_MS = 60_000
const WAF_COOLDOWN_MS = Object.freeze([5, 10, 20, 30].map(minutes => minutes * 60_000))

export function officialManifestUrl(raw) {
  let url
  try { url = new URL(String(raw || '')) } catch { throw new Error('泉州播放地址无效') }
  if (url.protocol !== 'https:' || url.hostname !== MEDIA_HOST || url.port || url.username
      || url.password || url.hash || !/^\/live\/mny[A-Za-z0-9_-]*\.m3u8$/.test(url.pathname)
      || !/^\d{10}-0-0-[a-f0-9]{32}$/.test(url.searchParams.get('auth_key') || '')
      || [...url.searchParams.keys()].some(key => key !== 'auth_key')) {
    throw new Error('泉州播放地址不在官方签名频道路径')
  }
  return url.href
}

export function officialSegmentUrl(raw, manifestUrl) {
  const manifest = new URL(officialManifestUrl(manifestUrl))
  let url
  try { url = new URL(String(raw || ''), manifest) } catch { throw new Error('泉州分片地址无效') }
  const stream = manifest.pathname.slice('/live/'.length, -'.m3u8'.length)
  if (url.protocol !== 'https:' || url.hostname !== MEDIA_HOST || url.port || url.username
      || url.password || url.hash || url.search || !url.pathname.startsWith(`/live/${MEDIA_HOST}_${stream}-`)
      || !/^\d+\.ts$/.test(url.pathname.slice(`/live/${MEDIA_HOST}_${stream}-`.length))) {
    throw new Error('泉州分片不在指定频道的 CDN 路径')
  }
  return url.href
}

export function validateManifest(text, manifestUrl) {
  officialManifestUrl(manifestUrl)
  if (typeof text !== 'string' || !text.trimStart().startsWith('#EXTM3U')
      || !/#EXT-X-MEDIA-SEQUENCE:\d+/.test(text) || !text.includes('#EXTINF:')) {
    throw new Error('泉州 CDN 没有返回实时 HLS 清单')
  }
  if (/#EXT-X-(?:KEY|MAP|STREAM-INF)/.test(text)) throw new Error('泉州 HLS 格式已变化')
  let count = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    officialSegmentUrl(line, manifestUrl)
    count++
  }
  if (!count) throw new Error('泉州清单没有视频分片')
  return text
}

async function requestText(url, { fetchImpl, timeoutMs, method = 'GET', body, headers = {} }) {
  const response = await fetchImpl(url, {
    method, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': UA, ...headers },
  })
  if (!response.ok || response.status >= 300) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error(`上游 HTTP ${response.status}`)
  }
  if (Number(response.headers.get('content-length')) > MAX_TEXT_BYTES) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error('上游响应过大')
  }
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > MAX_TEXT_BYTES) {
      await response.body?.cancel?.().catch(() => {})
      throw new Error('上游响应过大')
    }
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/** 签名地址可以复用到什么时候（毫秒时间戳），规则见 SIGN_REUSE_MS 注释。 */
export function signedReuseUntil(url, now = Date.now()) {
  let seconds = NaN
  try { seconds = Number(String(new URL(url).searchParams.get('auth_key') || '').split('-')[0]) } catch { /* 走默认 */ }
  const stamp = seconds * 1000
  if (Number.isFinite(stamp) && stamp - SIGN_EXPIRY_MARGIN_MS > now + SIGN_EXPIRY_MARGIN_MS) {
    return Math.min(stamp - SIGN_EXPIRY_MARGIN_MS, now + SIGN_REUSE_MAX_MS)
  }
  return now + SIGN_REUSE_MS
}

const wafError = () => Object.assign(new Error('官网要求人机验证'), { waf: true })

export async function requestPlayUrl({ fetchImpl = proxyAwareFetch, timeoutMs = 12000 } = {}) {
  let lastError = null
  let blocked = null
  for (const api of PLAY_APIS) {
    try {
      const text = await requestText(api, {
        fetchImpl, timeoutMs, method: 'POST',
        body: new URLSearchParams({ media_id: MEDIA_ID }),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          Referer: PLAYER_PAGE,
          Origin: new URL(api).origin,
          Accept: 'application/json',
        },
      })
      if (text.includes('aliyun_waf_aa')) throw wafError()
      let payload
      try { payload = JSON.parse(text) } catch { throw new Error('官网接口没有返回 JSON') }
      if (payload?.error_code !== 0 || typeof payload?.data !== 'string') {
        throw new Error('官网当前没有签发闽南语直播地址')
      }
      return officialManifestUrl(payload.data)
    } catch (error) {
      lastError = error
      if (error?.waf) blocked = error
    }
  }
  // 两个入口挂的是同一套 WAF：只要有一个弹了滑块又没拿到地址，就按被拦处理（调用方据此冷却）
  throw blocked || lastError || new Error('官网直播接口不可用')
}

export async function requestManifest(url, { fetchImpl = proxyAwareFetch, timeoutMs = 12000 } = {}) {
  const safe = officialManifestUrl(url)
  const text = await requestText(safe, {
    fetchImpl, timeoutMs,
    headers: { Referer: PLAYER_PAGE, Accept: 'application/vnd.apple.mpegurl' },
  })
  return validateManifest(text, safe)
}

export function buildChannels() {
  return [{ name: CHANNEL.name, deferredRef: CHANNEL.ref, logo: CHANNEL.logo,
    opts: ['network-caching=3000'], catchup: 'none' }]
}

export function claimsRef(ref) { return String(ref || '') === CHANNEL.ref }

export function createResolver({ fetchImpl: defaultFetch = proxyAwareFetch, now = () => Date.now() } = {}) {
  // 全部观众、全部刷新共用一份签名；同时到达的请求只签一次
  let signed = null          // { url, reuseUntil }
  let signing = null
  let cooldownUntil = 0
  let wafStrikes = 0

  const success = (url, manifest) => ({
    url,
    desc: '泉州闽南语官方直播地址',
    manifestText: manifest,
    manifestUrl: url,
    // CDN 拒绝 curl / Lavf 等客户端标识；所有分片由本机按官网浏览器标识取回。
    upstreamHeaders: () => ({ Referer: PLAYER_PAGE, 'User-Agent': UA }),
    upstreamUrlTransform: raw => officialSegmentUrl(raw, url),
  })
  const failure = error => {
    const reason = ['AbortError', 'TimeoutError'].includes(error?.name)
      ? '请求超时' : (error?.message || '上游请求失败')
    return { url: '', desc: `泉州闽南语取流失败：${reason}` }
  }
  const coolingDesc = () => {
    const minutes = Math.max(1, Math.ceil((cooldownUntil - now()) / 60_000))
    return { url: '', desc: `泉州闽南语取流失败：官网要求人机验证，已暂停向官网请求，约 ${minutes} 分钟后自动重试` }
  }

  function sign(options) {
    if (!signing) {
      signing = requestPlayUrl(options).then(url => {
        signed = { url, reuseUntil: signedReuseUntil(url, now()) }
        wafStrikes = 0
        cooldownUntil = 0
        return url
      }, error => {
        if (error?.waf) {
          cooldownUntil = now() + WAF_COOLDOWN_MS[Math.min(wafStrikes, WAF_COOLDOWN_MS.length - 1)]
          wafStrikes++
        }
        throw error
      }).finally(() => { signing = null })
    }
    return signing
  }

  async function resolve(ref, ctx = {}) {
    if (!claimsRef(ref)) return { url: '', desc: '泉州闽南语频道引用格式错误' }
    const options = { fetchImpl: ctx.fetchImpl || defaultFetch, timeoutMs: ctx.timeoutMs || 12000 }
    const reusable = signed && now() < signed.reuseUntil ? signed.url : ''
    if (reusable) {
      try {
        return success(reusable, await requestManifest(reusable, options))
      } catch {
        // CDN 不认这份签名了（过期或被收回）：丢掉，下面重签一次
        if (signed?.url === reusable) signed = null
      }
    }
    if (now() < cooldownUntil) return coolingDesc()
    try {
      const url = await sign(options)
      return success(url, await requestManifest(url, options))
    } catch (error) {
      return error?.waf ? coolingDesc() : failure(error)
    }
  }
  return { resolve }
}

export const resolveChannel = createResolver().resolve
