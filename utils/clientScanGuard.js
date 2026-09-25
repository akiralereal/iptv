/**
 * 客户端批量探测防护：同一个客户端短时间内连续碰很多个不同的频道，就按「播放器在批量
 * 探测」处理，后续请求本地拒绝、不再向上游解析。
 *
 * 背景：不少播放器有「刷新预览图 / 检测源可用性 / 失败自动换台」一类功能，会在几十秒内
 * 把整张列表逐一 GET 一遍（一台 0.1~0.5 秒，有的每台连打两次）。HEAD/OPTIONS 探活
 * app.js 已经本地应答，这里补的是 GET 这一半。对央视频这种「服务端代所有观众取票、拉清单」
 * 的模块，一次扫描等于本机出口对官方打上百个请求，正好撞上平台按 IP 的频率限制；被限后
 * 连正在看的人也一起 403（2026-09-25 网友日志：44 个客户端共用一台，两天 1487 次 403）。
 *
 * 判定只看「碰了多少个不同的频道」，不看请求次数：观众是反复轮询同一个台，扫描器是不停
 * 碰新台。一次「碰」= 请求一个本客户端最近 windowMs 内没请求过的频道，正常轮询（几秒一次）
 * 永远不算。
 *   进入：windowMs 内碰了 ≥ distinctLimit 个频道。
 *   期间：只放行「扫描开始前 settleLeadMs 就已经在看、且中途没停过 runGapMs 以上」的
 *         频道——边看边后台刷预览图的人画面不断；扫描中途用户选的新台会被拒到扫描停下为止。
 *   解除：连续 idleMs 没有再碰新频道。解除时清空窗口，避免刚解除又被同一批旧记录顶回去。
 *
 * 不做定时封禁：扫一遍 60 多个台要一两分钟，按秒数封等于每个窗口都放它几张票。
 * 只按客户端计（调用方传 IP + UA），不做全局限流——全局限流是主动拒绝正常观众；「人多」由
 * 模块自己的被动冷却兜底。慢扫（2 秒以上一个台）够不到判定，本身也温和，放过。
 * 循环扫描（失败自动换台转圈）：一圈超过 windowMs 的会一直被拦；一圈不到 windowMs 的小列表
 * 会在解除后放行，但要么播出来了就不再转，要么撞模块自己的失败冷却，上游代价有限。
 *
 * 纯内存、零依赖、绝不抛：内部任何异常都按放行处理，宁可漏拦不可拦错。
 */

export const SCAN_GUARD_DEFAULTS = Object.freeze({
  distinctLimit: 6,          // windowMs 内碰到这么多个不同频道即判为扫描
  windowMs: 10_000,          // 计数窗口；也是「多久没请求过的频道才算又碰了一次」
  idleMs: 5_000,             // 连续这么久没碰新频道就解除
  runGapMs: 30_000,          // 同一频道两次请求隔了这么久以上，算重新开始看
  settleLeadMs: 2_000,       // 扫描开始前至少这么久就在看的频道，扫描期间照常放行
  clientTtlMs: 10 * 60_000,  // 客户端这么久没请求就忘掉
  maxClients: 2_000,         // 表超过这个数整表丢弃（畸形流量才可能到，丢了只是少拦一会儿）
  announceEveryMs: 10_000,   // 拦截期间每隔这么久提示调用方打一行日志
})

const ALLOW = Object.freeze({ allowed: true, scanning: false })

export function createClientScanGuard(options = {}) {
  const cfg = { ...SCAN_GUARD_DEFAULTS, ...options }
  const clients = new Map()
  let calls = 0

  function prune(now) {
    for (const [key, client] of clients) {
      if (now - client.lastSeen > cfg.clientTtlMs) { clients.delete(key); continue }
      for (const [channel, run] of client.runs) {
        if (now - run.last > cfg.runGapMs) client.runs.delete(channel)
      }
    }
    if (clients.size > cfg.maxClients) clients.clear()
  }

  /**
   * @param {string} clientKey 客户端标识（调用方决定粒度，通常 `模块|IP|UA`）
   * @param {string} channelKey 频道标识
   * @param {number} [now]
   * @returns {{ allowed: boolean, scanning: boolean, distinct?: number, blocked?: number, announce?: boolean }}
   */
  function check(clientKey, channelKey, now = Date.now()) {
    if (typeof clientKey !== 'string' || !clientKey || typeof channelKey !== 'string' || !channelKey) return ALLOW
    if (!Number.isFinite(now)) now = Date.now()
    if (++calls % 256 === 0 || clients.size > cfg.maxClients) prune(now)

    let client = clients.get(clientKey)
    if (!client) {
      client = { lastSeen: now, runs: new Map(), touches: [], scanning: false, episodeStart: 0, lastTouch: 0, blocked: 0, announcedAt: 0 }
      clients.set(clientKey, client)
    }
    client.lastSeen = now

    let run = client.runs.get(channelKey)
    const touched = !run || now - run.last > cfg.windowMs
    if (!run || now - run.last > cfg.runGapMs) {
      run = { since: now, last: now }
      client.runs.set(channelKey, run)
    } else {
      run.last = now
    }
    // 先看「上一次碰新台到现在」够不够久，再记这一次：否则碰新台的请求永远解除不了拦截，
    // 只发一次请求就跟着 302 走的播放器（没有轮询）会一直被拦
    if (client.scanning && now - client.lastTouch >= cfg.idleMs) {
      client.scanning = false
      client.touches.length = 0
      client.blocked = 0
    }
    if (touched) {
      client.touches.push(now)
      client.lastTouch = now
    }
    while (client.touches.length && now - client.touches[0] >= cfg.windowMs) client.touches.shift()

    if (!client.scanning && client.touches.length >= cfg.distinctLimit) {
      client.scanning = true
      client.episodeStart = now
      client.blocked = 0
      client.announcedAt = 0
    }
    if (!client.scanning) return ALLOW

    // 扫描开始前就在看、中途没断过的频道照常放行（runs 里断过 runGapMs 的 since 已被重置）
    if (run.since <= client.episodeStart - cfg.settleLeadMs) return { allowed: true, scanning: true }

    client.blocked++
    const announce = now - client.announcedAt >= cfg.announceEveryMs
    if (announce) client.announcedAt = now
    return { allowed: false, scanning: true, distinct: client.touches.length, blocked: client.blocked, announce }
  }

  function safeCheck(clientKey, channelKey, now) {
    try {
      return check(clientKey, channelKey, now)
    } catch {
      return ALLOW
    }
  }

  return {
    check: safeCheck,
    clear() { clients.clear() },
    get size() { return clients.size },
    config: Object.freeze({ ...cfg }),
  }
}
