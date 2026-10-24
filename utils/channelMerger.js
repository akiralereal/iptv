import externalSourceManager from "./externalSources.js"
import builtInSourceManager from "./builtInSources.js"
import { getExtractorManager } from "./extractorManager.js"
import { printBlue, printGreen, printYellow, printRed } from "./colorOut.js"
import { isLocalGroup } from "./playlistConfig.js"
import { sanitizeCatchup } from "./channelCatchup.js"
import { hasReplaceToken } from "./replaceToken.js"

// 频道的「主来源」标识（issue #29/#68 按档过滤源）：
// 外部/内置/抓取模块的频道在 getValidChannels 里带上 sourceId（ext:<id> / bi:<id> / xt:<id>），
// 咪咕频道无 sourceId、以 pID 隐式识别。
function primarySourceId(ch) {
  return ch.sourceId || (ch.pID != null ? 'migu' : '')
}

// 分组内去重（纯函数，供测试）：name + 播放地址 完全相同只留第一个；
// 命中重复时把归属并入保留者的 sourceIds 并集——同一频道多个源提供时，按档禁用其一不误删（issue #29/#68）。
function dedupeAllChannels(allChannels) {
  let removed = 0
  for (const group of allChannels) {
    const seen = new Map()
    const kept = []
    for (const ch of group.dataList) {
      const urlKey = ch.url || ch.playURL || (ch.pID != null ? `migu:${ch.pID}` : '')
      const key = `${(ch.name || '').trim().toLowerCase()} ${urlKey}`
      const prev = seen.get(key)
      if (prev) {
        removed++
        const sid = primarySourceId(ch)
        if (sid) {
          if (!Array.isArray(prev.sourceIds)) {
            const own = primarySourceId(prev)
            prev.sourceIds = own ? [own] : []
          }
          if (!prev.sourceIds.includes(sid)) prev.sourceIds.push(sid)
          for (const extra of (ch.sourceIds || [])) {
            if (!prev.sourceIds.includes(extra)) prev.sourceIds.push(extra)
          }
        }
        // 留下的那条没给回看模式和模板、被去掉的这条给了：把声明接过来（自己写的天数优先），
        // 否则同一路流会因为列在前面的源没写而退回订阅头的咪咕模板（issue #190）。
        // 只在外部订阅之间转交：第三方订阅能把地址写成 migu:<pid> 等撞上咪咕 / 内置 / 模块频道的
        // 去重键，不能借此改写这些频道的回看
        if (isExternalChannel(prev) && isExternalChannel(ch)) {
          const own = sanitizeCatchup(prev)
          const other = sanitizeCatchup(ch)
          if (!own.catchup && !own.catchupSource && other.catchup !== 'none') Object.assign(prev, other, own)
        }
        continue
      }
      seen.set(key, ch)
      kept.push(ch)
    }
    group.dataList = kept
  }
  return removed
}

// 频道上会写进播放列表的外来字段（台标还有咪咕的 pics.highResolutionH）。汇总到这里时，
// 本项目自己的占位地址（咪咕 / 模块的 ${replace}/<ref>、本机台标）都还没生成——那是
// updateData 写盘时才拼的，所以这些字段里出现占位符只可能来自外部数据。
const FOREIGN_FIELDS = ['name', 'url', 'playURL', 'logo', 'pID', 'deferredRef']

function hasForeignReplaceToken(channel) {
  return FOREIGN_FIELDS.some(key => hasReplaceToken(channel?.[key])) || hasReplaceToken(channel?.pics?.highResolutionH)
}

