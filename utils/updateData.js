import { getAllChannels, updateExternalSources, updateBuiltInSources, updateExtractors, externalSourceManager } from "./channelMerger.js"
import { getExtractorManager, getModuleConfig } from "./extractorManager.js"
import { appendFile, appendFileSync, copyFileSync, renameFileSync, writeFile, writeFileSync } from "./fileUtil.js"
import { updatePlaybackData } from "./playback.js"
import { aggregateExternalEpg } from "./epgAggregator.js"
import { normalizeKey, logoMatchName } from "./channelNormalize.js"
import { renderOpts, needsOpts } from "./channelOpts.js"
import { refreshToken as enableTokenRefresh, host, pass, enableMigu, externalLogoBase } from "../config.js"
import refreshToken from "./refreshToken.js"
import { printGreen, printRed, printYellow, printBlue } from "./colorOut.js"
import { getDateString } from "./time.js"
import { fetchUrl } from "./net.js"
import { dataPath } from "./paths.js"
import { readMiguTokenState, markMiguTokenRefreshed, MIGU_TOKEN_REFRESH_INTERVAL_MS } from "./miguTokenState.js"
import { readFileSync, existsSync } from "node:fs"
import { announcementM3uEntry, announcementTxtEntry } from "./announcement.js"

const PE_CACHE_PATH = dataPath('pe-cache.json')

// 本地台标支持的扩展名（按优先级查找）
export const LOGO_EXTS = ['png', 'jpg', 'jpeg', 'webp']

// 查找本地台标 data/logos/<频道名>.<ext>（用户在后台上传或手动放），命中返回可写入 m3u 的相对 URL，否则 ''
export function findLocalLogo(name) {
  if (!name) return ''
  for (const ext of LOGO_EXTS) {
    if (existsSync(dataPath(`logos/${name}.${ext}`))) {
      return `\${replace}/logos/${encodeURIComponent(name)}.${ext}`
    }
  }
  return ''
}

/**
 * @param {Number} hours -更新小时数
 * @param {Object} options - 更新选项
 * @param {boolean} options.startupMode - 启动模式，根据配置决定是否更新
 * @param {boolean} options.regenerateOnly - 仅重新生成播放列表，使用缓存的咪咕数据（用于外部源变更时）
 */
/**
 * 本轮该不该刷咪咕 token。**提成纯函数是为了能被测试锁住**——它是一行布尔表达式，
 * 极易在后续改动里被顺手改回 `!(hours % 720)`，而改错了没有任何报错，
 * 只是悄悄开始高频请求咪咕的登录接口。判据的来龙去脉见调用处的注释。
 *
 * 判据是**墙钟时间差**，不再是 hours 计数器 —— 后者两个方向都错，
 * 原委见 utils/miguTokenState.js 的文件头。
 *
 * @param {number}      now            当前时间戳（毫秒）
 * @param {number|null} lastRefreshAt  上次刷新时间戳；null = 还没开始计时
 * @param {boolean}     regenerateOnly 仅用缓存重新生成播放列表
 * @param {boolean}     startupMode    启动那一次更新
 * @param {boolean}     enableMigu     咪咕源总开关
 * @param {number}      intervalMs     刷新周期，默认 30 天
 */
export function shouldRefreshMiguToken({
  now, lastRefreshAt, regenerateOnly, startupMode, enableMigu,
  intervalMs = MIGU_TOKEN_REFRESH_INTERVAL_MS,
}) {
  if (!enableMigu) return false
  // 「用缓存重新生成播放列表」和「启动那一次」都不做联网的账号操作。
  // 时间戳本身已经能挡住高频，这两道闸是纵深防御：数据目录只读导致时间戳
  // 落不了盘时，崩溃重启循环不至于把咪咕的登录接口打成 DDoS。
  if (regenerateOnly || startupMode) return false
  // 没有记录 = 本轮只开始计时、不刷。这样升级上来的用户不会在升级后立刻
  // 集体打一次咪咕接口，而是从现在起满 30 天再刷。
  if (!(lastRefreshAt > 0)) return false
  return now - lastRefreshAt >= intervalMs
}

