// EPG 节目单源管理 API（issue #38）—— 后台「系统配置」里 EPG 聚合卡片的增删改查
//
// 配置就是一个 JSON 文件 data/epg-sources.json，这里直接对其做 CRUD，
// 复用 epgAggregator 的 loadEpgConfig / saveEpgConfig 保证读写一致。

import { loadEpgConfig, saveEpgConfig, BUILT_IN_EPG_SOURCES, LEGACY_EPG_SOURCE_URLS } from "./epgAggregator.js"

function trimStr(v) {
  return typeof v === 'string' ? v.trim() : ''
}

function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10)
  if (Number.isNaN(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function isHttpUrl(u) {
  return /^https?:\/\//i.test(u)
}

// 获取 EPG 源配置（含每个源的运行状态：lastUpdated / lastStatus / channelCount / matchedCount）
export function getEpgSourcesAPI() {
  try {
    // legacyUrls：已废掉的老默认源地址。migrateLegacySources 只原地升级「一字未改」的内置默认源，
    // 用户改过名字的那条会被当成自定义源留在原地——它现在只回 101 个央视卫视、地方台一个都补不到，
    // 而界面上除了「已匹配」数字偏低看不出任何异常。把清单交给前端，让它在源列表里明说。issue #124
    return { success: true, data: loadEpgConfig(), legacyUrls: LEGACY_EPG_SOURCE_URLS, defaultUrl: BUILT_IN_EPG_SOURCES[0]?.url || '' }
  } catch (error) {
    return { success: false, message: error.message }
  }
}

// 开/关 EPG 聚合总开关（写入 epg-sources.json 的 enabled）
export function setEpgEnabledAPI(enabled) {
  try {
    const config = loadEpgConfig()
    config.enabled = !!enabled
    saveEpgConfig(config)
    return { success: true, data: config }
  } catch (error) {
    return { success: false, message: error.message }
  }
}

// 新增 EPG 源
export function addEpgSourceAPI(source = {}) {
  try {
    const name = trimStr(source.name)
    const url = trimStr(source.url)
    if (!name) return { success: false, message: '请填写源名称' }
    if (!isHttpUrl(url)) return { success: false, message: '请填写合法的 http(s) 地址' }

    const config = loadEpgConfig()
    if (config.sources.some(s => trimStr(s.url) === url)) {
      return { success: false, message: '该地址已存在' }
    }
    config.sources.push({
      name,
      url,
      enabled: source.enabled !== false,
      format: trimStr(source.format) || 'auto',
      refreshInterval: clampInt(source.refreshInterval, 720, 10, 100000),
      priority: clampInt(source.priority, 10, 0, 9999),
      lastUpdated: null,
      lastStatus: null,
      channelCount: 0,
      matchedCount: 0
    })
    saveEpgConfig(config)
    return { success: true, data: config }
  } catch (error) {
    return { success: false, message: error.message }
  }
}

// 编辑 EPG 源（按下标，仅更新传入字段）
export function updateEpgSourceAPI(index, fields = {}) {
  try {
    const config = loadEpgConfig()
    const s = config.sources[index]
    if (!s) return { success: false, message: '源不存在' }

    if (fields.name !== undefined) {
      const n = trimStr(fields.name)
      if (!n) return { success: false, message: '名称不能为空' }
      s.name = n
    }
    if (fields.url !== undefined) {
      const u = trimStr(fields.url)
      if (!isHttpUrl(u)) return { success: false, message: '请填写合法的 http(s) 地址' }
      s.url = u
    }
    if (fields.enabled !== undefined) s.enabled = !!fields.enabled
    if (fields.format !== undefined) s.format = trimStr(fields.format) || 'auto'
    if (fields.refreshInterval !== undefined) s.refreshInterval = clampInt(fields.refreshInterval, 720, 10, 100000)
    if (fields.priority !== undefined) s.priority = clampInt(fields.priority, 10, 0, 9999)

    saveEpgConfig(config)
    return { success: true, data: config }
  } catch (error) {
    return { success: false, message: error.message }
  }
}

// 删除 EPG 源
export function removeEpgSourceAPI(index) {
  try {
    const config = loadEpgConfig()
    if (index < 0 || index >= config.sources.length) {
      return { success: false, message: '索引越界' }
    }
    config.sources.splice(index, 1)
    saveEpgConfig(config)
    return { success: true, data: config }
  } catch (error) {
    return { success: false, message: error.message }
  }
}

// 强制下次更新重新下载所有源（清空 lastUpdated）。实际重建 playback.xml 由调用方触发 update()。
export function expireEpgSourcesAPI() {
  try {
    const config = loadEpgConfig()
    config.sources.forEach(s => { s.lastUpdated = null })
    saveEpgConfig(config)
    return { success: true, data: config }
  } catch (error) {
    return { success: false, message: error.message }
  }
}
