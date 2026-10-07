/**
 * 海外频道：在大陆常卡顿或连不上、海外播放流畅的免费直播频道，默认关闭，用户自己打开。
 *
 * 频道表是仓库根目录的 IPTV-overseas.m3u（格式同精选列表 IPTV.m3u，维护规则写在文件头）：运行时从仓库拉，
 * GitHub 镜像回退与精选列表同一套，改文件推送即生效、不用发版；远程都拉不到时读镜像里自带的那份。
 * 分工：大陆也播得顺的放 IPTV.m3u，只在海外顺的放这里（OVERSEAS.md）。
 *
 * 频道表里标了 x-top-first="1" 的台（官方主清单把低档排在前面）不直接给地址：播放时本机取一次主清单，
 * 把最高档挪到最前再交给播放器（utils/hlsTopFirst.js），子清单和分片仍由播放器直连，网速不够照常降档。
 * 本机取不到主清单（比如部署在大陆、官方入口在大陆连不上）就 302 回官方原地址，和直连时一样。
 * 官方只公开单档清单的台（France 24）登记在 LADDERS 里，播放时直接拼主清单，不发请求。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { buildMasterPlaylist, topVariantFirst } from '../../utils/hlsTopFirst.js'
import { proxyAwareFetch } from '../../utils/systemProxy.js'

export const PLAYLIST_FILE = 'IPTV-overseas.m3u'
// 设成空（moverseasPlaylistUrl=）就只用镜像自带的那份，便于本地调试与测试
export const PLAYLIST_URL = process.env.moverseasPlaylistUrl !== undefined
  ? process.env.moverseasPlaylistUrl
  : `https://raw.githubusercontent.com/akiralereal/iptv/refs/heads/main/${PLAYLIST_FILE}`
const BUNDLED_PATH = new URL(`../../${PLAYLIST_FILE}`, import.meta.url)
const REF_PREFIX = 'overseas-'
const REF_RE = /^overseas-[a-z0-9][a-z0-9-]{0,54}$/
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const MAX_MASTER_BYTES = 1024 * 1024
// 主清单是播放器起播时取一次的，取不到要尽快退回直连，别让播放器干等
const MASTER_TIMEOUT_MS = 8000

/**
 * 官方只公开了单档清单、没有多档主清单的台：键是频道表里写的那条（最高档）地址，值是从高到低的各档，
 * 播放时拼成主清单交给播放器，不发请求。France 24 各语种都只有 master_5000（1080p）与 master_500（360p）
 * 两条，分片序号、时长对齐，master.m3u8 回 403；英语、法语台在亚洲与国际直播模块，照同样办法拼。
 * 频道表里同样要标 x-top-first；地址换了对不上，就按普通地址处理（取回来不是主清单 → 302 直连）。
 */
const F24_ES = 'https://live.france24.com/hls/live/2037220-b/F24_ES_HI_HLS/'
export const LADDERS = new Map([
  [`${F24_ES}master_5000.m3u8`, [
    { url: `${F24_ES}master_5000.m3u8`, bandwidth: 5600000, resolution: '1920x1080' },
    { url: `${F24_ES}master_500.m3u8`, bandwidth: 760000, resolution: '640x360' },
  ]],
])

// externalSources 在 import 时会读写数据目录里的订阅配置，只在真要抓的时候再加载
const playlistTools = () => import('../../utils/externalSources.js')

/** 读频道表：先仓库（含镜像回退），拉不到用镜像自带的。返回 { channels, from, warnings }。 */
export async function loadChannels({ url = PLAYLIST_URL } = {}) {
  const { fetchAndParseM3u, parsePlaylistContent } = await playlistTools()
  const warnings = []
  if (url) {
    try {
      return { channels: await fetchAndParseM3u(url), from: 'remote', warnings }
    } catch (error) {
      warnings.push(`仓库里的 ${PLAYLIST_FILE} 拉不到，先用镜像自带的：${error.message}`)
    }
  }
  return { channels: parsePlaylistContent(readFileSync(BUNDLED_PATH, 'utf8')), from: 'bundled', warnings }
}