// 丢掉带占位符 ${replace} 的外来频道（纯函数，供测试；原地改 dataList，与 dedupeAllChannels 同）。
// 输出订阅时占位符会被换成「本机地址 + 访问密码 / 令牌」，第三方订阅、内置源 JSON、平台接口
// 里写一个，凭据就拼进指向第三方的地址里了。整条丢弃而不是剔掉占位符：剔掉后剩下的是
// 一条来路可疑、多半也播不了的地址。分组名带它的整组丢弃；因此被清空的分组一并去掉。
// sources 是被丢频道的源归属（去重），日志里点名，用户才知道该去改哪个源。
function dropForeignReplaceTokens(groups) {
  let removed = 0
  const sources = new Set()
  const drop = channel => {
    removed++
    const sid = primarySourceId(channel)
    if (sid) sources.add(sid)
  }
  const kept = []
  for (const group of groups) {
    const list = group.dataList || []
    if (hasReplaceToken(group.name)) {
      list.forEach(drop)
      continue
    }
    const clean = []
    for (const channel of list) {
      if (hasForeignReplaceToken(channel)) drop(channel)
      else clean.push(channel)
    }
    if (list.length && !clean.length) continue
    group.dataList = clean
    kept.push(group)
  }
  return { groups: kept, removed, sources: [...sources] }
}

// 外部源按名字报（ext:<id> 对用户没意义），其余报源归属本身（migu / bi:<id> / xt:<id>）
function reportForeignReplaceTokens({ removed, sources }) {
  if (!removed) return
  const names = sources.map(sid => {
    const ext = sid.startsWith('ext:') && (externalSourceManager.sources?.sources || []).find(s => s && `ext:${s.id}` === sid)
    return ext?.name || sid
  })
  const from = names.length ? `（来源：${names.join('、')}）` : ''
  printYellow(`丢弃 ${removed} 个带内部占位符 \${replace} 的频道${from}：输出订阅时它会换成本机地址和访问密码 / 令牌，外部数据里不允许出现`)
}

/** 「纪实」改名为「文旅」，并合并已经使用新名的其它来源。 */
function normalizeContentGroupNames(groups) {
  const output = []
  const byName = new Map()
  for (const group of Array.isArray(groups) ? groups : []) {
    const name = group?.name === '纪实' ? '文旅' : group?.name
    const channels = Array.isArray(group?.dataList) ? group.dataList : []
    const existing = byName.get(name)
    if (existing) {
      existing.dataList.push(...channels)
      continue
    }
    const normalized = { ...group, name, dataList: [...channels] }
    byName.set(name, normalized)
    output.push(normalized)
  }
  return output
}

// 地方官方模块的少儿频道在保留省份归属的同时，也收到「少儿」组。部分频道
// 名字不带「少儿 / 卡通 / 动漫」，需要明确补入，避免漏分。
const LOCAL_KIDS_EXACT_NAMES = new Set(['哈哈炫动'])

function isKidsChannel(channel) {
  const name = String(channel?.name || '').trim()
  return LOCAL_KIDS_EXACT_NAMES.has(name) || /(少儿|卡通|动漫)/.test(name)
}

// 只用于少儿组的重复判定：「优漫卡通频道」与「优漫卡通」、
// 「海南广播电视总台少儿频道」与「海南少儿」应视为同一频道。
function kidsChannelKey(channel) {
  return String(channel?.name || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/广播电视总台/g, '')
    .replace(/频道$/, '')
}

// 外部订阅（含内置的「精选频道」订阅）进来的频道：getAllChannels 里打 source:'external'，
// sourceId 是 ext:<id>；纯函数测试只给 sourceId。
function isExternalChannel(channel) {
  return channel?.source === 'external' || String(channel?.sourceId || '').startsWith('ext:')
}

// 用户自己配的线路：外部源里除去内置「精选频道」订阅（getValidChannels 给它打 builtInSubscription）
// 的全部——自建订阅、本地文件/粘贴、直连、「复制到分组」副本。常见是本地 IPTV 组播，
// 与地方官方同台时只能并排当备用线路，不能被替换或删掉。
function isUserConfiguredChannel(channel) {
  return isExternalChannel(channel) && channel.builtInSubscription !== true
}

/**
 * 把符合条件的地方频道复制到内容分组，地方组仍保留完整频道；
 * 如果其它内容分组已有同台条目，用地方官方源替换并去掉重复（咪咕、内置源、精选订阅）。
 * 用户自配的同台线路不替换不删除：内容组里的紧跟在官方线路后面，其它分组里的原地保留。
 * 返回新分组，不修改输入。
 */
