/**
 * 看看新闻（SMG）官方节目单。
 *
 * 官网回看页的节目单取自 kapi.kankanews.com/content/pc/tv/programs?channel_id=<id>&date=YYYY-MM-DD，
 * 请求头要和取流一样双 MD5 验签（sign.js）：不带签名回 4001「验签参数格式错误」、签错回 4003「验签失败」，
 * 都是 HTTP 200 + JSON code；时间戳差一天也照样放行。节目 start_time / end_time 是 unix 秒，
 * 一天首尾正好接上零点，官网页面显示的是同条的 date（上海 HH:MM）。
 * 官网日期栏只列今天和前 6 天；实测过了零点，明天仍是空列表。
 *
 * 只有频道表 is_exist_program=1 的 6 个台有节目单；魔都眼、新纪实（同一接口回 {list: []}）
 * 和景观慢直播没有，不登记。
 *
 * 和取流链路没有任何共享状态：只 import 同目录的 sign.js，用调用方注入的 fetch——
 * 两个文件一起拿出去就能单独产出节目单。
 */
import { buildSignedHeaders } from './sign.js'

export const EPG_API = 'https://kapi.kankanews.com/content/pc/tv/programs'
// 实测一天最多 70 多条、不到 20KB
const MAX_BYTES = 512 * 1024

// channel_id → 模块输出的显示名；ref 与 api.js buildChannels 的 deferredRef 同式，顺序也照它
const EPG_CHANNELS = [
  { id: '1', name: '东方卫视' },
  { id: '2', name: '上海新闻综合' },
  { id: '5', name: '第一财经' },
  { id: '10', name: '五星体育' },
  { id: '4', name: '上海都市' },
  { id: '9', name: '哈哈炫动' },
]

/** 读响应体，超过上限就中止，不把异常大的回包整个读进内存。 */
async function readCapped(response) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (declared > MAX_BYTES) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error('看看新闻节目单响应过大')
  }
  const reader = response.body?.getReader?.()
  if (!reader) {
    const buf = Buffer.from(await response.arrayBuffer())
    if (buf.length > MAX_BYTES) throw new Error('看看新闻节目单响应过大')
    return buf.toString('utf8')
  }
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {})
      throw new Error('看看新闻节目单响应过大')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 接口 JSON → 节目。code 不是 1000（验签、频道不存在等）一律抛错。
 * is_shield=1 只是官网网络直播因版权停播，电视上照播，节目照写。
 */
export function parseProgrammes(payload, key) {
  if (String(payload?.code) !== '1000') {
    throw new Error(`看看新闻节目单接口 ${payload?.code ?? '无 code'}：${payload?.message || '返回结构不符合预期'}`)
  }
  const result = payload.result
  // 没有节目单的频道回的是另一种形状 {system_time, date, list: []}
  if (!Array.isArray(result?.programs)) {
    if (Array.isArray(result?.list) && !result.list.length) return []
    throw new Error('看看新闻节目单返回结构不符合预期')
  }
  if (result.id != null && String(result.id) !== String(key)) {
    throw new Error('看看新闻节目单返回的频道与请求不一致')
  }
  const programmes = []
  for (const row of result.programs) {
    const title = String(row?.name ?? '').trim()
    const start = Number(row?.start_time)
    const stop = Number(row?.end_time)
    if (title && Number.isSafeInteger(start) && start > 0 && Number.isSafeInteger(stop) && stop > start) {
      programmes.push({ title, start: start * 1000, stop: stop * 1000 })
    }
  }
  return programmes.sort((a, b) => a.start - b.start)
}

export default {
  id: 'kankanews',
  // 今天 + 明天：官网日期栏不含明天，实测凌晨取明天是空数组（几点发布没抓到），空着就是 []；
  // 若赶在零点前发了，全量更新（默认 8 小时一轮）跨零点时播放器仍有节目。多一天只多 6 个小请求
  days: 2,

  /** 本模块哪些频道出节目单：频道 ref、显示名 → 节目单接口用的 channel_id。 */
  channels() {
    return EPG_CHANNELS.map(channel => ({ ref: `kankanews-${channel.id}`, name: channel.name, key: channel.id }))
  },

  /**
   * 取一个频道某一天（上海日期 YYYYMMDD）的节目，按开始时间升序。
   * now / nonce / uuid 只给测试固定签名用。
   */
  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000, now, nonce, uuid } = {}) {
    if (!/^\d{1,4}$/.test(String(key)) || !/^\d{8}$/.test(String(day))) {
      throw new Error('看看新闻节目单参数非法')
    }
    const d = String(day)
    const params = { channel_id: String(key), date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` }
    const url = `${EPG_API}?${new URLSearchParams(params)}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, {
        headers: buildSignedHeaders(params, { now, nonce, uuid }),
        signal: controller.signal,
        redirect: 'manual',
      })
      if (response.status !== 200) {
        await response.body?.cancel?.().catch(() => {})
        throw new Error(`看看新闻节目单 HTTP ${response.status}`)
      }
      const text = await readCapped(response)
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        throw new Error('看看新闻节目单返回的不是 JSON')
      }
      return parseProgrammes(payload, key)
    } finally {
      clearTimeout(timer)
    }
  },
}
