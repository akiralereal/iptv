import { CHANNEL_BY_REF } from './channels.js'
import { requestPlayUrls, selectWorkingManifest, UPSTREAM_HEADERS } from './api.js'
import { FILLER_PATH, LIBVLC_UA, libvlcPlaylist } from './libvlc-view.js'

/**
 * 只缓存官方主备入口，绝不把清单正文按取票 TTL 缓存。
 *
 * 直播媒体清单里只有 3 个分片、每 3 秒滚动一次，缓存正文等于让播放器在整个 TTL 内
 * 反复拿到同一批分片：播完这十几秒就没有下一片，画面直接卡死，且那批分片早已被
 * CDN 回收，重取只会 403。每次解析都实时取清单，并直接交给代理层下发，
 * 避免「选线探测成功后立即再取一次」触发 CDN 403。只合并同频道正在进行的请求。
 *
 * 5 分钟远短于接口自报的 vkey_renew_interval（实测 14400 秒）；但 CDN 仍可能
 * 提前拒绝旧地址，因此每次取清单都能换备用入口，全部失败时提前换票。
 * 相比原先 20 秒又把取票请求降到 1/15，60 路同放也不会打爆官方接口。
 */
export const CACHE_MS = 5 * 60 * 1000

/**
 * 换票后主备 CDN 仍全部 403 = 本机出口正被官方限流。此后该频道 30 秒内直接回失败、
 * 不再打官方：播放器失败后是毫秒级连环重试，每次重试在这里要打 6~8 枪（缓存入口 +
 * 两轮换票 × 主备），只会把限流越拖越久。
 *
 * 30 秒取自共享实例的真实日志（两天 1487 次 403）：同频道相邻两次失败 54% 间隔不到
 * 1 秒，30~60 秒的只占 1%。按日志回放，冷却 5/15/30/60/120 秒分别挡掉 54/59/65/65/66%
 * 的上游请求——30 秒之后再加长几乎不再多挡，只会让官方恢复后观众白等。
 * 只认「全部 403」：超时、版权停播等失败照旧每次实打，不因一次抖动封掉一个台。
 */
export const FORBIDDEN_COOLDOWN_MS = 30 * 1000

/**
 * 同一媒体序号只下发第一次见到的分片地址（issue #142 / #143）。
 *
 * 同一入口短间隔重取清单官方会回 403，这里随即换备用入口；换票也会换主机和路径令牌。
 * 于是相邻两次刷新里同一序号的分片地址常常不同（实测 2.5 秒一刷，一个序号先后出现
 * 5 个主机）。各节点同序号分片字节完全一致，但 hls.js 1.6+（levelParsingError）和
 * AVPlayer（-12312 Media Entry URL not match previous playlist）都逐片比对新旧清单，
 * 对不上就不再接纳新清单：约 10 秒后卡住，几次之后整条报错停播。实测同一实例同一台，
 * AVPlayer 原样下发 4 分钟卡 5 次后停播，固定地址后零卡顿。
 *
 * 只在文件名相同时沿用旧地址（文件名是「流 ID-序号」），文件名变了说明换了一路流，
 * 以新地址为准。旧地址照样能取：令牌 4 小时有效，窗口内的分片各节点都在。
 * 当前窗口前后 PIN_MARGIN 个序号以外的记录随即剪掉，序号重置也不会串到旧地址。
 */
export const PIN_MARGIN = 30

const fileName = url => new URL(url).pathname.split('/').pop()

