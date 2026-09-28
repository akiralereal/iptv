/**
 * 陕西广电：陕西网络广播电视台看电视页（live.snrtv.com）的八套电视频道。
 *
 * 官网播放器不在页面里写死地址，而是加载 toutiao.cnwest.com/static/v1/group/stream.js：
 * 里面两串 sTV / sRadio，各取前 16 个字符作 AES-128-CBC 的密钥与 IV，sTV 余下部分
 * base64 解开、去掉零填充，就是 { sxbc: { <频道键>: { name, m3u8, playlist, ... } } } 频道目录。
 * 密钥与 IV 每次下发都不同，只能按这个规则现解，不能抄一份结果。
 *
 * 播放地址是 stream.snrtv.com/sxbc-<频道>-<六位随机串>.m3u8，不带签名，但随机串会换：
 * 2026-09-25 上海凌晨 3 点前后八路全换了新名，旧名当即 404；网上流传的往年旧名也全是 404。
 * 所以地址不能写进播放列表，只能播放时现读目录（几分钟复用一次），清单 404 就立刻重读目录再试。
 *
 * CDN 不看来源头、也不挑播放器标识：Lavf、okhttp、空 UA，带不带 Referer，清单与分片都是
 * 200，分片可以由播放器直连，所以走 relay 而不是 proxy：本机每次轮询自己取清单、交给
 * 代理层改写后下发，分片直连官方 CDN；?relay=2 仍可升级成全代理。媒体主机只有 HTTP
 * （HTTPS 握手失败）。
 *
 * 清单地址带一个每秒一换的查询参数，取不到就换个值重试：这家 CDN 按完整地址把一小部分请求
 * 分到卡住的节点，同一地址次次如此——本机 12 或 24 秒、大陆 Globalping 各地探针 6 秒多才回，
 * 而 L2 回源只要几十毫秒（Via 头可见）。2026-09-25 实测都市青春、移动电视的裸地址就一直卡着，
 * 同一路换 20 个参数值有 2 个卡、其余都是一两百毫秒。清单本来就不缓存（X-Swift-CacheTime: 0），
 * 换参数不给官方多添回源；分片按清单里的相对地址取，不带参数。分片偶尔也会碰上（36 片里 1 片
 * 6 秒），那是播放器直连 CDN 的事，缓冲够就不影响。
 *
 * 换名那次是逐路错开的（02:46 还是旧名，03:05 六路已换、03:07 八路全换）：目录先换成新名，
 * 新名要到 03:10–03:12 才陆续可播，这段时间官网自己也播不了，模块只能如实报失败。
 */
import { createDecipheriv } from 'node:crypto'
import { proxyAwareFetch } from '../../utils/systemProxy.js'
import { CHANNELS } from './channels.js'

export const LIVE_PAGE = 'http://live.snrtv.com/'
export const CATALOG_URL = 'https://toutiao.cnwest.com/static/v1/group/stream.js'

const MEDIA_HOST = 'stream.snrtv.com'
// 目录只决定每路当前的随机串：五分钟重读；接口故障时沿用上次成功的目录一天，
// 随机串真换了会在清单 404 时立即重读，用不着靠缩短周期去追
const CATALOG_POLICY = Object.freeze({ refreshMs: 5 * 60 * 1000, retryMs: 30 * 1000, hardTtlMs: 24 * 60 * 60 * 1000 })
// 清单正常一两百毫秒就回；超过这么久多半是分到了卡住的节点，换个参数值再试，
// 最后一次给足整个超时，真慢也能拿到
const MANIFEST_ATTEMPT_MS = 3000
const MANIFEST_ATTEMPTS = 3
// 目录正常 17 KB 上下，清单不到 1 KB
const MAX_RESPONSE_BYTES = 1024 * 1024
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

export { CHANNELS }

const CHANNEL_BY_REF = new Map(CHANNELS.map(channel => [channel.ref, channel]))

/**
 * 媒体地址白名单：只认 stream.snrtv.com 根目录下的清单与分片。目录里的 m3u8、
 * 本模块取回的清单、?relay=2 全代理登记的每一条分片都经它过一遍。
 */
