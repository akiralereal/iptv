/**
 * 泉州闽南语频道官方节目单。
 *
 * 官网闽南语播放页（取流用的同一页，wxqz2.qztv.cn 主、www.qztv.cn 备）下方直接渲染了节目表，
 * 不用登录、不带签名。实测（2026-09-25）：
 * - 日期标签是完整日期（<div id="day">2026-09-25</div>），给最近七天到今天，没有明天。
 * - 每档写「HH:MM-HH:MM」加节目名；当天最后一档的结束写的是次日时刻（23:50-00:10），按跨零点处理。
 * - 官网偶尔要求阿里云人机验证（页面里带 aliyun_waf），两个入口都被拦时本轮就没有节目单。
 *
 * 和取流链路没有共享状态：只用调用方注入的 fetch，不 import 项目内其它模块。
 */
export const EPG_PAGES = Object.freeze([
  'https://wxqz2.qztv.cn/index/Medias/index/media_id/wq95wqbDnMKyd8KiwqzChnt0w5nChcKofcKh/stream_name/mny.html',
  'https://www.qztv.cn/index/Medias/index/media_id/wq95wqbDnMKyd8KiwqzChnt0w5nChcKofcKh/stream_name/mny.html',
])
const REF = 'quanzhou-minnan-tv'
const EPG_KEY = 'mny'
const MAX_BYTES = 2 * 1024 * 1024
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** 上海日期 YYYYMMDD → { 页面标签用的 YYYY-MM-DD, 当天零点, 次日零点 }。 */
export function dayInfo(day) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(day ?? ''))
  if (!match) throw new Error('泉州节目单参数非法')
  const [year, month, date] = match.slice(1).map(Number)
  const start = Date.UTC(year, month - 1, date) - SHANGHAI_OFFSET_MS
  const local = new Date(start + SHANGHAI_OFFSET_MS)
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== date) {
    throw new Error('泉州节目单参数非法')
  }
  return { date: `${match[1]}-${match[2]}-${match[3]}`, start, end: start + DAY_MS }
}

const decode = text => String(text ?? '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim()

const minutesOf = (h, m) => (Number(h) > 23 || Number(m) > 59 ? null : Number(h) * 60 + Number(m))

/** 整页 + 上海日期 → [{ title, start, stop }]；页面没有这一天的标签返回空数组。 */
export function parseProgrammes(html, day) {
  const info = dayInfo(day)
  const text = String(html ?? '')
  if (/aliyun_waf/i.test(text)) throw new Error('泉州官网要求人机验证')
  const dates = [...text.matchAll(/<div id="day">\s*(\d{4}-\d{2}-\d{2})\s*<\/div>/g)].map(m => m[1])
  const panes = text.split(/<div class="z-tabs-pane[^"]*">/).slice(1)
  if (!dates.length || panes.length < dates.length) throw new Error('泉州节目单页面格式异常')
  const index = dates.indexOf(info.date)
  if (index < 0) return []

  const items = []
  for (const m of panes[index].matchAll(/<div class="time"[^>]*>\s*(\d{2}):(\d{2})\s*-\s*(\d{2}):(\d{2})\s*<\/div>[\s\S]*?<div class="program">([\s\S]*?)<\/div>/g)) {
    const from = minutesOf(m[1], m[2])
    const to = minutesOf(m[3], m[4])
    const title = decode(m[5].replace(/<[^>]*>/g, ''))
    if (from == null || to == null || !title) continue
    const start = info.start + from * 60000
    // 结束早于等于开始就是跨过了零点（当天末档 23:50-00:10）
    const stop = info.start + (to > from ? to : to + 24 * 60) * 60000
    items.push({ title, start, stop })
  }
  if (!items.length && /class="program"/.test(panes[index])) throw new Error('泉州节目单页面格式异常')
  items.sort((a, b) => a.start - b.start)
  const unique = items.filter((item, i) => i === 0 || item.start !== items[i - 1].start)
  return unique.map((item, i) => {
    const next = unique[i + 1]?.start
    return next != null && item.stop > next ? { ...item, stop: next } : item
  })
}

async function readCapped(response) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (declared > MAX_BYTES) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error('泉州节目单响应过大')
  }
  const buf = Buffer.from(await response.arrayBuffer())
  if (buf.length > MAX_BYTES) throw new Error('泉州节目单响应过大')
  return buf.toString('utf8')
}

export default {
  id: 'quanzhou-minnan',
  // 官网只到今天，没有明天
  days: 1,

  channels() {
    return [{ ref: REF, name: '泉州闽南语', key: EPG_KEY }]
  },

  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    if (key !== EPG_KEY) throw new Error('泉州节目单参数非法')
    dayInfo(day)
    let lastError = null
    for (const page of EPG_PAGES) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetchImpl(page, {
          headers: { 'User-Agent': UA, Accept: 'text/html' },
          redirect: 'manual',
          signal: controller.signal,
        })
        if (!response.ok) {
          await response.body?.cancel?.().catch(() => {})
          throw new Error(`泉州节目单 HTTP ${response.status}`)
        }
        return parseProgrammes(await readCapped(response), day)
      } catch (error) {
        lastError = error
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastError || new Error('泉州节目单不可用')
  },
}
