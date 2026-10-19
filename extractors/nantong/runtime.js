import { randomBytes } from 'node:crypto'
import { proxyAwareFetch } from '../../utils/systemProxy.js'
import { CHANNELS, snapshot, readBytes, parseManifest, mediaUrl } from './api.js'

// 必须由模块管理每片的节目租期：通用代理的分片缓存不能在节目换档后继续放行。
const liveMatch = path => /^\/(?:[^/]+\/[^/]+\/)?nantong-([1-3])(?:\.m3u8)?$/.exec(String(path || ''))
const mediaMatch = path => /^\/(?:[^/]+\/[^/]+\/)?nantong-media\/([a-f0-9]{24})\.ts$/.exec(String(path || ''))
export const claimsLocalPath = path => Boolean(liveMatch(path) || mediaMatch(path))
export const claimsRef = ref => CHANNELS.some(c => c.ref === ref)

function response(status, body, type = 'text/plain; charset=utf-8') {
  return { status, body, headers: {
    'Content-Type': type, 'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  } }
}

export function createRuntime({ fetchImpl = proxyAwareFetch, now = Date.now, snapshotImpl = snapshot } = {}) {
  const cache = new Map(), pending = new Map(), media = new Map()
  async function lease(channel) {
    const old = cache.get(channel.id)
    if (old && old.until > now() && old.endAt > now()) return old
    if (pending.has(channel.id)) return pending.get(channel.id)
    const job = snapshotImpl(channel, { fetchImpl }).then(value => {
      value.until = Math.min(now() + 4000, value.endAt)
      cache.set(channel.id, value)
      return value
    }).catch(error => { cache.delete(channel.id); throw error })
      .finally(() => pending.delete(channel.id))
    pending.set(channel.id, job)
    return job
  }
  return {
    clearResolveCache() { cache.clear(); media.clear() },
    async resolveChannel(ref) {
      const channel = CHANNELS.find(c => c.ref === ref)
      if (!channel) return { url: '', desc: '南通频道引用无效' }
      try {
        await lease(channel)
        return { url: `/${ref}.m3u8`, desc: '南通官方节目直播入口' }
      } catch { return { url: '', desc: '南通官方当前节目暂不可播' } }
    },
    async handleLocalRequest({ path, method = 'GET', accessPrefix = '' } = {}) {
      if (!claimsLocalPath(path)) return null
      if (method === 'OPTIONS') return response(204, '')
      if (!['GET', 'HEAD'].includes(method)) return response(405, '请使用 GET 或 HEAD')
      try {
        let match = liveMatch(path)
        if (match) {
          const channel = CHANNELS.find(c => c.id === match[1])
          const current = await lease(channel)
          const upstream = await readBytes(current.url, { fetchImpl })
          const text = parseManifest(upstream.body.toString('utf8'), current)
          if (current.endAt <= now()) throw new Error('节目已切换，请刷新直播清单')
          for (const [key, item] of media) if (item.expires <= now()) media.delete(key)
          if (media.size > 1000) media.clear()
          // 保留旧版 /user/token 的鉴权前缀；站长密码路径由 app.js 的 accessPrefix 传入。
          const accountPrefix = path.match(/^((?:\/[^/]+){2})\/nantong-[1-3]/)?.[1] || ''
          const prefix = `${accessPrefix}${accountPrefix}`
          const rewritten = text.split(/\r?\n/).map(line => {
            if (!line || line.startsWith('#')) return line
            const key = randomBytes(12).toString('hex')
            media.set(key, { channel, programId: current.programId,
              url: mediaUrl(new URL(line, current.url), channel, true),
              expires: Math.min(now() + 30000, current.endAt) })
            return `${prefix}/nantong-media/${key}.ts`
          }).join('\n')
          return response(200, rewritten, 'application/vnd.apple.mpegurl')
        }
        match = mediaMatch(path)
        const item = media.get(match[1])
        if (!item || item.expires <= now()) return response(410, '媒体入口已过期，请刷新直播清单')
        const current = await lease(item.channel)
        if (current.programId !== item.programId) return response(410, '节目已切换，请刷新直播清单')
        const upstream = await readBytes(item.url, { fetchImpl, maxBytes: 8 * 1024 * 1024 })
        if (item.expires <= now() || current.endAt <= now()) return response(410, '节目媒体入口已过期')
        if (upstream.body.length < 564 || ![0, 188, 376].every(i => upstream.body[i] === 0x47)) {
          throw new Error('官方媒体不是可识别的 MPEG-TS')
        }
        return response(200, upstream.body, 'video/mp2t')
      } catch (error) {
        const reason = /^(?:官网|官方|南通|台方|当前|节目|媒体|不是)/.test(error.message)
          && !/https?:\/\//i.test(error.message) ? error.message : '南通官方接口或媒体暂不可用'
        return response(503, reason)
      }
    },
  }
}

const runtime = createRuntime()
export const handleLocalRequest = runtime.handleLocalRequest
export const clearResolveCache = runtime.clearResolveCache
// HTTP 入口由上面的本机处理器直出；保留模块 resolve 契约及旧式 ref 路由。
export const resolveChannel = runtime.resolveChannel