function consolidateLocalChannels(groups, { targetGroup, matches, keyOf }) {
  const output = (Array.isArray(groups) ? groups : []).map(group => ({
    ...group,
    dataList: [...(Array.isArray(group?.dataList) ? group.dataList : [])],
  }))
  const localChannels = []

  for (const group of output) {
    if (!isLocalGroup(group.name)) continue
    for (const channel of group.dataList) {
      if (matches(channel)) localChannels.push(channel)
    }
  }
  if (!localChannels.length) return output

  const preferred = new Map()
  for (const channel of localChannels) {
    const key = keyOf(channel)
    if (!key) continue
    const current = preferred.get(key)
    // 用户把自配线路放在某个地方组里时，同台官方线路仍优先当代表
    if (!current || (isUserConfiguredChannel(current) && !isUserConfiguredChannel(channel))) {
      preferred.set(key, channel)
    }
  }

  // 同台可能被平台放在其它分类（如「南京教科频道」在纪实），
  // 不能只查目标组，否则重复源会换个分组继续存在；
  // 地方组是用户需要的完整省份入口，不参与此处删重；用户自配线路也不删。
  for (const group of output) {
    if (group.name === targetGroup || isLocalGroup(group.name)) continue
    group.dataList = group.dataList.filter(channel =>
      isUserConfiguredChannel(channel) || !preferred.has(keyOf(channel)))
  }

  let contentGroup = output.find(group => group.name === targetGroup)
  if (!contentGroup) {
    contentGroup = { name: targetGroup, dataList: [] }
    const firstLocal = output.findIndex(group => isLocalGroup(group.name))
    output.splice(firstLocal >= 0 ? firstLocal : output.length, 0, contentGroup)
  }

  // 内容组里与官方同台的用户线路：跟着官方线路一起放、紧贴其后，
  // 播放器按「同组同名」聚成线路1（官方）/线路2（用户）。
  const userLines = new Map()
  for (const channel of contentGroup.dataList) {
    const key = keyOf(channel)
    if (!preferred.has(key) || !isUserConfiguredChannel(channel)) continue
    if (!userLines.has(key)) userLines.set(key, [])
    userLines.get(key).push(channel)
  }
  const gluedUserLines = new Set([...userLines.values()].flat())

  const placedPreferred = new Set()
  const merged = []
  for (const channel of contentGroup.dataList) {
    const key = keyOf(channel)
    const local = preferred.get(key)
    if (!local) {
      merged.push(channel)
      continue
    }
    // 外部源的同台条目不当官方线路的落点：精选的丢掉，用户的随官方线路走；
    // 官方线路只在替换咪咕 / 内置源条目时原地放，否则与其它地方频道一起插到外部订阅之前。
    if (isExternalChannel(channel)) continue
    if (!placedPreferred.has(key)) {
      merged.push(local, ...(userLines.get(key) || []))
      placedPreferred.add(key)
    }
  }
  const appended = []
  for (const channel of localChannels) {
    const key = keyOf(channel)
    if (placedPreferred.has(key)) continue
    appended.push(preferred.get(key) || channel, ...(userLines.get(key) || []))
    placedPreferred.add(key)
  }
  // 模块标了 trailing 的海外台（extractors/overseas）虽是模块频道，也排在组尾（见 moveTrailingChannelsLast）
  const ordered = [...merged.filter(channel => channel?.trailing !== true), ...merged.filter(channel => channel?.trailing === true)]
  // 合并优先级是「抓取模块 → 内置源 → 外部订阅」：地方官方频道插在第一个外部订阅频道
  // （或海外台）之前，不追加到组尾——否则精选列表里起播慢的海外台（World Poker Tour、
  // UFC 24/7 等）会夹在咪咕与各地体育频道中间。组里没有这两类时仍排在最后。紧贴官方线路的用户线路不算。
  const firstExternal = ordered.findIndex(channel =>
    (isExternalChannel(channel) || channel?.trailing === true) && !gluedUserLines.has(channel))
  ordered.splice(firstExternal >= 0 ? firstExternal : ordered.length, 0, ...appended)
  contentGroup.dataList = ordered

  return output.filter(group => group.dataList.length > 0)
}