export function officialAssetUrl(raw) {
  let url
  try {
    url = new URL(String(raw || '').trim())
  } catch {
    throw new Error('陕西广电返回了无效媒体地址')
  }
  const ok = ['http:', 'https:'].includes(url.protocol) && url.hostname === MEDIA_HOST
    && !url.username && !url.password && ['', '80', '443'].includes(url.port) && !url.hash
    && /^\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.(?:m3u8|ts)$/.test(url.pathname)
  if (!ok) throw new Error('陕西广电返回了非官方媒体地址')
  return url.href
}

/** stream.js → 频道键到当前清单地址；只收频道表里的八路，某一路缺地址或地址不合规就跳过。 */
export function decodeCatalog(script) {
  const text = String(script ?? '')
  const tv = /\bvar\s+sTV\s*=\s*"([A-Za-z0-9+/=]+)"/.exec(text)?.[1]
  const radio = /\bvar\s+sRadio\s*=\s*"([A-Za-z0-9+/=]+)"/.exec(text)?.[1]
  if (!tv || !radio || tv.length < 32 || radio.length < 16) throw new Error('陕西广电频道目录格式已变化')

  let data
  try {
    const decipher = createDecipheriv('aes-128-cbc', Buffer.from(tv.slice(0, 16)), Buffer.from(radio.slice(0, 16)))
    decipher.setAutoPadding(false)
    const plain = Buffer.concat([decipher.update(Buffer.from(tv.slice(16), 'base64')), decipher.final()])
    data = JSON.parse(plain.toString('utf8').replace(/\0+$/, ''))
  } catch {
    throw new Error('陕西广电频道目录解密失败')
  }
  const group = data?.sxbc
  if (!group || typeof group !== 'object') throw new Error('陕西广电频道目录里没有电视分组')

  const urls = new Map()
  for (const channel of CHANNELS) {
    const url = group[channel.key]?.m3u8
    if (typeof url !== 'string' || !url) continue
    try {
      const checked = officialAssetUrl(url)
      if (new URL(checked).pathname.endsWith('.m3u8')) urls.set(channel.key, checked)
    } catch {}
  }
  if (!urls.size) throw new Error('陕西广电频道目录里没有可用的电视频道')
  return urls
}

/** 清单请求地址：目录给的地址加秒级时间戳参数，重试时再加序号换一个值（见文件头）。 */
export function manifestRequestUrl(streamUrl, now = Date.now(), attempt = 0) {
  const url = new URL(officialAssetUrl(streamUrl))
  url.search = ''
  url.searchParams.set('_', `${Math.floor(Number(now) / 1000)}${attempt ? `-${attempt}` : ''}`)
  return url.href
}

async function readText(response, label) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error(`陕西广电${label}响应过大`)
  }
  const text = await response.text()
  if (text.length > MAX_RESPONSE_BYTES) throw new Error(`陕西广电${label}响应过大`)
  if (!response.ok) throw new Error(`陕西广电${label} HTTP ${response.status}`)
  return text
}

async function requestText(url, label, headers, { timeoutMs = 15000, fetchImpl = proxyAwareFetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': UA, ...headers },
    })
    return await readText(response, label)
  } finally {
    clearTimeout(timer)
  }
}

// 目录接口实测不校验来源头；照官网页面的样子带上，不给它（加速乐防护）多一个拒绝的理由
const loadCatalog = async options => decodeCatalog(await requestText(CATALOG_URL, '频道目录', {
  Accept: '*/*',
  Referer: LIVE_PAGE,
}, options))

/** 取清单：前几次短超时，超时就换参数值重试；404 等其它失败照实抛给上层去重读目录。 */
async function requestManifest(streamUrl, options, now) {
  for (let attempt = 0; ; attempt++) {
    const last = attempt === MANIFEST_ATTEMPTS - 1
    const url = manifestRequestUrl(streamUrl, now, attempt)
    const timeoutMs = last ? options.timeoutMs : Math.min(MANIFEST_ATTEMPT_MS, options.timeoutMs)
    let text
    try {
      text = await requestText(url, '直播清单', { Accept: '*/*' }, { ...options, timeoutMs })
    } catch (error) {
      if (!last && error?.name === 'AbortError') continue
      throw error
    }
    if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('陕西广电直播清单不是 HLS')
    return { url, text }
  }
}

