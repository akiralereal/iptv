// 「忽略源自带分组」的默认分组兜底（issue #110）—— 供 applyConfig 使用。
//
// 勾选 ignoreGroups 的订阅源，其频道在刷新时一律以「未分组」写入 interface.txt
// （见 externalSources.js 的 resolveSubscriptionGroup），生成播放列表时由关键字
// 自动分组规则实时接管；规则未命中的频道，这里按频道的源归属（source-ids）回填
// 到该源配置的「默认分组」，不至于全堆在「未分组」。
//
// 为什么不在刷新时直接套规则/默认分组：那会把分组烧进 originalGroup，导致
// 隐藏/移动/重命名的 channelKey（originalGroup::id）随规则变动而失配，也让规则
// 修改要等下次源刷新才生效——applyConfig 时决定 targetGroup 则两者都稳（同 #69）。
//
// 与 groupRulesAPI 同款：按 external-sources.json 的 mtime 缓存，保存即生效、无需重启。

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dataPath } from './paths.js'

const SOURCES_PATH = dataPath('external-sources.json')

function safeMtime(p) {
  try { return existsSync(p) ? statSync(p).mtimeMs : 0 } catch { return 0 }
}

// 纯构建（便于测试）：ext:<源id> → 默认分组。只收录「勾选了忽略源分组、有稳定 id、
// 且默认分组有效」的源——默认分组留空或仍是「未分组」时无兜底可回填，不进映射。
export function buildSourceFallbackMap(sources) {
  const map = new Map()
  for (const s of (Array.isArray(sources) ? sources : [])) {
    const group = s && typeof s.group === 'string' ? s.group.trim() : ''
    if (s && s.ignoreGroups === true && s.id && group && group !== '未分组') {
      map.set(`ext:${s.id}`, group)
    }
  }
  return map
}

// 纯匹配（便于测试）：按频道的源归属逐个查映射，第一个命中的源胜。无命中返回 null。
export function matchFallbackByMap(sourceIds, map) {
  if (!Array.isArray(sourceIds) || !map || map.size === 0) return null
  for (const id of sourceIds) {
    const g = map.get(id)
    if (g) return g
  }
  return null
}

let _cache = { sig: null, map: null }

function getFallbackMap() {
  const sig = String(safeMtime(SOURCES_PATH))
  if (_cache.sig === sig && _cache.map) return _cache.map
  let map = new Map()
  try {
    const o = JSON.parse(readFileSync(SOURCES_PATH, 'utf-8'))
    map = buildSourceFallbackMap(o?.sources)
  } catch {
    // 配置缺失/损坏时视作无兜底，频道留在「未分组」
  }
  _cache = { sig, map }
  return map
}

// 关键字规则未命中的「未分组」频道，按其来源回填默认分组；
// 无源归属、或来源没勾「忽略源自带分组」→ null（保持现状）。
export function matchSourceFallbackGroup(sourceIds) {
  return matchFallbackByMap(sourceIds, getFallbackMap())
}

// 给 appUtils 的 applyConfig 触发门控用：存在需要默认分组兜底的源即须走 applyConfig
// ——它是全局配置（不在任何配置档里），零个性化配置的档也要能吃到兜底。
export function hasSourceFallbackGroups() {
  return getFallbackMap().size > 0
}
