/**
 * GOOD TV（好消息电视台）官网：两路固定公开 HLS，两条官方线路择优。
 *
 * 地址是官网播放页写死的，没有签名也没有 Referer 门。官网播放器给大陆观众备了两条线路
 * （页面配置里的 cnSignal1 / cnSignal2）：CloudFront 与 Akamai。两条线路回的是同一个源站，
 * 路径结构、分片序号完全一致，中途换线不需要重新对齐（issue #130）。
 *
 * 两条线路的门不一样：CloudFront 的 WAF 按 User-Agent 放行，浏览器 / VLC / ExoPlayer /
 * AppleCoreMedia 都过，ffmpeg 的 Lavf 和 okhttp 一律 403；Akamai 不挑。播放器用什么 UA
 * 不是本项目能决定的，而线路随时会换，所以清单和分片统一走本机全代理——代理层回源时用的是
 * 自己那个 Chrome UA，实测两条线路的清单与 .ts 均 200。
 *
 * 官网还有一条台湾线路 live.streamingfast.net，大陆 DNS 污染（解析到不相干的地址、TCP 连不上），
 * 放进来只会拖慢竞速，不收。
 *
 * 走 deferredRef + resolve 而不是直链，是因为只有 resolve() 能选线，并返回
 * upstreamHeaders / upstreamUrlTransform，把回源锁在官方分发目录内。
 */
import { proxyAwareFetch } from '../../utils/systemProxy.js'
import { CHANNELS } from './channels.js'

export { CHANNELS }

export const GOODTV_ORIGIN = 'https://www.goodtv.tv'

export const MEDIA_HOSTS = Object.freeze([
  'dqhxk7sbp7xog.cloudfront.net',
  'akamai-live.akamaized.net',
])
// 清单在 /hls-live/goodtv/...，分片用 ../../../../ 回到 /hls-live/streams/...，同属一个前缀
const MEDIA_PATH_PREFIX = '/hls-live/'

// 档位后缀：3 = 1920×1080 / 4 Mbps，2 = 1280×720 / 2 Mbps，均为 H.264 Main + AAC-LC。
// 1080p 只列在台湾线路的主清单里，这两条线路的主清单没列，但同名清单实测都在。
// 没列就可能哪天撤掉，所以整档取不到时退回主清单里列了的 720p，而不是直接报错。
const RENDITIONS = Object.freeze([3, 2])

export const LINE_TTL_MS = 60 * 1000
// 两条线路全挂时播放器会连环重试（AptvPlayer 1 秒 9 次），每次都竞速等于一秒打几十个请求
export const FAIL_RETRY_MS = 2 * 1000
const REQUEST_TIMEOUT_MS = 5000
const MAX_MANIFEST_CHARS = 512 * 1024

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const CHANNEL_BY_REF = new Map(CHANNELS.map(channel => [channel.ref, channel]))

/** 按档位分层的候选清单地址：同层两条线路竞速，整层失败才降档。 */
export function candidateTiers(channel) {
  return RENDITIONS.map(rendition => MEDIA_HOSTS.map(host =>
    `https://${host}/hls-live/goodtv/_definst_/liveevent/${channel.stream}-${rendition}.m3u8`))
}

/** 全代理登记清单与分片前统一校验；分片是 ../ 相对路径，解析后仍必须落在官方目录下。 */
export function officialAssetUrl(raw) {
  let url
  try {
    url = new URL(String(raw || '').trim())
  } catch {
    throw new Error('GOOD TV 返回了无效媒体地址')
  }
  if (url.protocol !== 'https:' || url.username || url.password || !['', '443'].includes(url.port)
      || !MEDIA_HOSTS.includes(url.hostname) || !url.pathname.startsWith(MEDIA_PATH_PREFIX)
      || /%2f|%5c/i.test(url.pathname) || url.hash) {
    throw new Error('GOOD TV 返回了非官方媒体地址')
  }
  return url.href
}

/**
 * 本机代取清单或分片时补齐的请求头。
 *
 * Referer 并不是这家的门（实测缺了照样 200），跟着官网播放器发一份而已；
 * 真正决定放行的 User-Agent 由代理层统一给出，这里声明也不会生效。
 */
export function upstreamHeadersFor(raw) {
  officialAssetUrl(raw)
  return { Referer: `${GOODTV_ORIGIN}/` }
}

export function buildChannels() {
  return CHANNELS.map(channel => ({
    name: channel.name,
    deferredRef: channel.ref,
    logo: channel.logo,
    groupTitle: '台湾',
    opts: ['network-caching=3000'],
    catchup: 'none',
  }))
}

export function claimsRef(ref) {
  return CHANNEL_BY_REF.has(String(ref || ''))
}

