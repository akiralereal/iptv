/**
 * 西藏广播电视台「珠峰云」App：直播页的西藏卫视、藏语卫视、影视文化三路。
 *
 * 取址：App 与官网共用的频道接口 POST api.vtibet.cn/xizangmobileinf/rest/xz/cardgroups，
 * 表单 json={"cardgroups":"LIVECAST"}（藏文界面用 LIVECASTTIBE，卡片与地址完全相同，只是标题
 * 换成藏文）。按固定卡片 ID 取三路 video.url：tv.vtibet.cn/live/<流名>.m3u8?secret=<32 位>&time=<8 位>。
 * 第一张卡片没有 ID，是西藏卫视「正在播出」的节目（标题 + date/enddate），地址与西藏卫视
 * 相同，不当频道收。接口匿名可用，不看 UA；这里照官网页面的样子带上官网 Origin
 * （接口 CORS 放行的正是 www.zhufengyunxz.cn），不给它多一个拒绝的理由。
 *
 * 签名（2026-09-25 实测，CDN 为天翼云）：
 * - time 是签发时刻（Unix 秒的十六进制），不是过期时刻。接口有服务端缓存：拿到的 time
 *   比请求时刻早 1 秒到 4 分多钟不等，所以复用期限按签发时刻算，不按取到的时刻算。
 * - 只有清单验签：去掉 secret、改 secret、单改 time 都是 403。三路签名地址签发一小时后
 *   清单仍是 200（长跑到签发后 60 多分钟都没有一条失效，真实上限没测到）。
 * - 分片不验签：清单里是不带签名的相对路径，裸取（连 ctyun_* 参数都去掉）照样 206。
 * - 清单与分片都不看 Referer / UA：Lavf、okhttp、AppleCoreMedia、VLC、空 UA、站外 Referer 全部放行。
 *
 * 所以走 relay：本机每次轮询取当前签名的清单、把相对分片改成官方绝对地址后下发，分片由播放器
 * 直连 CDN；服务端也能直取分片，`?relay=2` 可以安全升级成全代理。频道表五分钟复用一次
 * （远在有效期之内，只为挡住播放器三秒一次的清单轮询），签名超过 20 分钟也提前重取；
 * 清单万一 403/404 就立即重取频道表再试一次。
 */
import { proxyAwareFetch } from '../../utils/systemProxy.js'

export const CATALOG_API = 'https://api.vtibet.cn/xizangmobileinf/rest/xz/cardgroups'
export const CARD_GROUP = 'LIVECAST'
export const SITE_ORIGIN = 'https://www.zhufengyunxz.cn'

const MEDIA_HOST = 'tv.vtibet.cn'
// 频道表复用时长：挡住清单轮询即可，签名本身能用一小时以上
export const CATALOG_REFRESH_MS = 5 * 60 * 1000
// 按签发时刻算的复用上限：接口可能交回几分钟前生成的地址，签发太久的不等轮换直接重取
export const SIGN_REUSE_MS = 20 * 60 * 1000
// 两次取频道表至少隔这么久：接口哪天总交回很旧的地址，也不至于每次轮询都去打它
const CATALOG_MIN_REFRESH_MS = 30 * 1000
// 接口失败时的退避；退避期内沿用上次的地址
const CATALOG_RETRY_MS = 10 * 1000
// 清单被拒后强制重取的最小间隔：接口若一直交回被拒的地址，别跟着播放器的轮询一起打它
const FORCE_REFRESH_GAP_MS = 10 * 1000
const CATALOG_MAX_BYTES = 256 * 1024
const MANIFEST_MAX_BYTES = 256 * 1024
// 这几种说明地址本身不能用了（签名过期 / 流名轮换），值得重取频道表再试一次
const STALE_URL_STATUSES = new Set([401, 403, 404, 410])
const MEDIA_PATH_RE = /^\/live\/[A-Za-z0-9._-]{1,96}\.(?:m3u8|ts|m4s|aac|key)$/
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

const LOGO_BASE = 'https://pic.vtibet.cn/cms/vrupload/img/'

