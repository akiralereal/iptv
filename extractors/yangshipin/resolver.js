import { CHANNEL_BY_REF } from './channels.js'
import { MANIFEST_TIMEOUT_MS, requestPlayUrls, selectWorkingManifest, UPSTREAM_HEADERS } from './api.js'
import { FILLER_PATH, LIBVLC_UA, libvlcPlaylist } from './libvlc-view.js'
import { printYellow } from '../../utils/colorOut.js'
import { createPlaylistHistory } from './playlist-history.js'
import epg from './epg.js'

/**
 * 只缓存官方主备入口，绝不把清单正文按取票 TTL 缓存。
 *
 * 直播媒体清单里只有 3 个分片、每 3 秒滚动一次，缓存正文等于让播放器在整个 TTL 内
 * 反复拿到同一批分片：播完这十几秒就没有下一片，画面直接卡死，且那批分片早已被
 * CDN 回收，重取只会 403。正在观看的频道每 5 秒共享刷新一次，并直接交给代理层下发，
 * 避免多客户端重复刷新触发 CDN 403，也避免播放器刷新较慢漏掉短片。只有同一频道短时间内来了
 * 第二次请求（确实有播放器在轮询）才启动共享刷新，单次请求不留后台尾巴（见 PLAYING_WINDOW_MS）；
 * 停播后停止刷新。
 * （取不到新清单时拿上一份顶一下是另一回事，见 STALE_AFTER_MS。）
 *
 * 5 分钟远短于接口自报的 vkey_renew_interval（实测 14400 秒）；但 CDN 仍可能
 * 提前拒绝旧地址，因此每次取清单都能换备用入口，全部失败时提前换票。
 * 相比原先 20 秒又把取票请求降到 1/15，60 路同放也不会打爆官方接口。
 */
export const CACHE_MS = 5 * 60 * 1000
export const LIVE_REFRESH_MS = 5_000
export const LIVE_IDLE_MS = 15_000

/**
 * 共享刷新只给「真在播」的频道开：同一频道两次请求相隔在 (PLAYING_MIN_GAP_MS, PLAYING_WINDOW_MS]
 * 之内才算有播放器在轮询。播放器拿到清单后要隔两三秒（hls.js 按分片时长、libVLC 约 5 秒）才会再来；
 * 「刷新预览图 / 检测可用性」式的扫描每台只碰一次，有的连打两次但相隔只有几十毫秒，都够不到这个判定。
 * v4.27.0 一开始是只要有过一份清单就起后台刷新、停播后再跑 15 秒：按「同一地址重取即 403」模拟，
 * 扫一遍 20 个台上游要多打 40 次清单、多换 20 张票，正好放大被官方按出口限流的风险（issue #162）。
 */
export const PLAYING_MIN_GAP_MS = 1_000
export const PLAYING_WINDOW_MS = 10_000

/**
 * 实例级取票预算：整台实例每分钟最多为 TICKET_BUDGET 个「没在播」的频道向官方取票。
 *
 * utils/clientScanGuard.js 按客户端（IP+UA）记账，拦得住一台播放器连扫；但官方限的是本机出口 IP，
 * 几台设备各扫几个、或 2 秒一台的慢扫，按客户端都够不到判定，加起来照样把出口打进限流，此后换新票
 * 也全部 403（issue #162）。所以再加一道按实例的令牌桶：只约束冷启动（30 秒内没有这个频道的清单、
 * 也没人正在取），正在播的频道续播换票不计；桶空了对冷启动本地回「请求过于频繁」，一枪不打上游。
 * 20 张/分钟：一个人换台怎么也到不了一分钟 20 个新台，而把 63 个公开频道扫一遍会在第 21 个被拦住。
 * 代价是多人共用一台时，有人扫台的那一分钟里别人换新台会被挡几十秒，正在看的不受影响——比起出口
 * 被封、所有人一起 403 半小时，这是更小的伤害。只在单例上启用（见文件末尾），注入式解析器默认不限。
 */
export const TICKET_BUDGET = 20
export const TICKET_BUDGET_WINDOW_MS = 60 * 1000

