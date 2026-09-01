import { readFileSync } from "./fileUtil.js";
import { dataPath } from "./paths.js";
import { host, pass, enableTvgNormalize, enableDisplayNameUnify } from "../config.js";
import { printDebug, printGreen, printGrey, printRed, printYellow } from "./colorOut.js";
import { readConfig, parseInterfaceTxt, applyConfig, generateM3u8, generateTxt } from "./playlistConfig.js";
import { getKeywordGroupRules } from "./groupRulesAPI.js";
import { hasSourceFallbackGroups } from "./sourceGroupFallback.js";
import { resolverFor, listModules } from "../extractors/registry.js";
import { getExtractorManager, getModuleConfig } from "./extractorManager.js";

/**
 * 清空各模块的解析缓存。
 *
 * 名字保持不变：utils/systemConfigAPI.js:5 与 utils/configBackupAPI.js:17 都在
 * import 它，改名要同步两处。画质/编码改动后必须调，否则三小时内继续下发旧
 * 编码的流（issue #60）。
 */
function clearUrlCache() {
  for (const module of listModules()) {
    if (typeof module.clearResolveCache === 'function') module.clearResolveCache()
  }
}

// 把 HLS 清单里的相对路径改写为绝对地址（issue #98 清单直出用）。
// 覆盖两类位置：URI 行（非 # 开头的行）与标签内的 URI="..." 属性（EXT-X-KEY/MEDIA/MAP 等）。
// 纯字符串处理、无副作用，便于单测。
function rewriteManifest(text, finalUrl) {
  // 行尾/BOM 归一化：上游若是 \r\n，按 \n 切分后 # 标签行会保留 \r 而 URI 行被 trim 成
  // 裸 \n——混合行尾清单会让严格按 \r\n 分行的播放器拿到脏 URI（issue #98）。
  // 这里是 relay/proxy 全部清单的必经点，归一次即可覆盖所有下发路径。
  text = text.replace(/^\uFEFF/, '').replace(/\r/g, '')
  return text.split('\n').map(line => {
    const t = line.trim()
    if (!t) return line
    if (t.startsWith('#')) {
      return line.replace(/URI="([^"]*)"/g, (whole, uri) => {
        try { return `URI="${new URL(uri, finalUrl).href}"` } catch { return whole }
      })
    }
    try { return new URL(t, finalUrl).href } catch { return line }
  }).join('\n')
}

// 个别 CDN 只向真实 Chromium 返回清单。对应模块可在 resolve() 中直接交回本轮
// manifestText + manifestUrl；这里仍统一做相对地址绝对化，后续 relay/proxy 逻辑无需分叉。
function inlineResolvedManifest(result) {
  const text = typeof result?.manifestText === 'string' ? result.manifestText : ''
  const base = String(result?.manifestUrl || result?.playURL || '')
  if (!text.trimStart().startsWith('#EXTM3U') || text.length > 2 * 1024 * 1024) return null
  try {
    const url = new URL(base)
    if (!['http:', 'https:'].includes(url.protocol)) return null
    return rewriteManifest(text, url.href)
  } catch {
    return null
  }
}

// 取回一份 HLS 清单文本（跟随 302），非 200 或非 HLS 内容返回 null
async function fetchHls(url, signal, upstreamHeaders = {}) {
  const resp = await fetch(url, {
    redirect: 'follow',
    signal,
    headers: {
      ...upstreamHeaders,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
  })
  if (!resp.ok) return null
  const text = await resp.text()
  if (!text.trimStart().startsWith('#EXTM3U')) return null
  return { text, finalUrl: resp.url || url }
}

// master（多码率）清单里第一条子清单地址；不是 master 则返回 null。
// 咪咕的 master 只有一条子清单，取第一条即全部。
function firstVariantUrl(text, base) {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('#EXT-X-STREAM-INF')) continue
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim()
      if (!t || t.startsWith('#')) continue
      try { return new URL(t, base).href } catch { return null }
    }
  }
  return null
}

