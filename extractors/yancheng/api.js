import { proxyAwareFetch } from '../../utils/systemProxy.js'
import { CHANNELS, HEADERS, mediaUrl, programList, readText, shanghaiDay, validateManifest } from './protocol.js'

export const claimsRef = ref => CHANNELS.some(c => c.ref === ref)

export async function resolveChannel(ref, { fetchImpl = proxyAwareFetch, timeoutMs = 12000, now = () => Date.now() } = {}) {
  const channel = CHANNELS.find(c => c.ref === ref)
  if (!channel) return { url: '', desc: '盐城频道引用无效' }
  try {
    const time = now(), date = shanghaiDay(time)
    const rows = await programList(channel, date.replaceAll('-', ''), { fetchImpl, timeoutMs })
    const current = rows.filter(r => r.date === date && String(r.stream_id) === channel.streamId
      && Number(r.time_status) === 1 && Number(r.playing) === 1
      && Number(r.star_time_timestamp) * 1000 <= time && Number(r.end_time_timestamp) * 1000 > time)
    if (current.length !== 1 || Number(current[0].can_play) !== 1) throw new Error('盐城当前节目未开放网络直播')
    const programme = current[0], url = mediaUrl(programme.m3u8, channel)
    const manifestText = validateManifest(await readText(url, { fetchImpl, timeoutMs, headers: HEADERS }), url, channel)
    // 每次轮询重新取官网当前节目与签名，旧清单分片最多允许 30 秒且不能跨节目。
    const until = Math.min(time + 30000, Number(programme.end_time_timestamp) * 1000)
    return {
      url, manifestText, manifestUrl: url, desc: `${channel.name}官方直播`,
      upstreamUrlTransform: raw => mediaUrl(raw, channel, { segment: true, base: url }),
      upstreamHeaders: raw => {
        mediaUrl(raw, channel, { segment: true, base: url })
        if (now() >= until) throw new Error('盐城分片入口已过期，请刷新直播清单')
        return { ...HEADERS }
      },
    }
  } catch (error) {
    const reason = /^盐城/.test(error.message) && !/https?:\/\//.test(error.message) ? error.message : '盐城官方取流暂时失败'
    return { url: '', desc: reason }
  }
}