export function pinSegmentUrls(text, baseUrl, pins) {
  const body = String(text).replace(/\r/g, '')
  const first = Number(body.match(/^#EXT-X-MEDIA-SEQUENCE:\s*(\d+)/m)?.[1] || 0)
  let seq = first
  const pinned = body.split('\n').map(line => {
    const value = line.trim()
    if (!value || value.startsWith('#')) return line
    const current = seq++
    let url
    try { url = new URL(value, baseUrl).href } catch { return line }
    const previous = pins.get(current)
    if (previous && fileName(previous) === fileName(url)) return previous
    pins.set(current, url)
    return url
  })
  for (const key of pins.keys()) {
    if (key < first - PIN_MARGIN || key >= seq + PIN_MARGIN) pins.delete(key)
  }
  return pinned.join('\n')
}

export function createResolver({ request = requestPlayUrls, select = selectWorkingManifest } = {}) {
  const cache = new Map()
  const pending = new Map()
  const cooling = new Map()
  const pins = new Map()

  function remember(ref, urls, manifest, expiresAt) {
    // 保存取票接口给的入口；CDN 重定向后的临时媒体地址可能很快失效，不能
    // 将它作为未来 5 分钟唯一的取流地址。成功的主/备入口优先尝试。
    const preferred = urls.includes(manifest.sourceUrl) ? manifest.sourceUrl : urls[0]
    cache.set(ref, {
      url: manifest.url,
      urls: [...new Set([preferred, ...urls])],
      expiresAt,
    })
  }

  async function acquire(ref, channel, ctx) {
    let current = pending.get(ref)
    if (current) return current
    current = (async () => {
      let lastError
      const cached = cache.get(ref)
      if (cached && Number(ctx.now ?? Date.now()) < cached.expiresAt) {
        try {
          const manifest = await select(cached.urls, ctx)
          remember(ref, cached.urls, manifest, cached.expiresAt)
          return manifest
        } catch (error) {
          lastError = error
          cache.delete(ref)
        }
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { urls } = await request(channel, ctx)
          const manifest = await select(urls, ctx)
          remember(ref, urls, manifest, Number(ctx.now ?? Date.now()) + CACHE_MS)
          return manifest
        } catch (error) {
          lastError = error
        }
      }
      throw lastError
    })().finally(() => {
      if (pending.get(ref) === current) pending.delete(ref)
    })
    pending.set(ref, current)
    return current
  }

  async function resolve(ref, ctx = {}) {
    const key = String(ref || '')
    const channel = CHANNEL_BY_REF.get(key)
    if (!channel) return { url: '', desc: '央视频频道引用格式错误' }
    const now = Number(ctx.now ?? Date.now())
    const cooled = cooling.get(key)
    if (cooled && now < cooled.until) {
      const seconds = Math.ceil((cooled.until - now) / 1000)
      return { url: '', desc: `${channel.name}链接请求失败：官方 CDN 刚回 403（疑似限流），冷却中，${seconds} 秒后再向官方请求` }
    }
    cooling.delete(key)
    try {
      const manifest = await acquire(key, channel, ctx)
      if (!pins.has(key)) pins.set(key, new Map())
      const text = pinSegmentUrls(manifest.text, manifest.url, pins.get(key))
      // libVLC 另拿一份清单视图（见 libvlc-view.js）。垫片由本机提供，所以只在外壳给了
      // selfBase（清单直出）时才换；改写不了的清单 libvlcPlaylist 回 null，照旧下发原样。
      const forLibvlc = ctx.selfBase && LIBVLC_UA.test(String(ctx.client?.ua || ''))
      // 只返回本次请求刚取回的正文；缓存条目里没有正文，下次轮询会重新拉取。
      return {
        url: manifest.url,
        manifestText: (forLibvlc && libvlcPlaylist(text, `${ctx.selfBase}${FILLER_PATH}`)) || text,
        manifestUrl: manifest.url,
        upstreamHeaders: UPSTREAM_HEADERS,
        desc: `${channel.name} H.264 播放地址获取成功`,
      }
    } catch (error) {
      // AbortError 的原生文案是英文的 This operation was aborted，直接抛进日志没人看得懂
      const reason = error?.name === 'AbortError' ? '请求超时' : (error?.message || String(error))
      if (error?.allForbidden) {
        cooling.set(key, { until: now + FORBIDDEN_COOLDOWN_MS })
        return { url: '', desc: `${channel.name}链接请求失败：${reason}，${FORBIDDEN_COOLDOWN_MS / 1000} 秒内暂停向官方请求` }
      }
      return { url: '', desc: `${channel.name}链接请求失败：${reason}` }
    }
  }

  function clear() {
    cache.clear()
    pending.clear()
    cooling.clear()
    pins.clear()
  }

  return { resolve, clear, cache, pending, cooling, pins }
}

const resolver = createResolver()
export const resolveChannel = resolver.resolve
export const clearCache = resolver.clear
