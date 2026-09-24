/**
 * 浙江新蓝网官方节目单。
 *
 * 官网直播页的节目单取自 p.cztv.com/api/paas/program/<station_code>/<YYYYMMDD>：不用登录、
 * 不查 Referer，按上海日期一天一份，今天和往前都取得到。play_time / duration 是毫秒（官网按浏览器
 * 本地时间显示），每天的数据在零点被切齐（跨零点的节目两天各记一段）。
 *
 * 还没排出来的日子不回 404，而是回 24 条整点「精彩节目」占位（凌晨实测明天起就是，何时换成
 * 真节目单没观察到）；日期离谱或频道号不存在时回一个「精彩频道」兜底，时间还是今天的。购物台
 * 好易购的真节目单也全是「精彩节目」。所以逐条丢掉「精彩节目」，并只收开始时间落在所请求那天
 * 里的节目。
 *
 * 数据是播出串联单的粒度，一天 50～220 条，其中一半以上是广告、宣传片、片头片尾、串联包装，
 * 规则见 fillerReason()。
 *
 * 和取流链路没有任何共享状态：频道号就是频道接口 channel/tv 的 station_code，也是取流 ref
 * 的数字部分；不 import 项目里的其它模块，整份拿出去就能单独产出节目单。
 */

export const EPG_API = 'https://p.cztv.com/api/paas/program/'
const MAX_BYTES = 512 * 1024
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

// 与 api.js 的 NAME_OVERRIDES 输出名一致。好易购（111）取流模块不输出，节目单也只有占位，不列。
export const STATIONS = [
  { code: '101', name: '浙江卫视' },
  { code: '102', name: '钱江都市' },
  { code: '103', name: '浙江经济生活' },
  { code: '104', name: '浙江教科影视' },
  { code: '106', name: '浙江民生休闲' },
  { code: '107', name: '浙江新闻' },
  { code: '108', name: '浙江少儿' },
  { code: '110', name: '浙江国际' },
  { code: '112', name: '之江纪录' },
]

const PLACEHOLDER_TITLE = '精彩节目'
// 播出串联单的行话，不会出现在正片名里：多长都丢（民生休闲一段「TC-5广告」23 分钟、钱江都市「串播QB12」14 分钟）
const FILLER_ANY = /广告|串联|串播|包装|垫片/
// 只在 10 分钟以内时丢：少儿台正片名常带「片尾版」（13～30 分钟），钱江都市「带……片头」的专题 20 分钟
const FILLER_SHORT = /宣传|公益|片头|片尾|预告|花絮|MTV/
const FILLER_SHORT_MAX_MS = 10 * 60 * 1000
// 不到 1 分钟的不算节目：15 秒片头、国歌、禁毒短片、零点切下的碎片。最短的正经节目是 1 分钟的海洋预报
const MIN_PROGRAMME_MS = 60 * 1000

/** 串联单里的非节目条目返回原因，正经节目返回空串。丢掉后留下的空档就是广告时段，XMLTV 允许空档。 */
export function fillerReason(title, durationMs) {
  if (title === PLACEHOLDER_TITLE) return 'placeholder'
  if (durationMs < MIN_PROGRAMME_MS) return 'short'
  if (FILLER_ANY.test(title)) return 'filler'
  if (durationMs <= FILLER_SHORT_MAX_MS && FILLER_SHORT.test(title)) return 'promo'
  return ''
}

/** 上海日期 YYYYMMDD 零点的时间戳；与运行机器的时区无关。 */
export function shanghaiDayStart(day) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(day))
  if (!match) return NaN
  const [, y, m, d] = match.map(Number)
  const start = Date.UTC(y, m - 1, d) - SHANGHAI_OFFSET_MS
  const check = new Date(start + SHANGHAI_OFFSET_MS)
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return NaN
  return start
}

/** 接口 JSON → 该天的节目，按开始时间升序、互不重叠；结构不对抛错，没有真节目返回空数组。 */
export function parseProgrammes(payload, day) {
  const dayStart = shanghaiDayStart(day)
  if (!Number.isFinite(dayStart)) throw new Error('浙江新蓝网节目单参数非法')
  if (Number(payload?.state) !== 0) {
    throw new Error(`浙江新蓝网节目单返回异常：${payload?.alertMessage || payload?.message || payload?.state}`)
  }
  if (!Array.isArray(payload?.content?.list)) throw new Error('浙江新蓝网节目单结构不符合预期')
  const station = payload.content.list[0]
  if (!station) return []
  if (!Array.isArray(station.list)) throw new Error('浙江新蓝网节目单结构不符合预期')

  const dayEnd = dayStart + DAY_MS
  const rows = []
  for (const item of station.list) {
    const title = String(item?.program_title ?? '').trim()
    const start = Number(item?.play_time)
    const duration = Number(item?.duration)
    if (!title || !Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) continue
    // 兜底占位带的是今天的时间，不能记到别的日子上
    if (start < dayStart || start >= dayEnd) continue
    rows.push({ title, start, stop: Math.min(start + duration, dayEnd) })
  }
  rows.sort((a, b) => a.start - b.start)
  // 实测没有重叠；万一有，同一开始时间只留第一条，其余按真实时间线截到下一条开始
  const timeline = rows.filter((row, i) => i === 0 || row.start !== rows[i - 1].start)
  for (let i = 0; i + 1 < timeline.length; i++) {
    if (timeline[i + 1].start < timeline[i].stop) timeline[i].stop = timeline[i + 1].start
  }
  return timeline.filter(row => row.stop > row.start && !fillerReason(row.title, row.stop - row.start))
}

export default {
  id: 'cztv',
  // 今天 + 明天：明天多数时候还是占位（返回空），一旦官方提前排出来，跨零点前后也有节目可显示
  days: 2,

  /** 本模块哪些频道出节目单：频道 ref、显示名 → 节目单接口用的 station_code。 */
  channels() {
    return STATIONS.map(station => ({ ref: `cztv-${station.code}`, name: station.name, key: station.code }))
  },

  /** 取一个频道某一天（上海日期 YYYYMMDD）的节目，按开始时间升序。 */
  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    if (!/^\d{1,8}$/.test(String(key)) || !Number.isFinite(shanghaiDayStart(day))) {
      throw new Error('浙江新蓝网节目单参数非法')
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(`${EPG_API}${key}/${day}`, {
        headers: { Accept: 'application/json' },
        redirect: 'manual',
        signal: controller.signal,
      })
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {})
        throw new Error(`浙江新蓝网节目单 HTTP ${response.status}`)
      }
      if (Number(response.headers?.get?.('content-length')) > MAX_BYTES) {
        await response.body?.cancel?.().catch(() => {})
        throw new Error('浙江新蓝网节目单响应过大')
      }
      const buf = Buffer.from(await response.arrayBuffer())
      if (buf.length > MAX_BYTES) throw new Error('浙江新蓝网节目单响应过大')
      let payload
      try {
        payload = JSON.parse(buf.toString('utf8'))
      } catch {
        throw new Error('浙江新蓝网节目单不是 JSON')
      }
      return parseProgrammes(payload, day)
    } finally {
      clearTimeout(timer)
    }
  },
}
