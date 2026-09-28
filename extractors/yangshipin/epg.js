/**
 * 央视频官方节目单。
 *
 * 官网播放页的节目单取自 capi.yangshipin.cn/api/yspepg/program/<livePid>/<YYYYMMDD>：
 * 对象存储上按日一份的静态 protobuf 文件，不用登录、不带签名，实测今天往后能取三天，
 * 央视频道与 CNTV 官方节目单逐条一致。当天没发的频道回 404（国学频道就是）。
 *
 * 和取流链路没有任何共享状态：只用频道表里的 livePid 和调用方注入的 fetch，
 * 不 import 项目里的其它模块——整份连同 channels.js 拿出去就能单独产出节目单。
 */
import { AUTH_CHANNELS, CHANNELS } from './channels.js'

export const EPG_API = 'https://capi.yangshipin.cn/api/yspepg/program/'
const MAX_BYTES = 512 * 1024

function readVarint(buf, start) {
  let value = 0
  let scale = 1
  let pos = start
  for (;;) {
    if (pos >= buf.length) throw new Error('央视频节目单数据被截断')
    const byte = buf[pos++]
    value += (byte & 0x7f) * scale
    if (!(byte & 0x80)) return [value, pos]
    scale *= 128
    if (scale > 2 ** 56) throw new Error('央视频节目单数据格式异常')
  }
}

/** 逐个读出一层 protobuf 字段：[字段号, 值]，值是数字或 Buffer。 */
function readFields(buf) {
  const fields = []
  let pos = 0
  while (pos < buf.length) {
    let tag
    ;[tag, pos] = readVarint(buf, pos)
    const field = Math.floor(tag / 8)
    const wire = tag % 8
    if (wire === 0) {
      let value
      ;[value, pos] = readVarint(buf, pos)
      fields.push([field, value])
    } else if (wire === 2) {
      let length
      ;[length, pos] = readVarint(buf, pos)
      if (pos + length > buf.length) throw new Error('央视频节目单数据被截断')
      fields.push([field, buf.subarray(pos, pos + length)])
      pos += length
    } else if (wire === 1) {
      pos += 8
    } else if (wire === 5) {
      pos += 4
    } else {
      throw new Error('央视频节目单数据格式异常')
    }
  }
  return fields
}

/**
 * 顶层字段 2 是一条条节目；节目里字段 2 = 节目名，3 / 4 = 开始 / 结束（unix 秒）。
 * 其余字段（id、「HH:MM」文本、时长、标志位）用不上。
 */
export function decodeProgrammes(buf) {
  const programmes = []
  for (const [field, value] of readFields(buf)) {
    if (field !== 2 || !Buffer.isBuffer(value)) continue
    let title = ''
    let start = 0
    let stop = 0
    for (const [inner, v] of readFields(value)) {
      if (inner === 2 && Buffer.isBuffer(v)) title = v.toString('utf8').trim()
      else if (inner === 3 && typeof v === 'number') start = v
      else if (inner === 4 && typeof v === 'number') stop = v
    }
    if (title && start > 0 && stop > start) {
      programmes.push({ title, start: start * 1000, stop: stop * 1000 })
    }
  }
  return programmes
}

export default {
  id: 'yangshipin',
  // 今天 + 明天：全量更新默认 8 小时一轮，多备一天，跨零点前后播放器仍有节目可显示
  days: 2,

  /** 本模块哪些频道出节目单：频道 ref、显示名 → 节目单接口用的 livePid。 */
  channels() {
    return [
      ...CHANNELS.map(channel => ({ ref: `ysp-${channel.id}`, name: channel.name, key: channel.livePid })),
      ...AUTH_CHANNELS.map(channel => ({ ref: `ysp-vip-${channel.id}`, name: channel.name, key: channel.livePid })),
    ]
  },

  /** 取一个频道某一天（上海日期 YYYYMMDD）的节目，按开始时间升序。 */
  async programmes(key, day, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    if (!/^\d{1,16}$/.test(String(key)) || !/^\d{8}$/.test(String(day))) {
      throw new Error('央视频节目单参数非法')
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(`${EPG_API}${key}/${day}`, { signal: controller.signal })
      if (response.status === 404) {
        await response.body?.cancel?.().catch(() => {})
        return []
      }
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {})
        throw new Error(`央视频节目单 HTTP ${response.status}`)
      }
      const buf = Buffer.from(await response.arrayBuffer())
      if (buf.length > MAX_BYTES) throw new Error('央视频节目单响应过大')
      return decodeProgrammes(buf).sort((a, b) => a.start - b.start)
    } finally {
      clearTimeout(timer)
    }
  },
}
