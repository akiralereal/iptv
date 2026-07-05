import { get302URL, getAndroidURL, getAndroidURL720p, printLoginInfo } from "./androidURL.js";
import { readFileSync } from "./fileUtil.js";
import { dataPath } from "./paths.js";
import { host, pass, rateType, token, userId, enableTvgNormalize } from "../config.js";
import { printDebug, printGreen, printGrey, printRed, printYellow } from "./colorOut.js";
import { readConfig, parseInterfaceTxt, applyConfig, generateM3u8, generateTxt } from "./playlistConfig.js";

// url缓存 降低请求频率（按 pid 缓存咪咕解析出的播放地址，默认 3 小时）
const urlCache = {}

// 清空咪咕地址缓存：H265/HDR/清晰度等配置变更后调用，让新设置「即时生效」，
// 不必等旧缓存过期（3h）或重启容器——旧缓存键只含 pid、不含 H265/HDR，否则会继续发旧编码的流（issue #60）。
function clearUrlCache() {
  for (const k in urlCache) delete urlCache[k]
}

function interfaceStr(url, headers, urlUserId, urlToken, profile, accessPrefix) {

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
      // 另外：EPG 名称规整（issue #39）默认对所有人生效，故开关开启时也要走 applyConfig（即使无任何自定义配置）
      if (config && (
        enableTvgNormalize ||
        Object.keys(config.channelGroupMap || {}).length > 0 ||
        Object.keys(config.channelRenameMap || {}).length > 0 ||
        Object.keys(config.channelOrder || {}).length > 0 ||
        Object.keys(config.groupRenameMap || {}).length > 0 ||
        Object.keys(config.groupSortMode || {}).length > 0 ||
        config.hiddenChannels?.length > 0 ||
        config.deletedGroups?.length > 0 ||
        config.customGroups?.length > 0 ||
        config.groupOrder?.length > 0 ||
        config.disabledSources?.length > 0)) {   // 按档禁用源（issue #29/#68）也需触发 applyConfig
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
  if (urlUserId != userId && urlToken != token) {
    replaceHost = `${replaceHost}/${urlUserId}/${urlToken}`
  }

  // 剥离内部属性 source-ids（issue #29/#68 源归属标记）后再输出给播放器：
  // 覆盖两条路径——原始 interface.txt 直出 与 applyConfig 重生成（generateM3u8 不写该属性，正则兜底无副作用）
  result.content = `${result.content}`.replace(/ source-ids="[^"]*"/g, "").replaceAll("${replace}", replaceHost);

  return result
}

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

  if (isNaN(pid)) {
    result.desc = "地址格式错误"
    return result
  }

  // printYellow("频道ID " + pid)

  // 是否存在缓存
  const cache = channelCache(pid, params)
  if (cache.haveCache) {
    result.code = cache.code
    result.playURL = cache.playURL
    result.desc = cache.cacheDesc
    return result
  }

  let resObj = {}
  try {
    // 未登录请求720p
    if (rateType >= 3 && (urlUserId == "" || urlToken == "")) {
      resObj = await getAndroidURL720p(pid)
    } else {
      resObj = await getAndroidURL(urlUserId, urlToken, pid, rateType)
    }
  } catch (error) {
    console.log(error)
    result.desc = "链接请求出错"
    return result
  }
  printDebug(`添加加密字段后链接 ${resObj.url}`)

  if (resObj.url != "") {
    const location = await get302URL(resObj)
    if (location != "") {
      resObj.url = location
    }
  }
  printLoginInfo(resObj)
  // printRed(resObj.url)
  // printGreen(`添加节目缓存 ${pid}`)
  // 缓存有效时长
  let addTime = 3 * 60 * 60 * 1000
  // 节目调整
  if (resObj.url == "") {
    addTime = 1 * 60 * 1000
  }
  // 加入缓存
  urlCache[pid] = {
    // 有效期3小时 节目调整时改为1分钟
    valTime: Date.now() + addTime,
    url: resObj.url,
    content: resObj.content,
  }

  if (resObj.url == "") {
    let msg = resObj.content != null ? resObj.content.message : "节目调整，暂不提供服务"
    result.desc = `${pid} ${msg}`
    return result
  }
  let playURL = resObj.url

  // 添加回放参数
  if (params != "") {
    const resultParams = new URLSearchParams(params);
    for (const [key, value] of resultParams) {
      playURL = `${playURL}&${key}=${value}`
    }
  }

  // printGreen("链接获取成功")
  result.code = 302
  result.playURL = playURL
  return result
}

function channelCache(pid, params) {
  let cache = {
    haveCache: false,
    code: 200,
    pID: "",
    playURL: "",
    cacheDesc: ""
  }
  if (typeof urlCache[pid] === "object") {
    const valTime = urlCache[pid].valTime - Date.now()
    // 缓存是否有效
    if (valTime >= 0) {
      cache.haveCache = true
      let playURL = urlCache[pid].url
      let msg = "节目调整，暂不提供服务"
      if (urlCache[pid].content != null) {
        printLoginInfo(urlCache[pid])
        msg = urlCache[pid].content.message
      }
      // 节目调整
      if (playURL == "") {
        cache.cacheDesc = `${pid} ${msg}`
        return cache
      }

      // 添加回放参数
      if (params != "") {
        const resultParams = new URLSearchParams(params);
        for (const [key, value] of resultParams) {
          playURL = `${playURL}&${key}=${value}`
        }
      }
      printGreen("使用缓存数据")
      cache.code = 302
      cache.cacheDesc = "缓存获取成功"
      cache.playURL = playURL
      return cache
    }
  }
  cache.cacheDesc = "暂无缓存"
  return cache
}

export { interfaceStr, channel, channelCache, clearUrlCache }
