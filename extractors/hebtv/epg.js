/**
 * 河北广播电视台「冀时」官方节目单。
 *
 * 官网电视直播页（www.hebrts.cn/19/19js/st/xdszb/）的节目单取自
 * POST api.cmc.hebrts.cn/spidercrms/api/live/liveShowSet/findNoPage，JSON 体
 * { sourceId, tenantId, day, dayEnd }（日期 YYYY-MM-DD），请求头也要带 tenantId（缺了回
 * state 700006）；不用登录、不带签名、不看来源头。sourceId 是页面脚本按频道标题写死的节目源号
 * （河北卫视 462 …），和取流用的稿件 id 是两套号。回 { success, data: { 'YYYY-MM-DD': [...] } }，
 * 每条 name + startDateTime / endDateTime（上海时间 'YYYY-MM-DD HH:mm:ss'），每天最后一条止于
 * 23:59:59，次日从零点后第一档接上，不跨零点。
 *
 * 实测（2026-09-25）：往回一个多月都在，往后排到 5～17 天不等（按周成批录入，各频道进度不一），
 * 未来日与往日同样是逐条编排的真节目单；没排到的日子、不认识的 sourceId 回空对象。
 * 三农频道一天十几条 3～15 分钟的「宣传段」，是串联单里的宣传片时段，丢掉留作空档；周末偶有
 * 编辑把它并进前一条（「烟火事1 08:40 宣传段」），只留节目名。
 *
 * 取流 ref 是栏目里的稿件 id（hebtv-10524916），取流侧运行时拉栏目；这里是 2026-09-25 对着
 * 栏目 catalogId=32557 核对的静态表。官网若重建稿件，取流 ref 跟着变、这里对不上，只会缺节目单，
 * 不会配错。「美丽河北」景观是城市机位慢直播，不出节目单。
 *
 * 和取流链路没有任何共享状态，只用调用方注入的 fetch，不 import 项目里的其它模块——
 * 整份拿出去就能单独产出节目单。
 */

export const EPG_API = 'https://api.cmc.hebrts.cn/spidercrms/api/live/liveShowSet/findNoPage'
// 冀时 CMS 的公开租户号，官网页面脚本与取流侧（api.js）用的是同一个
const TENANT_ID = '0d91d6cfb98f5b206ac1e752757fc5a9'
const PAGE_URL = 'https://www.hebrts.cn/19/19js/st/xdszb/index.shtml'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
// 最多的三农频道一天六十来条、约 26KB；留足余量，超出按异常处理
const MAX_BYTES = 512 * 1024
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const TIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/
// 串联单里的宣传片时段，不是节目
const FILLER_TITLE = '宣传段'
// 编辑偶尔把下一段宣传并进节目名：「烟火事1 08:40 宣传段」，只留节目名
const MERGED_FILLER_RE = /\s+\d{1,2}:\d{2}\s*宣传段$/

/**
 * 模块发出的电视频道（显示名与 api.js 的 NAME_OVERRIDES 一致）→ 节目源号。
 * 购物台三佳购物（稿件 10516513、节目源 330）取流侧固定排除，这里也不列。
 */
export const CHANNELS = Object.freeze([
  { articleId: '10524916', name: '河北卫视', sourceId: '462' },
  { articleId: '10516507', name: '河北经济生活', sourceId: '114' },
  { articleId: '10516509', name: '河北都市', sourceId: '62' },
  { articleId: '10516510', name: '河北文旅体育', sourceId: '334' },
  { articleId: '10516511', name: '河北少儿科教', sourceId: '70' },
  { articleId: '10516508', name: '河北三农', sourceId: '118' },
])

/** 上海时间 'YYYY-MM-DD HH:mm:ss' → 毫秒时间戳；显式按 +08:00 算，不看运行机器时区。非法得 NaN。 */
export function shanghaiTime(value) {
  const text = String(value ?? '').trim()
  const match = TIME_RE.exec(text)
  if (!match) return NaN
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number)
  const utc = Date.UTC(year, month - 1, day, hour, minute, second)
  // Date.UTC 会把 02-30、25:00 这类越界值顺延成别的时刻，写回去对不上就是非法
  if (!new Date(utc).toISOString().startsWith(text.replace(' ', 'T'))) return NaN
  return utc - SHANGHAI_OFFSET_MS
}

