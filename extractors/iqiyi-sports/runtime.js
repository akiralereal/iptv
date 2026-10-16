import { createCatalog, officialFetch, selectAuthorizedStream, checkManifest, validateMediaUrl, claimsRef } from './api.js'
import { createBrowserAuth } from './auth.js'

export function createRuntime({ catalog = createCatalog(), auth, fetchImpl = officialFetch, now = Date.now } = {}) {
  auth ||= createBrowserAuth({ getEvent: async () => {
    const { events } = await catalog.discover()
    return events.find(e => !e.free) || events[0]
  } })
  const tickets = new Map(), pending = new Map()
  let rejected = '', revision = auth.revision(), capturing = false
  const clear = () => tickets.clear()
  async function ticket(event) {
    if (auth.revision() !== revision) { clear(); revision = auth.revision(); rejected = '' }
    if (tickets.get(event.id)?.expiresAt > now()) return tickets.get(event.id)
    if (pending.has(event.id)) return pending.get(event.id)
    if (capturing) throw new Error('正在解析另一场爱奇艺赛事，请稍后播放')
    capturing = true
    const task = (async () => {
      const captured = await auth.capture(event)
      const result = selectAuthorizedStream(captured.data, captured.hasLogin)
      if (captured.data.id && event.qipuId && String(captured.data.id) !== event.qipuId) throw new Error('官方播放房间与目录不一致，请刷新赛事目录')
      const value = { ...result, expiresAt: now() + 240000, referer: event.officialPage }
      tickets.set(event.id, value); rejected = ''
      return value
    })()
    pending.set(event.id, task)
    try { return await task } finally { pending.delete(event.id); capturing = false }
  }
  async function manifest(result) {
    const response = await fetchImpl(result.url, { headers: { Referer: result.referer, 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) })
    if (!response.ok) throw Object.assign(new Error(`官方节目清单返回 HTTP ${response.status}`), { renew: [401, 403, 404, 410].includes(response.status) })
    const url = validateMediaUrl(response.url || result.url)
    const text = checkManifest(await response.text())
    return { text, url }
  }
  return {
    catalog,
    clear,
    credentialRejected: () => rejected || (auth.flow.status().status === 'error' ? auth.flow.status().message : ''),
    browserLoginFlow: Object.fromEntries(['status', 'start', 'check', 'import', 'cancel', 'close'].map(method => [method, async (...args) => {
      const result = await auth.flow[method](...args)
      if (result.authenticated) rejected = ''
      return result
    }])),
    async resolve(ref) {
      if (!claimsRef(ref)) return { url: '', desc: '未知的爱奇艺体育赛事引用' }
      try {
        const event = (await catalog.discover()).events.find(e => e.id === ref.slice('iqiyi-sports-'.length))
        if (!event) return { url: '', desc: '此赛事已结束或不在官方在播目录中' }
        let result = await ticket(event), hls
        try { hls = await manifest(result) }
        catch (error) {
          if (!error.renew) throw error
          tickets.delete(event.id); result = await ticket(event); hls = await manifest(result)
        }
        return { url: result.url, desc: `${event.title} · ${result.size}${result.bid === 610 ? ' · 50帧档' : ''}`,
          manifestText: hls.text, manifestUrl: hls.url,
          upstreamHeaders: target => { validateMediaUrl(target); return { Referer: event.officialPage, 'User-Agent': 'Mozilla/5.0' } },
          upstreamUrlTransform: validateMediaUrl }
      } catch (error) {
        if (error.credential) rejected = error.message
        return { url: '', desc: String(error.message).replace(/https?:\/\/\S+/g, '[官方地址]') }
      }
    },
    async shutdown() { clear(); await auth.shutdown() },
  }
}
export const runtime = createRuntime()