/**
 * 换票后主备 CDN 仍全部 403 = 本机出口正被官方限流。此后该频道 30 秒内直接回失败、
 * 不再打官方：播放器失败后是毫秒级连环重试，每次重试在这里要打 6~8 枪（缓存入口 +
 * 两轮换票 × 主备），只会把限流越拖越久。
 *
 * 30 秒取自共享实例的真实日志（两天 1487 次 403）：同频道相邻两次失败 54% 间隔不到
 * 1 秒，30~60 秒的只占 1%。按日志回放，冷却 5/15/30/60/120 秒分别挡掉 54/59/65/65/66%
 * 的上游请求——30 秒之后再加长几乎不再多挡，只会让官方恢复后观众白等。
 * 只认「全部 403」：超时等失败照旧每次实打，不因一次抖动封掉一个台（版权停播另有冷却，见下）。
 */
export const FORBIDDEN_COOLDOWN_MS = 30 * 1000

/**
 * 官方回「应版权方要求，暂停提供直播信号」后，这个台冷却到当前节目结束（最多 5 分钟）再向官方请求。
 *
 * 版权停播按节目走：一档节目没有版权，整档都是这句话，换了节目才可能恢复。此前它和超时一样每次
 * 实打，播放器失败后约每秒重试一次、每次还换两张票：issue #158 的日志里 CCTV10 停播 3 分钟失败
 * 184 次，6 分钟后那台服务器的出口就被官方全线 403 了（不能证明是它触发的，但这种重试毫无意义）。
 * 现在第一次就记下，冷却到官方节目单上当前节目的结束时刻，期间本地回同一句话、一枪不打官方。
 *   - 节目单查不到当前节目，冷却 BLACKOUT_FALLBACK_MS。
 *   - 不管节目多长，最多 BLACKOUT_RECHECK_MS 就再问一次官方：官方偶尔误报、节目单的结束时刻也不一定准，
 *     误判最多挡这么久；真停播时每隔这么久多取一张票，对出口风控可以忽略。
 * 冷却期间的拒绝不刷红字，开始时打一行黄字，写明节目和到几点。
 */
export const BLACKOUT_FALLBACK_MS = 3 * 60 * 1000
export const BLACKOUT_RECHECK_MS = 5 * 60 * 1000
const BLACKOUT = /版权/
// 上海时间的日期 YYYYMMDD 与时分 HH:MM
const shanghai = ms => new Date(ms + 8 * 3600 * 1000).toISOString()
const shanghaiDay = ms => shanghai(ms).slice(0, 10).replaceAll('-', '')
const shanghaiClock = ms => shanghai(ms).slice(11, 16)

/**
 * 官方入口一时取不到新清单，先把上一份清单回给播放器（issue #158）。
 *
 * 入口偶尔会挂住十几秒不回应。原先这次请求要陪着等完整轮（缓存入口 + 两次换票，每次主入口
 * 等满 3 秒，共约 9.5 秒），最后回一段失败说明。用录下来的真实分片按原节奏回放实测：APTV
 * （系统播放内核）的清单请求被挂这么久，就再也不发请求、停在最后一帧，只能手动切台，这时回
 * 什么内容都一样；裸的 AVPlayer 能熬过这一挂，但缓冲见底时拿到失败说明会直接报错停播。
 * 改成三四秒内回上一份清单，APTV 只是等几秒，官方恢复后自己续上。清单没变对播放器是正常情况
 * （还没出新片），各家都是过一会儿再来取。
 *
 * STALE_AFTER_MS：有上一份清单可回时，一次请求最多等这么久。比一个入口的超时多半秒——主入口
 * 挂住、备用入口正常时照样等得到新清单，不白白晚一轮。取新清单的事接着在后台做。
 * 已经回过旧清单之后的请求，两类播放器实测要的正好相反，只能分开对待：
 *   - APTV：断流期间只要有一次清单请求被多留了 1 秒，就停在原地不再恢复（4 轮里 3 轮，剩下
 *     那轮它缓冲还没用完）；一律立刻回、跳片也接回的 3 轮都自己续上。所以默认不等，立刻回旧清单，
 *     新清单在后台取，取到后下一次请求直接给（见 resolve 里「还没发过」那一条），全程不让它的请求等。
 *   - libVLC（Ceau Player）：它是上一次响应后 5 秒才再来取。立刻回旧的会让它在官方已经恢复的
 *     那一轮白拿一份旧清单，晚 5 秒续上、还多跳过一片，比不改之前更卡。所以给它等 STALE_RECHECK_MS：
 *     官方正常时取清单最慢不到 1 秒（见 api.js），等得到就是恢复了，当场给新清单。
 * STALE_MAX_MS：上一份清单最多顶这么久。再久播放器手里的内容早就播完，官方也只留一分钟左右的
 * 分片，继续回旧清单只会让人以为还在播；到点照旧回失败说明。
 */
