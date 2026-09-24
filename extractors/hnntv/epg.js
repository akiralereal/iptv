/**
 * 海南网台官方节目单。
 *
 * 官网直播页的节目单取自 www.hnntv.cn/api/schedule/byDay?channelId=<id>：不用登录、不带签名，
 * channelId 就是频道表接口（/api/channel）里的 id，与取流是同一套编号。七套电视都有节目单。
 *
 * 一次回七天：今天加往前六天，不给明天；date、day 之类的参数一概忽略。所以每轮只取今天，
 * 从返回里按日期挑出那一天。时间是不带时区的「YYYY-MM-DD HH:mm:ss」北京时间；平台在零点
 * 把跨日节目切成两段，当天最后一条止于 23:59:59。官网只显示 status > 0 的条目，这里照做。
 *
 * 和取流链路没有任何共享状态：只用 channels.js 里的频道表和调用方注入的 fetch，
 * 不 import 项目里的其它模块——两个文件拿出去就能单独产出节目单。
 */
import { CHANNELS } from './channels.js'

export const EPG_API = 'https://www.hnntv.cn/api/schedule/byDay'
// 七天一份实测 40–85 KB
const MAX_BYTES = 1024 * 1024
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/

/** 「2026-09-25 19:00:00」按北京时间换成毫秒时间戳，与运行机器的时区无关；格式不对返回 NaN。 */
export function parseShanghaiTime(text) {
  const match = DATETIME.exec(String(text ?? '').trim())
  if (!match) return NaN
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number)
  const utc = Date.UTC(year, month - 1, day, hour, minute, second)
  const d = new Date(utc)
  // Date.UTC 会把 09-31、24:00 悄悄进位成别的时刻，这里直接拒掉
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day
    || d.getUTCHours() !== hour || d.getUTCMinutes() !== minute || d.getUTCSeconds() !== second) return NaN
  return utc - SHANGHAI_OFFSET_MS
}

/** 从七天的返回里挑出某一天（YYYYMMDD）的节目，按开始时间升序；返回里没有这一天就是空数组。 */
export function pickDay(payload, day) {
  if (String(payload?.businessCode) !== '00000' || !Array.isArray(payload?.resultSet)) {
    throw new Error(`海南网台节目单返回异常：${payload?.description || '结构不符合预期'}`)
  }
  const date = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`
  const programmes = []
  let listed = 0
  for (const group of payload.resultSet) {
    if (group?.date !== date) continue
    if (!Array.isArray(group.schedules)) throw new Error('海南网台节目单格式异常')
    for (const item of group.schedules) {
      if (!(Number(item?.status) > 0)) continue
      listed++
      const title = String(item?.showName ?? '').trim()
      const start = parseShanghaiTime(item?.startDatetime)
      const stop = parseShanghaiTime(item?.endDatetime)
      if (title && start < stop) programmes.push({ title, start, stop })
    }
  }
  // 有条目却一条都读不出来，多半是时间格式改了；抛出去比悄悄当成「当天没发」好查
  if (listed && !programmes.length) throw new Error('海南网台节目单时间格式异常')
  return programmes.sort((a, b) => a.start - b.start)
}

async function discard(response) {
  response.body?.destroy?.()
  await response.body?.cancel?.().catch(() => {})
}

async function readText(response) {
  if (Number(response.headers?.get?.('content-length')) > MAX_BYTES) {
    await discard(response)
    throw new Error('海南网台节目单响应过大')
  }
  if (!response.body) return ''
  const chunks = []
  let total = 0
  for await (const chunk of response.body) {
    total += chunk.length
    // 在循环里抛出会让迭代器收尾、取消剩下的下载
    if (total > MAX_BYTES) throw new Error('海南网台节目单响应过大')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

export default {
  id: 'hnntv',
  // 接口不给明天，只取今天；全量更新每轮重取，零点后的下一轮才有新一天
  days: 1,

  /** 本模块哪些频道出节目单：频道 ref、显示名 → 节目单接口的 channelId。 */
  channels() {
    return CHANNELS.map(channel => ({ ref: `hnntv-${channel.id}`, name: channel.name, key: channel.id }))
  },

  /** 取一个频道某一天（上海日期 YYYYMMDD）的节目，按开始时间升序。 */
  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    if (!/^\d{1,6}$/.test(String(key)) || !/^\d{8}$/.test(String(day))) {
      throw new Error('海南网台节目单参数非法')
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(`${EPG_API}?channelId=${key}`, {
        headers: { Accept: 'application/json', Referer: 'https://www.hnntv.cn/' },
        redirect: 'manual',
        signal: controller.signal,
      })
      if (!response.ok) {
        await discard(response)
        throw new Error(`海南网台节目单 HTTP ${response.status}`)
      }
      let payload
      try {
        payload = JSON.parse(await readText(response))
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error('海南网台节目单不是 JSON')
        throw error
      }
      return pickDay(payload, String(day))
    } finally {
      clearTimeout(timer)
    }
  },
}
