// 模块自带的官方节目单（extractors/<id>/epg.js，契约见 extractors/registry.js 的 epg）。
//
// 顺序：咪咕（playback.js）→ 这里 → 外部 XMLTV 聚合（epgAggregator.js）。咪咕已覆盖的频道
// 不再取；这里写成的频道记进 coveredKeys，外部源不会重复补。
//
// 频道按 ref 找到自己的模块，再由模块的频道表换成平台内部 key，不按名字模糊配对。
// 取数、合并、序列化在零依赖的 epgXmltv.js，这里只管 iptv 这一侧的衔接。

import { appendFileSync } from './fileUtil.js'
import { resolverFor } from '../extractors/registry.js'
import { normalizeKey } from './channelNormalize.js'
import { epgChannelId } from './epgAggregator.js'
import { channelXml, mapSettled, providerProgrammes } from './epgXmltv.js'
import { proxyAwareFetch } from './systemProxy.js'
import { printGreen, printYellow } from './colorOut.js'

// 静态小文件，并发 4 足够快，也不至于对官方接口扎堆
const CONCURRENCY = 4

/**
 * 把模块节目单追加进正在写的 playback.xml.bak。
 *
 * @param {string} playbackBakPath
 * @param {{ref: string, name: string}[]} channels - 播放列表里实际写出的延迟解析频道
 * @param {Set<string>} coveredKeys - 已有节目单的频道归一 key；本函数会把自己写成的加进去
 * @returns {Promise<{appended: number, failed: number}>}
 */
export async function appendModuleEpg(playbackBakPath, channels, coveredKeys, {
  now = Date.now(),
  fetchImpl = proxyAwareFetch,
  timeoutMs = 10000,
} = {}) {
  const keysByProvider = new Map()
  const queued = new Set()
  const jobs = []
  for (const { ref, name } of channels) {
    const module = resolverFor(ref)
    const provider = module?.epg
    if (!provider) continue
    let keys = keysByProvider.get(provider)
    if (!keys) {
      keys = new Map(provider.channels().map(channel => [channel.ref, channel.key]))
      keysByProvider.set(provider, keys)
    }
    const key = keys.get(ref)
    const normKey = normalizeKey(name)
    // 同名频道（换过分组的、多个档共用的）只取一次
    if (key == null || !normKey || coveredKeys.has(normKey) || queued.has(normKey)) continue
    queued.add(normKey)
    jobs.push({ module, provider, key, name, normKey })
  }
  if (!jobs.length) return { appended: 0, failed: 0 }

  const results = await mapSettled(jobs, CONCURRENCY,
    job => providerProgrammes(job.provider, job.key, { now, fetchImpl, timeoutMs }))

  let appended = 0
  let failed = 0
  let lastError = ''
  const perModule = new Map()
  results.forEach((result, index) => {
    const job = jobs[index]
    if (result.status === 'rejected') {
      failed++
      lastError = result.reason?.name === 'AbortError'
        ? `超时 ${timeoutMs}ms`
        : (result.reason?.message || String(result.reason))
      return
    }
    // 官方当天没发节目单的频道（央视频的国学频道）留给外部源
    if (!result.value.length) return
    appendFileSync(playbackBakPath, channelXml(epgChannelId(job.name), result.value))
    coveredKeys.add(job.normKey)
    appended++
    perModule.set(job.module, (perModule.get(job.module) || 0) + 1)
  })

  for (const [module, count] of perModule) printGreen(`模块节目单「${module.name}」补充 ${count} 个频道`)
  if (failed) printYellow(`模块节目单 ${failed} 个频道本轮没取到（不影响播放，外部 EPG 源会尝试补）：${lastError}`)
  return { appended, failed }
}
