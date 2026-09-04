import fetch from 'node-fetch'

import { sourceFromRef } from './channels.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const STREAM_URL_TTL_MS = 45 * 1000

function endpointAllowed(url, rules) {
  return rules.some(rule => {
    if (typeof rule === 'string' || rule instanceof RegExp) {
      const hostMatches = typeof rule === 'string' ? url.hostname === rule : rule.test(url.hostname)
      return url.protocol === 'https:' && !url.port && hostMatches
    }
    const hostMatches = typeof rule?.hostname === 'string'
      ? url.hostname === rule.hostname
      : rule?.hostname instanceof RegExp && rule.hostname.test(url.hostname)
    return hostMatches && url.protocol === (rule.protocol || 'https:') && url.port === (rule.port || '')
  })
}

export function allowUrl(raw, rules) {
  const url = new URL(raw)
  if (url.username || url.password || !endpointAllowed(url, rules)) {
    throw new Error(`不允许访问媒体地址：${url.protocol}//${url.host}`)
  }
  return url.href
}

async function discard(response) {
  response.body?.destroy?.()
  await response.body?.cancel?.().catch(() => {})
}

export async function fetchText(raw, {
  rules,
  fetchImpl = fetch,
  timeoutMs = 15_000,
  method = 'GET',
  body,
  headers = {},
}) {
  let url = allowUrl(raw, rules)
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetchImpl(url, {
      method,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': UA, ...headers },
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      await discard(response)
      if (method !== 'GET' || !location) throw new Error('上游返回了不安全的重定向')
      url = allowUrl(new URL(location, url).href, rules)
      continue
    }
    if (!response.ok) {
      await discard(response)
      throw new Error(`${new URL(url).hostname} HTTP ${response.status}`)
    }
    const text = await response.text()
    if (text.length > 2 * 1024 * 1024) throw new Error('上游响应过大')
    return { text, url, headers: response.headers }
  }
  throw new Error('上游重定向次数过多')
}

function hlsRefs(text, base) {
  const refs = []
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const value = line.trim()
    if (!value) continue
    if (value.startsWith('#')) {
      for (const match of value.matchAll(/URI="([^"]+)"/g)) refs.push(new URL(match[1], base).href)
    } else {
      refs.push(new URL(value, base).href)
    }
  }
  return refs
}

export function validateHls(text, base, rules) {
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('上游不是 HLS 清单')
  for (const ref of hlsRefs(text, base)) allowUrl(ref, rules)
  return text
}

export function parseYtn(text) {
  const match = /\bvar\s+liveUrl\s*=\s*(\{[^;]+\})\s*;?/.exec(text)
  const data = match && JSON.parse(match[1])
  if (!data?.hls || !['true', true, '1', 1].includes(data.live)) throw new Error('YTN News 当前没有直播')
  return data.hls
}

export function parseTvb(body) {
  if (body?.code !== 200 || body?.data?.geo_blocked || body?.data?.stream_type === 'audio' || !body?.data?.stream_url) {
    throw new Error('TVB 当前地区没有可用视频直播')
  }
  return body.data.stream_url
}

export function parseNasaLive(items, now = Date.now()) {
  if (!Array.isArray(items)) throw new Error('NASA+ 直播日程格式错误')
  const current = Math.floor(now / 1000)
  const event = items.find(item => {
    const start = Number(item?.meta?.first_aired_date)
    const end = Number(item?.meta?.end_aired_date)
    const stream = item?.meta?.['video-url']
    return Number.isFinite(start) && Number.isFinite(end) && start <= current && current <= end
      && typeof stream === 'string' && stream.length > 0
  })
  if (!event) throw new Error('NASA+ 当前没有正在进行的官方直播活动')
  return event.meta['video-url']
}

