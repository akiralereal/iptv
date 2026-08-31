import { CHANNEL_BY_REF } from './channels.js'
import { requestPlayUrls, selectWorkingManifest, UPSTREAM_HEADERS } from './api.js'

/**
 * 只缓存「选中哪条 CDN 地址」，绝不缓存清单正文。
 *
 * 直播媒体清单里只有 3 个分片、每 3 秒滚动一次，缓存正文等于让播放器在整个 TTL 内
 * 反复拿到同一批分片：播完这十几秒就没有下一片，画面直接卡死，且那批分片早已被
 * CDN 回收，重取只会 403。清单必须每次实时取回（由 utils/appUtils.js 的
 * fetchManifestDirect 承担），这里缓存的是那条「已确认可用的入口地址」。
 *
 * 5 分钟远短于接口自报的 vkey_renew_interval（实测 14400 秒），签名不会中途失效；
 * 相比原先 20 秒又把取票请求降到 1/15，60 路同放也不会打爆官方接口。
 */
export const CACHE_MS = 5 * 60 * 1000

export function createResolver({ request = requestPlayUrls, select = selectWorkingManifest } = {}) {
  const cache = new Map()
  const pending = new Map()

  async function acquire(ref, channel, ctx) {
    let current = pending.get(ref)
    if (current) return current
    current = (async () => {
      let lastError
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { urls } = await request(channel, ctx)
          const manifest = await select(urls, ctx)
          const entry = { url: manifest.url, expiresAt: Number(ctx.now ?? Date.now()) + CACHE_MS }
          cache.set(ref, entry)
          return entry
        } catch (error) {
          lastError = error
        }
      }
      throw lastError
    })().finally(() => pending.delete(ref))
    pending.set(ref, current)
    return current
  }

  async function resolve(ref, ctx = {}) {
    const key = String(ref || '')
    const channel = CHANNEL_BY_REF.get(key)
    if (!channel) return { url: '', desc: '央视频频道引用格式错误' }
    try {
      let entry = cache.get(key)
      if (!entry || Number(ctx.now ?? Date.now()) >= entry.expiresAt) entry = await acquire(key, channel, ctx)
      // 不交回 manifestText：那条路径是留给「只有真浏览器能读到清单」的平台的，
      // 央视频用普通请求就能取清单，交回正文只会让代理层拿着这一份陈旧清单反复下发。
      return {
        url: entry.url,
        upstreamHeaders: UPSTREAM_HEADERS,
        desc: `${channel.name} H.264 播放地址获取成功`,
      }
    } catch (error) {
      // AbortError 的原生文案是英文的 This operation was aborted，直接抛进日志没人看得懂
      const reason = error?.name === 'AbortError' ? '请求超时' : (error?.message || String(error))
      return { url: '', desc: `${channel.name}链接请求失败：${reason}` }
    }
  }

  function clear() {
    cache.clear()
    pending.clear()
  }

  return { resolve, clear, cache, pending }
}

const resolver = createResolver()
export const resolveChannel = resolver.resolve
export const clearCache = resolver.clear

