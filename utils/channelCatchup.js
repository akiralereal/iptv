/**
 * 频道级回看声明（catchup / catchup-days / catchup-source）的统一契约。
 *
 * 订阅头（updateData.js / playlistConfig.generateM3u8）声明的是咪咕的回看模板
 * `?playbackbegin=…&playbackend=…`，所有没在行内声明的频道都会继承它。第三方订阅
 * 往往自带另一套模板（如 `?playseek=${(b)…}-${(e)…}`）和回看天数，以前解析时被整个
 * 丢掉，频道只能继承咪咕模板：服务端忽略陌生参数照给直播，播放器不报错，表现为
 * 「回放入口消失 / 点了只有直播」（issue #190）。
 *
 * 频道对象上以三个可选字段承载：catchup（模式）、catchupDays（天数）、catchupSource（模板）。
 * 解析、回读、生成三处都走这里，避免各写一套。没有声明的频道不长出这些字段，
 * 生成结果与改动前逐字节一致、照旧继承订阅头。
 *
 * 注意：这些值来自用户添加的第三方订阅（不可信输入），要原样写回一个换行、引号敏感的
 * 格式里，因此：模式过白名单、天数只收正整数、模板含引号 / 空白 / 控制字符者整条拒收
 * （与 channelOpts 的 opt 消毒同理）；含逗号的也拒收——interface.txt 回读时频道名按
 * 「第一个逗号」切（与 source-ids 改用分号同一个原因），模板里一个逗号就会把频道名撑坏；
 * 模板里也不许出现 `${replace}`——输出订阅时它会被替换成本机地址连同访问密码 / 用户令牌，
 * 写进第三方模板等于把凭据发给第三方。
 */

import { hasReplaceToken } from './replaceToken.js'

// 主流播放器（Kodi IPTV Simple、TiviMate、OTT Navigator 等）认的回看模式，
// 外加本项目用来关掉继承的 none。白名单外的模式丢弃，频道回退为继承订阅头。
const MODES = new Set([
  'default',
  'append',
  'shift',
  'timeshift',
  'flussonic',
  'flussonic-hls',
  'flussonic-ts',
  'fs',
  'xc',
  'vod',
  'none',
])

// 模板长度上限。正常模板不过一两百字符，留足余量即可，
// 免得畸形订阅把超长串灌进每一行播放列表。
const MAX_SOURCE_LENGTH = 1024

// 回看天数上限。各家实际都在 1～30 天，给到一年足够宽松
const MAX_DAYS = 365

// 完整地址形式的模板（http://…、rtsp://…）只在 default 模式下能用：其余模式都把模板
// 拼在直播地址后面，会拼出 `…/live.m3u8http://…` 这种死链
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\//i

/** 从一行 EXTINF / EXTM3U 里取属性值；属性名前必须是行首、空白或逗号，免得 x-catchup 之类误中 */
function attr(line, name) {
  const m = line.match(new RegExp(`(?:^|[\\s,])${name}="([^"]*)"`, 'i'))
  return m ? m[1] : undefined
}

function cleanMode(raw) {
  if (typeof raw !== 'string') return undefined
  const mode = raw.trim().toLowerCase()
  return MODES.has(mode) ? mode : undefined
}

function cleanDays(raw) {
  const s = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : ''
  if (!/^\d{1,3}$/.test(s)) return undefined
  const days = Number(s)
  return days > 0 && days <= MAX_DAYS ? days : undefined
}

/**
 * 清洗回看模板：含引号、逗号、换行、控制字符、`${replace}` 或超长者整条拒收，返回 undefined。
 *
 * 含换行的整条丢弃而不是剔掉换行后留用——那会把注入内容粘成一条语法合法、
 * 值却是垃圾的模板，回看静默失败。宁可丢掉，让频道回退为继承订阅头的确定状态。
 *
 * 中间夹空白或以 `=` 结尾的也拒收：写回后值的收尾引号紧跟在后面，`…&group-title=`
 * 会拼成 `group-title="` 冒充下一个属性（回读时分组被解析错）；` source-ids=` 更会被
 * 输出时剥离内部属性的正则连同后面的真属性一起吃掉，把模板尾巴和分组名拼起来——
 * `${re` + `place}` 就这样凑出 `${replace}`，绕过上面的字面量检查。模板本是网址或
 * 查询串，正常不含空白，也不会以 `=` 结尾。
 */
