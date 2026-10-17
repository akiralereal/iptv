// Unknown is deliberately hidden. A free/paid catalog label never proves that the
// official player grants this account a complete, usable stream.
// An expired positive result stays listed only while its recheck is still queued or
// running (live results expire before the five-minute refresh, and official pages
// take longer than the refresh wait). A failed or refused recheck hides it as before.
const STALE_GRACE_MS = 10 * 60 * 1000

export function createEligibility({ probe, now = Date.now, onUpdate = () => {}, isPaused = () => false,
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)), concurrency = 2 } = {}) {
  // labels keeps the last probed viewing label apart from the verdict: playback can
  // confirm access after an expired or failed record, but cannot tell anonymous from paid.
  const records = new Map(), labels = new Map(), queue = new Map(), inFlight = new Set()
  let generation = 0, running, activated = false, closed = false, lastNotice = now()
  function notify(force = false) {
    if (!force && now() - lastNotice < 15000) return
    lastNotice = now()
    Promise.resolve().then(() => { if (!closed) return onUpdate() }).catch(() => {})
  }
  function kick() {
    if (running || closed || !queue.size) return running
    const epoch = generation
    running = (async () => {
      while (queue.size && !closed && epoch === generation) {
        if (isPaused()) { await delay(250); continue }
        const batch = [...queue.values()].sort((a, b) => Number(!!a.kind) - Number(!!b.kind)).slice(0, concurrency)
        for (const item of batch) { queue.delete(item.id); inFlight.add(item.id) }
        const previous = batch.map(item => records.get(item.id))
        const results = await Promise.allSettled(batch.map(probe))
        for (const item of batch) inFlight.delete(item.id)
        if (closed || epoch !== generation) return
        for (let i = 0; i < batch.length; i++) {
          const item = batch[i], result = results[i]
          if (records.get(item.id) !== previous[i]) continue
          const state = result.status === 'fulfilled' ? result.value : { status: 'unknown', reason: '官方权限核验未完成，请稍后重试' }
          const ttl = state.status === 'unknown' ? 60000 : item.kind ? (state.status === 'allowed' ? 1800000 : 600000) : 120000
          records.set(item.id, { ...state, expires: now() + ttl })
          if (state.status === 'allowed' && state.accessLabel) labels.set(item.id, state.accessLabel)
        }
        notify(!queue.size)
        if (queue.size) await delay(250)
      }
    })().finally(() => { running = undefined; if (queue.size && !closed) kick() })
    return running
  }
  return {
    async filter(items, { waitMs = 5000 } = {}) {
      activated = true
      const wanted = new Set(items.map(item => item.id))
      for (const id of records.keys()) if (!wanted.has(id)) records.delete(id)
      for (const id of labels.keys()) if (!wanted.has(id)) labels.delete(id)
      for (const id of queue.keys()) if (!wanted.has(id)) queue.delete(id)
      for (const item of items) if (!(records.get(item.id)?.expires > now()) && !inFlight.has(item.id)) queue.set(item.id, item)
      const task = kick()
      let timer
      if (task && waitMs > 0) {
        try { await Promise.race([task, new Promise(resolve => { timer = setTimeout(resolve, waitMs) })]) }
        finally { clearTimeout(timer) }
      }
      const allowed = [], skipped = [], unknown = []
      for (const item of items) {
        const record = records.get(item.id)
        const rechecking = (queue.has(item.id) || inFlight.has(item.id)) && record?.expires + STALE_GRACE_MS > now()
        if ((record?.expires > now() || rechecking) && record.status === 'allowed') allowed.push({ ...item, accessLabel: record.accessLabel || '权益已授权' })
        else if (record?.expires > now() && record.status === 'denied') skipped.push({ ref: `iqiyi-sports-${item.id}`, reason: record.reason })
        else unknown.push(item.id)
      }
      return { items: allowed, skipped, unknown: unknown.length,
        warnings: unknown.length ? [`${unknown.length} 条爱奇艺内容尚未确认完整播放权限，暂不显示；后台会继续核验`] : [] }
    },
    record(item, status, reason = '') {
      activated = true
      const changed = records.get(item.id)?.status !== status
      // Without the probed label a free room being watched would turn into 「权益已授权」.
      records.set(item.id, { status, reason, accessLabel: status === 'allowed' ? labels.get(item.id) : undefined, expires: now() + (status === 'unknown' ? 60000 : item.kind ? status === 'allowed' ? 1800000 : 600000 : 120000) })
      queue.delete(item.id)
      if (changed) notify(true)
    },
    reset() { generation++; records.clear(); labels.clear(); queue.clear(); inFlight.clear(); lastNotice = now(); if (activated) notify(true) },
    async shutdown() { closed = true; generation++; queue.clear(); await running },
  }
}
