/**
 * 抓取模块：哔哩哔哩直播。
 *
 * 模块契约（见 extractors/registry.js 顶部注释）里，本模块用到的部分：
 *   fetch(config, ctx)  → { groups: [{name, dataList}], meta }   只挑直播间，频道落 deferredRef
 *   resolve(ref, ctx)   → { url, desc, relayHls, upstreamHeaders }  播放时才换签名地址
 * 早先它是直链模块：把带 expires 的地址直接写进播放列表、靠 45～90 分钟刷新兜
 * 「约 2 小时」过期。实测签名只有 60 分钟，且播放器不重拉列表就拿不到新地址，
 * 表现为「每隔一段时间全部失效、手动刷新才恢复」（issue #120）——改成与虎牙 /
 * 斗鱼同款的播放时解析 + 本机中继清单后，播放列表里的地址永远有效。
 */
import { fetchRoom, resolveRoom, claimsRef, clearResolveCache, checkLogin, parseRoomList, mapLimit, areaList, topRoomsOfArea, qrLoginStart, qrLoginPoll, RiskControlError, RoomOfflineError, BILIBILI_GROUP, DEFAULT_MIN_ONLINE } from './api.js'

// 并发上限。B 站对短时间内的大量请求会回 -352，实测 3 路是安全且够快的折中；
// 外部源那边「串行 + 每个之间硬睡 2 秒」的做法在房间数上去之后是分钟级，不抄。
const CONCURRENCY = 3

/**
 * 这一轮算不算失败。
 *
 * 一条都没解析出来、且至少有一间房是真出错（不是没开播）→ 判失败，交给
 * extractorManager 保留上一轮缓存并退避重试，而不是把用户的频道清空。
 * 反之，全部房间都没开播时如实返回 0 条：那是「今天没人播」这个正常状态。
 *
 * 抽成纯函数是为了能单测——否则要真断网才走得到这条路径。
 */
export function shouldFailRound(groupCount, hardErrors) {
  return groupCount === 0 && hardErrors > 0
}

/**
 * 「自动加入热门直播间的分区」那个多行文本框 → 分区名数组。
 * 与 parseRoomList 同款约定：一行一个、去首尾空白、忽略空行与 # 开头的注释。
 */
export function parseAreaNames(text) {
  return String(text || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
}

/**
 * 手填清单 + 热门榜 → 去重后的抓取清单。
 *
 * 手填的排前面：那是用户明确指定的主播，热门榜只是「顺便给点内容」；顺序还决定了
 * 同名频道在播放器「源1 / 源2」里的先后。
 * 去重按房间号的字符串形式——热门榜里可能正好有用户已经手填过的那个房间，
 * 不去重的话同一个直播间会在播放列表里出现两次（同名、同地址，纯噪音）。
 */
export function mergeRoomRefs(manual, auto) {
  const seen = new Set()
  const out = []
  for (const ref of [...(manual || []), ...(auto || [])]) {
    const key = String(ref)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ref)
  }
  return out
}

/**
 * 不论直播间原本属于赛事 / 娱乐 / 网游等哪个 B 站分区，播放列表统一归到「B站」。
 * 分区仍用于热门榜选房间，只是不再泄漏成 IPTV 的顶层分组，避免用户选多个分区后
 * 侧边栏被拆成一串含义过宽的「赛事」「娱乐」组。
 */
export function groupBilibiliResults(results, warnings = []) {
  const dataList = []
  const seenRooms = new Set()
  for (const result of results || []) {
    if (!result) continue
    if (result.roomId) {
      if (seenRooms.has(result.roomId)) continue
      seenRooms.add(result.roomId)
    }
    if (result.warning) warnings.push(result.warning)
    dataList.push({ ...result.channel, groupTitle: BILIBILI_GROUP })
  }
  return dataList.length ? [{ name: BILIBILI_GROUP, dataList }] : []
}

