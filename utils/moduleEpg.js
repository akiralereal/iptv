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
  // 按 ref 找模块；测试注入假模块用
  resolveModule = resolverFor,
} = {}) {
  const keysByProvider = new Map()
  // 同名频道在播放器里是同一个 tvg-id，只写一份节目单。但同名的可能来自不同模块：
  // 按播放列表顺序逐个试，前一个官方没发或没取到才轮到下一个
  //（央视频的国学频道没有节目单文件，河南模块的有）
  const groups = new Map()
  for (const { ref, name } of channels) {
    const module = resolveModule(ref)
    const provider = module?.epg
    if (!provider) continue
    let keys = keysByProvider.get(provider)
    if (!keys) {
      keys = new Map(provider.channels().map(channel => [channel.ref, channel.key]))
      keysByProvider.set(provider, keys)
    }
    const key = keys.get(ref)
    const normKey = normalizeKey(name)
    if (key == null || !normKey || coveredKeys.has(normKey)) continue
    let group = groups.get(normKey)
    if (!group) {
      group = { normKey, names: new Set(), candidates: [] }
      groups.set(normKey, group)
    }
    group.names.add(name)
    // 换过分组、多个档共用的同一频道只取一次
    if (!group.candidates.some(c => c.provider === provider && c.key === key)) {
      group.candidates.push({ module, provider, key })
    }
  }
  const jobs = [...groups.values()]
  if (!jobs.length) return { appended: 0, failed: 0 }

  const results = await mapSettled(jobs, CONCURRENCY, async job => {
    let lastFailure = null
    for (const candidate of job.candidates) {
      try {
        const programmes = await providerProgrammes(candidate.provider, candidate.key, { now, fetchImpl, timeoutMs })
        if (programmes.length) return { module: candidate.module, programmes }
      } catch (error) {
        lastFailure = error
      }
    }
    if (lastFailure) throw lastFailure
    return null
  })

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
    // 官方当天都没发节目单的留给外部源
    if (!result.value) return
    // 同组各名字的 tvg-id 一般归一成同一个；关了归一时（江苏卫视 / 江苏卫视4K）各写一份，都对得上
    for (const id of new Set([...job.names].map(epgChannelId))) {
      appendFileSync(playbackBakPath, channelXml(id, result.value.programmes))
    }
    coveredKeys.add(job.normKey)
    appended++
    perModule.set(result.value.module, (perModule.get(result.value.module) || 0) + 1)
  })

  for (const [module, count] of perModule) printGreen(`模块节目单「${module.name}」补充 ${count} 个频道`)
  if (failed) printYellow(`模块节目单 ${failed} 个频道本轮没取到（不影响播放，外部 EPG 源会尝试补）：${lastError}`)
  return { appended, failed }
}
