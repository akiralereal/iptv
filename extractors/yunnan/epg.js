/**
 * 云视网（云南广播电视台）官方节目单。
 *
 * 官网直播页 www.yntv.cn/live.html 点日期时调 yntv-api.yntv.cn/index/jmd/getJmd?name=<webName>&da=YYYY-MM-DD，
 * 取流用的 getRq 是同一台服务器。不用登录、不带签名，但前面有加速乐 WAF：要浏览器 UA 加
 * 云视网 Referer，缺一样就回 403 拦截页（实测 2026-09-25，头给齐了次次 200）。取流链路本来就
 * 带着这组头请求 getRq，这里原样照带。
 *
 * 响应 { lists: [{ id, name, start, duration, ... }], ... }：start 是秒级时间戳，duration 是秒；
 * name 前面带「HH:MM」和空白，是官网列表直接显示的文本。实测：
 * - 往前 6 天到往后 6 天都是真节目单（再往前只剩最后一两条，再往后是占位）；
 * - 服务器自己生成的行 id 都是 1、标题「精彩节目」：每天零点到第一档节目之间补一条，
 *   还没排的日子、日期格式不对时整天是 24 条整点「精彩节目」。它们不是节目，逐条丢掉，
 *   整天都是占位就按当天没发（空数组）处理；
 * - 每天最后一档被截在 23:59:59，这里补齐到次日零点；
 * - 不认识的频道名回空 lists。
 *
 * 地方三台（七彩云端直播间）只有机位没有节目单，不登记。
 *
 * 和取流链路没有任何共享状态：只用 channels.js 的频道表和调用方注入的 fetch，
 * 不 import 项目里的其它模块——整份连同 channels.js 拿出去就能单独产出节目单。
 */
import { CHANNELS } from './channels.js'

export const EPG_API = 'https://yntv-api.yntv.cn/index/jmd/getJmd'
const PAGE = 'https://www.yntv.cn/live.html'
const ORIGIN = 'https://www.yntv.cn'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
// 一天三四十条、约 5KB；留足余量，超出按异常处理
const MAX_BYTES = 256 * 1024
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const WEB_NAME_RE = /^[a-z]{1,32}$/
// 官网列表文本前缀「07:01 」「00:53    」；只剩前缀的算空标题
const CLOCK_PREFIX_RE = /^\d{2}:\d{2}(?:\s+|$)/
// 服务器生成的占位行
const PLACEHOLDER_ID = 1
const PLACEHOLDER_TITLE = '精彩节目'

/** 上海日期 YYYYMMDD → { da: 'YYYY-MM-DD', dayStart }；与运行机器的时区无关。非法日期抛错。 */
export function dayOf(day) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(day))
  if (!match) throw new Error('云视网节目单参数非法')
  const [year, month, date] = match.slice(1).map(Number)
  const utc = Date.UTC(year, month - 1, date)
  const check = new Date(utc)
  // 拒绝 20260231 这类会被 Date.UTC 顺延的日期
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) {
    throw new Error('云视网节目单参数非法')
  }
  return { da: `${match[1]}-${match[2]}-${match[3]}`, dayStart: utc - SHANGHAI_OFFSET_MS }
}

/**
 * 接口 JSON → 当天（dayStart 起 24 小时）的 [{ title, start, stop }]，按开始时间升序。
 * 结束 = 开始 + 时长；时长缺失或离谱的取下一条开始，最后一条取次日零点。结束晚于下一条开始的
 * 截到下一条开始，同一开始时间只留一条，也不越过次日零点。
 */
export function parseSchedule(payload, dayStart) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.lists)) {
    throw new Error('云视网节目单格式异常')
  }
  const dayEnd = dayStart + DAY_MS
  const items = []
  let real = 0
  for (const row of payload.lists) {
    const rawTitle = String(row?.name ?? '').trim()
    const title = rawTitle.replace(CLOCK_PREFIX_RE, '').trim()
    if (Number(row?.id) === PLACEHOLDER_ID || title === PLACEHOLDER_TITLE) continue
    real++
    const startSeconds = Number(row?.start)
    if (!title || !Number.isInteger(startSeconds) || startSeconds <= 0) continue
    const start = startSeconds * 1000
    if (start < dayStart || start >= dayEnd) continue
    const duration = Number(row?.duration)
    items.push({ title, start, length: duration > 0 && duration <= DAY_MS / 1000 ? duration * 1000 : 0 })
  }
  // 有真节目却一条都用不上（时间读不出、全落在别的日子），多半是接口改了，报错而不是当成「当天没发」
  if (real && !items.length) throw new Error('云视网节目单格式异常')

  items.sort((a, b) => a.start - b.start || b.length - a.length)
  const unique = items.filter((item, index) => index === 0 || item.start !== items[index - 1].start)
  return unique.map((item, index) => {
    const next = unique[index + 1]?.start ?? dayEnd
    let stop = item.length ? item.start + item.length : next
    if (stop > next) stop = next
    // 官方把每天最后一档截在 23:59:59
    if (stop >= dayEnd - 1000) stop = dayEnd
    return { title: item.title, start: item.start, stop }
  })
}

/** 读响应体，超过上限就中止，不把整份读进内存再判断。 */
async function readCapped(response) {
  if (Number(response.headers?.get?.('content-length')) > MAX_BYTES) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error('云视网节目单响应过大')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text + decoder.decode()
    size += value.byteLength
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {})
      throw new Error('云视网节目单响应过大')
    }
    text += decoder.decode(value, { stream: true })
  }
}

export default {
  id: 'yunnan',
  // 今天 + 明天：全量更新默认 8 小时一轮，多备一天，跨零点前后播放器仍有节目可显示
  days: 2,

  /** 本模块哪些频道出节目单：频道 ref、显示名 → 官网频道标识。 */
  channels() {
    return CHANNELS
      .filter(channel => channel.kind === 'yntv')
      .map(channel => ({ ref: channel.ref, name: channel.name, key: channel.webName }))
  },

  /** 取一个频道某一天（上海日期 YYYYMMDD）的节目，按开始时间升序；官方当天没发返回空数组。 */
  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    const webName = String(key ?? '')
    if (!WEB_NAME_RE.test(webName)) throw new Error('云视网节目单参数非法')
    const { da, dayStart } = dayOf(day)
    const url = new URL(EPG_API)
    url.searchParams.set('name', webName)
    url.searchParams.set('da', da)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url.href, {
        headers: {
          Accept: 'application/json, text/javascript, */*; q=0.01',
          Referer: PAGE,
          Origin: ORIGIN,
          'User-Agent': UA,
        },
        // 接口不跳转；真跳了多半是 WAF 拦截页，按失败处理
        redirect: 'manual',
        signal: controller.signal,
      })
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {})
        throw new Error(`云视网节目单 HTTP ${response.status}`)
      }
      let payload
      try {
        payload = JSON.parse(await readCapped(response))
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error('云视网节目单不是 JSON')
        throw error
      }
      return parseSchedule(payload, dayStart)
    } finally {
      clearTimeout(timer)
    }
  },
}