// cardId 是直播分组里频道卡片的固定 ID，也是分享页 app://<cardId> 那一段；流名不写死，以接口为准。
// App 里标的是「西藏卫视」「藏语卫视」「影视文化」，后两个补「西藏」前缀：离开「西藏」分组也不会
// 和别家的影视、文化频道混，也与常见台标库、节目单源的叫法一致。西藏卫视与央视频模块同名：
// 跨源同台按设计不合并、各自作备份，同名也让两边共用节目单。
// 台标是同一接口里各频道卡片的 photo.thumb（220×160，XZTV 标 + 台名，三路各不相同），去掉了
// 防缓存的 ?r= 参数；频道详情 videolive 的 headpic 是「中国西藏广播电视台」整台台标，分不出频道，不用。
export const CHANNELS = Object.freeze([
  Object.freeze({
    ref: 'xizang-satellite', name: '西藏卫视', cardId: 'OlyL20211012170000000CH00000029',
    logo: `${LOGO_BASE}2021/10/15/1634292405536_979_220x160.png`,
  }),
  Object.freeze({
    ref: 'xizang-tibetan', name: '西藏藏语卫视', cardId: 'OlyL20211126142400000CH00000012',
    logo: `${LOGO_BASE}2021/11/26/1637908504567_224_220x160.jpg`,
  }),
  Object.freeze({
    ref: 'xizang-film-culture', name: '西藏影视文化', cardId: 'OlyL20211012175000000CH00000031',
    logo: `${LOGO_BASE}2021/10/15/1634292378543_831_220x160.png`,
  }),
])

const CHANNEL_BY_REF = new Map(CHANNELS.map(channel => [channel.ref, channel]))

/** 清单、分片只允许落在官方 CDN 的直播目录；relay 下分片由播放器直连用不到，`?relay=2` 全代理登记前经它过一遍。 */
export function officialAssetUrl(raw) {
  let url
  try {
    url = new URL(String(raw || '').trim())
  } catch {
    throw new Error('西藏广电返回了无效媒体地址')
  }
  if (url.protocol !== 'https:' || url.hostname !== MEDIA_HOST || url.username || url.password
      || !['', '443'].includes(url.port) || url.hash || !MEDIA_PATH_RE.test(url.pathname)) {
    throw new Error('西藏广电返回了非官方媒体地址')
  }
  return url.href
}

/** 频道卡片里的播放地址：直播目录下的 .m3u8，带齐 32 位 secret 与 8 位十六进制签发时刻。 */
export function signedLiveUrl(raw) {
  const url = new URL(officialAssetUrl(raw))
  const time = url.searchParams.get('time') || ''
  if (!url.pathname.endsWith('.m3u8') || !/^[a-f0-9]{32}$/i.test(url.searchParams.get('secret') || '')
      || !/^[a-f0-9]{8}$/i.test(time)) {
    throw new Error('西藏广电播放地址缺少有效签名')
  }
  return { url: url.href, issuedAt: parseInt(time, 16) * 1000 }
}

function parseJson(payload) {
  if (typeof payload !== 'string') return payload
  try {
    return JSON.parse(payload)
  } catch {
    throw new Error('珠峰云频道接口没有返回有效 JSON')
  }
}

/**
 * 按卡片 ID 逐路取地址；单路缺失或地址异常只影响这一路。
 * 返回 { urls: Map<ref, url>, issuedAt }，issuedAt 取几路里最早的签发时刻。
 */
export function parseCatalog(payload) {
  const data = parseJson(payload)
  if (data?.succeed !== 1 || data?.error_code !== 0 || !Array.isArray(data?.cardgroups)) {
    throw new Error('珠峰云频道接口返回失败或格式变化')
  }
  const cards = data.cardgroups.flatMap(group => (Array.isArray(group?.cards) ? group.cards : []))
  const urls = new Map()
  let issuedAt = Infinity
  for (const channel of CHANNELS) {
    const matches = cards.filter(card => card?.id === channel.cardId)
    if (matches.length !== 1 || typeof matches[0]?.video?.url !== 'string') continue
    try {
      const signed = signedLiveUrl(matches[0].video.url)
      urls.set(channel.ref, signed.url)
      issuedAt = Math.min(issuedAt, signed.issuedAt)
    } catch {}
  }
  if (!urls.size) throw new Error('珠峰云频道接口里没有找到任何有效频道')
  return { urls, issuedAt }
}

async function discard(response) {
  response.body?.destroy?.()
  await response.body?.cancel?.().catch(() => {})
}

async function readCapped(response, maxBytes, label) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discard(response)
    throw new Error(`西藏广电${label}响应过大`)
  }
  if (!response.body) return ''
  const chunks = []
  let total = 0
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk)
    total += bytes.length
    if (total > maxBytes) {
      await discard(response)
      throw new Error(`西藏广电${label}响应过大`)
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

export async function requestCatalog({ timeoutMs = 12000, fetchImpl = proxyAwareFetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(CATALOG_API, {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Origin: SITE_ORIGIN,
        Referer: `${SITE_ORIGIN}/`,
        'User-Agent': UA,
      },
      body: new URLSearchParams({ json: JSON.stringify({ cardgroups: CARD_GROUP }) }).toString(),
    })
    if (!response.ok) {
      await discard(response)
      throw new Error(`珠峰云频道接口 HTTP ${response.status}`)
    }
    return parseCatalog(await readCapped(response, CATALOG_MAX_BYTES, '频道接口'))
  } finally {
    clearTimeout(timer)
  }
}