/**
 * 模块接手了精选频道（IPTV.m3u）里的某台时，给频道标 supersedesFeatured：同组里同名（不分大小写）的
 * 精选频道条目在新镜像里收掉，只留模块那份。精选列表是运行中的实例直接从仓库拉的，条目要留给没升级的
 * 部署；而两份地址不同，按「名字 + 地址」的组内去重收不掉（先例：CNA、France 24 英语与法语台、World Poker Tour 挪进
 * 亚洲与国际直播模块，好把最高档挪到最前）。用户自己的订阅不受影响。
 */
function dropSupersededFeatured(groups) {
  return groups.map(group => {
    const names = new Set((group.dataList || [])
      .filter(channel => channel?.supersedesFeatured === true)
      .map(channel => String(channel.name || '').trim().toLowerCase()))
    if (!names.size) return group
    const dataList = group.dataList.filter(channel => !(channel?.builtInSubscription === true
      && names.has(String(channel.name || '').trim().toLowerCase())))
    return dataList.length === group.dataList.length ? group : { ...group, dataList }
  })
}

/**
 * 海外频道模块（extractors/overseas）的台标了 trailing：在任何分组里都排到最后，跟在各台官方
 * 频道与精选列表之后。它们是用户自己打开的海外免费频道，不该抢在各组原有频道前面
 * （咪咕关着时它会是体育组里的第一个模块）。
 */
function moveTrailingChannelsLast(groups) {
  return groups.map(group => {
    const trailing = (group.dataList || []).filter(channel => channel?.trailing === true)
    if (!trailing.length) return group
    return { ...group, dataList: [...group.dataList.filter(channel => channel?.trailing !== true), ...trailing] }
  })
}

function consolidateLocalKidsChannels(groups) {
  return consolidateLocalChannels(groups, {
    targetGroup: '少儿',
    matches: isKidsChannel,
    keyOf: kidsChannelKey,
  })
}

function isEducationChannel(channel) {
  const name = String(channel?.name || '').trim()
  // 「河北少儿科教」以少儿属性为主，应由上面的少儿规则处理。
  return !isKidsChannel(channel) && /(教育|科教|教科)/.test(name)
}

function educationChannelKey(channel) {
  return String(channel?.name || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/教育科技/g, '教科')
    .replace(/频道$/, '')
}

function consolidateLocalEducationChannels(groups) {
  return consolidateLocalChannels(groups, {
    targetGroup: '教育',
    matches: isEducationChannel,
    keyOf: educationChannelKey,
  })
}

// 地方体育频道多数直接带「体育」，「武术世界」是河南官方体育频道的例外名称。
const LOCAL_SPORTS_EXACT_NAMES = new Set(['武术世界'])

function isSportsChannel(channel) {
  const name = String(channel?.name || '').trim()
  return LOCAL_SPORTS_EXACT_NAMES.has(name) || /体育/.test(name)
}

function sportsChannelKey(channel) {
  return String(channel?.name || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/频道$/, '')
}

function consolidateLocalSportsChannels(groups) {
  return consolidateLocalChannels(groups, {
    targetGroup: '体育',
    matches: isSportsChannel,
    keyOf: sportsChannelKey,
  })
}

/**
 * 获取所有频道数据（咪咕 + 外部源）
 * @param {Object} options - 选项
 * @param {boolean} options.skipMigu - 跳过咪咕数据获取
 * @param {boolean} options.useCachedMigu - 使用缓存的咪咕数据（用于仅更新外部源时）
 */
