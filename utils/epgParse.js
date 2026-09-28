// 外部 EPG（XMLTV）解析与频道配对（issue #38）
//
// 从 epgAggregator 拆出的纯解析逻辑：不依赖网络，便于单测，也把「下载」与「解析」职责分开。
//
// 关键修复（issue #38 反馈「加了很多源一个都匹配不上」）：
//   XMLTV 里 <programme channel="ID"> 的 ID 是「频道 id」，现实中常是数字 / 拼音 / 不透明串，
//   真正的频道名在 <channel id="ID"><display-name>名字</display-name></channel> 里。
//   原实现直接拿 programme 的 channel 属性（= id）归一比对，遇到这类源永远 0 命中。
//   现改为先建立 id → display-name 映射，用 display-name（并保留 id 本身）归一后比对。

import { normalizeKey } from './channelNormalize.js'
import { escapeXml } from './epgXmltv.js'

const PROG_RE = /<programme\b([^>]*)>[\s\S]*?<\/programme>/g
const CH_ATTR_RE = /channel="([^"]*)"/
const STOP_ATTR_RE = /stop="([^"]*)"/
const CHANNEL_RE = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/g
const ID_ATTR_RE = /id="([^"]*)"/
const DISPLAY_NAME_RE = /<display-name\b[^>]*>([\s\S]*?)<\/display-name>/g

// XML 实体反转义（配对前还原频道名里的 &amp; 等）
export function decodeXml(s) {
  return String(s)
    .replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"').replaceAll('&apos;', "'")
}

// XML 实体转义放在零依赖的 epgXmltv.js，模块节目单与外部聚合共用同一份
export { escapeXml }

// 解析 <channel> 元素，建立「EPG 频道 id → 归一 key 集合」映射。
// key 集合 = 该频道每个 <display-name> 的归一 key + id 本身的归一 key（兼容「id 即频道名」的源）。
export function buildChannelKeyMap(xml) {
  const map = new Map()
  CHANNEL_RE.lastIndex = 0
  let m
  while ((m = CHANNEL_RE.exec(xml)) !== null) {
    const idm = ID_ATTR_RE.exec(m[1])
    if (!idm) continue
    const id = decodeXml(idm[1])
    const keys = new Set()
    const idKey = normalizeKey(id)
    if (idKey) keys.add(idKey)
    DISPLAY_NAME_RE.lastIndex = 0
    let dn
    while ((dn = DISPLAY_NAME_RE.exec(m[2])) !== null) {
      const nk = normalizeKey(decodeXml(dn[1].trim()))
      if (nk) keys.add(nk)
    }
    if (keys.size) map.set(id, keys)
  }
  return map
}

// 从 XMLTV 文本里，按归一 key 收集 <programme> 块；只保留 wantedKeys 命中的频道，控制内存与体积。
// 通过 <channel> 的 display-name 把 programme 的 channel id 解析为归一 key（无对应 <channel> 时退回 id 自身归一）。
// 返回 Map<归一key, [programme 原始 XML 块, ...]>
export function parseProgrammes(xml, wantedKeys) {
  const idKeyMap = buildChannelKeyMap(xml)
  const byKey = new Map()
  PROG_RE.lastIndex = 0
  let m
  while ((m = PROG_RE.exec(xml)) !== null) {
    const cm = CH_ATTR_RE.exec(m[1])
    if (!cm) continue
    const chId = decodeXml(cm[1])
    let keys = idKeyMap.get(chId)
    if (!keys) {
      const k = normalizeKey(chId)
      if (!k) continue
      keys = new Set([k])
    }
    for (const k of keys) {
      if (!wantedKeys.has(k)) continue
      let arr = byKey.get(k)
      if (!arr) { arr = []; byKey.set(k, arr) }
      arr.push(m[0])
      break // 一个 programme 只归到一个目标频道，避免重复
    }
  }
  return byKey
}

// 上游塞进 <desc> 的站务公告不是节目简介：erw 2026-09 起把每条节目的简介都换成同一句
// 关站通知，播放器里点开哪个节目都是它。只认这几个字眼，真正的节目简介一律不碰。
const NOTICE_DESC_RE = /<desc\b[^>]*>[^<]*(?:域名头关闭|不在支持xml下载)[^<]*<\/desc>\s*/g

export function stripNoticeDesc(block) {
  return block.replace(NOTICE_DESC_RE, '')
}

// XMLTV 时间 'YYYYMMDDHHmmss +HHMM' → 毫秒时间戳；不带时区按规范当 UTC，解不出返回 NaN
export function parseXmltvTime(value) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*(?:([+-])(\d{2})(\d{2}))?/.exec(String(value ?? '').trim())
  if (!m) return NaN
  const [, y, mo, d, h, mi, s, sign, oh, om] = m
  const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  const offset = sign ? (sign === '-' ? -1 : 1) * (Number(oh) * 60 + Number(om)) * 60 * 1000 : 0
  return utc - offset
}

// 源里「还有没播完的节目」的频道：频道 id → 它的归一 key（display-name 与 id 本身，与配对一致）。
// 判断一个源此刻是否真能替某频道出节目单；只剩过期缓存的源不算，免得拿旧节目单占着频道。
export function channelsWithCurrentProgrammes(xml, now = Date.now()) {
  const idKeyMap = buildChannelKeyMap(xml)
  const channels = new Map()
  PROG_RE.lastIndex = 0
  let m
  while ((m = PROG_RE.exec(xml)) !== null) {
    if (!(parseXmltvTime(STOP_ATTR_RE.exec(m[1])?.[1]) > now)) continue
    const cm = CH_ATTR_RE.exec(m[1])
    if (!cm) continue
    const chId = decodeXml(cm[1])
    if (!channels.has(chId)) channels.set(chId, [...(idKeyMap.get(chId) || [normalizeKey(chId)])].filter(Boolean))
  }
  return channels
}

export function channelKeysWithCurrentProgrammes(xml, now = Date.now()) {
  return new Set([...channelsWithCurrentProgrammes(xml, now).values()].flat())
}

// 把 programme 块里的 channel 属性改写为合并后输出用的频道 id
export function rewriteChannel(block, outputId) {
  return block.replace(CH_ATTR_RE, `channel="${escapeXml(outputId)}"`)
}