/** 只认带分片、且分片全部落在官方目录内的媒体清单；空壳或被劫持的 200 不算这条线路活着。 */
export function validateManifest(text, baseUrl) {
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('不是 HLS 清单')
  let segments = 0
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim()
    if (!value || value.startsWith('#')) continue
    officialAssetUrl(new URL(value, baseUrl).href)
    segments++
  }
  if (!segments || !text.includes('#EXTINF:')) throw new Error('清单里没有直播分片')
  return text
}

async function requestManifest(raw, { fetchImpl = proxyAwareFetch, timeoutMs = REQUEST_TIMEOUT_MS, signal } = {}) {
  const url = officialAssetUrl(raw)
  const host = new URL(url).hostname
  const timeout = AbortSignal.timeout(timeoutMs)
  try {
    const response = await fetchImpl(url, {
      // 两条线路都不跳转；真跳了也不跟，免得被带出白名单
      redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: {
        'User-Agent': UA,
        Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, */*',
        Referer: `${GOODTV_ORIGIN}/`,
      },
    })
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {})
      throw new Error(`HTTP ${response.status}`)
    }
    const text = await response.text()
    if (text.length > MAX_MANIFEST_CHARS) throw new Error('响应过大')
    return { text: validateManifest(text, url), url }
  } catch (error) {
    const reason = ['AbortError', 'TimeoutError'].includes(error?.name) ? '超时' : (error?.message || String(error))
    throw new Error(`${host} ${reason}`)
  }
}

async function raceLines(channel, options) {
  const details = []
  for (const tier of candidateTiers(channel)) {
    const race = new AbortController()
    try {
      return await Promise.any(tier.map(url => requestManifest(url, { ...options, signal: race.signal })))
    } catch (error) {
      for (const item of error?.errors || [error]) details.push(item?.message || String(item))
    } finally {
      // 胜出后掐掉落败那条还没回来的请求
      race.abort()
    }
  }
  throw new Error(`官方线路均不可用：${[...new Set(details)].join('；')}`)
}

export function createResolver({ fetchImpl: defaultFetch = proxyAwareFetch } = {}) {
  const lines = new Map()      // ref -> { url, expiresAt }
  const pending = new Map()    // ref -> 进行中的竞速，同台并发的轮询共用一次
  const failures = new Map()   // ref -> { error, until }

  function selectLine(channel, options, now) {
    const failed = failures.get(channel.ref)
    if (failed && failed.until > now()) return Promise.reject(failed.error)

    let active = pending.get(channel.ref)
    if (!active) {
      active = raceLines(channel, options).then(manifest => {
        failures.delete(channel.ref)
        lines.set(channel.ref, { url: manifest.url, expiresAt: now() + LINE_TTL_MS })
        return manifest
      }, error => {
        lines.delete(channel.ref)
        failures.set(channel.ref, { error, until: now() + FAIL_RETRY_MS })
        throw error
      }).finally(() => {
        if (pending.get(channel.ref) === active) pending.delete(channel.ref)
      })
      pending.set(channel.ref, active)
    }
    return active
  }

  /**
   * 每次轮询都由模块自己把清单取回来交给代理层，而不是只给地址让代理层去取：
   * 这样当前线路一出错就能在同一次轮询里当场竞速换线，不必等线路缓存过期，
   * 平时也不比原来多打一个请求。缓存到期的那次轮询改为两线竞速，顺带重新择优、
   * 以及在降到 720p 之后回到 1080p。
   */
  async function resolve(ref, ctx = {}) {
    const channel = CHANNEL_BY_REF.get(String(ref || ''))
    if (!channel) return { url: '', desc: 'GOOD TV 频道引用格式错误' }
    const options = { fetchImpl: ctx.fetchImpl || defaultFetch, timeoutMs: ctx.timeoutMs || REQUEST_TIMEOUT_MS }
    const now = () => Number(ctx.now ?? Date.now())
    try {
      let manifest = null
      const line = lines.get(channel.ref)
      if (line && line.expiresAt > now()) manifest = await requestManifest(line.url, options).catch(() => null)
      if (!manifest) manifest = await selectLine(channel, options, now)
      return {
        url: manifest.url,
        desc: `${channel.name}官方直播地址`,
        manifestText: manifest.text,
        manifestUrl: manifest.url,
        upstreamHeaders: upstreamHeadersFor,
        upstreamUrlTransform: officialAssetUrl,
      }
    } catch (error) {
      return { url: '', desc: `${channel.name}链接请求失败：${error?.message || error}` }
    }
  }

  return { resolve, lines }
}

export const resolveChannel = createResolver().resolve
