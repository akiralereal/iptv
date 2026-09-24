/** 南京广电官网电视直播与 Live 南京景观直播解析。 */
import fetch from 'node-fetch'

import { TV_CHANNELS } from './channels.js'

export { TV_CHANNELS }

export const TV_SCRIPT_URL = 'https://www.nbs.cn/js/tv.js?v=18'
export const SCENIC_PAGE_URL = 'https://m2.nbs.cn/eventlive/280714.html'

export const SCENIC_CHANNELS = [
  { name: '长江大桥', fallbackUrl: 'https://nklive2.nbs.cn/hls/292e69b9-9ca1-4908-bba0-32438dd7c464/index.m3u8' },
  { name: '南京南站', fallbackUrl: 'https://nklive2.nbs.cn/hls/ed208474-9d66-48d1-adfe-55f0d783915c/index.m3u8' },
  { name: '新庄立交', fallbackUrl: 'https://nklive2.nbs.cn/hls/e75a4b63-c05f-49c1-9d53-9c24c09107de/index.m3u8' },
  { name: '紫金山', fallbackUrl: 'https://nklive2.nbs.cn/hls/aff6d607-073a-4b4b-ab42-2f65f2b9ac4c/index.m3u8' },
  { name: '鼓楼广场', fallbackUrl: 'https://nklive2.nbs.cn/hls/82df63bc-e231-4b84-a277-30f603dd44ca/index.m3u8' },
  { name: '音乐台', fallbackUrl: 'https://nklive1.nbs.cn/hls/3c38d3ba-ee74-4b93-933c-da8e1e5418fa/index.m3u8' },
  { name: '北极阁', fallbackUrl: 'https://nklive2.nbs.cn/hls/157b42cc-93a7-42aa-89e7-0a07452ad4c3/index.m3u8' },
  { name: '三汊河', fallbackUrl: 'https://nklive2.nbs.cn/hls/e01482be-9a78-4c14-a76a-250f733fd993/index.m3u8' },
  { name: '石臼湖', fallbackUrl: 'https://nklive1.nbs.cn/hls/2a317dc5-f482-48ce-8bad-20a0b33926a3/index.m3u8' },
  { name: '南京眼', fallbackUrl: 'https://nklive2.nbs.cn/hls/2496cb32-fa2a-469b-bfd7-2d1991d671d5/index.m3u8' },
  { name: '五马渡', fallbackUrl: 'https://nklive1.nbs.cn/hls/019fe26e-5595-4330-a3be-df72d5e01e6b/index.m3u8' },
  { name: '石象路', fallbackUrl: 'https://yunlive.nbs.cn/live/mzb_sxl_1/playlist.m3u8' },
  { name: '鱼嘴', fallbackUrl: 'https://nklive2.nbs.cn/hls/509207c4-e2b1-43f0-b8f0-f04d0f584ed8/index.m3u8' },
]

const SCENIC_BY_NAME = new Map(SCENIC_CHANNELS.map(channel => [channel.name, channel]))
const ALLOWED_HOSTS = new Set(['nklive.nbs.cn', 'nklive1.nbs.cn', 'nklive2.nbs.cn', 'yunlive.nbs.cn'])
const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
}

