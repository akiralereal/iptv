// 频道名称 / TVG 规整（EPG 别名归一）—— issue #39
//
// 目的：把异构外部源五花八门的频道名（CCTV-1 / CCTV1HD / CCTV-1综合 …）的
//   tvg-id / tvg-name 归一到「规范名」，规范名 = 本项目 EPG(playback.xml) 里真实存在的频道 id
//   （即咪咕频道名），这样外部源频道也能蹭到对应的节目单。
//
// 规范名来源（构建顺序，后者可覆盖前者；用户表优先级最高）：
//   1) cntvNames：CCTV 系列的确切咪咕规范名（静态，首次启动 EPG 还没生成时也可用）
//   2) playback.xml 的 <channel id>：当前 EPG 全集（含卫视/港台等，权威、随更新自维护）
//   3) 内置兜底别名：normalizeKey 兜不住的语义映射（如 CGTN 别称）
//   4) data/channel-aliases.json：用户自定义别名表，最高优先级
//
// 只改 tvg-id / tvg-name，不动频道显示名（与「单频道重命名只改显示名」正好互补）。

import { existsSync, readFileSync, statSync } from "node:fs"
import { dataPath } from "./paths.js"
import { cntvNames } from "./datas.js"

// 质量/清晰度等修饰词：参与 key 比对时剔除（只影响匹配 key，不改频道显示名）
const QUALITY = /超高清|超清|高清|标清|蓝光|HD|UHD|FHD|SD|4K|8K|HEVC|H\.?265|IPV6|IPV4|50FPS/gi

// 运营商/信源/线路标注：不改变频道身份（CCTV1电信 与 CCTV1 是同一台），参与匹配时剔除。
// 只影响 EPG / 台标 的匹配 key，不改频道显示名——用户想保留「（电信）」这类信源标识仍可见。issue #40
const OPERATOR = /电信|联通|移动|广电|歌华|华数|鹏博士|IPTV|备用|备\d|线路\s*\d*|高码|低码|测试/gi

// 全角转半角（含全角空格）
function toHalfWidth(s) {
  return s
    .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, " ")
}

// 繁体 → 简体（常用频道名字符表，轻量；让繁体 EPG / 源频道名也能对上简体规范名）。issue #62
// 只取电视频道名里高频出现的字，不做全量 OpenCC（保持轻量）；只影响匹配 key，不改频道显示名。
const T2S = {
  '衛': '卫', '視': '视', '體': '体', '綜': '综', '電': '电', '劇': '剧', '場': '场', '鳳': '凤',
  '際': '际', '國': '国', '頻': '频', '聞': '闻', '財': '财', '經': '经', '軍': '军', '農': '农',
  '紀': '纪', '錄': '录', '藝': '艺', '臺': '台', '華': '华', '廣': '广', '東': '东', '語': '语',
  '樂': '乐', '戲': '戏', '龍': '龙', '兒': '儿', '風': '风', '雲': '云', '緯': '纬', '來': '来',
  '傳': '传', '統': '统', '醫': '医', '療': '疗', '釣': '钓', '魚': '鱼', '灣': '湾', '慶': '庆',
  '寧': '宁', '號': '号', '線': '线', '聲': '声', '點': '点', '響': '响', '業': '业', '產': '产',
  '護': '护', '後': '后', '將': '将', '馬': '马', '鳥': '鸟', '寶': '宝', '萬': '万', '與': '与',
  '開': '开', '關': '关', '觀': '观', '區': '区', '縣': '县', '麗': '丽', '陸': '陆', '葉': '叶',
  '雙': '双', '豐': '丰', '頭': '头', '陽': '阳', '義': '义', '術': '术', '畫': '画', '學': '学',
  '時': '时', '間': '间', '實': '实', '現': '现', '當': '当', '發': '发', '愛': '爱', '歡': '欢',
  '兩': '两', '個': '个', '靈': '灵', '嶺': '岭', '輪': '轮', '轉': '转', '遊': '游', '橋': '桥',
}
function toSimplified(s) {
  let out = ''
  for (const ch of s) out += (T2S[ch] || ch)
  return out
}