async function updateTV(hours, options = {}) {
  const { startupMode = false, regenerateOnly = false } = options
  
  printBlue(`开始更新电视频道...${startupMode ? '（启动模式）' : ''}${regenerateOnly ? '（仅重新生成播放列表）' : ''}`)

  const date = new Date()
  const start = date.getTime()
  let interfacePath = ""
  let interfaceTXTPath = ""
  
  // 检查是否需要跳过咪咕更新
  const externalConfig = externalSourceManager.sources
  const skipMigu = startupMode && externalConfig.updateOnStartup === false
  
  if (skipMigu) {
    printYellow("启动模式：跳过咪咕频道更新，保留现有播放列表文件")
    printYellow("提示：定时更新仍会正常执行完整更新")
    // 必须 return false 而不是裸 return：runUpdate 只在 `generated === false` 时中止，
    // undefined 拦不住它 → updatePE 照跑 → 它是 copyFileSync(interface.txt → .bak)
    // 再 append，而此时文件里已经有上一轮的体育段 → 每次以「启动时不更新」方式重启，
    // 体育-昨天/今天/明天 就再追加一份（实测每次 +308 条）。
    return false
  }
  
  // regenerateOnly: 仅重新生成播放列表，跳过playback更新
  if (regenerateOnly) {
    printYellow("快速模式：跳过节目单更新，保留现有playback.xml")
  }
  
  // 更新外部源（在获取数据之前）
  // regenerateOnly 模式下跳过外部源更新（因为这个模式用于配置变更后重新生成）
  if (!regenerateOnly) {
    // 更新内置源（需要抓取的）
    if (startupMode) {
      printBlue("启动模式：检查需要更新的内置源...")
      await updateBuiltInSources({ startupMode: true })
    }
    
    if (startupMode) {
      // 启动模式：只更新设置了 updateOnStartup: true 的源
      printBlue("启动模式：检查需要更新的外部源...")
      await updateExternalSources({ startupMode: true })
      // 抓取模块启动时一律抓一轮：直播地址是短效的（B 站约 2 小时），
      // 缓存里那份多半已经过期，不抓等于开机后一段时间全是死链。
      await updateExtractors({ forceAll: true })
    } else {
      // 定时更新模式：更新所有设置了自动刷新的源（包括内置源和外部源）
      await updateBuiltInSources({ autoOnly: true })
      await updateExternalSources({ autoOnly: true })
      await updateExtractors({ autoOnly: true })
    }
  }
  
  // 获取数据（咪咕 + 外部源）
  // regenerateOnly: 使用缓存的咪咕数据 + 最新的外部源数据
  let datas = await getAllChannels({ skipMigu, useCachedMigu: regenerateOnly })
  printGreen("电视频道-获取成功")

  // 守卫一：声明了 critical 的抓取模块（咪咕）一条频道都没拿到。
  //
  // 全局的「总频道数为 0」守卫护不住这种情况——外部源随便几十条就能把总数撑起来，
  // 于是播放列表被重写成没有咪咕的版本，而日志里只有一行「咪咕 0 个」。收编前它是
  // 安全的：咪咕现抓失败会让总数真的变成 0；收编后失败被吞在模块内，那份保护是靠
  // 巧合得来的。触发场景很日常：容器重启时咪咕/网络暂不可达（NAS 重启、compose
  // 启动顺序、家宽还没拨上）。
  const shortfall = getExtractorManager().criticalShortfall()
  if (shortfall.length) {
    printRed(`${shortfall.join('、')} 本次一条频道都没取到（疑似网络不可达），保留现有播放列表，不覆盖`)
    return false
  }

  // 守卫二：本次获取到 0 个频道。
  // 此时绝不能用空结果覆盖上一次的好文件，否则「我的频道」会被清空且不自愈。
  // 返回 false 通知上层 update() 跳过后续 PE 步骤，避免把体育缓存追加到旧文件造成污染。
  const totalChannels = datas.reduce((sum, g) => sum + (g.dataList?.length || 0), 0)
  if (totalChannels === 0) {
    // 咪咕启用时：0 频道基本只会在咪咕/网络不可达时发生，绝不能用空结果覆盖上一次的好文件。
    if (enableMigu) {
      printRed("本次获取到 0 个频道（疑似咪咕/网络不可达），保留现有播放列表，不覆盖")
      return false
    }
    // 咪咕已禁用：0/少 频道是合法状态（纯外部源用户、或尚未添加任何源），允许按空白/纯外部源生成，避免卡在旧文件且不自愈。
    printYellow("咪咕已禁用，本次按空白 / 纯外部源处理（生成的播放列表可能为空）")
  }

  interfacePath = dataPath('interface.txt.bak')
  // txt
  interfaceTXTPath = dataPath('interfaceTXT.txt.bak')
  // 创建写入空内容
  writeFileSync(interfacePath, "")
  // txt
  writeFileSync(interfaceTXTPath, "")

  // 每 720 小时（一个月）刷新一次咪咕 token。refreshToken() 打的是
  // migu-app-umnb.miguvideo.com/login/token_refresh_migu_plus —— 带登录态的续期请求，
  // config.js 原注释：可能是导致封号的原因。所以「一个月一次」必须真的是一个月一次。
  //
  // hours 是**进程内**计数器（app.js 的 `var hours = 0`，只在定时任务里 += updateInterval），
  // 而 `0 % 720 === 0` 恒真。光判 `!(hours % 720)` 会让下面三种场景每次都刷：
  //   1. 容器启动 —— app.js 的 `update(hours, { startupMode: true })` 此时 hours 就是 0。
  //      NAS 重启 / compose 更新 / 崩溃拉起，每次都刷。
  //   2. 启动后头 updateInterval 小时内（默认 8h）任何一次源刷新触发的重新生成 ——
  //      5 分钟一轮的源检查和 60 秒后的订阅重试都用当时还是 0 的 hours。
  //   3. 后台操作 —— 保存系统配置 / 导入配置 / 上传或删除台标 / 复制频道，
  //      共 8 处 `update(0, { regenerateOnly: true })`，每点一次刷一次。
  //      （extractorsAPI 早就为此专门传 update(1, …) 绕开，注释在那边。）
  //
  // 判据是「距上次刷新是否真的过了 30 天」，与 hours 计数器彻底脱钩。
  // hours 两个方向都错：0 % 720 === 0 让启动/重新生成每次都刷；而 hours 只落在
  // updateInterval 的整数倍上，间隔设成 7/11/13/14 时永远碰不到 720 的倍数、
  // 月度刷新从此不再发生。详见 utils/miguTokenState.js 的文件头。
  if (enableMigu) {
    // 账号来自咪咕模块配置（原先是 config.js 的全局导出）
    const { userId: miguUserId = "", token: miguToken = "" } = getModuleConfig('migu')
    if (miguUserId != "" && miguToken != "") {
      const now = Date.now()
      const { lastRefreshAt } = readMiguTokenState()
      if (!(lastRefreshAt > 0)) {
        // 首次见到这个账号（新装、升级上来、或数据目录被重建）：只开始计时，不刷。
        // 升级用户因此不会在升级后集体打一次咪咕接口。
        markMiguTokenRefreshed(now)
        printYellow("咪咕 token 刷新计时已开始，30 天后进行首次刷新")
      } else if (shouldRefreshMiguToken({ now, lastRefreshAt, regenerateOnly, startupMode, enableMigu })) {
        if (enableTokenRefresh) {
          await refreshToken(miguUserId, miguToken) ? printGreen("token刷新成功") : printRed("token刷新失败")
          // 成功与否都记时间：失败还立刻重试等于把频率放开，而失败多半是网络/风控，
          // 重试帮不上忙。等下一个周期。
          markMiguTokenRefreshed(now)
        } else {
          printYellow("已关闭token刷新（refreshToken=false），跳过")
        }
      }
    }
  }
  appendFileSync(interfacePath, `#EXTM3U x-tvg-url="\${replace}/playback.xml" catchup="append" catchup-source="?playbackbegin=\${(b)yyyyMMddHHmmss}&playbackend=\${(e)yyyyMMddHHmmss}"\n`)
  // 项目自有公告频道固定写在原始播放列表首位。它仍会进入「我的频道」配置链，
  // 因此用户可像普通频道一样隐藏、移动、重命名，不强塞给不需要的配置档。
  appendFileSync(interfacePath, announcementM3uEntry())
  appendFileSync(interfaceTXTPath, announcementTxtEntry())
  printYellow("开始更新电视频道...")
  
  // 回放数据：regenerateOnly模式下跳过playback更新
  let playbackFile = ""
  if (!regenerateOnly) {
    playbackFile = dataPath('playback.xml.bak')
    writeFileSync(playbackFile,
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<tv generator-info-name="iFansClub" generator-info-url="https://github.com/akiralereal/iPTV">\n`)
  }

  // 分组列表
  const includeExternalInPlaylists = externalSourceManager.sources?.includeInPlaylists !== false
  // EPG 聚合（issue #38）用：本次写入播放列表的频道原始名 + 已由咪咕给到 EPG 的频道归一 key
  const playlistChannelNames = []
  const epgCoveredKeys = new Set()
  // 因依赖请求头而未写进 txt 的频道数。静默跳过会让用户「莫名少台」且日志里毫无线索，
  // 排查成本从「看一眼日志」变成「提 issue」。
  let txtSkipped = 0
  // 节目单抓取失败的频道数。逐个打日志会刷屏（一轮 175 个频道），收尾统一报一次。
  let playbackFailed = 0
  let lastPlaybackError = ''
  for (let i = 0; i < datas.length; i++) {

    const data = datas[i].dataList
    // txt
    appendFileSync(interfaceTXTPath, `${datas[i].name},#genre#\n`)
    // 写入节目
    for (let j = 0; j < data.length; j++) {
      const channelItem = data[j]
      
      const isBuiltIn = channelItem.source === 'built-in'
      // 抓取模块（extractors/）自成一类。必须排在 isExternal 之前判定并把它排除掉——
      // isExternal 是靠「有没有 url」推断的，而模块频道也带 url，不排除就会被
      // 外部源的 includeInPlaylists 开关连坐关掉，用户只看到频道没了、日志里什么都没有。
      const isExtractor = channelItem.source === 'extractor'
      const isExternal = !isExtractor && (channelItem.source === 'external' || !!channelItem.url)
      // 台标优先级：本地 logos/<频道名>.<ext>（用户后台上传或手动放，最高、仅查本地不联网）
      //   > 源自带台标（咪咕 pics / m3u 手写）> fanmingming 兜底（仅外部/内置）> 空。
      // 取图用「台标匹配名」做 key（issue #40）：CCTV1高清（电信）→ CCTV1、湖南卫视（电信）→ 湖南卫视，
      // 让特殊命名的常见频道也能命中本地/公共库；频道显示名不变。本地查找仍以显示名优先、规范名兜底。
      const logoKey = logoMatchName(channelItem.name)
      let logoUrl = findLocalLogo(channelItem.name)
      if (!logoUrl && logoKey && logoKey !== channelItem.name) {
        logoUrl = findLocalLogo(logoKey)
      }
      if (!logoUrl) {
        logoUrl = channelItem.pics?.highResolutionH || channelItem.logo || ""
      }
      if (!logoUrl && (isExternal || isBuiltIn || isExtractor) && externalLogoBase) {
        logoUrl = `${externalLogoBase}${encodeURIComponent(logoKey || channelItem.name)}.png`
      }
      
      // 内置源使用playURL字段，外部源与抓取模块使用url字段，咪咕源构造URL
      let playUrl
      if (isBuiltIn) {
        playUrl = channelItem.playURL  // 内置源使用playURL
      } else if (isExtractor && channelItem.deferredRef != null) {
        // 延迟解析模块：写占位地址，播放请求到达时才算真实地址（咪咕就是这个形态）。
        // ref 必须是单个路径段——playlistConfig.buildChannelId 用
        // /^\$\{replace\}\/([^/?#]+)/ 取频道主键，多段会失配、让老用户的
        // 「我的频道」隐藏/重命名/归类/排序全部作废。
        // 某些官方 CDN 在服务端可访问，但会被电视/浏览器的网络层直接拦截。
        // 模块可声明 proxyHls（清单+分片全代理）或 relayHls（只代理清单）。
        // 后者适合需要持续换签/切 CDN、但分片可由播放器直连的平台。
        playUrl = channelItem.proxyHls === true
          ? `\${replace}/proxy/${channelItem.deferredRef}.m3u8`
          : channelItem.relayHls === true
            ? `\${replace}/relay/${channelItem.deferredRef}.m3u8`
            : `\${replace}/${channelItem.deferredRef}`
      } else if (isExternal || isExtractor) {
        playUrl = channelItem.url      // 外部源 / 抓取模块使用url
      } else {
        playUrl = `\${replace}/${channelItem.pID}`  // 咪咕源使用pID
      }

      if (isExternal && !includeExternalInPlaylists) {
        continue
      }

      // 记录实际进入播放列表的频道名，供 EPG 聚合配对
      playlistChannelNames.push(channelItem.name)

      // 要不要为这个频道抓节目单，按**能力**判定而不是按源类型：
      // 默认只有咪咕（既不是外部也不是内置也不是模块）需要；但模块可以在频道上
      // 显式声明 wantsPlayback——咪咕将来收编成模块后仍要走这条路，按源类型判会
      // 把它的节目单整条掐断。
      const wantsPlayback = channelItem.wantsPlayback === true
        || (!isExternal && !isBuiltIn && !isExtractor)

      // regenerateOnly模式下跳过playback更新（仅更新播放列表）
      if (wantsPlayback && !regenerateOnly) {
        // 单个频道的节目单抓不到，不该让整轮更新崩掉——这条链上（getPlaybackData →
        // updatePlaybackData → 这里）原本一个 try 都没有，节目单接口一次瞬时故障就会
        // 在第一个频道处抛出，其余一百多个频道的节目单一个都抓不到，本轮所有源的
        // 刷新也一起作废（实测日志：TypeError → 更新失败）。
        try {
          // 咪咕成功写入 EPG 的频道记为「已覆盖」，外部 EPG 不再为其重复补充
          if (await updatePlaybackData(channelItem, playbackFile)) {
            epgCoveredKeys.add(normalizeKey(channelItem.name))
          }
        } catch (error) {
          playbackFailed++
          lastPlaybackError = error?.message || String(error)
        }
      }

      // 源归属属性（issue #29/#68 按档过滤源）：主来源 + 去重并入的多源归属；
      // 咪咕频道无 sourceId、以 pID 隐式识别为 'migu'。播放器输出前会剥离该内部属性。
      const ownSourceId = channelItem.sourceId || (!isBuiltIn && !isExternal && !isExtractor ? 'migu' : '')
      const allSourceIds = [...new Set([ownSourceId, ...(channelItem.sourceIds || [])].filter(Boolean))]
      // 多源用分号分隔——EXTINF 频道名按「第一个逗号」解析，属性值里出现逗号会破坏频道名提取
      const sourceAttr = allSourceIds.length ? ` source-ids="${allSourceIds.join(';')}"` : ''

      // 频道级播放选项：防盗链源要靠 #EXTVLCOPT 把 Referer 等带给播放器，
      // 必须夹在 EXTINF 和播放地址之间。无 opts 时为空串，输出与之前逐字节一致。
      const optLines = renderOpts(channelItem.opts)

      // 写入节目
      const catchupAttr = channelItem.catchup === 'none' ? ' catchup="none"' : ''
      appendFileSync(interfacePath, `#EXTINF:-1 tvg-id="${channelItem.name}" tvg-name="${channelItem.name}" tvg-logo="${logoUrl}"${sourceAttr}${catchupAttr} group-title="${datas[i].name}",${channelItem.name}\n${optLines}${playUrl}\n`)
      // txt：diyp/TVBox 格式只有「频道名,地址」两列，放不下请求头，依赖请求头的
      // 频道写进去必定 403——缺一个台好过一个死台，整条跳过。
      // 判据用 needsOpts 而不是「optLines 是否为空」：只带 network-caching 的频道
      // 不依赖任何请求头，按后者会被误伤（公开源里这种写法很常见）。
      if (needsOpts(channelItem)) {
        txtSkipped++
      } else {
        appendFileSync(interfaceTXTPath, `${channelItem.name},${playUrl}\n`)
      }
      // printGreen(`    节目链接更新成功`)
    }
    printGreen(`分组:${datas[i].name} 更新完成！`)
  }

  if (playbackFailed > 0) {
    printYellow(`节目单抓取失败 ${playbackFailed} 个频道（播放列表不受影响，这些频道本轮没有节目单）：${lastPlaybackError}`)
  }

  if (txtSkipped > 0) {
    printYellow(`txt 播放列表跳过 ${txtSkipped} 个频道：它们依赖自定义请求头，而 txt(diyp/TVBox) 格式放不下请求头。m3u 订阅不受影响。`)
  }

  // regenerateOnly模式下跳过playback文件生成
  if (!regenerateOnly) {
    // EPG 聚合（issue #38）：为咪咕未覆盖的频道，从外部 XMLTV 源补节目单。失败不影响基础节目单。
    try {
      await aggregateExternalEpg(playbackFile, playlistChannelNames, epgCoveredKeys)
    } catch (e) {
      printYellow(`EPG 聚合失败（不影响基础节目单）: ${e.message}`)
    }
    appendFileSync(playbackFile, `</tv>\n`)
    renameFileSync(playbackFile, playbackFile.replace(".bak", ""))
  }
  renameFileSync(interfacePath, interfacePath.replace(".bak", ""))
  // txt
  renameFileSync(interfaceTXTPath, interfaceTXTPath.replace(".bak", ""))
  printGreen("电视频道更新完成！")
  const end = Date.now()
  printYellow(`电视频道更新耗时: ${(end - start) / 1000}秒`)
}

/**
 * @param {Number} hours -更新小时数 
 */
/**
 * 把上次缓存的体育赛事内容追加回已生成的播放列表。
 *
 * 两个调用方：regenerateOnly 快速模式（避免重复打约 290 次赛事接口），以及
 * updatePE 在赛事接口不可达时的兜底——后者不兜的话，赛事会整批从播放列表消失，
 * 而 updateTV 早已把不含赛事的 interface.txt 重命名到位，用户只看到「体育频道
 * 莫名没了」。
 *
 * @param {string} label 日志前缀，标明是哪条路径触发的
 * @returns {boolean} 是否成功恢复
 */
function restorePEFromCache(label) {
  if (!existsSync(PE_CACHE_PATH)) {
    printYellow(`${label}：尚无PE缓存，体育赛事频道本次暂缺（等待下次完整更新）`)
    return false
  }
  try {
    const cache = JSON.parse(readFileSync(PE_CACHE_PATH, 'utf-8'))
    if (cache.m3u) {
      appendFileSync(dataPath('interface.txt'), cache.m3u)
    }
    if (cache.txt) {
      appendFileSync(dataPath('interfaceTXT.txt'), cache.txt)
    }
    printGreen(`${label}：已从缓存恢复体育赛事频道（${cache.updatedAt || '时间未知'}）`)
    return true
  } catch (e) {
    printYellow(`${label}：PE缓存读取失败，体育赛事频道本次暂缺: ${e.message}`)
    return false
  }
}

async function updatePE(hours) {

  const date = new Date()
  const start = date.getTime()
  // 获取PE数据
  const datas = await fetchUrl("http://v0-sc.miguvideo.com/vms-match/v6/staticcache/basic/match-list/normal-match-list/0/all/default/1/miguvideo")

  // 空值守卫：utils/net.js 的 fetchUrl 失败时返回 undefined 而不抛，所以不判的话
  // 上面那句「获取成功」照打，然后在循环里 datas.body?.days[i] 才炸——`?.` 挡不住
  // datas 本身是 undefined。而那时 copyFileSync 已经执行、updateTV 也早把不含赛事的
  // interface.txt 重命名到位，用户看到的是「体育频道莫名没了 + 日志只说更新失败」。
  // 改成：拿不到就退回上次缓存（与 regenerateOnly 同一条路），赛事不至于整批掉线。
  if (!datas?.body?.days) {
    printYellow("体育赛事接口暂不可达，改用上次缓存")
    restorePEFromCache('体育赛事')
    return
  }
  printGreen("体育直播频道获取成功")
  // console.dir(datas, { depth: null })

  copyFileSync(dataPath('interface.txt'), dataPath('interface.txt.bak'), 0)
  copyFileSync(dataPath('interfaceTXT.txt'), dataPath('interfaceTXT.txt.bak'), 0)

  const interfacePath = dataPath('interface.txt.bak')
  const interfaceTXTPath = dataPath('interfaceTXT.txt.bak')

  printYellow("开始更新体育直播频道...")

  // 单场赛事抓取失败的计数。收尾统一报一次，避免逐场刷屏。
  let matchFailed = 0
  let lastMatchError = ''

  // 缓存本次PE内容，供 regenerateOnly 模式使用
  let peM3uCache = ""
  let peTxtCache = ""

  for (let i = 1; i < 4; i++) {
    // 日期
    const date = datas.body?.days[i]
    let relativeDate = "昨天"
    const dateString = getDateString(new Date())
    if (date == dateString) {
      relativeDate = "今天"
    } else if (parseInt(date) > parseInt(dateString)) {
      relativeDate = "明天"
    }

    const txtGroupHeader = `体育-${relativeDate},#genre#\n`
    appendFile(interfaceTXTPath, txtGroupHeader)
    peTxtCache += txtGroupHeader

    for (const data of datas.body?.matchList[date]) {

      let pkInfoTitle = data.pkInfoTitle
      if (data.confrontTeams) {
        pkInfoTitle = `${data.confrontTeams[0].name}VS${data.confrontTeams[1].name}`
      }
      // const peResult = await fetch(`http://app-sc.miguvideo.com/vms-match/v5/staticcache/basic/all-view-list/${data.mgdbId}/2/miguvideo`).then(r => r.json())
      try {
        // 取数放进 try 里。原本在 try 之外，靠「undefined 恰好在 try 内的 .body 处才炸」
        // 侥幸成立——一旦 fetchUrl 的失败约定变了，异常会从这里逃出两层 for、逃出
        // updatePE，导致本轮体育频道整批丢失且 pe-cache 不更新。行为与之前逐字节相同，
        // 只是不再依赖那个巧合。
        const peResult = await fetchUrl(`https://vms-sc.miguvideo.com/vms-match/v6/staticcache/basic/basic-data/${data.mgdbId}/miguvideo`)
        // 比赛已结束
        if (peResult.body.endTime < Date.now()) {
          const replayResult = await fetchUrl(`http://app-sc.miguvideo.com/vms-match/v5/staticcache/basic/all-view-list/${data.mgdbId}/2/miguvideo`)
          // `?.` 必须加在 replayResult 上而不是 .body 之后：回放接口一抖动，
          // replayResult 就是 undefined，原写法在这里直接抛，导致下面那段
          // 「回落到 peResult.body.multiPlayList.replayList」的兜底永远走不到，
          // 一场本来有回放数据的比赛被白白丢掉。
          let replayList = replayResult?.body?.replayList
          if (replayList == null || replayList == undefined) {
            replayList = peResult.body.multiPlayList.replayList
          }
          if (replayList == null || replayList == undefined) {
            printYellow(`${data.mgdbId} ${pkInfoTitle} 无回放`)
            continue
          }
          for (const replay of replayList) {
            if (replay.name.match(/.*集锦|训练.*/) != null) {
              continue
            }
            if (replay.name.match(/.*回放|赛.*/) != null) {
              // keyword 与 multiPlayList.preList 都可能缺失，原本是裸取——任一缺失就抛，
              // 整场比赛的全部回放被丢掉（外层 catch 只记一次 matchFailed）。
              // 下面 live 那一段已经判过 startTimeStr == undefined，同一个模式这里漏了。
              let timeStr = peResult.body.keyword?.substring(7) ?? ''
              const preList = peResult.body.multiPlayList?.preList
              const peResultStartTimeStr = preList?.[preList.length - 1]?.startTimeStr
              if (peResultStartTimeStr != undefined) {
                timeStr = peResultStartTimeStr.substring(11, 16)
              }
              const competitionDesc = `${data.competitionName} ${pkInfoTitle} ${replay.name} ${timeStr}`
              const m3uLine = `#EXTINF:-1 tvg-id="${pkInfoTitle}" tvg-name="${competitionDesc}" tvg-logo="${data.competitionLogo}" source-ids="migu" group-title="体育-${relativeDate}",${competitionDesc}\n\${replace}/${replay.pID}\n`
              const txtLine = `${competitionDesc},\${replace}/${replay.pID}\n`
              // 写入赛事
              appendFileSync(interfacePath, m3uLine)
              appendFileSync(interfaceTXTPath, txtLine)
              peM3uCache += m3uLine
              peTxtCache += txtLine
            }
          }
          continue
        }
        // 比赛未结束
        const liveList = peResult.body.multiPlayList.liveList
        for (const live of liveList) {
          if (live.name.match(/.*集锦.*/) != null || live.startTimeStr == undefined) {
            continue
          }
          const competitionDesc = `${data.competitionName} ${pkInfoTitle} ${live.name} ${live.startTimeStr.substring(11, 16)}`
          const m3uLine = `#EXTINF:-1 tvg-id="${pkInfoTitle}" tvg-name="${competitionDesc}" tvg-logo="${data.competitionLogo}" source-ids="migu" group-title="体育-${relativeDate}",${competitionDesc}\n\${replace}/${live.pID}\n`
          const txtLine = `${competitionDesc},\${replace}/${live.pID}\n`
          // 写入赛事
          appendFileSync(interfacePath, m3uLine)
          appendFileSync(interfaceTXTPath, txtLine)
          peM3uCache += m3uLine
          peTxtCache += txtLine
        }
      } catch (error) {
        // 逐场打日志会刷屏（一轮近 200 场），所以原来那两行被注释掉了——但完全静默
        // 又让「少了几场比赛」无从排查。改成计数，收尾统一报一次。
        matchFailed++
        lastMatchError = error?.message || String(error)
      }
    }
    printGreen(`日期 ${date} 更新完成！`)
  }

  // 保存PE缓存，供 regenerateOnly 模式直接复用
  try {
    writeFileSync(PE_CACHE_PATH, JSON.stringify({ m3u: peM3uCache, txt: peTxtCache, updatedAt: new Date().toISOString() }), 'utf-8')
  } catch (e) {
    printYellow(`PE缓存保存失败: ${e.message}`)
  }

  // 重命名
  renameFileSync(interfacePath, interfacePath.replace(".bak", ""))
  renameFileSync(interfaceTXTPath, interfaceTXTPath.replace(".bak", ""))
  if (matchFailed > 0) {
    printYellow(`体育赛事有 ${matchFailed} 场抓取失败，本轮不含这些场次：${lastMatchError}`)
  }
  printGreen("体育直播频道更新完成")
  const end = Date.now()
  printYellow(`体育直播频道更新耗时: ${(end - start) / 1000}秒`)
}

/**
 * @param {Number} hours - 更新小时数
 * @param {Object} options - 更新选项
 * @param {boolean} options.startupMode - 启动模式
 * @param {boolean} options.regenerateOnly - 仅重新生成播放列表，跳过PE更新
 */
async function runUpdate(hours, options = {}) {
  const { regenerateOnly = false } = options
  const generated = await updateTV(hours, options)

  // updateTV 因 0 频道（网络不可达）已保留旧文件并跳过生成 → 不再追加 PE，避免污染旧文件
  if (generated === false) {
    return
  }

  if (!enableMigu) {
    // 咪咕已禁用：体育赛事为纯咪咕 API，整体跳过；也不回填 pe-cache，避免分发指向失效 pID 的旧赛事
  } else if (!regenerateOnly) {
    await updatePE(hours)
  } else {
    // regenerateOnly 模式：updateTV 已重建 interface.txt，需将上次缓存的体育赛事内容追加回去
    // 避免重复调用大量 PE API，保持快速模式
    restorePEFromCache('快速模式')
  }
}

// 单飞锁：串行化所有 update() 调用。
// 多个触发源（启动、每 N 小时定时任务、每小时源刷新、后台保存外部源）可能并发调用，
// 而 updateTV/updatePE 都写同一批固定的 .bak 文件再 rename；并发执行会交叉写入导致
// interface.txt / interfaceTXT.txt / playback.xml 损坏。这里用 Promise 链保证逐个执行。
let updateQueue = Promise.resolve()
function update(hours, options = {}) {
  const result = updateQueue.then(() => runUpdate(hours, options))
  // 保证队列不被单次失败中断（调用方仍能拿到本次的真实结果/异常）
  updateQueue = result.then(() => {}, () => {})
  return result
}

export default update
