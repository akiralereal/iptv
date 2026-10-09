/**
 * 青岛广播电视台官网电视直播：固定 HLS 地址 + 本机全代理解密。
 *
 * 官网播放页（www.qtv.com.cn/live/tv/）的播放器按 channelName 拼
 * https://video10.qtv.com.cn/drm/<channelName>/manifest.m3u8 取流，地址不签名、CDN 不看
 * Referer / UA；分片是 ARCVIDEO 封装（见 decrypt.js），普通播放器直连播不了，所以频道声明
 * proxyHls，清单与分片都经本机代理，分片边下边解。
 */
import fetch from 'node-fetch'
import { CHANNELS } from './channels.js'
import { decryptArcvideo } from './decrypt.js'

export const STREAM_ORIGIN = 'https://video10.qtv.com.cn'
// 官网没有单独的频道图标，用官网页头的电视台台标（蓝睛 / QTV.COM.CN / 青岛网络广播电视台）
export const LOGO_URL = 'https://www.qtv.com.cn/shouye/images/stationlogo.png'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const CHANNEL_BY_REF = new Map(CHANNELS.map(channel => [channel.ref, channel]))

export function manifestUrlOf(stream) {
  return `${STREAM_ORIGIN}/drm/${stream}/manifest.m3u8`
}

/** 固定频道表 → 播放列表分组。地址在播放时由 resolve 给出，这里只登记引用。 */
export function buildChannelGroups() {
  return [{
    name: '青岛',
    dataList: CHANNELS.map(channel => ({
      name: channel.name,
      deferredRef: channel.ref,
      // 分片要本机解密，清单与分片都走 /proxy/<ref>.m3u8 全代理
      proxyHls: true,
      logo: LOGO_URL,
      opts: ['network-caching=3000'],
      catchup: 'none',
    })),
  }]
}

/** 取一路主清单确认官网还在播：要有 #EXTM3U 且列着分片。 */
export async function probeManifest(stream, { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(manifestUrlOf(stream), {
      headers: { 'User-Agent': UA, Accept: '*/*' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const text = String(await response.text())
    if (!/^#EXTM3U/.test(text.trimStart())) throw new Error('不是 HLS 清单')
    const segments = text.split(/\r?\n/).filter(line => line && !line.startsWith('#'))
    if (!segments.length) throw new Error('清单里没有分片')
    return segments.length
  } catch (error) {
    throw new Error(error?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error?.message || String(error)))
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 刷新：逐路探一次主清单。单路探不到只记警告、频道照留（官网临时抖动不该让台消失）；
 * 五路全探不到才算这轮失败，让后台沿用上一轮数据并提示。
 */
export async function fetchChannels(options = {}) {
  const results = await Promise.allSettled(CHANNELS.map(channel => probeManifest(channel.stream, options)))
  const warnings = []
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      warnings.push(`${CHANNELS[index].name}（${CHANNELS[index].rawName}）本轮取不到官网清单：${result.reason?.message || result.reason}`)
    }
  })
  if (warnings.length === CHANNELS.length) {
    throw new Error(`青岛广电官网清单全部取不到：${results[0].reason?.message || results[0].reason}`)
  }
  return { groups: buildChannelGroups(), warnings }
}

/** 播放入口：地址固定，分片交给 decrypt.js；本地 HLS 全代理由 app.js 的通用代理链完成。 */
export async function resolveChannel(ref) {
  const channel = CHANNEL_BY_REF.get(String(ref || ''))
  if (!channel) return { url: '', desc: '青岛广电频道引用格式错误' }
  return {
    url: manifestUrlOf(channel.stream),
    desc: '青岛广电官网地址，分片由本机解密',
    segmentTransform: decryptArcvideo,
  }
}
