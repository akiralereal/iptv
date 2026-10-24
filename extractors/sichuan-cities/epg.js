/** 云上凉山与攀枝花开公开节目表；只取已核验的电视，其他台不猜配。 */
import { CHANNELS } from './channels.js'
import { readOfficial, parseJson, panzhihuaRequest } from './protocol.js'

const channels = CHANNELS.filter(row => row.city === '凉山' || row.id === 'pzhtv1')
export function dateRange(day) {
  if (!/^\d{8}$/.test(String(day))) throw new Error('四川市州节目单日期无效')
  const date = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`
  const start = Date.parse(`${date}T00:00:00+08:00`)
  if (!Number.isFinite(start) || new Date(start + 8 * 3600000).toISOString().slice(0, 10) !== date) throw new Error('四川市州节目单日期无效')
  return { date, start, stop: start + 86400000 }
}

export function parseProgrammes(payload, day) {
  const range = dateRange(day)
  if (!Array.isArray(payload?.[range.date])) throw new Error('四川市州节目单响应无效')
  const rows = payload[range.date].map(row => ({ title: String(row.name || '').trim(),
    start: Number(row.start_time) * 1000, stop: Number(row.stop_time) * 1000 }))
    .filter(row => row.title && row.title !== '精彩节目' && Number.isSafeInteger(row.start) && Number.isSafeInteger(row.stop)
      && row.start >= range.start && row.start < range.stop && row.stop > row.start && row.stop <= range.stop + 86400000)
    .sort((a, b) => a.start - b.start)
  const result = []
  for (const row of rows) {
    const previous = result.at(-1)
    if (previous?.start === row.start) continue
    if (previous?.stop > row.start) previous.stop = row.start
    result.push(row)
  }
  return result
}

export function parsePanzhihuaProgrammes(payload, day, channel) {
  const range = dateRange(day)
  if (payload?.status !== '200' || payload.dateTime !== range.date || !Array.isArray(payload.list)) {
    throw new Error('攀枝花节目单响应无效')
  }
  if (payload.list.some(row => row.channelId !== channel.contentId)) throw new Error('攀枝花节目单频道不符')
  return parseProgrammes({ [range.date]: payload.list.map(row => ({ name: row.title,
    start_time: Number(row.startTime) / 1000, stop_time: Number(row.endTime) / 1000 })) }, day)
}

export async function programmes(key, day, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const row = channels.find(row => row.id === key)
  if (!row) throw new Error('四川市州节目单频道无效')
  const range = dateRange(day)
  if (row.id === 'pzhtv1') {
    const options = { fetchImpl, timeoutMs }
    const config = parseJson(await readOfficial('https://www.pzhxinwen.cn/json/config/site.sitejson', options))
    const payload = parseJson(await readOfficial('https://www.pzhxinwen.cn/rftapi/api/rft/getEpgInfo', { ...options,
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
      body: panzhihuaRequest(config, row, Date.now(), { channelId: row.contentId, dateTime: range.date }) }))
    return parsePanzhihuaProgrammes(payload, day, row)
  }
  const url = `${row.apiBase}/lives/${row.liveId}/playlists?start=${range.date}&limit=1`
  return parseProgrammes(parseJson(await readOfficial(url, { fetchImpl, timeoutMs })), day)
}

export default { days: 2, channels: () => channels.map(row => ({ ref: row.ref, name: row.name, key: row.id })), programmes }
