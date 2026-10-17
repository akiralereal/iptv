/** 绍兴网播放器公开节目单，start_time/end_time 为上海日期的 Unix 秒区间。 */
import { CHANNELS } from './channels.js'

export const EPG_API = 'https://app.shaoxing.com.cn/video/player/playbill'

export function dayRange(day) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(day))
  if (!match) throw new Error('绍兴节目单日期无效')
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  if (new Date(utc).toISOString().slice(0, 10).replaceAll('-', '') !== day) throw new Error('绍兴节目单日期无效')
  return { start: utc - 8 * 3600000, end: utc - 8 * 3600000 + 86400000 }
}

export function parseProgrammes(payload, day) {
  const range = dayRange(day)
  if (payload?.state !== true || !Array.isArray(payload.data)) throw new Error('绍兴节目单响应无效')
  const items = payload.data.map(row => ({
    title: String(row?.name ?? '').replace(/\s+/g, ' ').trim(),
    start: Number(row?.starttime) * 1000, stop: Number(row?.endtime) * 1000,
  })).filter(item => item.title && item.title !== '精彩节目'
    && Number.isSafeInteger(item.start) && Number.isSafeInteger(item.stop)
    && item.start >= range.start && item.start < range.end && item.stop - item.start >= 60000
    && !/节目预告|宣传片|片头|片尾/.test(item.title)).sort((a, b) => a.start - b.start)
  const programmes = []
  for (const item of items) {
    const previous = programmes.at(-1)
    if (previous?.start === item.start) continue
    if (previous && previous.stop > item.start) previous.stop = item.start
    programmes.push(item)
  }
  return programmes
}

export async function programmes(key, day, { fetchImpl = globalThis.fetch, timeoutMs = 12000 } = {}) {
  if (!CHANNELS.some(channel => channel.id === key)) throw new Error('绍兴节目单频道无效')
  const range = dayRange(day)
  const query = new URLSearchParams({ stream_id: key, site_id: '10001', start_time: String(range.start / 1000), end_time: String(range.end / 1000) })
  const response = await fetchImpl(`${EPG_API}?${query}`, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok || response.status >= 300) {
    await response.body?.cancel()
    throw new Error(`绍兴节目单 HTTP ${response.status}`)
  }
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > 256 * 1024) throw new Error('绍兴节目单响应过大')
    chunks.push(Buffer.from(chunk))
  }
  return parseProgrammes(JSON.parse(Buffer.concat(chunks).toString('utf8')), day)
}

export default {
  days: 2,
  channels: () => CHANNELS.map(channel => ({ ref: channel.ref, name: channel.name, key: channel.id })),
  programmes,
}