// 清单直出（issue #98）：极空间极影视等播放器不跟随 302 跳转，播放一直转圈。
// 此模式由服务端替播放器取回 HLS 清单，相对路径改写成绝对地址后直接 200 返回。
//
// 咪咕返回的是 master（多码率）清单，里面还嵌着一层子清单地址——对严格按 HLS 规范
// 实现的播放器没问题，但兼容模式面向的正是「实现不完整」的播放器：它们要么不跟随跳转，
// 要么处理不了「清单里再跳一层、且跳到另一个主机」。故这里多走一跳，把 master 拍平成
// 播放器直接能用的媒体清单（分片列表）——媒体清单是最基础的 HLS 形态，兼容面最广；
// 咪咕 master 只有单条码率，拍平不损失任何画质选择。
// 视频分片仍由播放器直连 CDN，服务器只经手清单文本，不占带宽。
//
// 注意：清单由服务端取回，节点由服务端网络选择，与「客户端就近取流」语义互斥——
// 兼容模式面向 NAS 与播放设备同一网络的家庭场景，正好不需要就近取流。
// 返回 null 表示取清单失败或内容不是 HLS，调用方应回退 302。
async function fetchManifestDirect(playURL, upstreamHeaders = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10000)   // 覆盖两跳
  try {
    const master = await fetchHls(playURL, ctrl.signal, upstreamHeaders)
    if (!master) return null

    const variantUrl = firstVariantUrl(master.text, master.finalUrl)
    if (variantUrl) {
      const media = await fetchHls(variantUrl, ctrl.signal, upstreamHeaders)
      // 拍平成功：直接给播放器分片列表；失败则退回改写后的 master（跟随能力正常的播放器仍可播）
      if (media) return rewriteManifest(media.text, media.finalUrl)
      printDebug(`子清单取回失败，退回 master 清单: ${variantUrl}`)
    }
    return rewriteManifest(master.text, master.finalUrl)
  } catch (error) {
    printDebug(`清单直出取回失败，回退 302: ${error.message}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

function interfaceStr(url, headers, urlUserId, urlToken, profile, accessPrefix, relay) {

  let result = {
    content: null,
    contentType: 'text/plain;charset=UTF-8'
  }
  let fileName = dataPath("interface.txt")
  switch (url) {
    case "/playback.xml":
      fileName = dataPath("playback.xml")
      result.contentType = "text/xml;charset=UTF-8"
      break;

    case "/txt":
      fileName = dataPath("interfaceTXT.txt")
      break;

    case "/m3u":
    case "/interface.m3u":
      // 必须用 text/plain，不能用 audio/x-mpegurl。
      // audio/x-mpegurl 是“可播放的 HLS 媒体”类型，浏览器和飞牛(fnOS)订阅会把它当成一个视频去播放，
      // 而不是当成订阅文本去解析，导致飞牛无法订阅、浏览器直接弹出播放器。
      // GitHub raw 提供的 .m3u 就是 text/plain，飞牛能正常订阅——这里与之对齐。
      // 普通播放器按正文(#EXTM3U)解析、忽略 Content-Type，所以改成 text/plain 对它们零影响。
      result.contentType = "text/plain;charset=UTF-8"
      break;

    default:
      break;
  }
  try {
    result.content = readFileSync(fileName)
  } catch (error) {
    printRed("文件获取失败")
    console.log(error)
    return result
  }
  if (url == "/playback.xml") {
    return result
  }
  
  // 对于播放列表，应用用户配置
  if (url === "/" || url === "/m3u" || url === "/interface.m3u" || url === "/interface.txt" || url === "/txt") {
    try {
      const config = readConfig(profile)

      // 只有存在任意自定义配置时才应用（避免首次访问解析失败）
      // 注意：旧写法 `config.channelGroupMap` 恒真（{} 也为真），会导致始终套用配置；
      // 这里改为按内容判断，并补上 groupRenameMap / customGroups / groupSortMode
      // 另外：EPG 名称规整（issue #39）/ 统一显示名（issue #56）默认对所有人生效，故开关开启时也要走 applyConfig（即使无任何自定义配置）
      // 关键字自动分组（issue #69）与「忽略源自带分组」的默认分组兜底（issue #110）
      // 同为全局配置、不落在任何配置档里，存在时零个性化配置的档也必须走 applyConfig
      if (config && (
        enableTvgNormalize ||
        enableDisplayNameUnify ||
        Object.keys(config.channelGroupMap || {}).length > 0 ||
        Object.keys(config.channelRenameMap || {}).length > 0 ||
        Object.keys(config.channelOrder || {}).length > 0 ||
        Object.keys(config.groupRenameMap || {}).length > 0 ||
        Object.keys(config.groupSortMode || {}).length > 0 ||
        config.hiddenChannels?.length > 0 ||
        config.deletedGroups?.length > 0 ||
        config.customGroups?.length > 0 ||
        config.groupOrder?.length > 0 ||
        config.disabledSources?.length > 0 ||    // 按档禁用源（issue #29/#68）也需触发 applyConfig
        getKeywordGroupRules().length > 0 ||
        hasSourceFallbackGroups())) {
        printGrey("应用播放列表自定义配置")
        const groups = parseInterfaceTxt()
        const configuredGroups = applyConfig(groups, config)
        result.content = url === "/txt" ? generateTxt(configuredGroups) : generateM3u8(configuredGroups)
      }
    } catch (error) {
      printYellow(`应用配置失败，使用原始播放列表: ${error.message}`)
      // 失败时继续使用原始content
    }
  }

  // 生成频道 URL 前缀（根据访问来源自动适配，内网/外网互不影响）
  // 优先使用反向代理转发的原始 host（x-forwarded-host），否则用直接请求的 host
  const forwardedHost = headers["x-forwarded-host"]?.split(",")[0]?.trim()
  const actualHost = forwardedHost || headers.host || ""
  const actualHostName = actualHost.split(":")[0]
  const isLocal = !forwardedHost && (actualHostName === "localhost" || actualHostName === "127.0.0.1" || actualHostName.startsWith("192.168.") || actualHostName.startsWith("10.") || actualHostName.startsWith("172."))
  let replaceHost

  if (isLocal) {
    // 内网/本地直接访问（非代理）：用本地地址，不走外网
    replaceHost = `http://${headers.host}`
  } else if (host != "") {
    // 配置了自定义域名：使用配置的地址
    replaceHost = host
  } else {
    // 外网访问（NAS转发等）：从请求头自动检测协议和域名
    let proto = "http"
    if (headers["x-forwarded-proto"]) {
      proto = headers["x-forwarded-proto"].split(",")[0].trim()
    } else if (forwardedHost) {
      proto = "https"
    }
    replaceHost = `${proto}://${actualHost}`
  }

  // 访问前缀：调用方传入（用户令牌 `/u/<token>` 或站长 `/<pass>`）。
  // 兼容旧调用：未传时回退到原 pass 逻辑。让令牌/密码贯穿分发出去的每个频道与 EPG 地址。
  if (accessPrefix !== undefined) {
    if (accessPrefix) replaceHost = `${replaceHost}${accessPrefix}`
  } else if (pass != "") {
    replaceHost = `${replaceHost}/${pass}`
  }

  // 咪咕 VIP 账号经 URL 注入（站长用 /<pass>/<userId>/<token>/m3u 的场景）；用户令牌请求已剥离成无账号段，不触发
  // 「默认账号」现在来自咪咕模块的配置（原先是 config.js 的全局导出）
  const miguAccount = getModuleConfig('migu')
  if (urlUserId != (miguAccount.userId || "") && urlToken != (miguAccount.token || "")) {
    replaceHost = `${replaceHost}/${urlUserId}/${urlToken}`
  }

  // 兼容版订阅（?relay=1，issue #98）：频道地址改为 /relay/<pid> 清单直出路径，
  // 供不跟随 302 跳转的播放器（极空间极影视、部分老电视盒）使用；
  // ?relay=2 为全代理版：频道地址改为 /proxy/<pid>，连分片也经服务器转发。
  // 只匹配「${replace}/纯数字」的咪咕频道地址；x-tvg-url 的 playback.xml、外部源直链不受影响。
  // 用路径前缀而非 query 参数：m3u 头的 catchup-source 以 "?" 开头直接拼在频道地址后，
  // query 方案会拼出双问号破坏回看，路径方案天然兼容。
  // relay=2（全代理版）再进一步：清单里的分片地址也改回本机，由服务器转发——
  // 给「兼容版清单完全合法却仍播不了、同一条 CDN 地址直接填却能播」的播放器（极影视，issue #98）
  if (relay) {
    // 带 .m3u8 后缀：极影视等播放器按 URL 后缀识别流格式，无后缀会被判定不可播（issue #98 追踪）
    const seg = String(relay) === '2' ? 'proxy' : 'relay'
    result.content = `${result.content}`.replace(/\$\{replace\}\/(\d+)/g, '${replace}/' + seg + '/$1.m3u8')
  }

  // 剥离内部属性 source-ids（issue #29/#68 源归属标记）后再输出给播放器：
  // 覆盖两条路径——原始 interface.txt 直出 与 applyConfig 重生成（generateM3u8 不写该属性，正则兜底无副作用）
  result.content = `${result.content}`.replace(/ source-ids="[^"]*"/g, "").replaceAll("${replace}", replaceHost);

  return result
}