async function getAllChannels() {
  try {
    // 抓取模块（咪咕也在其中）。读的是模块缓存而非现抓——抓取失败时沿用上一轮
    // 结果，否则频道会静默从播放列表消失（全局的 0 频道守卫只看总数，护不住
    // 单个模块）。缓存冷时 ensureWarm 现抓一次：cache:'memory' 的模块重启后
    // 缓存是空的，而 regenerateOnly 那轮不触发抓取。
    const extractorManager = getExtractorManager()
    await extractorManager.ensureWarm()
    const extractorChannels = extractorManager.getValidChannels()

    // 获取外部源频道
    const externalChannels = externalSourceManager.getValidChannels()
    
    // 获取内置源频道
    const builtInChannels = builtInSourceManager.getValidChannels()

    // 合并数据：抓取模块（咪咕居首）+ 内置源 + 外部源
    // 组内去重保留先入者，所以打底的顺序即优先级——咪咕在注册表 MODULES 里
    // 排第一，其频道的优先级与收编前一致。
    let allChannels = extractorChannels.map(group => ({
      ...group,
      dataList: [...group.dataList]
    }))
    
    // 先合并内置源
    // 注意：内置源频道用 playURL 字段，不能在此补 url —
    // 下游 updateData.js 用 `!!channelItem.url` 判定外部源，补 url 会让内置源被误判为外部源。
    const tagBuiltIn = channel => ({
      ...channel,
      source: 'built-in'
    })
    builtInChannels.forEach(builtInGroup => {
      const existingGroup = allChannels.find(group => group.name === builtInGroup.name)

      if (existingGroup) {
        existingGroup.dataList.push(...builtInGroup.dataList.map(tagBuiltIn))
      } else {
        allChannels.push({
          ...builtInGroup,
          source: 'built-in',
          dataList: builtInGroup.dataList.map(tagBuiltIn)
        })
      }
    })
    
    // 再合并外部源
    externalChannels.forEach(externalGroup => {
      const existingGroup = allChannels.find(group => group.name === externalGroup.name)
      
      if (existingGroup) {
        existingGroup.dataList.push(...externalGroup.dataList.map(channel => ({
          ...channel,
          source: 'external'
        })))
      } else {
        allChannels.push({
          ...externalGroup,
          source: 'external',
          dataList: externalGroup.dataList.map(channel => ({
            ...channel,
            source: 'external'
          }))
        })
      }
    })

    // 先清掉带占位符的外来频道，再做归并和去重：放到去重之后的话，恶意条目可能被留下、
    // 同名同地址的干净条目被当成重复删掉，恶意条目随后再被丢弃，干净的那条就没了
    const foreign = dropForeignReplaceTokens(allChannels)
    allChannels = foreign.groups
    reportForeignReplaceTokens(foreign)

    // 平台历史名「纪实」统一显示为「文旅」，外部精选频道
    // 也合并到同一组，避免新旧名并存。
    allChannels = normalizeContentGroupNames(allChannels)
    allChannels = dropSupersededFeatured(allChannels)
    allChannels = moveTrailingChannelsLast(allChannels)

    // 内容型分组按频道性质统一：地方体育 / 少儿 / 教育频道分别复制到
    // 对应内容组，地方组仍保持完整；同台多源时优先地方官方线路。
    allChannels = consolidateLocalSportsChannels(allChannels)
    allChannels = consolidateLocalKidsChannels(allChannels)
    allChannels = consolidateLocalEducationChannels(allChannels)
    
    // 频道级去重：同一分组内，name + 播放地址 完全相同的频道只保留第一个
    // （合并顺序为 咪咕 > 内置 > 外部 > 抓取模块，因此优先保留更高优先级的来源）
    // 只移除完全重复的条目，名称相同但地址不同的频道予以保留
    const dedupRemoved = dedupeAllChannels(allChannels)
    if (dedupRemoved > 0) {
      printYellow(`频道去重：移除 ${dedupRemoved} 个分组内完全重复的频道`)
    }

    const externalCount = externalChannels.reduce((sum, group) => sum + group.dataList.length, 0)
    const builtInCount = builtInChannels.reduce((sum, group) => sum + group.dataList.length, 0)
    // 咪咕现在是抓取模块之一，按归属拆开统计，日志格式与收编前保持一致
    let miguCount = 0
    let extractorCount = 0
    for (const group of extractorChannels) {
      for (const channel of group.dataList) {
        if (channel.sourceId === 'migu') miguCount++
        else extractorCount++
      }
    }

    printGreen(`频道数据获取完成: 咪咕 ${miguCount} 个，内置源 ${builtInCount} 个，外部源 ${externalCount} 个，抓取模块 ${extractorCount} 个`)

    return allChannels
    
  } catch (error) {
    printRed(`获取频道数据失败: ${error.message}`)
    // 合并环节出错时至少返回抓取模块的缓存（咪咕在其中）。
    // 注意不能直接返回 fetchList 的裸数据——那份没有 deferredRef，写盘会变成
    // ${replace}/undefined，比少几个频道糟糕得多。
    try {
      const foreign = dropForeignReplaceTokens(getExtractorManager().getValidChannels())
      reportForeignReplaceTokens(foreign)
      return foreign.groups
    } catch (fallbackError) {
      printRed(`抓取模块缓存也不可用: ${fallbackError.message}`)
      return []
    }
  }
}

