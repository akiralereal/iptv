/**
 * 频道级播放选项（#EXTVLCOPT）的统一契约。
 *
 * 有些直播源不是拿到地址就能播——B 站、虎牙一类带防盗链，请求头不对就 403。
 * 这类信息没法塞进 EXTINF 属性，标准做法是在 EXTINF 和播放地址之间插
 * #EXTVLCOPT 行，由播放器转成请求头。
 *
 * 实测（2026-08，B 站 cn-gotcha104 节点）：真正卡的是 User-Agent 而不是 Referer
 * ——裸请求 403、只给 Referer 仍 403、只给浏览器 UA 就 200。所以别把 Referer
 * 当成唯一必需项；两条都带上，成本为零且能兼容各家不同的校验口径。
 *
 * 频道对象上以 `opts: string[]` 承载（元素形如 `http-referrer=https://...`），
 * 解析、回读、生成三处都走这里，避免各写一套。
 *
 * 注意：opts 可能来自用户添加的第三方订阅（不可信输入）。渲染进播放列表等于
 * 把内容写进一个换行敏感的格式里，因此这里做两层限制——键名白名单 + 含换行/
 * 控制字符者整条拒收，防止一条 opt 撑开成任意 M3U 指令（与 EXTINF 属性消毒同理）。
 */

const OPT_PREFIX = '#EXTVLCOPT:'

// 会被播放器转成 HTTP 请求头的键。**只有这些**才意味着「缺了就播不了」，
// 也只有这些才该让频道从 txt 订阅里被跳过（txt 放不下请求头）。
// http-cookie 之类可能携带凭据的一律不收，需要鉴权的源应当在抓取侧换成带
// token 的地址，而不是把凭据发给播放器。
const HEADER_KEYS = new Set([
  'http-referrer',
  'http-user-agent',
  'http-origin',
])

// 纯播放器提示，与请求头无关。缺了它频道照播不误，只是缓冲行为不同。
// 公开 IPTV 源里 `#EXTVLCOPT:network-caching=1000` 是极常见的写法，把它算成
// 「依赖请求头」会让一大批本来好好的频道被 txt 侧误伤。
const PLAYER_KEYS = new Set([
  'network-caching',
])

const ALLOWED_KEYS = new Set([...HEADER_KEYS, ...PLAYER_KEYS])

/**
 * 判断一行是否 #EXTVLCOPT 指令。
 */
export function isOptLine(line) {
  return typeof line === 'string' && line.trimStart().startsWith(OPT_PREFIX)
}

/**
 * 把一行 #EXTVLCOPT 解析成 `key=value`，不合法或不在白名单内返回 null。
 */
export function parseOptLine(line) {
  if (!isOptLine(line)) return null
  return sanitizeOpt(line.trim().slice(OPT_PREFIX.length))
}

// 单条 opt 的长度上限。正常 UA 不过两百字符，留足余量即可，
// 免得畸形订阅把超长串灌进每一行播放列表。
const MAX_OPT_LENGTH = 1024

/**
 * 清洗单条 `key=value`：白名单校验 + 拒收含换行/控制字符者。不合法返回 null。
 *
 * 含换行的一律整条丢弃，而不是把换行剔掉后留用——后者会把注入内容粘成一条
 * 语法合法、值却是垃圾的 opt（Referer 变成 `http://a/#EXTINF...`），播放器照发不误，
 * 结果是静默播不了。宁可丢掉这条 opt，让频道以「没有请求头」的确定状态失败。
 */
export function sanitizeOpt(raw) {
  if (typeof raw !== 'string') return null
  if (raw.length > MAX_OPT_LENGTH) return null
  // 换行会撑出额外的 M3U 指令；其余 C0 控制字符进请求头同样无意义
  if (/[\r\n\u0000-\u001f\u007f]/.test(raw)) return null

  const trimmed = raw.trim()
  const eq = trimmed.indexOf('=')
  if (eq <= 0) return null

  const key = trimmed.slice(0, eq).trim().toLowerCase()
  const value = trimmed.slice(eq + 1).trim()
  if (!ALLOWED_KEYS.has(key) || !value) return null

  return `${key}=${value}`
}

/**
 * 清洗一组 opts：逐条过白名单、去重、保序。恒返回数组。
 */
export function sanitizeOpts(opts) {
  if (!Array.isArray(opts)) return []
  const seen = new Set()
  const out = []
  for (const item of opts) {
    const clean = sanitizeOpt(item)
    if (!clean || seen.has(clean)) continue
    seen.add(clean)
    out.push(clean)
  }
  return out
}

/**
 * 从 EXTINF 行之后收集连续的 #EXTVLCOPT，直到遇到播放地址。
 *
 * @param {string[]} lines 已按行切分的播放列表
 * @param {number} start   EXTINF 所在下标
 * @returns {{opts: string[], urlIndex: number}} urlIndex 为播放地址下标，-1 表示没找到
 */
export function collectOptsUntilUrl(lines, start) {
  const opts = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = (lines[i] || '').trim()
    if (!line) continue
    if (line.startsWith('#')) {
      // 只认 EXTVLCOPT，其余注释/指令（含下一条 EXTINF）按原有行为跳过
      const opt = parseOptLine(line)
      if (opt) opts.push(opt)
      continue
    }
    return { opts, urlIndex: i }
  }
  return { opts, urlIndex: -1 }
}

/**
 * 渲染成播放列表片段（含结尾换行）；无 opts 时返回空串,输出与改动前逐字节一致。
 */
export function renderOpts(opts) {
  return sanitizeOpts(opts).map(opt => `${OPT_PREFIX}${opt}\n`).join('')
}

/**
 * 对外订阅省略仅含播放器提示的选项块（issue #114）。LunaTV 只认 EXTINF
 * 的下一行地址，network-caching 会让整个频道被丢弃。防盗链请求头仍须保留，
 * 未识别的选项也不擅自删除；内部缓存继续保留完整 opts，升级不必等源刷新。
 */
export function omitPlayerOnlyOpts(content) {
  return String(content).replace(
    /(^#EXTINF:[^\r\n]*\r?\n)((?:#EXTVLCOPT:[^\r\n]*\r?\n)+)/gm,
    (entry, info, block) => {
      const opts = block.trimEnd().split(/\r?\n/).map(parseOptLine)
      return opts.every(opt => opt && PLAYER_KEYS.has(opt.slice(0, opt.indexOf('='))))
        ? info
        : entry
    },
  )
}

/**
 * 该频道是否**依赖自定义请求头**才能播。
 *
 * TXT（diyp / TVBox）格式只有「频道名,地址」两列，没有承载请求头的位置——
 * 这类频道写进 txt 会稳定 403。缺一个台好过一个死台，故在 txt 侧整条跳过。
 *
 * 判据必须是「有没有请求头类的 opt」，不能是「有没有 opt」：只带
 * network-caching 的频道不依赖任何请求头，误判会让它从 txt 订阅里凭空消失。
 */
export function needsOpts(channel) {
  return sanitizeOpts(channel && channel.opts)
    .some(opt => HEADER_KEYS.has(opt.slice(0, opt.indexOf('='))))
}

export { HEADER_KEYS, PLAYER_KEYS }
