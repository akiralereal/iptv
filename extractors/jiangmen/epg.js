import { CHANNEL, EPG_URL, readOfficial, shanghaiDay } from './protocol.js'

export function parseEpg(body) {
  const match = /^\s*liveList\.jsonpCallback\(([\s\S]*)\)\s*;?\s*$/.exec(String(body))
  if (!match) throw new Error('江门官方节目单格式已变化')
  const data = JSON.parse(match[1])
  if (!Array.isArray(data)) throw new Error('江门官方节目单不是节目数组')
  return data
}

export function programmeTime(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) return NaN
  const value = Date.parse(raw.replace(' ', 'T') + '+08:00')
  return Number.isFinite(value) && new Date(value + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ') === raw ? value : NaN
}

export function dayRange(day) {
  if (!/^\d{8}$/.test(String(day))) throw new Error('江门节目单日期非法')
  const date = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`
  const start = Date.parse(`${date}T00:00:00+08:00`)
  if (!Number.isFinite(start) || shanghaiDay(start) !== date) throw new Error('江门节目单日期非法')
  return { start, end: start + 86400000 }
}

export function parseProgrammes(data, day) {
  const range = dayRange(day)
  if (!Array.isArray(data)) throw new Error('江门官方节目单不是节目数组')
  const rows = data.filter(row => row && row.liveid === CHANNEL.upstreamId).map(row => ({
    title: typeof row.name === 'string' ? row.name.trim() : '',
    start: programmeTime(row.start_time), stop: programmeTime(row.end_time),
  })).filter(row => row.title && !/^(?:精彩节目|节目预告)$/.test(row.title)
    && Number.isFinite(row.start) && Number.isFinite(row.stop) && row.stop > row.start
    && row.start >= range.start && row.start < range.end && row.stop <= range.end + 86400000)
    .sort((a, b) => a.start - b.start || a.stop - b.stop)
  const result = []
  for (const row of rows) {
    const previous = result.at(-1)
    if (previous?.start === row.start) continue
    if (previous && previous.stop > row.start) previous.stop = row.start
    result.push(row)
  }
  return result
}

export default {
  id: 'jiangmen', days: 2,
  channels() { return [{ ref: CHANNEL.ref, name: CHANNEL.name, key: CHANNEL.upstreamId }] },
  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    if (key !== CHANNEL.upstreamId) throw new Error('江门节目单频道非法')
    dayRange(day)
    const body = await readOfficial(EPG_URL, { fetchImpl, timeoutMs })
    return parseProgrammes(parseEpg(body.toString('utf8')), day)
  },
}