/** 频道的 deferredRef：按台名生成，重启、换地址都不变（用户对这台的隐藏、改名、排序跟着它走）。 */
export function refForName(name) {
  const slug = String(name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return REF_PREFIX + (slug || createHash('sha1').update(String(name)).digest('hex').slice(0, 12))
}

export function claimsRef(ref) {
  return REF_RE.test(String(ref || ''))
}

async function readLimited(response) {
  if (Number(response.headers.get('content-length')) > MAX_MASTER_BYTES) throw new Error('上游响应过大')
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > MAX_MASTER_BYTES) throw new Error('上游响应过大')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

export function createResolver({ fetchImpl = proxyAwareFetch, load = loadChannels } = {}) {
  let catalog = new Map()   // ref -> { name, url }
  let loading = null
  let loadedAt = 0

  function remember(channels) {
    const next = new Map()
    for (const channel of channels) if (channel.topFirst) next.set(refForName(channel.name), channel)
    catalog = next
    loadedAt = Date.now()
  }

  // 重启后磁盘缓存里已经有频道，但这一轮还没跑 fetch：头一次播放时现读一次频道表
  // 已经下架的台被播放器反复请求时，一分钟内不重读频道表
  async function lookup(ref, now = Date.now()) {
    if (!catalog.has(ref) && (loading || now - loadedAt > 60 * 1000)) {
      loading ||= load().then(({ channels }) => remember(channels)).finally(() => { loading = null })
      await loading
    }
    return catalog.get(ref)
  }

  async function resolve(ref, ctx = {}) {
    let channel
    try { channel = claimsRef(ref) ? await lookup(String(ref)) : null } catch { channel = null }
    if (!channel) return { url: '', desc: '海外频道表里没有这个频道，可能已下架' }
    const ladder = LADDERS.get(channel.url)
    if (ladder) {
      return {
        url: ladder[0].url,
        desc: `${channel.name} 主清单已按最高档在前拼好`,
        relayHls: true,
        manifestText: buildMasterPlaylist(ladder),
        manifestUrl: ladder[0].url,
      }
    }
    try {
      const response = await (ctx.fetchImpl || fetchImpl)(channel.url, {
        signal: AbortSignal.timeout(ctx.timeoutMs || MASTER_TIMEOUT_MS),
        headers: { 'User-Agent': UA, Accept: 'application/vnd.apple.mpegurl, */*' },
      })
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {})
        throw new Error(`HTTP ${response.status}`)
      }
      const text = await readLimited(response)
      // 不是主清单（官方换成了单档）就别经本机转发：播放器每次刷新清单都会打到本机
      if (!text.trimStart().startsWith('#EXTM3U') || !text.includes('#EXT-X-STREAM-INF')) throw new Error('不是多档主清单')
      const manifestUrl = response.url || channel.url
      return {
        url: manifestUrl,
        desc: `${channel.name} 主清单已按最高档在前转发`,
        relayHls: true,
        manifestText: topVariantFirst(text),
        manifestUrl,
      }
    } catch (error) {
      // 不带 relayHls：app.js 直接 302 回官方原地址，播放器照旧自己选档
      const reason = ['AbortError', 'TimeoutError'].includes(error?.name) ? '请求超时' : (error?.message || String(error))
      return { url: channel.url, desc: `${channel.name} 主清单本机取不到（${reason}），改由播放器直连` }
    }
  }

  return { resolve, remember }
}

const resolver = createResolver()

export default {
  id: 'overseas',
  name: '海外频道',
  category: 'overseas',
  description: '海外免费直播频道（体育、娱乐时尚、文旅、国际、韩国），并入现有分组。在大陆常卡顿或连不上，默认关闭；视频由播放器直连各平台 CDN，能不能看取决于播放设备的网络。',
  // 播放器直连海外 CDN：能不能看取决于看的人的网络，服务端判断不了，交给用户自己打开
  defaultEnabled: false,
  capabilities: { cache: 'disk', resolve: true, epg: false, catchup: false },
  defaultRefreshMinutes: 360,
  refreshConfigurable: false,
  refreshDescription: '每 6 小时从仓库拉一次 IPTV-overseas.m3u（与精选列表同周期），改了推送即生效；视频由播放器直连各平台 CDN，官方主清单把低档排在前面的几台由本机取一次主清单、把最高档挪到最前。',
  configSchema: [],

  async fetch() {
    const { channels, warnings } = await loadChannels()
    resolver.remember(channels)
    const groups = new Map()
    for (const { name, group, url, logo, opts, topFirst } of channels) {
      if (!groups.has(group)) groups.set(group, { name: group, dataList: [] })
      groups.get(group).dataList.push({
        name,
        // 最高档前置的台写成本机入口（${replace}/overseas-…），播放时由 resolve 转发主清单
        ...(topFirst ? { deferredRef: refForName(name) } : { url }),
        ...(logo ? { logo } : {}),
        ...(opts ? { opts } : {}),
        catchup: 'none',
        // 排到所在分组最后，跟在各台官方频道与精选列表之后（见 channelMerger）
        trailing: true,
      })
    }
    return { groups: [...groups.values()], meta: { skipped: [], warnings } }
  },

  claimsRef,
  resolve: resolver.resolve,
}