/**
 * 按配置的分区名，取各分区人气前 N 的直播间。
 *
 * 存在的理由：不这么做的话，用户想用 B 站直播就得自己去网页上一个个找房间号——
 * 那是这个模块最劝退的一步。默认填「赛事」，开箱就是当前正在打的比赛。
 *
 * **不硬编码房间号**：主播会退播、赛事会结束，写死的清单必然烂掉。每轮抓取现查，
 * 拿到的永远是此刻真在播的。
 *
 * 失败不抛，但要**分账记**：「分区名写错」是配置问题，只记 warning；「分区清单 /
 * 热门榜接口获取失败」是网络层问题，除记 warning 外还计入 fetchFailures——
 * 外层 fetch() 把它并进 hardErrors 交给 shouldFailRound 判整轮成败。不分账的话，
 * 默认配置（纯热门榜、不手填）下一次断网 / 接口 5xx 会被当成「正常抓到 0 个
 * 直播间」，上一轮的频道被覆盖成空且不退避重试；这里抛的话，一个写错的分区名
 * 又会让整个模块报失败。两头都不对，所以记账、让外层按「还有没有别的收成」裁决。
 *
 * @returns {Promise<{rooms: number[], warnings: string[], fetchFailures: number, failureMessages: string[]}>}
 */
async function collectTopRooms(config, ctx) {
  const perArea = Number(config.topPerArea)
  const names = parseAreaNames(config.topAreas)
  if (!(perArea > 0) || !names.length) return { rooms: [], warnings: [], fetchFailures: 0, failureMessages: [] }

  const options = { timeoutMs: ctx.timeoutMs || 10000 }
  const warnings = []
  // 网络层失败的原话单独记一份：整轮判失败时错误消息要引用**这里**的原因，
  // 不能拿 warnings[0]——那可能是「分区名不存在」这类配置提示，归因会张冠李戴。
  const failureMessages = []

  let areas
  try {
    areas = await areaList(options)
  } catch (error) {
    // 风控要往上抛：让 health() 报「被风控」而不是一条不起眼的 warning
    if (error instanceof RiskControlError) throw error
    const message = `分区清单获取失败，本轮不自动加入热门直播间：${error.message}`
    return { rooms: [], warnings: [message], fetchFailures: 1, failureMessages: [message] }
  }

  const byName = new Map(areas.map(area => [area.name, area.id]))
  const rooms = []
  for (const name of names) {
    const id = byName.get(name)
    if (id == null) {
      warnings.push(`分区「${name}」在 B 站不存在，已跳过（当前可用：${areas.map(a => a.name).join(' / ')}）`)
      continue
    }
    try {
      // topRoomsOfArea 内部已经按用户配置滤过人气下限并截到 perArea 个（见 selectTopRooms）
      rooms.push(...await topRoomsOfArea(id, perArea, { ...options, minOnline: config.minOnline }))
    } catch (error) {
      // 风控要往上抛：让 health() 报「被风控」而不是一条不起眼的 warning
      if (error instanceof RiskControlError) throw error
      const message = `分区「${name}」热门榜获取失败，已跳过：${error.message}`
      failureMessages.push(message)
      warnings.push(message)
    }
  }
  return { rooms, warnings, fetchFailures: failureMessages.length, failureMessages }
}

