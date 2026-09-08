// 按名字长期屏蔽频道的规则匹配（issue #123）—— 纯函数，不碰文件、不碰配置读写。
//
// 为什么需要它：hiddenChannels 按 `原始分组::频道ID` 存，而频道 ID 里含播放地址，
// 上游换个路径 / 换台服务器就换一个 ID，那条隐藏静默失效、频道自己冒回分组
// （签名参数那一类已由 buildChannelId 的 stripVolatileParams 挡掉，换路径的挡不住）。
// 更根本的是有一类频道本来就没有稳定 ID 可言——每天重建的赛事、事件直播——
// 逐条隐藏对它们没有意义，用户要的是「这个名字以后都别出现」。
//
// 规则形如 { value, mode }：
//   mode 'exact'    整名相等（「永久屏蔽此频道名」一键生成，不会误伤别的台）
//   mode 'contains' 名字含该子串（用户手输，用来一次盖住一批）
// 均大小写不敏感。命中即隐藏，不分先后（与关键字分组的「首条命中胜」不同：
// 那边要决定归到哪个组，这边只有隐藏 / 不隐藏两种结果，无需排序语义）。
//
// 安全底线：value 为空的规则**永不命中**。'' 会让 includes('') 恒为真，
// 一条手滑存下的空规则将清空整份播放列表——这是本模块最危险的失败模式，
// 由 test-hidden-rules.mjs 钉死。

/** 规整规则数组：丢掉非法条目、去掉空 value、统一 mode。存盘与匹配共用，保证两边看到的是同一套。 */
export function normalizeHiddenRules(rules) {
  if (!Array.isArray(rules)) return []
  const seen = new Set()
  const out = []
  for (const rule of rules) {
    // 允许裸字符串写法（手改配置文件时最顺手），按 contains 解释
    const raw = typeof rule === 'string' ? { value: rule } : rule
    if (!raw || typeof raw !== 'object') continue
    const value = typeof raw.value === 'string' ? raw.value.trim() : ''
    if (!value) continue                                   // 空规则一律丢弃，绝不允许落盘
    const mode = raw.mode === 'exact' ? 'exact' : 'contains'
    const key = `${mode}\n${value.toLowerCase()}`
    if (seen.has(key)) continue                            // 同模式同值只留一条
    seen.add(key)
    out.push({ value, mode })
  }
  return out
}

/**
 * 频道是否被规则屏蔽。names 传该频道的**所有**可见名字——原始名与重命名后的显示名，
 * 任一命中即隐藏：用户可能是照着界面上改过的名字配的规则，也可能是照着源里的原名配的。
 * @param {string[]} names
 * @param {Array} rules 未规整的原始规则数组（内部自行规整，调用方无需预处理）
 * @returns {{value: string, mode: string}|null} 命中的那条规则，用于界面标注「按规则隐藏」
 */
export function matchHiddenRule(names, rules) {
  const list = normalizeHiddenRules(rules)
  if (list.length === 0) return null

  const candidates = (Array.isArray(names) ? names : [names])
    .filter(name => typeof name === 'string' && name.trim())
    .map(name => name.trim().toLowerCase())
  if (candidates.length === 0) return null

  for (const rule of list) {
    const needle = rule.value.toLowerCase()
    const hit = rule.mode === 'exact'
      ? candidates.some(name => name === needle)
      : candidates.some(name => name.includes(needle))
    if (hit) return rule
  }
  return null
}

export default { normalizeHiddenRules, matchHiddenRule }
