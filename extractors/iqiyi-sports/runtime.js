import { createCatalog, officialFetch, selectAuthorizedMedia, checkManifest, validateMediaUrl, claimsRef, accessLabel } from './api.js'
import { createEligibility } from './eligibility.js'
import { createBrowserAuth } from './auth.js'

const ACCOUNT_RECHECK_MS = 10 * 60 * 1000

export function createRuntime({ catalog = createCatalog(), auth, fetchImpl = officialFetch, now = Date.now, onFilterUpdate, eligibilityWaitMs = 5000 } = {}) {
  auth ||= createBrowserAuth({ getEvent: async () => {
    // Free rooms prove nothing about the account; only member rooms can verify login.
    const { events, vods = [] } = await catalog.discover()
    return events.find(e => !e.free) || vods.find(e => !e.free)
  } })
  const tickets = new Map(), pending = new Map()
  let rejected = '', revision = auth.revision(), capturing = false, accountCheck, accountCheckedAt = -Infinity
  const eligibility = createEligibility({ now, onUpdate: onFilterUpdate,
    isPaused: () => capturing || auth.flow.status().active || auth.flow.status().status === 'waiting',
    probe: async event => {
      try {
        // A catalog "free" flag is only a candidate. Confirm the complete stream
        // with a fresh, cookie-free context before advertising anonymous playback.
        if (event.free && auth.captureAnonymous) {
          try {
            const captured = await auth.captureAnonymous(event)
            const result = selectAuthorizedMedia(captured, event)
            if (!event.kind && captured.data.id && String(captured.data.id) !== event.qipuId) throw new Error('官方播放房间与目录不一致')
            await manifest({ ...result, referer: event.officialPage })
            return { status: 'allowed', accessLabel: accessLabel(event, true) }
          } catch { /* Anonymous failure does not revoke the owner's paid access. */ }
        }
        const captured = await auth.capture(event)
        const result = selectAuthorizedMedia(captured, event)
        if (!event.kind && captured.data.id && String(captured.data.id) !== event.qipuId) throw new Error('官方播放房间与目录不一致')
        await manifest({ ...result, referer: event.officialPage })
        return { status: 'allowed', accessLabel: accessLabel(event, captured.hasLogin === false) }
      } catch (error) {
        if (error.credential || /DRM|加密|H\.264|CDN|不一致/.test(error.message)) return { status: 'denied', reason: error.message }
        return { status: 'unknown', reason: '官方权限核验未完成，请稍后重试' }
      }
    },
  })
  const clear = () => { tickets.clear(); eligibility.reset() }
  function syncRevision() {
    if (auth.revision() !== revision) { clear(); revision = auth.revision(); rejected = ''; accountCheckedAt = -Infinity }
  }
  // A valid account without this room's rights gets the same preview as an expired login.
  // The refused item is hidden at once; the login alert waits for the official account API,
  // asked off the manifest path and at most every ten minutes because players keep retrying.
  function confirmLoginSoon() {
    if (!auth.checkAccount || accountCheck || now() - accountCheckedAt < ACCOUNT_RECHECK_MS) return
    accountCheckedAt = now()
    const epoch = auth.revision()
    accountCheck = auth.checkAccount().then(() => { if (auth.revision() === epoch) rejected = '' },
      error => { if (error.credential && auth.revision() === epoch) rejected = error.message })
      .finally(() => { accountCheck = undefined })
  }
  // Re-check authorization off the manifest path: a browser capture takes seconds and
  // would stall players if it ran inside a manifest poll. Hard expiry stays at four minutes.
  function renewSoon(event, cached) {
    cached.renewAt = now() + 30000
    ticket(event, true).catch(error => {
      if (!error.credential) return
      confirmLoginSoon()
      eligibility.record(event, 'denied', error.message)
      if (tickets.get(event.id) === cached) tickets.delete(event.id)
    })
  }
  async function ticket(event, force = false) {
    syncRevision()
    const cached = tickets.get(event.id)
    if (!force && cached?.expiresAt > now()) {
      if (cached.renewAt <= now() && !pending.has(event.id) && !capturing) renewSoon(event, cached)
      return cached
    }
    if (pending.has(event.id)) return pending.get(event.id)
    if (capturing) throw new Error('正在解析另一场爱奇艺赛事，请稍后播放')
    capturing = true
    const task = (async () => {
      const captured = await auth.capture(event)
      const result = selectAuthorizedMedia(captured, event)
      if (!event.kind && captured.data.id && event.qipuId && String(captured.data.id) !== event.qipuId) throw new Error('官方播放房间与目录不一致，请刷新赛事目录')
      const value = { ...result, expiresAt: now() + 240000, renewAt: now() + 150000, referer: event.officialPage }
      tickets.set(event.id, value); rejected = ''
      return value
    })()
    pending.set(event.id, task)
    try { return await task } finally { pending.delete(event.id); capturing = false }
  }
  async function manifest(result) {
    if (result.manifestText) return { text: checkManifest(result.manifestText), url: result.referer }
    const response = await fetchImpl(result.url, { headers: { Referer: result.referer, 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) })
    if (!response.ok) throw Object.assign(new Error(`官方节目清单返回 HTTP ${response.status}`), { renew: [401, 403, 404, 410].includes(response.status) })
    const url = validateMediaUrl(response.url || result.url)
    const text = checkManifest(await response.text())
    return { text, url }
  }
  return {
    catalog,
    clear,
    async filterPlayable(items) { syncRevision(); return eligibility.filter(items, { waitMs: eligibilityWaitMs }) },
    credentialRejected: () => rejected || (auth.flow.status().status === 'error' ? auth.flow.status().message : ''),
    browserLoginFlow: Object.fromEntries(['status', 'start', 'check', 'import', 'cancel', 'close'].map(method => [method, async (...args) => {
      const result = await auth.flow[method](...args)
      syncRevision()
      if (method === 'start') eligibility.reset()
      if (result.authenticated && result.entitled !== false) rejected = ''
      return result
    }])),
    async resolve(ref) {
      if (!claimsRef(ref)) return { url: '', desc: '未知的爱奇艺体育赛事引用' }
      let selectedEvent
      try {
        const id = ref.slice('iqiyi-sports-'.length)
        // Manifest polls take the cached catalog and refresh it in the background; only
        // an event missing from the cached copy waits for a fresh scan.
        const find = data => [...data.events, ...(data.vods || [])].find(e => e.id === id)
        let event = find(await catalog.discover({ allowStale: true }))
        if (!event) event = find(await catalog.discover())
        if (!event) return { url: '', desc: '此内容已结束或不在官方直播及点播目录中' }
        selectedEvent = event
        let result = await ticket(event), hls
        try { hls = await manifest(result) }
        catch (error) {
          if (!error.renew) throw error
          tickets.delete(event.id); result = await ticket(event); hls = await manifest(result)
        }
        // A background recheck may have rejected/deleted this older ticket while
        // its manifest was being read. Do not let the old success undo the denial.
        if (tickets.get(event.id) === result) eligibility.record(event, 'allowed')
        return { url: result.url, desc: `${event.title} · ${result.size}${!event.kind && result.bid === 610 ? ' · 50帧档' : ''}`,
          manifestText: hls.text, manifestUrl: hls.url,
          upstreamHeaders: target => { validateMediaUrl(target); return { Referer: event.officialPage, 'User-Agent': 'Mozilla/5.0' } },
          upstreamUrlTransform: validateMediaUrl }
      } catch (error) {
        if (error.credential) confirmLoginSoon()
        if (selectedEvent) eligibility.record(selectedEvent, error.credential || /DRM|加密|H\.264|CDN|不一致/.test(error.message) ? 'denied' : 'unknown', '播放权限或媒体核验未通过，暂不显示')
        return { url: '', desc: String(error.message).replace(/https?:\/\/\S+/g, '[官方地址]') }
      }
    },
    async shutdown() { await eligibility.shutdown(); tickets.clear(); await auth.shutdown() },
  }
}
export const runtime = createRuntime({ onFilterUpdate: async () => {
  // Lazy import keeps the extractor independent of manager initialization.
  const { runExtractorNowAPI } = await import('../../utils/extractorsAPI.js')
  runExtractorNowAPI('iqiyi-sports')
} })