/**
 * 更新外部源
 * @param {Object} options - 更新选项
 * @param {boolean} options.autoOnly - 仅更新设置了自动刷新的源（默认true）
 * @param {boolean} options.forceAll - 强制更新所有源
 * @param {boolean} options.startupMode - 启动模式，仅更新设置了updateOnStartup的源
 */
async function updateExternalSources(options = {}) {
  const { autoOnly = true, forceAll = false, startupMode = false } = options
  
  if (!externalSourceManager.sources.enabled) {
    return { success: true, message: "外部源已禁用" }
  }

  if (!externalSourceManager.sources.sources || externalSourceManager.sources.sources.length === 0) {
    return { success: true, message: "未配置外部源" }
  }
  
  const results = await externalSourceManager.updateAllSources({ autoOnly, forceAll, startupMode })
  
  const successful = results.filter(r => r.success).length
  const total = results.length
  
  if (results.length === 0) {
    return { success: true, message: "无需更新" }
  }
  
  if (successful === total) {
    return { success: true, results }
  } else if (successful > 0) {
    return { success: true, results, partial: true }
  } else {
    return { success: false, results }
  }
}

/**
 * 更新内置源（需要抓取的）
 * @param {Object} options - 更新选项
 * @param {boolean} options.startupMode - 启动模式，仅更新updateOnStartup=true的源
 * @param {boolean} options.forceAll - 强制更新所有抓取源
 */
async function updateBuiltInSources(options = {}) {
  return await builtInSourceManager.updateFetchSources(options)
}

/**
 * 更新抓取模块
 *
 * 返回值形状与 updateExternalSources 一致（success / results / partial），
 * 好让 app.js 的定时器和后台按钮用同一套归类逻辑。
 * @param {Object} options - { autoOnly, forceAll, onlyId }
 */
async function updateExtractors(options = {}) {
  // 这里刻意不判模块是否启用：判定在 extractorManager.isModuleEnabled 里，
  // 因为代理开关的模块（咪咕听 enableMigu）要绕过子系统总开关。
  const { updated, results, message } = await getExtractorManager().updateAll(options)
  if (message) return { success: true, message }
  if (!results.length) return { success: true, message: "无需更新" }

  const successful = results.filter(r => r.success).length
  if (successful === results.length) return { success: true, results, updated }
  if (successful > 0) return { success: true, results, partial: true, updated }
  return { success: false, results, updated }
}

/**
 * 获取外部源统计信息
 */
function getExternalSourceStats() {
  return externalSourceManager.getConfig()
}

export {
  getAllChannels,
  updateExternalSources,
  updateBuiltInSources,
  updateExtractors,
  getExternalSourceStats,
  externalSourceManager,
  builtInSourceManager,
  dedupeAllChannels,
  dropForeignReplaceTokens,
  primarySourceId,
  normalizeContentGroupNames,
  moveTrailingChannelsLast,
  dropSupersededFeatured,
  consolidateLocalSportsChannels,
  consolidateLocalKidsChannels,
  consolidateLocalEducationChannels
}
