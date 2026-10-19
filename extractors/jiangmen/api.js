import { proxyAwareFetch } from '../../utils/systemProxy.js'
import { CHANNEL, HEADERS, infoUrl, selectChannel, manifestUrl, segmentUrl, parseManifest, readOfficial, createCache } from './protocol.js'

export const claimsRef = ref => ref === CHANNEL.ref

export function createResolver({ fetchImpl = proxyAwareFetch, now = Date.now } = {}) {
  const loadCatalog = createCache(async () => selectChannel(JSON.parse(
    (await readOfficial(infoUrl(now()), { fetchImpl })).toString('utf8'),
  )), { ttl: 60000, now })
  return {
    loadCatalog,
    async resolveChannel(ref) {
      if (!claimsRef(ref)) return { url: '', desc: '江门频道引用无效' }
      try {
        const meta = await loadCatalog()
        // 每次轮询重算上海日切路径，不把昨天的清单地址缓存到今天。
        const url = manifestUrl(meta, now())
        const manifestText = parseManifest((await readOfficial(url, { fetchImpl })).toString('utf8'), url)
        return { url, manifestText, manifestUrl: url, upstreamHeaders: HEADERS,
          upstreamUrlTransform: raw => segmentUrl(raw, url), desc: '江门综合官方直播' }
      } catch (error) {
        const reason = /^(?:江门|媒体|不是)/.test(error.message) && !/https?:\/\//i.test(error.message)
          ? error.message : '江门官方接口或媒体暂不可用'
        return { url: '', desc: reason }
      }
    },
  }
}

const resolver = createResolver()
export const loadCatalog = resolver.loadCatalog
export const resolveChannel = resolver.resolveChannel