export function normalizeStreamUrl(raw) {
  try {
    const input = decodeHtml(raw).trim().replace(/^\/\//, 'https://').replace(/^http:/i, 'https:')
    const url = new URL(input)
    return url.protocol === 'https:' && ALLOWED_HOSTS.has(url.hostname) && /\.m3u8$/i.test(url.pathname)
      ? url.href
      : ''
  } catch {
    return ''
  }
}

export function parseTvScript(script) {
  const urls = []
  const seen = new Set()
  for (const match of String(script || '').matchAll(/(?:https?:)?\/\/[^'"\s]+\.m3u8\s*/gi)) {
    const url = normalizeStreamUrl(match[0])
    if (!url || seen.has(url)) continue
    seen.add(url)
    urls.push(url)
  }
  if (urls.length !== TV_CHANNELS.length) {
    throw new Error(`电视脚本只找到 ${urls.length}/${TV_CHANNELS.length} 个唯一直播地址`)
  }
  return TV_CHANNELS.map((channel, index) => ({ name: channel.name, url: urls[index], logo: channel.logo }))
}

export function parseScenicPage(html) {
  const found = new Map()
  const pattern = /data-url\s*=\s*["']([^"']+)["'][\s\S]{0,900}?text-align\s*:\s*center[^>]*>\s*([^<]+)</gi
  for (const match of String(html || '').matchAll(pattern)) {
    const name = decodeHtml(match[2]).replace(/\s+/g, ' ').trim()
    const definition = SCENIC_BY_NAME.get(name)
    const url = normalizeStreamUrl(match[1])
    if (!definition || !url || found.has(name)) continue
    found.set(name, { name, url, logo: '' })
  }
  if (!found.size) throw new Error('景观页面没有找到白名单内的直播地址')
  return SCENIC_CHANNELS.flatMap(channel => found.has(channel.name) ? [found.get(channel.name)] : [])
}

async function requestText(url, { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: 'text/html,application/javascript,*/*', Referer: 'https://www.nbs.cn/', 'User-Agent': UA },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.text()
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error?.message || String(error))
    throw new Error(reason)
  } finally {
    clearTimeout(timer)
  }
}

// 景观机位不是电视台，没有台标
const fallbackRows = definitions => definitions.map(channel => ({
  name: channel.name,
  url: normalizeStreamUrl(channel.fallbackUrl),
  logo: channel.logo || '',
}))

export function buildChannels(rows) {
  return (Array.isArray(rows) ? rows : []).flatMap(row => {
    const url = normalizeStreamUrl(row?.url)
    return url ? [{ name: String(row.name || '').trim(), url, logo: row.logo || '', opts: ['network-caching=3000'] }] : []
  })
}

/** 两张官网页面独立抓取，任一路页面异常都只回退自己的已核验固定地址。 */
export async function fetchChannelGroups(options = {}) {
  const [tvResult, scenicResult] = await Promise.allSettled([
    requestText(TV_SCRIPT_URL, options).then(parseTvScript),
    requestText(SCENIC_PAGE_URL, options).then(parseScenicPage),
  ])
  const warnings = []
  const tvRows = tvResult.status === 'fulfilled' ? tvResult.value : fallbackRows(TV_CHANNELS)
  const parsedScenicRows = scenicResult.status === 'fulfilled' ? scenicResult.value : []
  if (tvResult.status === 'rejected') warnings.push(`南京电视页面本轮不可用，沿用已核验地址：${tvResult.reason?.message || tvResult.reason}`)
  if (scenicResult.status === 'rejected') warnings.push(`Live 南京页面本轮不可用，沿用已核验地址：${scenicResult.reason?.message || scenicResult.reason}`)
  const missing = SCENIC_CHANNELS.filter(channel => !parsedScenicRows.some(row => row.name === channel.name))
  const fallbackScenicByName = new Map(fallbackRows(missing).map(row => [row.name, row]))
  const parsedScenicByName = new Map(parsedScenicRows.map(row => [row.name, row]))
  const scenicRows = SCENIC_CHANNELS.map(channel => parsedScenicByName.get(channel.name) || fallbackScenicByName.get(channel.name))
  if (scenicResult.status === 'fulfilled' && missing.length) {
    warnings.push(`Live 南京页面缺少 ${missing.map(channel => channel.name).join('、')}，已沿用已核验地址`)
  }
  return {
    groups: [
      { name: '南京电视台', dataList: buildChannels(tvRows) },
      { name: '南京景观', dataList: buildChannels(scenicRows) },
    ],
    warnings,
  }
}