/** 清单里的每条引用都必须落在官方直播目录（相对路径按清单地址解析）。 */
export function validateManifest(text, baseUrl) {
  const body = String(text || '').replace(/^\uFEFF/, '')
  if (!body.trimStart().startsWith('#EXTM3U')) throw new Error('西藏广电上游不是 HLS 清单')
  for (const line of body.split(/\r?\n/)) {
    const value = line.trim()
    if (!value) continue
    if (value.startsWith('#')) {
      for (const match of value.matchAll(/URI="([^"]+)"/g)) officialAssetUrl(new URL(match[1], baseUrl).href)
    } else {
      officialAssetUrl(new URL(value, baseUrl).href)
    }
  }
  return body
}

async function requestManifest(url, { timeoutMs = 12000, fetchImpl = proxyAwareFetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': UA },
    })
    if (!response.ok) {
      await discard(response)
      throw Object.assign(new Error(`西藏广电直播清单 HTTP ${response.status}`), { status: response.status })
    }
    return validateManifest(await readCapped(response, MANIFEST_MAX_BYTES, '直播清单'), url)
  } finally {
    clearTimeout(timer)
  }
}

let catalog = null   // { urls, refreshAt, retryAt, expiresAt }
let pending = null
let lastForcedAt = -Infinity

/**
 * 频道表：到期或签发太久才重取，并发请求共用一次；接口故障时在签名有效期内沿用上次的
 * 地址并退避。force 用于清单被拒之后——手上的地址已知不能用，重取失败就照实报错。
 */
async function currentCatalog(options, now, force = false) {
  const hit = catalog
  if (!force && hit && (hit.refreshAt > now || (hit.retryAt > now && hit.expiresAt > now))) return hit
  if (!pending) {
    const promise = requestCatalog(options)
      .then(({ urls, issuedAt }) => {
        const next = {
          urls,
          refreshAt: Math.max(now + CATALOG_MIN_REFRESH_MS, Math.min(now + CATALOG_REFRESH_MS, issuedAt + SIGN_REUSE_MS)),
          retryAt: 0,
          // 签名一小时以上仍有效；接口故障时最多沿用到签发后 SIGN_REUSE_MS 的三倍
          expiresAt: issuedAt + 3 * SIGN_REUSE_MS,
        }
        catalog = next
        return next
      })
      .finally(() => {
        if (pending === promise) pending = null
      })
    pending = promise
  }
  const active = pending
  try {
    return await active
  } catch (error) {
    if (force || !hit || hit.expiresAt <= now) throw error
    hit.retryAt = now + CATALOG_RETRY_MS
    return hit
  }
}

export function buildChannels() {
  return CHANNELS.map(channel => ({
    name: channel.name,
    deferredRef: channel.ref,
    logo: channel.logo,
    groupTitle: '西藏',
    opts: ['network-caching=3000'],
    catchup: 'none',
  }))
}

export function claimsRef(ref) {
  return CHANNEL_BY_REF.has(String(ref || ''))
}

export async function resolveChannel(ref, ctx = {}) {
  const channel = CHANNEL_BY_REF.get(String(ref || ''))
  if (!channel) return { url: '', desc: '西藏频道引用格式错误' }
  const options = { timeoutMs: ctx.timeoutMs || 12000, fetchImpl: ctx.fetchImpl || proxyAwareFetch }
  const now = Number(ctx.now ?? Date.now())
  try {
    let url = (await currentCatalog(options, now)).urls.get(channel.ref)
    if (!url) throw new Error(`${channel.name}当前不在珠峰云直播列表中`)
    let manifestText
    try {
      manifestText = await requestManifest(url, options)
    } catch (error) {
      if (!STALE_URL_STATUSES.has(error?.status) || lastForcedAt + FORCE_REFRESH_GAP_MS > now) throw error
      // 签名过期或流名轮换：立即重取频道表，换新地址再试一次
      lastForcedAt = now
      url = (await currentCatalog(options, now, true)).urls.get(channel.ref)
      if (!url) throw new Error(`${channel.name}当前不在珠峰云直播列表中`)
      manifestText = await requestManifest(url, options)
    }
    return {
      url,
      desc: `${channel.name}当前直播地址获取成功`,
      // 旧的无后缀入口也直出清单：302 给出去的是短效签名地址
      relayHls: true,
      manifestText,
      manifestUrl: url,
      upstreamUrlTransform: officialAssetUrl,
    }
  } catch (error) {
    const reason = error?.name === 'AbortError'
      ? `超时 ${options.timeoutMs}ms`
      : (error?.message || String(error))
    return { url: '', desc: `西藏广电链接请求失败：${reason}` }
  }
}

export function clearCache() {
  catalog = null
  pending = null
  lastForcedAt = -Infinity
}