export const STALE_AFTER_MS = MANIFEST_TIMEOUT_MS + 500
export const STALE_RECHECK_MS = 1000
export const STALE_MAX_MS = 30 * 1000

/**
 * 短分片频道冷起时先攒一攒再交给播放器。CCTV8K 每片只有 2 秒，官方窗口 3 片 = 6 秒；共享刷新
 * 5 秒一次，新片两三片一批地出现，播放器自己还要再隔一个刷新周期才看得到，libVLC 又要数据比
 * 播放头早约 4.4 秒到。冷起时手里只有 6 秒，盖不住这几段，于是几秒卡一次（普通频道每片 5～7 秒，
 * 冷起就有 15 秒左右，没这个问题）。所以每片不超过 WARMUP_MAX_TD 秒的频道，冷起取到第一份清单后
 * 按它的 TARGETDURATION 续取，等清单历史攒到 WARMUP_SECONDS 再回，最多等 WARMUP_MAX_MS；只多取
 * 四五次清单，之后照常 5 秒一次。CDN 对这类频道只留最近 11 片（8K 是 22 秒），门槛只能定在这以内。
 */
export const WARMUP_MAX_TD = 3
export const WARMUP_SECONDS = 14
export const WARMUP_MAX_MS = 12_000

/**
 * 官方各 CDN 节点进度不一（实测慢的比快的落后一两片），共享刷新又因为重复取会被 403 而几乎每次都换节点，
 * 于是时不时取回一份比手里还旧的清单。以前把它当成换流：清单往回走，清单历史整个清空；短分片频道
 * （CCTV8K 窗口只有 6 秒）接下来再取到快节点时就跳过了一片，播放器少放 2 秒、音画时间戳断开
 * （2026-10-04 libVLC 实测 6 分钟 3 次）。最新一片落后在 LAG_TOLERANCE 片以内的，当作这次没有新内容，
 * 沿用手里那份；落后更多才当真是序号重置。
 */
export const LAG_TOLERANCE = 10

/**
 * 断流恢复后，把清单跳过去的分片接回来（issue #158）。
 *
 * 官方清单只列最新 3 片。断了十几秒再取到时窗口已经滚过去，播放器手里最后一片和新清单第一片
 * 之间缺一两片。同一套回放实测：APTV 遇到这种跳片会停在原地不动（它其实还在取清单、下分片），
 * 把缺的片接回清单前面就自己续上了；跟清单里带不带时间标签无关。
 *
 * 缺的片官方还留着：清单头的 EXT-QQHLS-SEGMENT_RANGE 是 CDN 上现存的序号范围（约 11 片），
 * 同一主机同一令牌只换文件名里的序号就能取。时长清单里没有，用两头的 EXT-QQHLS-START-TIME 相减
 * 再平摊；这个标签只精确到秒，所以每片可能差一两秒（回放里差零点几秒，APTV 和 AVPlayer 照常续播）。
 * 认不出这些标签、缺的片已不在 CDN 留存范围、或算出来的时长离谱时原样返回，不硬补。
 */
