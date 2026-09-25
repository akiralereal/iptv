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

export async function requestPlayUrl({ fetchImpl = proxyAwareFetch, timeoutMs = 12000 } = {}) {
  let lastError = null
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
      if (text.includes('aliyun_waf_aa')) throw new Error('官网要求人机验证')
      let payload
      try { payload = JSON.parse(text) } catch { throw new Error('官网接口没有返回 JSON') }
      if (payload?.error_code !== 0 || typeof payload?.data !== 'string') {
        throw new Error('官网当前没有签发闽南语直播地址')
      }
      return officialManifestUrl(payload.data)
    } catch (error) { lastError = error }
  }
  throw lastError || new Error('官网直播接口不可用')
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

export function createResolver({ fetchImpl: defaultFetch = proxyAwareFetch } = {}) {
  async function resolve(ref, ctx = {}) {
    if (!claimsRef(ref)) return { url: '', desc: '泉州闽南语频道引用格式错误' }
    const options = { fetchImpl: ctx.fetchImpl || defaultFetch, timeoutMs: ctx.timeoutMs || 12000 }
    try {
      const url = await requestPlayUrl(options)
      const manifest = await requestManifest(url, options)
      return {
        url,
        desc: '泉州闽南语官方直播地址',
        manifestText: manifest,
        manifestUrl: url,
        // CDN 拒绝 curl / Lavf 等客户端标识；所有分片由本机按官网浏览器标识取回。
        upstreamHeaders: () => ({ Referer: PLAYER_PAGE, 'User-Agent': UA }),
        upstreamUrlTransform: raw => officialSegmentUrl(raw, url),
      }
    } catch (error) {
      const reason = ['AbortError', 'TimeoutError'].includes(error?.name)
        ? '请求超时' : (error?.message || '上游请求失败')
      return { url: '', desc: `泉州闽南语取流失败：${reason}` }
    }
  }
  return { resolve }
}

export const resolveChannel = createResolver().resolve
