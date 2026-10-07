/**
 * 宁德台直播详情接口 → 官方 HLS。
 *
 * POST app.0593tv.cn/jhxtapi/jhxt/Live/detail，表单 uid=0、device、nid 留空、lid=<频道 id>、siteid=1，
 * 分享页 live.js 同款，不用登录。实测（2026-09-30）：
 * - code 为 200 时 data.link 是 live.0593tv.cn/live/<流名>.m3u8，不带签名、多次请求不变；
 *   主清单只有一路子清单（带 hls_ctx 会话参数），清单与分片不看 Referer 和 UA，播放器直连即可；
 * - 接口不看 Origin / Referer，照分享页带上；
 * - 2026-09-30 时 Globalping 美国、香港探针连不上 live.0593tv.cn；10-06 复测 GitHub Actions 三个美国机房、
 *   Globalping 港 / 日 / 美 / 英都能取到清单与分片，海外现在也能播（OVERSEAS.md）。
 *
 * 流名虽然固定，还是每轮刷新向接口要一次：哪天台里换了流名，下一轮自动跟上，不用改代码。
 */
import { proxyAwareFetch } from '../../utils/systemProxy.js'
import { CHANNELS } from './channels.js'

export { CHANNELS }

export const DETAIL_API = 'https://app.0593tv.cn/jhxtapi/jhxt/Live/detail'
const SHARE_PAGE = 'https://app.0593tv.cn/jhxtapi/jhxt/Live/newsShow/id/'
const MEDIA_HOST = 'live.0593tv.cn'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
// 一路详情约 1.5 KB，留足余量
const MAX_TEXT_BYTES = 256 * 1024
// 接口里的「电视」分类；广播是 4
const TV_TYPE_ID = 3

/** 频道的官方 HLS，统一成 https；主机、路径不对都抛错。 */
export function officialStreamUrl(raw) {
  let url
  try { url = new URL(String(raw || '')) } catch { throw new Error('宁德直播地址无效') }
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== MEDIA_HOST
      || url.username || url.password || url.port || url.hash || url.search
      || !/^\/live\/[0-9a-z]+\.m3u8$/i.test(url.pathname)) {
    throw new Error('宁德直播地址不在官方 CDN')
  }
  url.protocol = 'https:'
  return url.href
}

/** 详情接口的 JSON → 官方 HLS；接口拒绝、频道对不上、不是电视都抛错。 */
export function parseDetail(payload, channel) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('返回结构不符合预期')
  if (Number(payload.code) !== 200) throw new Error(`接口拒绝：${payload.message || payload.code}`)
  const data = payload.data
  if (!data || Number(data.id) !== channel.id) throw new Error('返回的频道与请求不一致')
  if (Number(data.typeId) !== TV_TYPE_ID) throw new Error('返回的不是电视频道')
  return officialStreamUrl(data.link)
}

async function requestDetail(channel, { fetchImpl, timeoutMs }) {
  const body = new URLSearchParams({ uid: '0', device: '', nid: '', lid: String(channel.id), siteid: '1' })
  const response = await fetchImpl(DETAIL_API, {
    method: 'POST',
    body: body.toString(),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://app.0593tv.cn',
      Referer: `${SHARE_PAGE}${channel.id}`,
    },
  })
  if (!response.ok || response.status >= 300) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error(`HTTP ${response.status}`)
  }
  const text = await response.text()
  if (text.length > MAX_TEXT_BYTES) throw new Error('响应过大')
  let payload
  try { payload = JSON.parse(text) } catch { throw new Error('返回的不是 JSON') }
  return parseDetail(payload, channel)
}

/** 逐路取官方 HLS：取不到的那一路记进 warnings，其余照常；一路都没有才抛错（沿用上一轮结果）。 */
export async function fetchChannels({ fetchImpl = proxyAwareFetch, timeoutMs = 10000 } = {}) {
  const warnings = []
  const channels = []
  for (const channel of CHANNELS) {
    try {
      const url = await requestDetail(channel, { fetchImpl, timeoutMs })
      channels.push({
        name: channel.name,
        url,
        logo: channel.logo,
        opts: ['network-caching=3000'],
        catchup: 'none',
      })
    } catch (error) {
      const reason = ['AbortError', 'TimeoutError'].includes(error?.name) ? '请求超时' : (error?.message || String(error))
      warnings.push(`${channel.name}取流失败：${reason}`)
    }
  }
  if (!channels.length) throw new Error(`宁德直播接口本轮全部失败：${warnings.join('；')}`)
  return { channels, warnings }
}