/**
 * 播放请求的解析外壳。
 *
 * 平台知识（签名、缓存、画质档位）已搬进 extractors/<id>/；这里只剩三件事：
 * 解析地址里的 ref 与回看参数、按 ref 路由到模块、把模块结果拼成 HTTP 响应。
 *
 * 失败一律 code=200 + 中文正文（app.js:881-888 直接用 result.code 写响应头），
 * 不改 4xx/5xx——那是存量播放器依赖的行为。
 */
async function channel(url, urlUserId, urlToken) {

  let result = {
    code: 200,
    pID: "",
    desc: "服务异常",
    playURL: ""
  }
  // 处理频道ID
  let urlSplit = url.split("/")[1]
  let pid = urlSplit
  let params = ""

  // 处理回放参数
  if (urlSplit.match(/\?/)) {
    printGreen("处理传入参数")

    const urlSplit1 = urlSplit.split("?")
    pid = urlSplit1[0]
    params = urlSplit1[1]
  } else {
    // printGrey("无参数传入")
  }

  // 按 ref 路由到模块。认不出来 = 收编前 isNaN(pid) 那条分支，措辞保持一致。
  const module = resolverFor(pid)
  if (!module) {
    result.desc = "地址格式错误"
    return result
  }

  let resolved
  try {
    // ctx 带三样：账号（来自地址里的 /userId/token 段）、模块自己的生效配置
    // （画质等，effectiveConfig 是纯内存计算，不碰磁盘）、以及回看参数由外壳处理。
    const config = getExtractorManager().effectiveConfig(module)
    resolved = await module.resolve(pid, { account: { userId: urlUserId, token: urlToken }, config })
  } catch (error) {
    // 模块契约要求 resolve 不抛。万一抛了也绝不能让异常冒出去——app.js 的
    // 请求 handler 没有顶层 try，未捕获异常等于请求永远不 end、客户端挂死。
    console.log(error)
    result.desc = "链接请求出错"
    return result
  }

  if (!resolved || resolved.url == "") {
    result.desc = resolved?.desc || "服务异常"
    return result
  }

  let playURL = resolved.url

  // 添加回放参数。必须是裸字符串拼接——统一用 new URL()/URLSearchParams 构造
  // 会把 puData / ddCalcu 里的原始字符重新编码，签名当场失效。
  if (params != "") {
    const resultParams = new URLSearchParams(params);
    for (const [key, value] of resultParams) {
      playURL = `${playURL}&${key}=${value}`
    }
  }

  result.code = 302
  result.playURL = playURL
  // 仅在 /proxy/ 全代理链里消费；普通 302/relay 不会执行平台分片变换。
  result.segmentTransform = resolved.segmentTransform
  // 平台要求的上游请求头只在服务端清单/分片代理链消费，不下发给客户端。
  result.upstreamHeaders = resolved.upstreamHeaders
  // 个别平台要求每一条子清单/分片路径分别签名；仅全代理登记上游地址时调用。
  result.upstreamUrlTransform = resolved.upstreamUrlTransform
  // 浏览器指纹保护平台可直接交回已经读取到的 HLS；只在清单代理链消费。
  result.manifestText = resolved.manifestText
  result.manifestUrl = resolved.manifestUrl
  // 平台可要求旧的无后缀入口也直出动态 HLS 清单；用于兼容已收藏/已下发的旧地址。
  result.relayHls = resolved.relayHls === true
  return result
}

export { interfaceStr, channel, clearUrlCache, fetchManifestDirect, rewriteManifest, firstVariantUrl, inlineResolvedManifest }