function cleanSource(raw) {
  if (typeof raw !== 'string') return undefined
  if (raw.length > MAX_SOURCE_LENGTH) return undefined
  if (/[",\r\n\u0000-\u001f\u007f-\u009f]/.test(raw)) return undefined
  if (hasReplaceToken(raw)) return undefined
  const value = raw.trim()
  if (!value || /\s/.test(value) || value.endsWith('=')) return undefined
  return value
}

/**
 * 清洗一组回看声明，只保留合法字段；一个都不剩时返回空对象。
 * 也用来从频道对象上挑出回看字段展开进新对象：`...sanitizeCatchup(ch)`。
 * 模式为 none 时只留 catchup——关掉回看后天数和模板都没意义。
 */
export function sanitizeCatchup(info) {
  if (!info || typeof info !== 'object') return {}
  const catchup = cleanMode(info.catchup)
  if (catchup === 'none') return { catchup }
  const catchupDays = cleanDays(info.catchupDays)
  const catchupSource = cleanSource(info.catchupSource)
  return {
    ...(catchup ? { catchup } : {}),
    ...(catchupDays ? { catchupDays } : {}),
    ...(catchupSource ? { catchupSource } : {}),
  }
}

/**
 * 从一行 #EXTINF 或 #EXTM3U 解析回看声明（已清洗）。
 * 兼容 Kodi IPTV Simple 也认的别名：模式 catchup-type，天数 tvg-rec / timeshift；正名优先。
 */
export function parseCatchupAttrs(line) {
  if (typeof line !== 'string') return {}
  return sanitizeCatchup({
    catchup: ['catchup', 'catchup-type'].map(name => attr(line, name)).find(cleanMode),
    catchupDays: ['catchup-days', 'tvg-rec', 'timeshift'].map(name => attr(line, name)).find(cleanDays),
    catchupSource: attr(line, 'catchup-source'),
  })
}

/**
 * 算出一个频道最终的回看声明：订阅文件头（已解析）与 #EXTINF 行逐字段合并，行内为准。
 * 常见写法是文件头写模式和模板、行内只写天数，只认行内会漏掉模板。
 *
 * 合并后仍没有（合法的）模式时，按源的写法补上，因为我们的订阅头带 catchup="append"，
 * 不补就会被它接管：
 *  - SIPTV 老写法 `timeshift="N"` 等于 catchup="shift" 加 N 天（Kodi 同此处理）；
 *  - 完整地址模板补成 default，否则播放器会把它拼到直播地址后面。
 * 只在合并后判断一次：文件头单独推断出的 default 配上行内的相对模板就错了。
 */
export function resolveCatchup(header, line) {
  const merged = { ...sanitizeCatchup(header), ...parseCatchupAttrs(line) }
  if (!merged.catchup && typeof line === 'string' && cleanDays(attr(line, 'timeshift'))) merged.catchup = 'shift'
  if (!merged.catchup && merged.catchupSource && ABSOLUTE_URL.test(merged.catchupSource)) merged.catchup = 'default'
  return sanitizeCatchup(merged)
}

/**
 * 渲染成 EXTINF 属性片段（含前导空格）；没有声明时返回空串，输出与改动前逐字节一致。
 */
export function renderCatchupAttrs(channel) {
  const { catchup, catchupDays, catchupSource } = sanitizeCatchup(channel)
  return (catchup ? ` catchup="${catchup}"` : '')
    + (catchupDays ? ` catchup-days="${catchupDays}"` : '')
    + (catchupSource ? ` catchup-source="${catchupSource}"` : '')
}