async function dynamicStreamUrl(source, options) {
  const common = { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs }
  if (source.kind === 'tvb') {
    const result = await fetchText('https://news.tvb.com/app/public/live/stream/C', {
      ...common,
      rules: ['news.tvb.com'],
      method: 'POST',
      body: '{}',
      headers: { Referer: source.page, Origin: new URL(source.page).origin, 'Content-Type': 'application/json' },
    })
    return parseTvb(JSON.parse(result.text))
  }
  if (source.kind === 'ytn') {
    const result = await fetchText(`https://www.ytn.co.kr/_hd/cdnurl.js?_=${options.now ?? Date.now()}`, {
      ...common,
      rules: ['www.ytn.co.kr'],
      headers: { Referer: 'https://m.ytn.co.kr/', 'Cache-Control': 'no-cache' },
    })
    return parseYtn(result.text)
  }
  if (source.kind === 'nhk') {
    const result = await fetchText('https://livepl.nhkworld.jp/hlslive_web.json', {
      ...common,
      rules: ['livepl.nhkworld.jp'],
      headers: { Referer: source.page },
    })
    const url = JSON.parse(result.text)?.main?.jstrm
    if (typeof url !== 'string' || !url) throw new Error('NHK 当前没有直播')
    return url
  }
  if (source.kind === 'nasa') {
    const result = await fetchText('https://plus.nasa.gov/wp-json/wp/v2/scheduled_video?per_page=20&orderby=date&order=desc&_fields=link,title,meta', {
      ...common,
      rules: ['plus.nasa.gov'],
      headers: { Referer: source.page },
    })
    return parseNasaLive(JSON.parse(result.text), options.now)
  }
  throw new Error(`${source.name} 缺少播放地址解析器`)
}

function responseCookies(headers) {
  if (typeof headers?.raw === 'function') return headers.raw()['set-cookie'] || []
  if (typeof headers?.getSetCookie === 'function') return headers.getSetCookie()
  const one = headers?.get?.('set-cookie')
  return one ? [one] : []
}

function sameHostCookie(headers, manifestUrl, rules) {
  const origin = new URL(manifestUrl)
  // 主机边界不唯一时不能把一个 CDN 的 Cookie 透传给另一个 CDN。
  if (rules.length !== 1 || typeof rules[0] !== 'string' || rules[0] !== origin.hostname) return ''
  return responseCookies(headers).map(line => {
    const pair = line.split(';', 1)[0]?.trim()
    return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+=[^;\r\n]*$/.test(pair) ? pair : ''
  }).filter(Boolean).join('; ')
}

export function createResolver({ fetchImpl = fetch } = {}) {
  const streamCache = new Map()
  const pending = new Map()
  let generation = 0

  async function streamUrlFor(source, options) {
    if (source.streamUrl) return allowUrl(source.streamUrl, source.rules)
    const now = Number(options.now ?? Date.now())
    const cached = streamCache.get(source.id)
    if (cached?.expiresAt > now && cached.fetchImpl === options.fetchImpl) return cached.url
    let task = pending.get(source.id)
    if (!task) {
      const startedInGeneration = generation
      task = dynamicStreamUrl(source, options).then(raw => {
        const url = allowUrl(raw, source.rules)
        if (generation === startedInGeneration) {
          streamCache.set(source.id, { url, expiresAt: now + STREAM_URL_TTL_MS, fetchImpl: options.fetchImpl })
        }
        return url
      }).finally(() => {
        if (pending.get(source.id) === task) pending.delete(source.id)
      })
      pending.set(source.id, task)
    }
    return task
  }

  async function resolve(ref, ctx = {}) {
    const source = sourceFromRef(ref)
    if (!source) return { url: '', desc: '亚洲与国际直播频道引用格式错误' }
    const request = {
      fetchImpl: ctx.fetchImpl || fetchImpl,
      timeoutMs: ctx.timeoutMs || 15_000,
      now: ctx.now,
    }
    try {
      const streamUrl = await streamUrlFor(source, request)
      const referer = source.referer || source.page
      const upstreamHeaders = { Referer: referer, Origin: new URL(referer).origin }
      const manifest = await fetchText(streamUrl, {
        ...request,
        rules: source.rules,
        headers: upstreamHeaders,
      })
      validateHls(manifest.text, manifest.url, source.rules)
      const cookie = sameHostCookie(manifest.headers, manifest.url, source.rules)
      if (cookie) upstreamHeaders.Cookie = cookie
      return {
        url: manifest.url,
        desc: `${source.name} 播放地址获取成功`,
        relayHls: true,
        manifestText: manifest.text,
        manifestUrl: manifest.url,
        upstreamHeaders,
        upstreamUrlTransform: raw => allowUrl(raw, source.rules),
      }
    } catch (error) {
      return { url: '', desc: `${source.name} 链接请求失败：${error?.message || String(error)}` }
    }
  }

  function clear() {
    generation++
    streamCache.clear()
    pending.clear()
  }

  return { resolve, clear, streamCache, pending }
}

const resolver = createResolver()

export const resolveChannel = resolver.resolve
export const clearCache = resolver.clear
export { STREAM_URL_TTL_MS }
