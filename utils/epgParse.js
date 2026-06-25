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

const PROG_RE = /<programme\b([^>]*)>[\s\S]*?<\/programme>/g
const CH_ATTR_RE = /channel="([^"]*)"/
const CHANNEL_RE = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/g
const ID_ATTR_RE = /id="([^"]*)"/
const DISPLAY_NAME_RE = /<display-name\b[^>]*>([\s\S]*?)<\/display-name>/g

// XML 实体反转义（配对前还原频道名里的 &amp; 等）
export function decodeXml(s) {
  return String(s)
    .replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"').replaceAll('&apos;', "'")
}

// XML 实体转义（写出 channel id / display-name 时用）
export function escapeXml(s) {
  return String(s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

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

// 把 programme 块里的 channel 属性改写为合并后输出用的频道 id
export function rewriteChannel(block, outputId) {
  return block.replace(CH_ATTR_RE, `channel="${escapeXml(outputId)}"`)
}