// 「央视N / 央视N套 / 央视N台」→ CCTVN（含中文数字一~十七），与 CCTV 各种写法归一。
// normalizeKey 与 logoMatchName 共用，保证两边对央视写法的口径一致（issue #40）。
const CN_NUM = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10, '十一': 11, '十二': 12, '十三': 13, '十四': 14, '十五': 15, '十六': 16, '十七': 17 }
function yangshiToCctv(s) {
  return s.replace(/央视\s*([0-9]{1,2}|[一二三四五六七八九十]{1,3})\s*(?:套|台|频道|综合|高清)?/, (whole, num) => {
    const n = /^[0-9]+$/.test(num) ? num : CN_NUM[num]
    return n ? 'CCTV' + n : whole
  })
}

// 把频道名归一成可比较的 key：CCTV 用频道号(及 +/欧美)做 key，其余去清晰度后缀和分隔符
export function normalizeKey(name) {
  if (!name) return ""
  let s = yangshiToCctv(toSimplified(toHalfWidth(String(name)).trim().toUpperCase()))

  // CCTV 专项：靠频道号识别，丢弃「综合/财经/高清」等描述词，避免同台不同写法对不上。
  // 数字后紧跟的 K（CCTV4K / CCTV8K 超高清）是独立频道，必须纳入 key，否则会和 CCTV4 / CCTV8 撞成同一台（issue #56）。
  const m = s.match(/CCTV[-\s]*(\d{1,2})(K)?\s*(\+|PLUS|加)?/)
  if (m) {
    if (m[2]) return "CCTV" + m[1] + "K"   // 4K / 8K 超高清，与普通 CCTVn 区分
    let key = "CCTV" + m[1] + (m[3] ? "+" : "")
    // CCTV4 有 中文国际 / 欧洲 / 美洲 三路，需区分，否则会互相覆盖
    if (/欧洲|欧/.test(s)) key += "欧"
    else if (/美洲|美/.test(s)) key += "美"
    return key
  }

  s = s.replace(QUALITY, "")
  s = s.replace(OPERATOR, "")   // 去运营商/信源/线路标注（电信/联通/IPTV…），让「湖南卫视（电信）」也归一到「湖南卫视」。issue #40
  s = s.replace(/[\s\-_·.|"'’，,、（）()\[\]【】]/g, "")
  return s
}

// XML 实体反转义（playback.xml 里频道 id 可能含 &amp; 等）
function decodeXml(s) {
  return s
    .replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"").replaceAll("&apos;", "'")
}

// 内置兜底别名：仅用于 normalizeKey 兜不住的语义映射。{ 规范名: [别名…] }
const BUILTIN_ALIASES = {
  // CGTN 常见别称
  "CGTN": ["中国国际电视台", "中国环球电视网"],
}

function safeMtime(path) {
  try { return existsSync(path) ? statSync(path).mtimeMs : 0 } catch { return 0 }
}

let _cache = { sig: null, map: null }

// 构建「归一 key → 规范名」映射；按 playback.xml / 用户别名表的 mtime 缓存，避免每次请求重读重解析
export function getCanonicalMap() {
  const pbPath = dataPath("playback.xml")
  const aliasPath = dataPath("channel-aliases.json")
  const sig = `${safeMtime(pbPath)}|${safeMtime(aliasPath)}`
  if (_cache.sig === sig && _cache.map) return _cache.map

  const map = new Map()
  const seed = (canonicalName) => {
    const k = normalizeKey(canonicalName)
    if (k && !map.has(k)) map.set(k, canonicalName) // 先到先得，保持确定性
  }

  // 1) CCTV 确切规范名
  for (const name of Object.keys(cntvNames)) seed(name)

  // 2) 当前 EPG 频道全集
  if (existsSync(pbPath)) {
    try {
      const xml = readFileSync(pbPath, "utf-8")
      const re = /<channel\s+id="([^"]+)"/g
      let m
      while ((m = re.exec(xml)) !== null) seed(decodeXml(m[1]))
    } catch { /* 读取/解析失败则忽略，退化为仅 cntvNames */ }
  }

  // 3) 内置兜底别名
  for (const [canonical, aliases] of Object.entries(BUILTIN_ALIASES)) {
    seed(canonical)
    for (const a of aliases) { const k = normalizeKey(a); if (k && !map.has(k)) map.set(k, canonical) }
  }

  // 4) 用户别名表（最高优先级，覆盖前面的）
  if (existsSync(aliasPath)) {
    try {
      const user = JSON.parse(readFileSync(aliasPath, "utf-8"))
      for (const [canonical, aliases] of Object.entries(user)) {
        const ck = normalizeKey(canonical)
        if (ck) map.set(ck, canonical)
        for (const a of (Array.isArray(aliases) ? aliases : [])) {
          const k = normalizeKey(a)
          if (k) map.set(k, canonical)
        }
      }
    } catch { /* 用户表损坏则忽略 */ }
  }

  _cache = { sig, map }
  return map
}

