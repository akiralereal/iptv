// 节目单提供者（extractors/<id>/epg.js）的公共件：上海日期、XMLTV 时间、节目 → XMLTV 片段、
// 按提供者取多天节目。
//
// 刻意零依赖：提供者文件也不 import 项目内部模块，两者合起来就能脱离 iptv 单独产出 XMLTV
// （scripts/build-epg.mjs 就是这么跑的）。哪天要把节目单拆出去独立维护，搬走这几个文件即可。

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

const pad = n => String(n).padStart(2, '0')

// XML 实体转义（写出 channel id / display-name / 节目名时用）
export function escapeXml(s) {
  return String(s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

/** 从今天起连续 count 天的上海日期 YYYYMMDD；与运行机器的时区无关。 */
export function shanghaiDays(now = Date.now(), count = 1) {
  const days = []
  for (let i = 0; i < count; i++) {
    const d = new Date(Number(now) + SHANGHAI_OFFSET_MS + i * DAY_MS)
    days.push(`${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`)
  }
  return days
}

/** 毫秒时间戳 → XMLTV 时间，统一按上海时间写 +0800；与运行机器的时区无关。 */
export function xmltvTime(ms) {
  const d = new Date(Number(ms) + SHANGHAI_OFFSET_MS)
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
    + `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())} +0800`
}

/** 一个频道的 <channel> 加它的全部 <programme>；缩进与咪咕、外部聚合写出的一致。 */
export function channelXml(id, programmes) {
  const channel = escapeXml(id)
  let out = `    <channel id="${channel}">\n`
    + `        <display-name lang="zh">${channel}</display-name>\n`
    + `    </channel>\n`
  for (const item of programmes) {
    out += `    <programme channel="${channel}" start="${xmltvTime(item.start)}" stop="${xmltvTime(item.stop)}">\n`
      + `        <title lang="zh">${escapeXml(item.title)}</title>\n`
      + `    </programme>\n`
  }
  return out
}

/**
 * 按提供者声明的天数取一个频道的节目，合并、去重、按开始时间排好。
 * 单天失败不连累其它天；所有天都失败才抛，由调用方计数。
 */
export async function providerProgrammes(provider, key, { now = Date.now(), fetchImpl, timeoutMs } = {}) {
  const days = shanghaiDays(now, provider.days || 1)
  const settled = await Promise.allSettled(days.map(day => provider.programmes(key, day, { fetchImpl, timeoutMs })))
  const failed = settled.filter(result => result.status === 'rejected')
  if (failed.length === settled.length) throw failed[0].reason
  const seen = new Set()
  return settled
    .flatMap(result => (result.status === 'fulfilled' ? result.value : []))
    // 相邻两天的文件在零点前后可能都带着那条跨日节目
    .filter(item => (seen.has(item.start) ? false : seen.add(item.start)))
    .sort((a, b) => a.start - b.start)
}

/** 限并发地逐个执行，结果与 Promise.allSettled 同形、同序。 */
export async function mapSettled(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const index = next++
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index], index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