let catalog = null
let pending = null
let generation = 0

/**
 * 到期才重读；重读失败时在硬期限内沿用上次成功的目录并退避，硬期限过了照实报错。
 * force 是清单失败后的立即重读：距上次成功不到 retryMs 就不再打目录——整台停播时播放器
 * 连环重试，每次都重读只会把加速乐防护下的目录接口越打越狠。
 */
async function catalogUrls(options, now, { force = false } = {}) {
  const hit = catalog
  const backingOff = hit?.retryAt > now && hit?.hardExpiresAt > now
  const fresh = force
    ? hit?.loadedAt > now - CATALOG_POLICY.retryMs || backingOff
    : hit?.refreshAt > now || backingOff
  if (fresh) return hit.urls

  if (!pending) {
    const requestGeneration = generation
    const promise = loadCatalog(options)
      .then(urls => {
        if (requestGeneration === generation) {
          catalog = {
            urls,
            loadedAt: now,
            refreshAt: now + CATALOG_POLICY.refreshMs,
            hardExpiresAt: now + CATALOG_POLICY.hardTtlMs,
            retryAt: 0,
          }
        }
        return urls
      })
      .finally(() => {
        if (pending === promise) pending = null
      })
    pending = promise
  }

  try {
    return await pending
  } catch (error) {
    if (!hit || hit.hardExpiresAt <= now || catalog !== hit) throw error
    hit.retryAt = now + CATALOG_POLICY.retryMs
    return hit.urls
  }
}

async function streamUrlFor(channel, options, now, refresh) {
  const url = (await catalogUrls(options, now, { force: refresh })).get(channel.key)
  if (!url) throw new Error(`${channel.name}当前不在官网直播目录里`)
  return url
}

async function currentManifest(channel, options, now) {
  const streamUrl = await streamUrlFor(channel, options, now, false)
  try {
    return await requestManifest(streamUrl, options, now)
  } catch (error) {
    // 随机串换了：旧名立即 404。立刻重读目录，地址真的变了才再试一次
    const fresh = await streamUrlFor(channel, options, now, true).catch(() => streamUrl)
    if (fresh === streamUrl) throw error
    return requestManifest(fresh, options, now)
  }
}

export function buildChannels() {
  return CHANNELS.map(channel => ({
    name: channel.name,
    deferredRef: channel.ref,
    logo: channel.logo,
    groupTitle: '陕西',
    opts: ['network-caching=3000'],
    catchup: 'none',
  }))
}

export function claimsRef(ref) {
  return CHANNEL_BY_REF.has(String(ref || ''))
}

export async function resolveChannel(ref, ctx = {}) {
  const channel = CHANNEL_BY_REF.get(String(ref || ''))
  if (!channel) return { url: '', desc: '陕西频道引用格式错误' }
  const options = { timeoutMs: ctx.timeoutMs || 15000, fetchImpl: ctx.fetchImpl || proxyAwareFetch }
  try {
    const manifest = await currentManifest(channel, options, Number(ctx.now ?? Date.now()))
    return {
      url: manifest.url,
      desc: `${channel.name}当前直播地址获取成功`,
      // 清单已由本模块取回（带着避开边缘卡顿的参数），代理层直接改写下发，不再自己去取
      manifestText: manifest.text,
      manifestUrl: manifest.url,
      relayHls: true,
      upstreamUrlTransform: officialAssetUrl,
    }
  } catch (error) {
    const reason = error?.name === 'AbortError'
      ? `超时 ${options.timeoutMs}ms`
      : (error?.message || String(error))
    return { url: '', desc: `陕西广电链接请求失败：${reason}` }
  }
}

export function clearCache() {
  generation++
  catalog = null
  pending = null
}
