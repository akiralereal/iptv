// 外部源失效检测（issue #88）
//
// 探活策略与 scripts/probe-m3u.mjs 一致：GET + 超时 + 重试（任一次通即判活）+ 并发池，
// 拿到响应状态即断开、不下载流体。只做「连通性检测 + 首字节延迟参考」，不做吞吐测速——
// 下载分片测吞吐流量大、易被源站限流封 IP，且结果随时段波动，投入产出比差。
//
// 结果仅用于标记与「建议隐藏」，绝不自动删除：带 UA/Referer/token 防盗链的源可能「假失效」，
// rtmp/rtp/udp 组播无法 HTTP 探测（归为 skip），一律以实际播放为准。
//
// 检测从服务端发起：家庭部署（服务端与播放设备同一出口）结果基本代表实际体验；
// 跨网/异地访问的场景结果仅供参考。

const CONCURRENCY = 12
const TIMEOUT_MS = 8000
const RETRIES = 2
const RETRY_DELAY_MS = 500
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 单任务态：同一时刻只允许一个检测任务（避免多任务并发探测互相挤占带宽导致误判；也保持轻量）
let task = null

async function probeOnce(url, signal, userAgent) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  const onOuterAbort = () => ctrl.abort()
  if (signal) signal.addEventListener('abort', onOuterAbort, { once: true })
  const started = Date.now()
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': userAgent || UA },
    })
    res.body?.cancel?.().catch(() => {}) // 不下载流体，拿到状态即可
    const alive = res.status >= 200 && res.status < 400
    return { status: alive ? 'alive' : 'dead', code: res.status, ttfbMs: Date.now() - started }
  } catch (e) {
    // 外层取消（停止检测/关闭弹窗）导致的中断不算失效：纯超时时外层 signal 不会是 aborted，可区分
    if (signal?.aborted) return { status: 'skip', code: 'cancelled', ttfbMs: null }
    return { status: 'dead', code: e?.name === 'AbortError' ? 'timeout' : (e?.cause?.code || e?.code || 'error'), ttfbMs: null }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onOuterAbort)
  }
}

// 带重试：任一次成功即判活；连续失败才判死（过滤临时抖动，减少误判）
// userAgent：频道自带或订阅源里填的 UA（issue #170），没有就用默认浏览器 UA
async function probe(url, signal, userAgent) {
  // rtmp/rtp/udp/rtsp 等非 HTTP 协议无法探测，跳过并保留（不判死）
  if (!url || !/^https?:\/\//i.test(url)) return { status: 'skip', code: 'non-http', ttfbMs: null }
  let last
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    if (signal?.aborted) return { status: 'skip', code: 'cancelled', ttfbMs: null }
    last = await probeOnce(url, signal, userAgent)
    if (last.status === 'alive') return last
    if (attempt < RETRIES) await sleep(RETRY_DELAY_MS)
  }
  return last
}

async function runProbeTask(t, channels, signal) {
  let idx = 0
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, channels.length) }, async () => {
    while (idx < channels.length && !signal.aborted) {
      const cur = idx++
      const ch = channels[cur]
      const r = await probe(ch.url, signal, ch.userAgent)
      t.results[cur] = { name: ch.name || '', url: ch.url || '', group: ch.group || '', ...r }
      t.done++
    }
  }))
  t.running = false
  t.finishedAt = Date.now()
}

/**
 * 启动检测（异步后台跑，用 getProbeStatus 轮询进度与结果）
 * channels: [{name, url, group?, userAgent?}]
 */
export function startProbe(sourceIndex, sourceName, channels) {
  if (task && task.running) {
    return { success: false, message: `已有检测任务在进行（${task.sourceName}），请等待完成或先取消` }
  }
  const ctrl = new AbortController()
  const t = {
    running: true,
    cancelled: false,
    sourceIndex,
    sourceName,
    total: channels.length,
    done: 0,
    startedAt: Date.now(),
    finishedAt: null,
    results: [],
    error: null,
    _ctrl: ctrl,
  }
  task = t
  runProbeTask(t, channels, ctrl.signal).catch(err => {
    t.running = false
    t.error = err?.message || String(err)
    t.finishedAt = Date.now()
  })
  return { success: true, message: `开始检测 ${channels.length} 个频道` }
}

/**
 * 查询检测进度/结果。
 * 进行中只回进度计数（大订阅几千频道，明细留到跑完一次性返回，轮询不背大 JSON）；
 * 完成后返回 dead/skip 明细 + 存活统计（含首字节延迟分布参考）。
 */
export function getProbeStatus() {
  if (!task) return { success: true, data: { state: 'idle' } }
  const results = task.results.filter(Boolean)
  const aliveList = results.filter(r => r.status === 'alive')
  const data = {
    state: task.running ? 'running' : 'done',
    cancelled: task.cancelled,
    sourceIndex: task.sourceIndex,
    sourceName: task.sourceName,
    total: task.total,
    done: task.done,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    error: task.error,
    summary: {
      alive: aliveList.length,
      dead: results.filter(r => r.status === 'dead').length,
      skip: results.filter(r => r.status === 'skip').length,
    },
  }
  if (!task.running) {
    data.dead = results.filter(r => r.status === 'dead').map(r => ({ name: r.name, url: r.url, group: r.group, code: r.code }))
    data.skip = results.filter(r => r.status === 'skip').map(r => ({ name: r.name, url: r.url, group: r.group, code: r.code }))
    // 存活频道的首字节延迟参考（中位数），帮助粗判「慢源」
    const ttfbs = aliveList.map(r => r.ttfbMs).filter(v => typeof v === 'number').sort((a, b) => a - b)
    data.summary.aliveTtfbMedianMs = ttfbs.length ? ttfbs[Math.floor(ttfbs.length / 2)] : null
  }
  return { success: true, data }
}

/** 取消进行中的检测 */
export function cancelProbe() {
  if (!task || !task.running) return { success: true, message: '没有进行中的检测任务' }
  task.cancelled = true
  task._ctrl.abort()
  return { success: true, message: '已取消检测' }
}
