/**
 * 河南广播电视台（大象新闻）官方节目单。
 *
 * 官网「看电视」页的节目单取自 pubmod.hntv.tv/program/getAuth/vod/originStream/program/<cid>/<秒>：
 * cid 就是频道表的 id，末段是当天 00:00（上海时间）的 unix 秒；请求头与取流共用一套
 * sign/timestamp 签名（sign.js）。programs[].beginTime / endTime 是字符串形式的 unix 秒。
 * 签名、时间戳不对也回 HTTP 200，正文换成 {code:-2, msg, success:false}；不认识的 cid 回 {}。
 *
 * 只有今天和过去的节目单是真的：录制系统按天生成，update_id 为正、每条带 signa（频道、时段、
 * 日期的 base64）。明天往后，卫视、新闻、国学回空，其余频道回一套冻结的周编排模板——update_id
 * 为 0，隔一周分集号原样不动，节目名与实播对不上（都市频道还排着 2019 年六一文艺汇演）。
 * 官网日历也只开放到今天，所以只取今天，模板一律当官方没发。
 *
 * 和取流链路没有共享状态：只用本目录的频道表、签名和调用方注入的 fetch，
 * 不 import 项目里的其它模块——连同 channels.js、sign.js 拿出去就能单独产出节目单。
 */
import { CHANNELS } from './channels.js'
import { buildSignedHeaders } from './sign.js'

export const EPG_API = 'https://pubmod.hntv.tv/program/getAuth/vod/originStream/program/'
// 实测一天一个频道 2–15 KB（过去的日子带回看地址，最大）；购物频道 72 条也才 23 KB
const MAX_BYTES = 256 * 1024
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** 上海日期 YYYYMMDD → 当天 00:00（+08:00）的 unix 秒；与运行机器的时区无关，非法日期返回 NaN。 */
export function dayStartSeconds(day) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(day))
  if (!match) return NaN
  const [year, month, date] = match.slice(1).map(Number)
  const utc = new Date(Date.UTC(year, month - 1, date))
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== date) return NaN
  return (utc.getTime() - SHANGHAI_OFFSET_MS) / 1000
}

/** 一个频道某一天的节目单地址。 */
export function epgUrl(cid, day) {
  return `${EPG_API}${cid}/${dayStartSeconds(day)}`
}

/** 解析一天的节目单 JSON → [{ title, start, stop }]（毫秒），按开始时间升序；残缺条目跳过。 */
export function parseProgrammes(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('河南节目单返回结构不符合预期')
  }
  if (!Array.isArray(payload.programs)) {
    throw new Error(payload.msg ? `河南节目单接口拒绝：${payload.msg}` : '河南节目单返回结构不符合预期')
  }
  // 编排模板（未来日期）与空日子都是 update_id 0
  if (!(Number(payload.update_id) > 0)) return []
  const programmes = []
  for (const item of payload.programs) {
    const title = String(item?.title ?? '').trim()
    const start = Number(item?.beginTime)
    const stop = Number(item?.endTime)
    if (title && Number.isSafeInteger(start) && start > 0 && Number.isSafeInteger(stop) && stop > start) {
      programmes.push({ title, start: start * 1000, stop: stop * 1000 })
    }
  }
  return programmes.sort((a, b) => a.start - b.start)
}

/** 读正文，超过上限就断开；先看声明长度，再边读边数。 */
async function readCapped(response) {
  if (Number(response.headers?.get?.('content-length')) > MAX_BYTES) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error('河南节目单响应过大')
  }
  const reader = response.body?.getReader?.()
  if (!reader) {
    const text = await response.text()
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('河南节目单响应过大')
    return text
  }
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {})
      throw new Error('河南节目单响应过大')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export default {
  id: 'hntv',
  // 只取今天：明天往后官方只有冻结的编排模板（见文件头），宁缺勿错
  days: 1,

  /** 白名单十三个频道都有官方节目单：频道 ref、显示名 → 节目单接口用的 cid。 */
  channels() {
    return CHANNELS.map(channel => ({ ref: `hntv-${channel.id}`, name: channel.name, key: channel.id }))
  },

  /** 取一个频道某一天（上海日期 YYYYMMDD）的节目，按开始时间升序。 */
  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000, now = Date.now() } = {}) {
    if (!/^\d{1,4}$/.test(String(key)) || !Number.isFinite(dayStartSeconds(day))) {
      throw new Error('河南节目单参数非法')
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(epgUrl(key, day), {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          ...buildSignedHeaders(now),
          'User-Agent': UA,
          Origin: 'https://static.hntv.tv',
          Referer: 'https://static.hntv.tv/kds/',
          Accept: 'application/json, text/plain, */*',
        },
      })
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {})
        throw new Error(`河南节目单 HTTP ${response.status}`)
      }
      const text = await readCapped(response)
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        throw new Error('河南节目单不是 JSON')
      }
      return parseProgrammes(payload)
    } finally {
      clearTimeout(timer)
    }
  },
}
