// 关键字自动分组规则 API（issue #69）—— 可视化维护 data/group-keyword-rules.json
//
// 格式（数组，保留顺序以支持「首条命中胜」）：
//   [{ "group": "央视", "keywords": ["CCTV", "央视"] }, { "group": "影视", "keywords": ["电影","影院","电视剧"] }, ...]
//
// 用途：自定义订阅源里没写分组(group-title)的频道会落到「未分组」，且每次刷新新频道又回到未分组、
//   手动移动（按频道 ID 存）不顺延。这里按「频道名」配关键字规则，applyConfig 对「未分组」频道
//   按名字子串匹配（首条命中的规则胜）自动归到对应分组，刷新也不丢。只对未分组生效、不动源已分好的组。
//   保存即在下次生成播放列表时生效（按文件 mtime 缓存，无需重启）。

import { existsSync, readFileSync, statSync } from 'node:fs'
import { writeJsonFileSync } from './fileUtil.js'
import { dataPath } from './paths.js'

const RULES_PATH = dataPath('group-keyword-rules.json')

function load() {
  if (!existsSync(RULES_PATH)) return []
  try {
    const o = JSON.parse(readFileSync(RULES_PATH, 'utf-8'))
    return Array.isArray(o) ? o : []
  } catch {
    return []
  }
}

function safeMtime(p) {
  try { return existsSync(p) ? statSync(p).mtimeMs : 0 } catch { return 0 }
}

let _cache = { sig: null, rules: null }

// 给 applyConfig 用：按 mtime 缓存的规整后规则（每条 {group, keywords[]}，去空）
export function getKeywordGroupRules() {
  const sig = String(safeMtime(RULES_PATH))
  if (_cache.sig === sig && _cache.rules) return _cache.rules
  const rules = load().map(r => ({
    group: typeof r?.group === 'string' ? r.group.trim() : '',
    keywords: Array.isArray(r?.keywords) ? r.keywords.map(k => String(k).trim()).filter(Boolean) : []
  })).filter(r => r.group && r.keywords.length)
  _cache = { sig, rules }
  return rules
}

// 纯匹配（便于测试 / 复用）：在给定规则集里，频道名按子串包含、大小写不敏感、首条命中胜。
// 空关键字（""）跳过——否则 includes("") 恒为真会误命中。无命中返回 null。
export function matchGroupByRules(name, rules) {
  if (!name || !Array.isArray(rules)) return null
  const lower = String(name).toLowerCase()
  for (const r of rules) {
    const g = r && typeof r.group === 'string' ? r.group : ''
    const kws = r && Array.isArray(r.keywords) ? r.keywords : []
    if (g && kws.some(k => { const kk = String(k).toLowerCase(); return kk && lower.includes(kk) })) return g
  }
  return null
}

// 频道名按当前已保存的规则匹配分组（首条命中胜）。无命中返回 null。
export function matchKeywordGroup(name) {
  return matchGroupByRules(name, getKeywordGroupRules())
}

export function getGroupRulesAPI() {
  try {
    return { success: true, data: load() }
  } catch (e) {
    return { success: false, message: e.message }
  }
}

// 新增 / 更新一条规则（按分组名 upsert，原位更新以保持「首条命中胜」的顺序）
export function setGroupRuleAPI(group, keywords) {
  try {
    const g = typeof group === 'string' ? group.trim() : ''
    if (!g) return { success: false, message: '请填写分组名' }
    if (g === '未分组') return { success: false, message: '不能把频道自动归到「未分组」' }
    let list = Array.isArray(keywords) ? keywords : String(keywords || '').split(/[,，\n]/)
    list = [...new Set(list.map(s => String(s).trim()).filter(Boolean))]
    if (list.length === 0) return { success: false, message: '请至少填写一个关键字' }
    const rules = load()
    const idx = rules.findIndex(r => r && r.group === g)
    const entry = { group: g, keywords: list }
    if (idx >= 0) rules[idx] = entry   // 原位更新，保持顺序
    else rules.push(entry)
    writeJsonFileSync(RULES_PATH, rules)
    return { success: true, data: rules }
  } catch (e) {
    return { success: false, message: e.message }
  }
}

// 上移 / 下移一条规则（issue #69 跟进）：顺序即优先级（首条命中胜），提供可视化调序。
// 已在顶/底时原样返回成功（幂等，前端按钮置灰只是体验层，不依赖它保证正确性）。
export function moveGroupRuleAPI(group, direction) {
  try {
    if (direction !== 'up' && direction !== 'down') return { success: false, message: '方向无效' }
    const rules = load()
    const idx = rules.findIndex(r => r && r.group === group)
    if (idx < 0) return { success: false, message: '规则不存在' }
    const to = direction === 'up' ? idx - 1 : idx + 1
    if (to >= 0 && to < rules.length) {
      ;[rules[idx], rules[to]] = [rules[to], rules[idx]]
      writeJsonFileSync(RULES_PATH, rules)
    }
    return { success: true, data: rules }
  } catch (e) {
    return { success: false, message: e.message }
  }
}

// 删除一条规则
export function removeGroupRuleAPI(group) {
  try {
    const rules = load()
    const next = rules.filter(r => r && r.group !== group)
    if (next.length === rules.length) return { success: false, message: '规则不存在' }
    writeJsonFileSync(RULES_PATH, next)
    return { success: true, data: next }
  } catch (e) {
    return { success: false, message: e.message }
  }
}
