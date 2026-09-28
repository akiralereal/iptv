/**
 * 湖北广电官方节目单。
 *
 * 长江云官网直播页没有节目单（标题旁的 program-name 一直是空的），官网播放器的
 * app.cjyun.org.cn/video/player/playbill 对这几套频道回「未找到相关信息」。有数据的是长江云 TV
 * （湖北广电的 IPTV）遥控 H5（res.cjyun.org/t/common/app/iptv/）里频道详情页用的接口：
 *   GET cjy-iptv.hbtv.com.cn/wxcms3/remote-wx/api/cj-cloud/play/<账号>/show?channelCode=<频道码>&date=YYYY-MM-DD
 * 请求头 Authorization 是写在该 H5 公开脚本里的固定值，所有访客都一样，不是用户凭据。
 * 实测（2026-09-25）：
 * - 路径里的账号段 H5 取本地存的长江云用户 id，没登录时就是字符串 null；服务端不校验，
 *   这里照没登录时的样子发 null。Authorization 不对回 { code: 403, message: 'check is fail' }。
 * - 往前一周以上都有，往后到后天，再往后回空数组；日期也只认补零的 YYYY-MM-DD，别的格式同样回空。
 *   频道码不认识回空数组，缺参数回 HTTP 400；偶有网关 502。
 * - 每条有 starttime / endtime（上海时间文本，个别带秒），name 如「白天剧场:毛泽东」。
 *   一天的最后一条跨过零点，次日的第一条常从零点半后才开始，中间空档照实保留。
 *
 * 和取流链路没有任何共享状态：只用频道表 channels.js 和调用方注入的 fetch，
 * 不 import 项目里的其它模块——整份连同 channels.js 拿出去就能单独产出节目单。
 */
import { CHANNELS } from './channels.js'

export const EPG_API = 'https://cjy-iptv.hbtv.com.cn/wxcms3/remote-wx/api/cj-cloud/play/null/show'
// 长江云 TV H5 公开脚本里的固定请求头
const AUTHORIZATION = 'RCilBnX20oXYuA2wQ0'
// 一天三四十条、约 10KB；留足余量，超出按异常处理
const MAX_BYTES = 256 * 1024
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const CODE_RE = /^\d{32}$/
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

/** 上海日期 YYYYMMDD 零点的时间戳；与运行机器的时区无关。非法日期得 NaN。 */
export function shanghaiDayStart(day) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(day))
  if (!match) return NaN
  const [year, month, date] = match.slice(1).map(Number)
  const start = Date.UTC(year, month - 1, date) - SHANGHAI_OFFSET_MS
  const check = new Date(start + SHANGHAI_OFFSET_MS)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) return NaN
  return start
}

/** 'YYYY-MM-DD HH:mm[:ss]'（上海时间）→ 毫秒时间戳；显式按 +08:00 算。非法得 NaN。 */
export function shanghaiTime(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(text ?? '').trim())
  if (!match) return NaN
  const [hour, minute, second = 0] = match.slice(4).map(v => Number(v ?? 0))
  if (hour > 23 || minute > 59 || second > 59) return NaN
  const dayStart = shanghaiDayStart(`${match[1]}${match[2]}${match[3]}`)
  return dayStart + ((hour * 60 + minute) * 60 + second) * 1000
}

/**
 * 接口 JSON → 该天的节目，按开始时间升序、互不重叠。
 * 只收开始时间落在所请求那天里的；同一开始时间只留一条；结束晚于下一条开始的截到下一条开始。
 */
export function parseProgrammes(payload, day) {
  const dayStart = shanghaiDayStart(day)
  if (!Number.isFinite(dayStart)) throw new Error('湖北节目单参数非法')
  if (!payload || typeof payload !== 'object') throw new Error('湖北节目单数据格式异常')
  if (Number(payload.code) !== 200) {
    throw new Error(`湖北节目单接口返回 ${payload.code}：${payload.message || '未知错误'}`)
  }
  if (payload.data == null) return []
  if (!Array.isArray(payload.data)) throw new Error('湖北节目单数据格式异常')

  const dayEnd = dayStart + DAY_MS
  const rows = []
  let readable = 0
  for (const row of payload.data) {
    // 接口同时给 starttime 与拼错的 startime，两者相同
    const start = shanghaiTime(row?.starttime ?? row?.startime)
    const stop = shanghaiTime(row?.endtime)
    const title = String(row?.name ?? '').trim()
    if (!Number.isFinite(start) || !Number.isFinite(stop) || !title) continue
    readable++
    if (start < dayStart || start >= dayEnd || stop <= start) continue
    rows.push({ title, start, stop })
  }
  // 有数据却一条时间都读不出，多半是接口改了格式，报错而不是当成「当天没发」
  if (payload.data.length && !readable) throw new Error('湖北节目单数据格式异常')

  rows.sort((a, b) => a.start - b.start || b.stop - a.stop)
  const programmes = []
  for (const item of rows) {
    const previous = programmes.at(-1)
    if (previous?.start === item.start) continue
    if (previous && previous.stop > item.start) previous.stop = item.start
    programmes.push(item)
  }
  return programmes
}

/** 读响应体，超过上限就中止，不把整份读进内存再判断。 */
async function readCapped(response) {
  if (Number(response.headers?.get?.('content-length')) > MAX_BYTES) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error('湖北节目单响应过大')
  }
  if (!response.body?.getReader) {
    const buf = Buffer.from(await response.arrayBuffer())
    if (buf.length > MAX_BYTES) throw new Error('湖北节目单响应过大')
    return buf.toString('utf8')
  }
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {})
      throw new Error('湖北节目单响应过大')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 长江云 TV 频道详情页同款请求地址：频道码 + 补零的上海日期。 */
export function epgUrl(code, day) {
  const dayStart = shanghaiDayStart(day)
  if (!CODE_RE.test(String(code ?? '')) || !Number.isFinite(dayStart)) throw new Error('湖北节目单参数非法')
  const text = String(day)
  const query = new URLSearchParams({ channelCode: String(code), date: `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}` })
  return `${EPG_API}?${query}`
}

export default {
  id: 'hbtv',
  // 今天 + 明天：全量更新默认 8 小时一轮，多备一天，跨零点前后播放器仍有节目可显示
  days: 2,

  /** 本模块哪些频道出节目单：频道 ref、显示名 → 长江云 TV 频道码。 */
  channels() {
    return CHANNELS.map(channel => ({ ref: `hbtv-${channel.id}`, name: channel.name, key: channel.epgCode }))
  },

  /** 取一个频道某一天（上海日期 YYYYMMDD）的节目，按开始时间升序；官方当天没发返回空数组。 */
  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    const url = epgUrl(key, day)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, {
        headers: {
          Authorization: AUTHORIZATION,
          'User-Agent': UA,
          Referer: 'https://res.cjyun.org/',
          Accept: 'application/json, text/plain, */*',
        },
        // 接口不跳转；真跳了多半是拦截页，按失败处理
        redirect: 'manual',
        signal: controller.signal,
      })
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {})
        throw new Error(`湖北节目单 HTTP ${response.status}`)
      }
      let payload
      try {
        // 接口声明 text/plain，正文是 JSON
        payload = JSON.parse(await readCapped(response))
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error('湖北节目单不是 JSON')
        throw error
      }
      return parseProgrammes(payload, day)
    } finally {
      clearTimeout(timer)
    }
  },
}