export default {
  id: 'bilibili-live',
  name: '哔哩哔哩直播',
  description: '按分区加入 B 站热门直播间，也可手动指定房间；播放时即时换取一小时有效的地址，本机中继清单并补齐防盗链请求头。',
  category: 'live',

  // 结果小（一个房间一条）、只有房间名单没有短效地址，可以落盘缓存，失败时用它兜底。
  capabilities: { cache: 'disk', resolve: true, epg: false },

  // 刷新周期只决定多久重挑一次直播间（热门榜换人、主播下播）；播放地址在播放时
  // 现换，与这里无关。下限 15 是给风控留的余量（一轮约 3 个请求 × 房间数），
  // 上限与虎牙 / 斗鱼对齐；默认沿用 45，老用户存过的值不会越界回落。
  defaultRefreshMinutes: 45,
  minRefreshMinutes: 15,
  maxRefreshMinutes: 120,

  // 后台在这个模块的卡片里额外渲染一块助手 UI（markup 在 admin.html，与咪咕的
  // migu-bookmarklet 同款约定：具体长相属于前端，模块只声明「我要哪一块」）。
  helper: 'bilibili-login',
  // 挂在「登录态」那一段的开头，而不是整个表单最上面
  helperSection: '登录态（选填）',

  // 扫码登录。声明成通用的 loginFlow 而不是在 API 层写死 B 站：将来别的模块
  // （比如咪咕）想加扫码/授权流程，声明同样的两个函数即可，不用动框架。
  //   start()      → { url, key }   url 是要编成二维码的内容
  //   poll(key, {cookie}) → { status, message, sessdata? }  status: pending|scanned|expired|failed|ok
  //   start() 返回的 cookie 是这次登录的设备标识，由 API 层与 key 绑定后在 poll 时回传
  //   configKey    → 登录成功后把凭据写进哪个配置字段
  loginFlow: {
    configKey: 'sessdata',
    start: qrLoginStart,
    poll: qrLoginPoll,
  },

  configSchema: [
    // 「频道从哪来」有两条路，而且可以同时用。原先它们平铺成兄弟项、手填的还排在
    // 前面，用户第一眼看不出该用哪个。现在自动的排前面（那是默认路径、开箱即用），
    // 手填的排后面并写明「可留空」，再靠 section 归到同一段里。
    {
      key: 'topAreas',
      section: '频道从哪来 —— 两种可以同时用，结果取并集（重复的直播间只出现一次，手填的排在前面）',
      group: '① 自动：按分区加入热门直播间',
      label: '选择分区（可多选）',
      type: 'multiselect',
      options: [
        { value: '赛事', label: '赛事' },
        { value: '知识', label: '知识' },
        { value: '生活', label: '生活' },
        { value: '网游', label: '网游' },
        { value: '手游', label: '手游' },
        { value: '单机游戏', label: '单机游戏' },
        { value: '娱乐', label: '娱乐' },
        { value: '电台', label: '电台' },
        { value: '虚拟主播', label: '虚拟主播' },
        { value: '聊天室', label: '聊天室' },
        { value: '互动玩法', label: '互动玩法' },
        { value: '购物', label: '购物' },
      ],
      // 「赛事 + 知识」兼顾官方比赛与新闻 / 教育 / 科普，适合电视端长时间观看；
      // 每区最多 8 路且仍受最低人气过滤，合并到一个 B站 组后总量也可控。
      default: '赛事\n知识',
      hint: '默认勾选「赛事、知识」。至少选择一个；想只用右边手填的直播间，把下面「每个分区取前几名」设为 0。所有频道在播放列表里统一归入「B站」组。',
    },
    {
      key: 'topPerArea',
      section: '频道从哪来 —— 两种可以同时用，结果取并集（重复的直播间只出现一次，手填的排在前面）',
      group: '① 自动：按分区加入热门直播间',
      label: '每个分区取前几名',
      type: 'int',
      min: 0,
      max: 20,
      // 8 而不是 5：实测赛事区人气在第 6~7 名之间有 82% 的断崖，取 5 会漏掉
      // 「第五人格 IVL 夏季赛总决赛」这种 300 万人在看的比赛。8 正好覆盖到断崖处。
      default: 8,
      hint: '按人气从高到低，是上限不是保证。人气过低的会被自动滤掉（免得把同一场比赛的多机位小号也拉进来），所以清闲时段实际条数会少于这个值。填 0 ＝ 只关掉左边这一列，右边手填的照常生效。',
    },
    {
      key: 'minOnline',
      section: '频道从哪来 —— 两种可以同时用，结果取并集（重复的直播间只出现一次，手填的排在前面）',
      group: '① 自动：按分区加入热门直播间',
      label: '最低人气',
      type: 'int',
      min: 0,
      max: 100000000,
      default: DEFAULT_MIN_ONLINE,
      hint: '低于该人气的直播间不自动加入。B 站“人气”不是实际观看人数且量级会调整；默认 3000 能保留多数正常赛事并过滤低热度重复机位。填 0 ＝ 不设人气门槛。',
    },
    {
      key: 'rooms',
      section: '频道从哪来 —— 两种可以同时用，结果取并集（重复的直播间只出现一次，手填的排在前面）',
      group: '② 手动：指定直播间',
      label: '房间号 / 直播间地址（一行一个，可留空）',
      type: 'text',
      multiline: true,
      placeholder: '一行一个：房间号 / 直播间地址 / b23.tv 短链\n13\nhttps://live.bilibili.com/1022\n# 井号开头是注释',
      hint: '想固定看某个主播时才填，不填也能用。房间号是地址路径里的数字，不是 live_from= 那种参数，直接粘完整地址最稳。未开播的房间会自动跳过。这里填的排在热门榜之前。',
      default: '',
    },
    {
      key: 'sessdata',
      section: '登录态（选填）',
      label: 'SESSDATA（登录态）',
      type: 'text',
      secret: true,
      // 没有 env 兜底的话，docker 用户没法在 compose 里注入凭据。这里让 schema
      // 自己声明环境变量名，由 extractorManager 统一兜底——比给每个模块往
      // config.js 里加一个全局字段更能扩展（每加一个模块就要动 5 个文件）。
      env: 'mbiliSessdata',
      hint: '不填也能用，但画质会被限制在「超清」。填了才有「原画」。等同登录态，别外传。',
      default: '',
    },
    // 直链时代的「优先 HLS」「播放缓冲」已下线：播放时解析统一走 HLS 清单中继
    // （FLV 得由本机整条转发，白占 NAS 带宽），缓冲提示则从来到不了订阅端
    // （omitPlayerOnlyOpts 会剥掉）。旧配置里残留的这两个键会被 resolveConfig 忽略。
    {
      key: 'preferAvc',
      section: '播放偏好',
      label: '优先 H.264',
      type: 'boolean',
      hint: '关掉则优先 HEVC（H.265）。老电视盒子多数解不了 HEVC，默认开着更稳。改动后下一次播放生效。',
      default: true,
    },
  ],

  // 登录态失效时 B 站照样给流、只是封顶超清，播放时分不出来，只能刷新时问
  credentialCheck: { refresh: true, playback: false, degrade: '登录态失效时 B 站照样给流，画质封顶「超清」' },

  /**
   * @param {object} config 已由 extractorManager 按 configSchema 校验并补齐默认值
   * @param {object} ctx    { timeoutMs, signal }
   */
  async fetch(config, ctx = {}) {
    const manualRefs = parseRoomList(config.rooms)
    const cookie = config.sessdata ? `SESSDATA=${config.sessdata}` : ''
    // 登录态检查只做提示：失效时 B 站照样给流（封顶超清），频道照常抓
    const [autoResult, login] = await Promise.all([
      collectTopRooms(config, ctx),
      checkLogin(cookie, { timeoutMs: ctx.timeoutMs || 10000, fetchImpl: ctx.fetchImpl }),
    ])
    const loginWarnings = login.warning ? [login.warning] : []
    // 没查成（超时、412）不下结论，后台沿用上一轮（registry.js）
    const credentialRejected = login.warning ? undefined : (login.rejected || '')

    const refs = mergeRoomRefs(manualRefs, autoResult.rooms)

    if (!refs.length) {
      // 一间房都没有，且热门榜是「获取失败」而非「没配 / 没人播」——这一轮就是
      // 失败，必须抛：返回空的话会被记成「成功抓到 0 频道」，上一轮缓存被覆盖成
      // 空、consecutiveFailures 归零，既不退避也要等满刷新周期才重试。默认配置
      // 正是纯热门榜，一次瞬时网络故障就会清空全部 B 站频道。
      if (autoResult.fetchFailures > 0) {
        throw new Error(autoResult.failureMessages[0] || '热门榜获取失败，本轮没有可抓的直播间')
      }
      return {
        groups: [],
        meta: {
          skipped: [],
          warnings: [...autoResult.warnings, ...loginWarnings, '没有可抓的直播间——填几个房间号，或在「自动加入热门直播间的分区」里填个分区名'],
          credentialRejected,
        },
      }
    }

    const options = {
      cookie,
      preferAvc: config.preferAvc !== false,
      timeoutMs: ctx.timeoutMs || 10000,
      fetchImpl: ctx.fetchImpl,
    }

    const skipped = []
    const warnings = [...autoResult.warnings, ...loginWarnings]
    let riskControl = null
    // 第一条「真出错」（非未开播）的原话，供整轮失败时归因——skipped[0] 靠不住，
    // 它多半是「未开播」这个被明确定义为正常状态的原因。
    let firstHardReason = null
    // 「没开播」与「出错了」要分开计：两者都产出 0 个频道，但前者是正常状态、
    // 后者是这一轮失败了。混在一起的话，断网时会被记成「成功抓到 0 个频道」，
    // 把上一轮的缓存覆盖成空——用户的频道就此消失且不退避重试。
    // 热门榜的网络层失败也计进来：手填的房间恰好都没开播 + 热门榜挂了，同样
    // 该判整轮失败保缓存，而不是「成功 0 频道」。
    let hardErrors = autoResult.fetchFailures

    const results = await mapLimit(refs, CONCURRENCY, async (ref) => {
      try {
        return await fetchRoom(ref, options)
      } catch (error) {
        // 风控是全局性的：记下来，等这一轮跑完统一往上抛，让 health() 报
        // 「被风控」而不是一串「未开播」——后者会让用户以为主播都下播了。
        if (error instanceof RiskControlError) {
          riskControl = riskControl || error
          return null
        }
        if (!(error instanceof RoomOfflineError)) {
          hardErrors++
          firstHardReason = firstHardReason || error.message
        }
        skipped.push({ ref: String(ref), reason: error.message })
        return null
      }
    })

    if (riskControl) throw riskControl

    // 所有 B 站频道统一归到「B站」组，与咪咕/外部源的 [{name, dataList}] 同构。
    // mergeRoomRefs 只按用户填的字面量去重，URL / 短号 / 短链写法各异时同一间房
    // 会漏网（rooms 字段还推荐「直接粘完整地址」）——这里按归一后的真实房间号
    // 再去一次重。refs 手填在前、mapLimit 按下标写结果，保留首个即保留手填优先序。
    const groups = groupBilibiliResults(results, warnings)

    if (shouldFailRound(groups.length, hardErrors)) {
      // 归因要分账：热门榜接口失败与直播间获取失败是两码事，混着算分子会把
      // 「热门榜挂了 + 手填的都没开播」报成「N/M 个直播间获取失败：未开播」。
      const roomErrors = hardErrors - autoResult.fetchFailures
      const parts = []
      if (autoResult.fetchFailures > 0) parts.push(autoResult.failureMessages[0])
      if (roomErrors > 0) parts.push(`${roomErrors}/${refs.length} 个直播间获取失败：${firstHardReason || '未知原因'}`)
      throw new Error(`${parts.join('；')}（本轮无一成功，沿用上一轮结果）`)
    }

    return {
      groups,
      meta: { skipped, warnings, requested: refs.length, hardErrors, credentialRejected },
    }
  },

  claimsRef,
  resolve: resolveRoom,
  clearResolveCache,
}
