import { proxyAwareFetch } from '../../utils/systemProxy.js'
import { CHANNELS, CHANNEL_BY_REF, CLOUD_API, ABA_TENANT, ABA_NODE, BAZHONG_CATALOG,
  officialMedia, mediaHeaders, needsProxy, playUrlFromHtml, nmipUrl, bazhongUrl, abaUrl, signAbaUrl, readOfficial, parseJson,
  dfsxContent, dfsxComponent, ziyangUrl, deyangUrl, panzhihuaRequest, panzhihuaUrl } from './protocol.js'

export { CHANNELS }
export const claimsRef = ref => typeof ref === 'string' && CHANNEL_BY_REF.has(ref)
export const buildChannels = () => CHANNELS.map(row => ({ name: row.name, logo: row.logo,
  deferredRef: row.ref, catchup: 'none', opts: ['network-caching=3000'],
  ...(needsProxy(row) ? { proxyHls: true } : { relayHls: true }) }))

export function createResolver({ fetchImpl = proxyAwareFetch, now = Date.now } = {}) {
  // 一台正在播放时几秒就会拉一次清单：目录短缓存、同请求合并，避免把官网当媒体服务器。
  // 缓存只在内存里且键仅来自固定频道表；新建阿坝 CDN 会话时用当前时间生成 60 秒签名。
  const cache = new Map()
  const dispatchCache = new Map()
  async function read(url, options) {
    const key = `${url}|${options.method || 'GET'}|${options.body || ''}|${options.headers?.tenant || ''}`
    const previous = cache.get(key)
    if (previous?.expires > now()) return previous.text
    if (previous?.pending) return previous.pending
    const pending = readOfficial(url, options).catch(error => {
      if (error.message !== '官方网络请求失败') throw error
      return readOfficial(url, options) // 官网偶发连接中断只重试一次；HTTP 拒绝和超时不重试。
    })
    cache.set(key, { pending })
    try {
      const text = await pending
      cache.set(key, { text, expires: now() + 30000 })
      return text
    } catch (error) { cache.delete(key); throw error }
  }
  async function dispatch(raw, channel, options) {
    const previous = dispatchCache.get(channel.ref)
    if (previous?.expires > now()) {
      previous.expires = now() + 10 * 60000
      return previous.url
    }
    if (previous?.pending) return previous.pending
    const pending = (async () => {
      const text = await readOfficial(raw, { ...options, headers: mediaHeaders(raw, channel) })
      if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('官方调度没有返回 HLS 清单')
      const lines = text.split(/\r?\n/).map(line => line.trim())
      const index = lines.findIndex(line => line.startsWith('#EXT-X-STREAM-INF:'))
      const next = index >= 0 ? lines.slice(index + 1).find(line => line && !line.startsWith('#')) : ''
      return next ? officialMedia(new URL(next, raw).href, channel, { asset: true }) : raw
    })()
    dispatchCache.set(channel.ref, { pending })
    try {
      const url = await pending
      // wsTime 是新建会话的准入时间。已有 wsSession 按官网播放器方式保持，不能周期性
      // 换节点/会话：不同会话可能有不同的 TS 时间戳，强换会让播放器停在旧时间线上。
      dispatchCache.set(channel.ref, { url, expires: now() + 10 * 60000 })
      return url
    } catch (error) { dispatchCache.delete(channel.ref); throw error }
  }
  return {
    async resolve(ref, ctx = {}) {
      const channel = CHANNEL_BY_REF.get(ref)
      if (!channel) return { url: '', desc: '四川市州频道引用无效' }
      const options = { fetchImpl: ctx.fetchImpl || fetchImpl, timeoutMs: ctx.timeoutMs ?? 10000 }
      const request = (url, extra = {}) => read(url, { ...options, ...extra })
      const json = async (url, extra = {}) => parseJson(await request(url, extra))
      try {
        let url, cloudConfig
        switch (channel.kind) {
          case 'html': url = playUrlFromHtml(await request(channel.page), channel); break
          case 'nmip': {
            const endpoint = new URL(`/cms/home/content?id=${channel.contentId}`, channel.page).href
            url = nmipUrl(await json(endpoint), channel)
            break
          }
          case 'bazhong': url = bazhongUrl(await json(BAZHONG_CATALOG), channel); break
          case 'dfsx': {
            const fields = dfsxContent(await json(`${channel.apiBase}/v2/contents/${channel.contentId}`), channel)
            url = channel.sourceField === 'link' ? officialMedia(fields.link_url, channel)
              : dfsxComponent(await json(`${channel.apiBase}/components`, { method: 'POST',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lives: [channel.liveId] }) }), channel)
            break
          }
          case 'deyang': url = deyangUrl(await json('https://api.deyangnews.cn/cms-api/broadcast/list?mark=tv'), channel); break
          case 'panzhihua': {
            const config = await json('https://www.pzhxinwen.cn/json/config/site.sitejson')
            url = panzhihuaUrl(await json('https://www.pzhxinwen.cn/rftapi/api/rft/getLiveList', { method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
              body: panzhihuaRequest(config, channel, Math.floor(now() / 30000) * 30000) }), channel)
            break
          }
          case 'ziyang': url = ziyangUrl(await json(`https://appmgr.zyrb.com.cn/tvradio/Tvfront/getTvInfo?tv_id=${channel.contentId}`), channel); break
          case 'cloud': {
            const headers = { tenant: channel.tenant, 'Content-Type': 'application/json' }
            const catalog = await json(`${CLOUD_API}layout/client/nodeClient/node`, { method: 'POST', headers,
              body: JSON.stringify({ nodeId: channel.nodeId }) })
            url = abaUrl(catalog, channel)
            if (channel.signed) {
              cloudConfig = await json(`${CLOUD_API}content/client/unifiedConfiguration/getUnifiedConfiguration`, { headers })
              url = signAbaUrl(url, cloudConfig, channel, now())
            }
            break
          }
          case 'neijiang': {
            const html = await request(channel.page)
            const live = html.match(/<input\b[^>]*id="live_id"[^>]*value="([^"]+)"/i)?.[1]
            const type = html.match(/<input\b[^>]*id="live_type"[^>]*value="(\d+)"/i)?.[1]
            const liveUrl = officialMedia(live, channel)
            if (type !== '107') throw new Error('内江官网播放器类型已变化')
            const endpoint = new URL('/web/video_ajax.php', channel.page)
            endpoint.search = new URLSearchParams({ live_id: liveUrl, live_type: type, aid: '972' }).toString()
            const payload = await json(endpoint.href)
            if (Number(payload?.ret) !== 1 || Number(payload.flag) !== 1) throw new Error('内江官方接口没有直播地址')
            url = officialMedia(payload.content, channel)
            break
          }
          case 'aba': {
            const headers = { tenant: ABA_TENANT, 'Content-Type': 'application/json' }
            const [catalog, config] = await Promise.all([
              json(`${CLOUD_API}layout/client/nodeClient/node`, { method: 'POST', headers, body: JSON.stringify({ nodeId: ABA_NODE }) }),
              json(`${CLOUD_API}content/client/unifiedConfiguration/getUnifiedConfiguration`, { headers }),
            ])
            cloudConfig = config
            url = signAbaUrl(abaUrl(catalog, channel), cloudConfig, channel, now())
            break
          }
          default: throw new Error('未知的官方入口类型')
        }
        let manifestText
        if (channel.id === 'mytv1' || channel.kind === 'aba' || channel.dispatch) {
          const entryUrl = url
          for (let attempt = 0; attempt < 2; attempt++) {
            url = await dispatch(entryUrl, channel, options)
            try {
              manifestText = await readOfficial(url, { ...options, headers: mediaHeaders(url, channel) })
              if (!manifestText.trimStart().startsWith('#EXTM3U')) throw new Error('官方 CDN 未返回 HLS 清单')
              break
            } catch (error) {
              // 官方会话被明确拒绝才重新申请一次；网络抖动不会切掉仍合法的会话。
              if (attempt !== 0 || !/^官方入口 HTTP (?:401|403|404|410)$/.test(error.message)) throw error
              dispatchCache.delete(channel.ref)
            }
          }
        }
        return { url, relayHls: true, desc: `${channel.name}官方直播`,
          ...(manifestText ? { manifestText, manifestUrl: url } : {}),
          upstreamHeaders: raw => mediaHeaders(raw, channel),
          // 全代理兼容订阅也只跟随同台官方资产；不把公共配置送给媒体 CDN。
          upstreamUrlTransform: raw => {
            const value = officialMedia(raw, channel, { asset: true })
            return cloudConfig && new URL(value).hostname === new URL(channel.media).hostname && new URL(value).pathname.endsWith('.m3u8')
              ? signAbaUrl(value, cloudConfig, channel, now()) : value
          } }
      } catch (error) {
        const message = /https?:\/\//.test(error?.message || '') ? '官方服务暂不可用' : error.message
        return { url: '', desc: `${channel.name}取流失败：${message}` }
      }
    },
  }
}

export const resolveChannel = createResolver().resolve