/** YYYYMMDD → 接口要的 YYYY-MM-DD；日期不合法抛错。 */
export function isoDate(day) {
  const text = String(day)
  const iso = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
  if (!/^\d{8}$/.test(text) || !Number.isFinite(shanghaiTime(`${iso} 00:00:00`))) {
    throw new Error('河北节目单参数非法')
  }
  return iso
}

/**
 * 接口 JSON → 所请求那天的节目，按开始时间升序、互不重叠。
 * 末条的 23:59:59 补到次日零点，不留一秒空档；丢「宣传段」、剥掉并进节目名的宣传段；同一开始时间只留第一条；
 * 结束晚于下一条开始的截到下一条开始。结构或状态不对抛错，那天没排返回空数组。
 */
export function parseProgrammes(payload, day) {
  const date = isoDate(day)
  const dayStart = shanghaiTime(`${date} 00:00:00`)
  const dayEnd = dayStart + DAY_MS
  if (!payload || typeof payload !== 'object') throw new Error('河北节目单数据格式异常')
  if (payload.success !== true) {
    throw new Error(`河北节目单返回异常：${payload.message || payload.state || '未知错误'}`)
  }
  if (payload.data == null) return []
  if (typeof payload.data !== 'object' || Array.isArray(payload.data)) throw new Error('河北节目单数据格式异常')
  const rows = payload.data[date]
  if (rows == null) return []
  if (!Array.isArray(rows)) throw new Error('河北节目单数据格式异常')

  const items = []
  let parsed = 0
  for (const row of rows) {
    const title = String(row?.name ?? '').trim().replace(MERGED_FILLER_RE, '')
    const start = shanghaiTime(row?.startDateTime)
    let stop = shanghaiTime(row?.endDateTime)
    if (!title || !Number.isFinite(start) || !Number.isFinite(stop)) continue
    parsed++
    if (stop === dayEnd - 1000) stop = dayEnd
    if (start < dayStart || start >= dayEnd || stop <= start || title === FILLER_TITLE) continue
    items.push({ title, start, stop })
  }
  // 有数据却一条时间都读不出，多半是接口改了格式，报错而不是当成「当天没发」
  if (rows.length && !parsed) throw new Error('河北节目单数据格式异常')

  items.sort((a, b) => a.start - b.start)
  const programmes = []
  for (const item of items) {
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
    throw new Error('河北节目单响应过大')
  }
  if (!response.body?.getReader) {
    const buf = Buffer.from(await response.arrayBuffer())
    if (buf.length > MAX_BYTES) throw new Error('河北节目单响应过大')
    return buf.toString('utf8')
  }
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {})
      throw new Error('河北节目单响应过大')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export default {
  id: 'hebtv',
  // 今天 + 明天：全量更新默认 8 小时一轮，多备一天，跨零点前后播放器仍有节目可显示
  days: 2,

  /** 本模块哪些频道出节目单：频道 ref、显示名 → 节目源号。 */
  channels() {
    return CHANNELS.map(channel => ({ ref: `hebtv-${channel.articleId}`, name: channel.name, key: channel.sourceId }))
  },

  /** 取一个频道某一天（上海日期 YYYYMMDD）的节目，按开始时间升序；官方当天没排返回空数组。 */
  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    const sourceId = String(key ?? '')
    if (!/^\d{1,9}$/.test(sourceId)) throw new Error('河北节目单参数非法')
    const date = isoDate(day)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(EPG_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          tenantId: TENANT_ID,
          Accept: 'application/json',
          'User-Agent': UA,
          Referer: PAGE_URL,
        },
        body: JSON.stringify({ sourceId, tenantId: TENANT_ID, day: date, dayEnd: date }),
        // 接口不跳转；真跳了多半是 WAF 拦截页，按失败处理
        redirect: 'manual',
        signal: controller.signal,
      })
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {})
        throw new Error(`河北节目单 HTTP ${response.status}`)
      }
      let payload
      try {
        payload = JSON.parse(await readCapped(response))
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error('河北节目单不是 JSON')
        throw error
      }
      return parseProgrammes(payload, day)
    } finally {
      clearTimeout(timer)
    }
  },
}
