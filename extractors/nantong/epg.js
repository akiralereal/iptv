import { CHANNELS, request } from './api.js'

const OFFSET = 8 * 60 * 60 * 1000
export const shanghaiDay = now => new Date(now + OFFSET).toISOString().slice(0, 10)

function programmeTime(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) return NaN
  const ms = Date.parse(raw.replace(' ', 'T') + '+08:00')
  // Date.parse 会自动修正部分非法日期；转换回来必须仍与官网原值一致。
  return Number.isFinite(ms) && new Date(ms + OFFSET).toISOString().slice(0, 19).replace('T', ' ') === raw ? ms : NaN
}

export function normalizePrograms(payload, channel, now = Date.now()) {
  const day = shanghaiDay(now)
  if (payload.state !== 1000 || !Array.isArray(payload.data)
      || !/^\d{14}$/.test(String(payload.currTime)) || String(payload.currTime).slice(0, 8) !== day.replaceAll('-', '')) {
    throw new Error(`${channel.name}：官方当日节目单不可用`)
  }
  const dayStart = Date.parse(`${day}T00:00:00+08:00`), dayEnd = dayStart + 86400000
  const rows = [], seen = new Set()
  for (const row of payload.data) {
    if (!row || typeof row !== 'object') continue
    const start = programmeTime(row.startTime), stop = programmeTime(row.endTime)
    const title = typeof row.programName === 'string' ? row.programName.trim() : ''
    // EPG 保留所有已发布节目，包含电视剧和未开放直播的时段，不使用播放状态过滤。
    if (Number(row.programStatus) !== 2 || !title || !Number.isFinite(start) || !Number.isFinite(stop)
        || stop <= start || start < dayStart || start >= dayEnd || stop > dayEnd) continue
    const key = JSON.stringify([start, stop, title])
    if (seen.has(key)) continue
    seen.add(key)
    rows.push({ channel: channel.ref, title, start: row.startTime, stop: row.endTime })
  }
  if (!rows.length) throw new Error(`${channel.name}：官方当日节目单没有有效节目`)
  return rows.sort((a, b) => a.start.localeCompare(b.start) || a.stop.localeCompare(b.stop) || a.title.localeCompare(b.title))
}

// 官网只发布服务器当天节目；不把同一份数据套到其他日期。
export default {
  id: 'nantong', days: 1,
  channels() { return CHANNELS.map(c => ({ ref: c.ref, name: c.name, key: c.id })) },
  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    const channel = CHANNELS.find(c => c.id === key)
    if (!channel || !/^\d{8}$/.test(day)) throw new Error('南通节目单参数非法')
    const date = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`
    const now = Date.parse(`${date}T12:00:00+08:00`)
    if (!Number.isFinite(now) || shanghaiDay(now) !== date) throw new Error('南通节目单日期非法')
    const payload = await request('getBroadcastList', { id: channel.upstreamId }, { fetchImpl, timeoutMs })
    if (payload.state !== 1000 || !Array.isArray(payload.data) || !/^\d{14}$/.test(String(payload.currTime))) {
      throw new Error('南通官方节目单响应无效')
    }
    if (String(payload.currTime).slice(0, 8) !== day || !payload.data.length) return []
    return normalizePrograms(payload, channel, now).map(row => ({
      title: row.title, start: Date.parse(row.start.replace(' ', 'T') + '+08:00'),
      stop: Date.parse(row.stop.replace(' ', 'T') + '+08:00'),
    }))
  },
}