// 把一个频道名归一到规范名；无对应规范名时返回 null（保持原样、不误改）
export function normalizeTvgName(name) {
  return getCanonicalMap().get(normalizeKey(name)) || null
}

let _pbIds = { sig: null, set: null }

// 读取 playback.xml 里实际存在的 <channel id> 集合（按 mtime 缓存）。
// 用于「这个频道到底有没有节目单」的判定：播放器按 tvg-id 对 playback 的 channel id，
// id 在集合里 = 有节目单。issue #38（后台展示每频道配对状态）
export function getPlaybackChannelIds() {
  const pbPath = dataPath("playback.xml")
  const sig = String(safeMtime(pbPath))
  if (_pbIds.sig === sig && _pbIds.set) return _pbIds.set

  const set = new Set()
  if (existsSync(pbPath)) {
    try {
      const xml = readFileSync(pbPath, "utf-8")
      const re = /<channel\s+id="([^"]+)"/g
      let m
      while ((m = re.exec(xml)) !== null) set.add(decodeXml(m[1]))
    } catch { /* 读取失败则视为空集，频道一律显示「未匹配」而非报错 */ }
  }
  _pbIds = { sig, set }
  return set
}

// 为「按名取台标」清洗频道名（issue #40）。目标是 fanmingming 这类公共台标库的短文件名约定
// （CCTV1.png / CCTV5+.png / CCTV4欧洲.png / 湖南卫视.png），实测库里没有 CCTV1综合.png、湖南卫视高清.png。
// 与 normalizeKey 的差异（所以不复用）：
//   - 保留大小写与中文原样（URL 区分大小写，英文台名不能被大写化）；
//   - CCTV 收敛到库里的「短名」而非 EPG 的「长规范名」（CCTV1 而非 CCTV1综合；4 路保留 欧洲/美洲 全称）；
//   - 只剔除清晰度/运营商/空括号等噪声，不做激进的分隔符压缩。
// 让「CCTV1高清（电信）」「湖南卫视（电信）」这类特殊命名的常见频道也能命中公共库；频道显示名保持不变。
export function logoMatchName(name) {
  if (!name) return ''
  // 先把「央视N套」等中文写法转成 CCTVN，与 normalizeKey 同口径（fanmingming 只有 CCTV1.png，没有 央视1套.png）；繁体转简体（issue #62）
  const raw = yangshiToCctv(toSimplified(toHalfWidth(String(name)).trim()))
  // CCTV：按频道号收敛到公共库短名（保留 + 与 CCTV4 的 欧洲/美洲 三路区分；4K/8K 超高清独立，不并入 CCTVn）（issue #56）
  const cc = raw.toUpperCase().match(/CCTV[-\s]*(\d{1,2})(K)?\s*(\+|PLUS|加)?/)
  if (cc) {
    if (cc[2]) return 'CCTV' + cc[1] + 'K'   // CCTV4K / CCTV8K 超高清
    if (cc[1] === '4') {
      if (/欧/.test(raw)) return 'CCTV4欧洲'
      if (/美/.test(raw)) return 'CCTV4美洲'
    }
    return 'CCTV' + cc[1] + (cc[3] ? '+' : '')
  }
  // 非 CCTV：去清晰度/运营商标注 → 清掉被掏空的空括号 → 去首尾分隔符（大小写与其余字符原样保留）
  let s = raw.replace(QUALITY, '').replace(OPERATOR, '')
  s = s.replace(/[（(\[【]\s*[)）\]】]/g, '')
  s = s.replace(/^[\s\-_·.|]+|[\s\-_·.|]+$/g, '').trim()
  return s || raw
}