const SEGMENT_TAG = /^#(?:EXT-QQHLS-MACHINEID|EXT-QQHLS-START-TIME|EXT-SID|EXT-X-PROGRAM-DATE-TIME|EXTINF)\b/
const firstSeq = text => Number(String(text).match(/^#EXT-X-MEDIA-SEQUENCE:\s*(\d+)/m)?.[1])

// 清单最后一片的序号、开始时刻（秒）和时长：下一份清单拿它判断中间缺了几片、缺了多久
export function tailOf(text) {
  const lines = String(text).replace(/\r/g, '').split('\n')
  const count = lines.filter(line => line.trim() && !line.startsWith('#')).length
  const pick = prefix => Number(lines.findLast(line => line.startsWith(prefix))?.slice(prefix.length).split(',')[0])
  return {
    seq: firstSeq(text) + count - 1,
    start: pick('#EXT-QQHLS-START-TIME:'),
    duration: pick('#EXTINF:'),
  }
}

export function backfillSkipped(text, tail) {
  const first = firstSeq(text)
  const kept = Number(String(text).match(/^#EXT-QQHLS-SEGMENT_RANGE:\s*(\d+)-/m)?.[1])
  const missing = first - tail?.seq - 1
  if (!(missing >= 1) || !(tail.seq + 1 >= kept)) return text
  const lines = String(text).replace(/\r/g, '').split('\n')
  const urlAt = lines.findIndex(line => line.trim() && !line.startsWith('#'))
  const tagAt = lines.findIndex(line => SEGMENT_TAG.test(line))
  if (urlAt < 0 || tagAt < 0 || tagAt > urlAt) return text
  const url = lines[urlAt].trim()
  const start = Number(lines.slice(tagAt, urlAt).find(line => line.startsWith('#EXT-QQHLS-START-TIME:'))?.split(':')[1])
  const each = (start - tail.start - tail.duration) / missing
  if (!url.includes(`-${first}.ts`) || !(each >= 1 && each <= 15)) return text
  const skipped = []
  for (let seq = tail.seq + 1; seq < first; seq++) skipped.push(`#EXTINF:${each.toFixed(3)},`, url.replace(`-${first}.ts`, `-${seq}.ts`))
  lines.splice(tagAt, 0, ...skipped)
  return lines.join('\n')
    .replace(/^#EXT-X-MEDIA-SEQUENCE:.*$/m, `#EXT-X-MEDIA-SEQUENCE:${tail.seq + 1}`)
    .replace(/^#EXT-X-TARGETDURATION:\s*(\d+)/m, (_, declared) => `#EXT-X-TARGETDURATION:${Math.max(Number(declared), Math.ceil(each))}`)
}

// 等 promise 出结果，最多等 ms；没等到回 null
function within(promise, ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), ms)
    promise.then(value => { clearTimeout(timer); resolve(value) })
  })
}

/**
 * 同一媒体序号只下发第一次见到的分片地址（issue #142 / #143）。
 *
 * 同一入口短间隔重取清单官方会回 403，这里随即换备用入口；换票也会换主机和路径令牌。
 * 于是相邻两次刷新里同一序号的分片地址常常不同（实测 2.5 秒一刷，一个序号先后出现
 * 5 个主机）。各节点同序号分片字节完全一致，但 hls.js 1.6+（levelParsingError）和
 * AVPlayer（-12312 Media Entry URL not match previous playlist）都逐片比对新旧清单，
 * 对不上就不再接纳新清单：约 10 秒后卡住，几次之后整条报错停播。实测同一实例同一台，
 * AVPlayer 原样下发 4 分钟卡 5 次后停播，固定地址后零卡顿。
 *
 * 只在文件名相同时沿用旧地址（文件名是「流 ID-序号」），文件名变了说明换了一路流，
 * 以新地址为准。旧地址照样能取：令牌 4 小时有效，窗口内的分片各节点都在。
 * 当前窗口前后 PIN_MARGIN 个序号以外的记录随即剪掉，序号重置也不会串到旧地址。
 */
export const PIN_MARGIN = 30

const fileName = url => new URL(url).pathname.split('/').pop()

export function pinSegmentUrls(text, baseUrl, pins) {
  const body = String(text).replace(/\r/g, '')
  const first = Number(body.match(/^#EXT-X-MEDIA-SEQUENCE:\s*(\d+)/m)?.[1] || 0)
  let seq = first
  const pinned = body.split('\n').map(line => {
    const value = line.trim()
    if (!value || value.startsWith('#')) return line
    const current = seq++
    let url
    try { url = new URL(value, baseUrl).href } catch { return line }
    const previous = pins.get(current)
    if (previous && fileName(previous) === fileName(url)) return previous
    pins.set(current, url)
    return url
  })
  for (const key of pins.keys()) {
    if (key < first - PIN_MARGIN || key >= seq + PIN_MARGIN) pins.delete(key)
  }
  return pinned.join('\n')
}

export function createResolver({
  request = requestPlayUrls,
  select = selectWorkingManifest,
  staleAfterMs = STALE_AFTER_MS,
  staleRecheckMs = STALE_RECHECK_MS,
  // The singleton enables shared polling; injected one-shot resolvers can opt in.
  refreshIntervalMs = 0,
  idleMs = LIVE_IDLE_MS,
  playingMinGapMs = PLAYING_MIN_GAP_MS,
  playingWindowMs = PLAYING_WINDOW_MS,
  // 0 = 不限；单例按 TICKET_BUDGET 启用
  ticketBudget = 0,
  ticketBudgetWindowMs = TICKET_BUDGET_WINDOW_MS,
  // 频道当天的官方节目单 [{ title, start, stop }]（毫秒），版权停播冷却用
  programmesOf = (channel, day) => epg.programmes(channel.livePid, day, { timeoutMs: 5000 }),
  blackoutFallbackMs = BLACKOUT_FALLBACK_MS,
  blackoutRecheckMs = BLACKOUT_RECHECK_MS,
  warmupMaxTd = WARMUP_MAX_TD,
  warmupSeconds = WARMUP_SECONDS,
  warmupMaxMs = WARMUP_MAX_MS,
  // 续取间隔，默认按该频道的 TARGETDURATION；测试注入
  warmupStepMs = 0,
  log = printYellow,
} = {}) {
  const cache = new Map()
  const pending = new Map()
  const cooling = new Map()
  // 频道 -> 版权停播冷却 { reason, until }
  const blackouts = new Map()
  const pins = new Map()
  const histories = new Map()
  const refreshers = new Map()
  // 频道 -> 冷起攒清单的任务（见 WARMUP_SECONDS）；同一频道同时来的请求都等它
  const warmups = new Map()
  // 频道 -> 最近一次播放器请求的时刻；连着两次请求隔得像在轮询才启动共享刷新
  const asks = new Map()
  // 实例级取票预算（令牌桶）：按 ticketBudget / ticketBudgetWindowMs 的速率回填，满桶封顶
  const bucket = { tokens: ticketBudget, at: 0 }
  let budgetAnnouncedAt = -Infinity
  let generation = 0
  // 频道 -> 最近一份成功取回的清单 { text, plain, url, at, tail, stale, sent }；
  // stale = 已经拿它顶过至少一次，sent = 发给过播放器（没等到、后台才取回的那份一开始是没发过的）
  const latest = new Map()
  // 频道 -> 最近一次真正发给播放器的清单的最后一片。跳片要对着它算：没等到、在后台才取回的清单
  // 没发出去过，拿它当「上一份」会以为不缺片
  const served = new Map()

  function remember(ref, urls, manifest, expiresAt) {
    // 保存取票接口给的入口；CDN 重定向后的临时媒体地址可能很快失效，不能
    // 将它作为未来 5 分钟唯一的取流地址。成功的主/备入口优先尝试。
    const preferred = urls.includes(manifest.sourceUrl) ? manifest.sourceUrl : urls[0]
    cache.set(ref, {
      url: manifest.url,
      urls: [...new Set([preferred, ...urls])],
      expiresAt,
    })
  }

  async function acquire(ref, channel, ctx) {
    let current = pending.get(ref)
    if (current) return current
    const epoch = generation
    current = (async () => {
      let lastError
      const cached = cache.get(ref)
      if (cached && Number(ctx.now ?? Date.now()) < cached.expiresAt) {
        try {
          const manifest = await select(cached.urls, ctx)
          if (epoch === generation) remember(ref, cached.urls, manifest, cached.expiresAt)
          return manifest
        } catch (error) {
          lastError = error
          cache.delete(ref)
        }
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { urls } = await request(channel, ctx)
          const manifest = await select(urls, ctx)
          if (epoch === generation) remember(ref, urls, manifest, Number(ctx.now ?? Date.now()) + CACHE_MS)
          return manifest
        } catch (error) {
          lastError = error
          if (BLACKOUT.test(error?.message || '')) break
        }
      }
      throw lastError
    })().finally(() => {
      if (pending.get(ref) === current) pending.delete(ref)
    })
    pending.set(ref, current)
    return current
  }

  // AbortError 的原生文案是英文的 This operation was aborted，直接抛进日志没人看得懂
  const reasonOf = error => error?.name === 'AbortError' ? '请求超时' : (error?.message || String(error))

  function keep(key, channel, manifest, ctx) {
    const previous = latest.get(key)
    // 同一次取回的清单会被每个在等它的请求各交来一次，只处理第一次
    if (previous?.source === manifest) return previous
    // 落在慢节点上，比手里的旧：当作没有新内容（见 LAG_TOLERANCE）
    const behind = previous?.tail?.seq - tailOf(manifest.text).seq
    if (behind > 0 && behind <= LAG_TOLERANCE) return previous
    if (!pins.has(key)) pins.set(key, new Map())
    const at = Number(ctx.now ?? Date.now())
    const filled = backfillSkipped(manifest.text, served.get(key))
    const pinned = pinSegmentUrls(manifest.text, manifest.url, pins.get(key))
    if (!histories.has(key)) histories.set(key, createPlaylistHistory())
    // History only contains genuinely observed segments with exact durations.
    // The existing estimated gap repair remains separate, for native players.
    const plain = histories.get(key).extend(pinned, at)
    const text = filled === manifest.text ? plain : pinSegmentUrls(filled, manifest.url, pins.get(key))
      .replace(/^#EXT-X-TARGETDURATION:\s*(\d+)/m, (_, n) => `#EXT-X-TARGETDURATION:${Math.max(Number(n), Number(plain.match(/^#EXT-X-TARGETDURATION:\s*(\d+)/m)?.[1]) || 0)}`)
    const tail = tailOf(manifest.text)
    if (previous?.stale) log(`[央视频] ${channel.name} 官方入口恢复，隔了 ${Math.round((at - previous.at) / 1000)} 秒拿到新清单`)
    if (filled !== manifest.text) log(`[央视频] ${channel.name} 新清单跳过了 ${firstSeq(manifest.text) - firstSeq(filled)} 片，已接回`)
    const entry = {
      source: manifest, text, plain, url: manifest.url, at, stale: false, tail,
      covered: histories.get(key).seconds,
      targetDuration: Number(manifest.text.match(/^#EXT-X-TARGETDURATION:\s*(\d+)/m)?.[1]) || 0,
    }
    latest.set(key, entry)
    return entry
  }

  function answer(key, entry, ctx, desc) {
    renew(key, ctx)
    served.set(key, entry.tail)
    entry.sent = true
    // libVLC 另拿一份清单视图（见 libvlc-view.js）。垫片由本机提供，所以只在外壳给了
    // selfBase（清单直出）时才换；改写不了的清单 libvlcPlaylist 回 null，照旧下发原样。
    const forLibvlc = ctx.selfBase && LIBVLC_UA.test(String(ctx.client?.ua || ''))
    return {
      url: entry.url,
      manifestText: (forLibvlc && libvlcPlaylist(entry.plain, `${ctx.selfBase}${FILLER_PATH}`)) || entry.text,
      manifestUrl: entry.url,
      upstreamHeaders: UPSTREAM_HEADERS,
      desc,
    }
  }

  function fetchFresh(key, channel, ctx) {
    const epoch = generation
    return acquire(key, channel, ctx)
      .then(manifest => epoch === generation
        ? { entry: keep(key, channel, manifest, ctx) }
        : { error: new Error('解析缓存已重置') })
      .catch(error => {
        if (epoch === generation && error?.allForbidden) {
          cooling.set(key, { until: Number(ctx.now ?? Date.now()) + FORBIDDEN_COOLDOWN_MS })
        }
        if (epoch === generation && BLACKOUT.test(reasonOf(error))) startBlackout(key, channel, reasonOf(error), Number(ctx.now ?? Date.now()))
        return { error }
      })
  }

  function startBlackout(key, channel, reason, now) {
    const current = blackouts.get(key)
    if (current && now < current.until) return
    const entry = { reason, until: now + blackoutFallbackMs }
    blackouts.set(key, entry)
    Promise.resolve()
      .then(() => programmesOf(channel, shanghaiDay(now)))
      .then(list => (list || []).find(show => show.start <= now && now < show.stop), () => null)
      .then(show => {
        if (blackouts.get(key) !== entry) return
        if (show) entry.until = Math.min(show.stop, now + blackoutRecheckMs)
        const title = show ? `（当前节目《${show.title}》）` : '（节目单里查不到当前节目）'
        log(`[央视频] ${channel.name} 版权停播${title}，${shanghaiClock(entry.until)} 前不再向官方请求`)
      })
  }

  // 短分片频道冷起：按 TARGETDURATION 续取，清单历史攒到 warmupSeconds 再交给播放器（见 WARMUP_SECONDS）。
  // 清单认不出（历史为 0）、片不短或已经够了就原样返回；续取出错就拿手里有的先回。
  function warmUp(key, channel, entry, ctx) {
    const step = warmupStepMs || entry.targetDuration * 1000
    if (!(step > 0 && entry.targetDuration <= warmupMaxTd && entry.covered > 0 && entry.covered < warmupSeconds)) return entry
    const running = warmups.get(key)
    if (running) return running
    const task = (async () => {
      const deadline = Date.now() + warmupMaxMs
      let current = entry
      while (current.covered < warmupSeconds && Date.now() + step <= deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, step))
        const pollContext = { ...ctx }
        delete pollContext.now
        const outcome = await fetchFresh(key, channel, pollContext)
        if (outcome.error) break
        current = outcome.entry
      }
      return current
    })().finally(() => { if (warmups.get(key) === task) warmups.delete(key) })
    warmups.set(key, task)
    return task
  }

  // 已在跑的共享刷新续一下活跃时间，不新开
  function renew(key, ctx) {
    const state = refreshers.get(key)
    if (state) { state.touched = Date.now(); state.ctx = ctx }
  }

  function touch(key, channel, ctx) {
    if (!(refreshIntervalMs > 0) || !latest.has(key)) return
    if (refreshers.has(key)) return renew(key, ctx)
    const state = { touched: Date.now(), ctx, timer: null }
    refreshers.set(key, state)
    const tick = async () => {
      if (refreshers.get(key) !== state) return
      if (Date.now() - state.touched >= idleMs) { refreshers.delete(key); return }
      const cooled = cooling.get(key)
      const blackout = blackouts.get(key)
      if ((!cooled || Date.now() >= cooled.until) && (!blackout || Date.now() >= blackout.until)) {
        // Fresh wall time: do not carry a foreground request's timestamp into
        // a later poll. Pending acquisition still coalesces with client requests.
        const pollContext = { ...state.ctx }
        delete pollContext.now
        const outcome = await fetchFresh(key, channel, pollContext)
        if (refreshers.get(key) !== state) return
        if (outcome.error) {
          const previous = latest.get(key)
          if (previous && !previous.stale) {
            previous.stale = true
            log(`[央视频] ${channel.name} 后台清单刷新失败（${reasonOf(outcome.error)}），先把上一份清单回给播放器`)
          }
        }
      }
      if (refreshers.get(key) === state) {
        state.timer = setTimeout(tick, refreshIntervalMs)
        state.timer.unref?.()
      }
    }
    state.timer = setTimeout(tick, refreshIntervalMs)
    state.timer.unref?.()
  }

  function refillBudget(now) {
    if (now <= bucket.at) return
    bucket.tokens = Math.min(ticketBudget, bucket.tokens + (now - bucket.at) * ticketBudget / ticketBudgetWindowMs)
    bucket.at = now
  }

  // 冷启动花一张票；桶空回 ok:false，并给出大约几秒后攒得出下一张
  function takeTicket(now) {
    refillBudget(now)
    if (bucket.tokens >= 1) { bucket.tokens -= 1; return { ok: true } }
    return { ok: false, wait: Math.max(1, Math.ceil((1 - bucket.tokens) * ticketBudgetWindowMs / ticketBudget / 1000)) }
  }

  async function resolve(ref, ctx = {}) {
    const key = String(ref || '')
    const channel = CHANNEL_BY_REF.get(key)
    if (!channel) return { url: '', desc: '央视频频道引用格式错误' }
    const now = Number(ctx.now ?? Date.now())
    // 隔得像播放器在轮询的第二次请求才启动共享刷新；已在跑的只续活跃时间
    const asked = asks.get(key)
    asks.set(key, now)
    const gap = asked == null ? NaN : now - asked
    if (gap > playingMinGapMs && gap <= playingWindowMs) touch(key, channel, ctx)
    else renew(key, ctx)
    const held = latest.get(key)
    const spare = held && now - held.at <= STALE_MAX_MS ? held : null
    const standIn = () => answer(key, spare, ctx, `${channel.name} 暂时取不到新清单，先回上一份`)
    const cooled = cooling.get(key)
    if (cooled && now < cooled.until) {
      if (spare) { spare.stale = true; return standIn() }
      const seconds = Math.ceil((cooled.until - now) / 1000)
      return { url: '', desc: `${channel.name}链接请求失败：官方 CDN 刚回 403（疑似限流），冷却中，${seconds} 秒后再向官方请求` }
    }
    cooling.delete(key)
    const blackout = blackouts.get(key)
    if (blackout && now < blackout.until) {
      return { url: '', silent: true, desc: `${channel.name}链接请求失败：${blackout.reason}（版权停播，${shanghaiClock(blackout.until)} 前不再向官方请求）` }
    }
    blackouts.delete(key)
    // 正在冷起攒清单：同一频道后来的请求一起等它，不拿攒了一半的薄清单先走
    const warming = warmups.get(key)
    if (warming) return answer(key, await warming, ctx, `${channel.name} H.264 播放地址获取成功`)
    // 没等到、在后台才取回的清单还没发给过播放器：直接给它，不让播放器再陪着取一次
    if (spare && !spare.sent) return answer(key, spare, ctx, `${channel.name} H.264 播放地址获取成功`)
    if (refreshIntervalMs > 0 && spare && !spare.stale && now - spare.at < refreshIntervalMs) {
      return answer(key, spare, ctx, `${channel.name} H.264 播放地址获取成功`)
    }
    // 冷启动（30 秒内没有这个频道的清单、也没人正在取）要花一张实例级取票预算
    if (ticketBudget > 0 && !spare && !pending.has(key)) {
      const ticket = takeTicket(now)
      if (!ticket.ok) {
        const seconds = ticketBudgetWindowMs / 1000
        if (now - budgetAnnouncedAt >= 10_000) {
          budgetAnnouncedAt = now
          log(`[央视频] ${seconds} 秒内已为 ${ticketBudget} 个新频道向官方取票，疑似播放器批量探测，暂停新频道取票约 ${ticket.wait} 秒（最近：${ctx.client?.tag || '未知客户端'} 请求 ${channel.name}）；正在播放的频道不受影响`)
        }
        return { url: '', silent: true, desc: `${channel.name}链接请求失败：央视频 ${seconds} 秒内已为 ${ticketBudget} 个新频道取票，疑似播放器批量探测，已暂停新频道取票，约 ${ticket.wait} 秒后恢复（正在播放的频道不受影响）` }
      }
    }
    // 结果统一收成 { entry } 或 { error }：后台跑完没人等的那一次也得把冷却记上，且不留未处理的拒绝
    const fresh = fetchFresh(key, channel, ctx)
    const patient = LIBVLC_UA.test(String(ctx.client?.ua || ''))
    const wait = !spare ? Infinity : !spare.stale ? staleAfterMs : patient ? staleRecheckMs : 0
    const outcome = wait === Infinity ? await fresh : wait ? await within(fresh, wait) : null
    // 新取得的正文立即交给播放器（短分片频道冷起时先攒一攒）；正常时复用最多一个共享刷新周期。
    if (outcome?.entry) {
      const entry = spare ? outcome.entry : await warmUp(key, channel, outcome.entry, ctx)
      return answer(key, entry, ctx, `${channel.name} H.264 播放地址获取成功`)
    }
    if (spare) {
      if (!spare.stale) {
        spare.stale = true
        const why = outcome ? reasonOf(outcome.error) : `${staleAfterMs / 1000} 秒没取到新清单（还在取）`
        log(`[央视频] ${channel.name} ${why}，先把上一份清单回给播放器`)
        if (!outcome) fresh.then(late => { if (late.error) log(`[央视频] ${channel.name}链接请求失败：${reasonOf(late.error)}`) })
      }
      return standIn()
    }
    const reason = reasonOf(outcome.error)
    if (outcome.error?.allForbidden) {
      return { url: '', desc: `${channel.name}链接请求失败：${reason}，${FORBIDDEN_COOLDOWN_MS / 1000} 秒内暂停向官方请求` }
    }
    return { url: '', desc: `${channel.name}链接请求失败：${reason}` }
  }

  function clear() {
    generation++
    for (const state of refreshers.values()) clearTimeout(state.timer)
    refreshers.clear()
    cache.clear()
    pending.clear()
    cooling.clear()
    blackouts.clear()
    pins.clear()
    latest.clear()
    served.clear()
    histories.clear()
    warmups.clear()
    asks.clear()
    // 取票预算不随缓存清空重置：它量的是出口 IP 最近一分钟的消耗，不是缓存
  }

  return { resolve, clear, cache, pending, cooling, blackouts, pins, latest }
}

const resolver = createResolver({ refreshIntervalMs: LIVE_REFRESH_MS, ticketBudget: TICKET_BUDGET })
export const resolveChannel = resolver.resolve
export const clearCache = resolver.clear
