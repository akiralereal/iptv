import { createCKey, clientConstants } from './ckey.js'

export const API_URL = 'https://bkliveinfo.ysp.cctv.cn/'
export const UPSTREAM_HEADERS = Object.freeze({
  Accept: 'application/vnd.apple.mpegurl,application/json,*/*',
  Referer: 'https://live.cctv.cn/',
  'User-Agent': 'qqlive',
})

// 只声明 AVC/H.264 能力，不向接口申报 HEVC；用于电视盒子和内置播放器兼容模式。
const H264_CAPABILITY = Buffer.from('H(30:1080,60:1080|30:1080,60:1080)').toString('base64')

function withTimeout(timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return { signal: controller.signal, done: () => clearTimeout(timer) }
}

export function isOfficialMediaUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && (
      url.hostname === 'cctv.cn'
      || url.hostname.endsWith('.cctv.cn')
      || url.hostname === 'ysp.cctv.cn'
      || url.hostname.endsWith('.ysp.cctv.cn')
      || url.hostname === 'cctv.com'
      || url.hostname.endsWith('.cctv.com')
    )
  } catch {
    return false
  }
}

function collectUrls(payload) {
  const values = [payload?.playurl]
  const backups = payload?.backurl_list ?? payload?.backurlList ?? payload?.backurl
  if (Array.isArray(backups)) {
    for (const item of backups) values.push(typeof item === 'string' ? item : item?.url || item?.playurl)
  } else if (typeof backups === 'string') {
    values.push(...backups.split(/[;,]/))
  }
  return [...new Set(values.map(value => String(value || '').trim()).filter(isOfficialMediaUrl))]
}

export async function requestPlayUrls(channel, options = {}) {
  const fetchImpl = options.fetchImpl || fetch
  const ticket = createCKey(channel.channelId, { now: options.now })
  const query = new URLSearchParams({
    atime: '120',
    livepid: channel.livePid,
    cnlid: channel.channelId,
    appVer: clientConstants.appVersion,
    app_version: '300090',
    caplv: '1',
    cmd: '2',
    defn: channel.defn || 'fhd',
    device: 'iPhone',
    encryptVer: '4.2',
    getpreviewinfo: '0',
    hevclv: '0',
    lang: 'zh-Hans_CN',
    livequeue: '0',
    logintype: '1',
    nettype: '1',
    newnettype: '1',
    newplatform: String(clientConstants.platform),
    platform: String(clientConstants.platform),
    sdtfrom: 'v3021',
    spacode: '23',
    spaudio: '1',
    spdemuxer: '6',
    spdrm: '2',
    spdynamicrange: '1',
    spflv: '1',
    spflvaudio: '1',
    sphdrfps: '60',
    sphttps: '1',
    spvcode: H264_CAPABILITY,
    spvideo: '4',
    stream: '1',
    system: '1',
    sysver: 'ios18.2.1',
    uhd_flag: '0',
    cKey: ticket.cKey,
    guid: ticket.guid,
    fntick: String(ticket.timestamp),
    flowid: ticket.flowId,
    playbacktime: '0',
  })
  const timeout = withTimeout(Number(options.timeoutMs || 12_000))
  try {
    const response = await fetchImpl(`${API_URL}?${query}`, {
      redirect: 'follow',
      signal: timeout.signal,
      headers: { 'User-Agent': 'qqlive', Accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`官方接口 HTTP ${response.status}`)
    const payload = await response.json()
    if (Number(payload?.iretcode) !== 0) throw new Error(payload?.errinfo || `官方接口返回 ${payload?.iretcode ?? '未知错误'}`)
    const urls = collectUrls(payload)
    if (!urls.length) throw new Error('官方接口没有返回可用的 HLS 地址')
    return { urls, payload }
  } finally {
    timeout.done()
  }
}

function firstVariant(text, base) {
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('#EXT-X-STREAM-INF')) continue
    for (let j = i + 1; j < lines.length; j++) {
      const value = lines[j].trim()
      if (!value || value.startsWith('#')) continue
      try { return new URL(value, base).href } catch { return '' }
    }
  }
  return ''
}

function mediaSegments(text, base) {
  return text.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      try { return new URL(line, base).href } catch { return '' }
    })
    .filter(isOfficialMediaUrl)
}

async function fetchManifest(url, fetchImpl, signal) {
  const response = await fetchImpl(url, { redirect: 'follow', signal, headers: UPSTREAM_HEADERS })
  if (!response.ok) throw new Error(`清单 HTTP ${response.status}`)
  const text = await response.text()
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('响应不是 HLS 清单')
  return { text, url: response.url || url }
}

/**
 * 逐一检查官方主/备 CDN，取回能拍平成媒体清单的那一条。
 *
 * 只验证清单本身，不去试拉分片：官方 CDN 对短间隔的重复请求会直接回 403，
 * 而一次换票本就已经打了取票和清单两枪，再补一枪分片正好撞上限速——那样探活会在
 * CDN 完全正常时失败，把主备两条都误判成不可用，最终整个频道播不了。分片能否取到
 * 由播放器在真正播放时决定，它自己会重试，不需要这里替它预判。
 */
export async function selectWorkingManifest(urls, options = {}) {
  const fetchImpl = options.fetchImpl || fetch
  const errors = []
  for (const url of urls) {
    const timeout = withTimeout(Number(options.timeoutMs || 10_000))
    try {
      let manifest = await fetchManifest(url, fetchImpl, timeout.signal)
      const variant = firstVariant(manifest.text, manifest.url)
      if (variant && isOfficialMediaUrl(variant)) manifest = await fetchManifest(variant, fetchImpl, timeout.signal)
      const segments = mediaSegments(manifest.text, manifest.url)
      if (!segments.length) throw new Error('媒体清单没有分片')
      return manifest
    } catch (error) {
      let host = '未知节点'
      try { host = new URL(url).hostname } catch { /* 保留默认文案 */ }
      errors.push(`${host}: ${error?.name === 'AbortError' ? '超时' : error?.message || error}`)
    } finally {
      timeout.done()
    }
  }
  throw new Error(`主、备用 CDN 均不可用（${errors.join('；')}）`)
}
