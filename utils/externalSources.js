import { readFileSync, existsSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { writeJsonFileSync } from "./fileUtil.js"
import { dataPath } from "./paths.js"
import { enableBuiltInSubscriptions } from "../config.js"
import { printBlue, printGreen, printGrey, printRed, printYellow } from "./colorOut.js"
import { extractM3u8FromWeb, validateM3u8 } from "./webSourceExtractor.js"
import { collectOptsUntilUrl, cleanUserAgent, withUserAgent } from "./channelOpts.js"
import { parseCatchupAttrs, resolveCatchup, sanitizeCatchup } from "./channelCatchup.js"
import { FailureBackoff } from "./refreshBackoff.js"
import fetch from 'node-fetch'
import { customSourceFetch, proxiableUrl, proxyRefFor } from "./customSourceProxy.js"
import { outboundProxyUrl } from "./outboundProxy.js"

/**
 * 从一行 #EXTINF 提取频道显示名。
 * 标准格式是「属性...,频道名」，但有些源把 group-title 等属性写在逗号之后
 * （如 tvg-logo="x",group-title="y",频道名，见 issue #84），若直接取「第一个逗号
 * 之后」会把 group-title="y" 一并吞进名字，脏名字再回填进 tvg-id="..." 会破坏
 * 整行 EXTINF 语法、导致该频道播放异常。
 * 因此改为取「最后一个属性引号之后的那个逗号」后的部分——属性都是 key="value"，
 * 末个引号之后剩下的就是显示名；无带引号属性时回退到第一个逗号。
 */
function extractExtinfName(line) {
  const lastQuote = line.lastIndexOf('"')
  if (lastQuote !== -1) {
    const after = line.slice(lastQuote + 1)
    const comma = after.indexOf(',')
    if (comma !== -1) return after.slice(comma + 1).trim()
  }
  const comma = line.indexOf(',')
  return comma !== -1 ? line.slice(comma + 1).trim() : ''
}

/**
 * 解析 m3u/m3u8 播放列表内容，提取频道列表
 */
function parseM3uContent(content) {
  const lines = content.split('\n').map(l => l.trim()).filter(l => l)
  const channels = []
  // 文件头的回看声明对其后所有频道生效，行内逐字段覆盖（issue #190）。
  // 拼接起来的多段列表每段各有文件头，遇到新的 #EXTM3U 就换成新的那份。
  let headerCatchup = {}

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\uFEFF?#EXTM3U/i.test(line)) {
      headerCatchup = parseCatchupAttrs(line)
      continue
    }
    if (!line.startsWith('#EXTINF:')) continue

    // 解析 #EXTINF 行
    const groupMatch = line.match(/group-title="([^"]*)"/)
    const logoMatch = line.match(/tvg-logo="([^"]*)"/)
    // 海外模块和自定义订阅共用：服务端现取主清单，把最高档挪到最前。
    const topFirst = /\sx-top-first="(?:1|true)"/i.test(line)
    const name = extractExtinfName(line)
    // 源自带的回看模板 / 天数：不收下就只能继承订阅头的咪咕模板，回看静默失效（issue #190）
    const catchup = resolveCatchup(headerCatchup, line)

    // 下一个非注释行是 URL；沿途的 #EXTVLCOPT 收进 opts（防盗链源靠它才播得动）
    const { opts, urlIndex } = collectOptsUntilUrl(lines, i)
    const url = urlIndex === -1 ? '' : lines[urlIndex]

    if (url && name) {
      channels.push({
        name,
        group: groupMatch ? groupMatch[1] : '未分组',
        logo: logoMatch ? logoMatch[1] : '',
        url: url,
        ...(opts.length ? { opts } : {}),
        ...(topFirst ? { topFirst: true } : {}),
        ...catchup
      })
    }
  }

  return channels
}

/**
 * 解析 TXT（diyp / TVBox）格式播放列表，提取频道列表。
 * 格式约定：
 *   分组名,#genre#          → 分组头，后续频道归入该分组
 *   频道名,播放地址          → 一个频道
 *   频道名,地址1#地址2#地址3  → 同一频道的多个备用源，取第一个
 * 分组为空的频道交由 getValidChannels 回退到 source.group。
 */
function parseTxtContent(content) {
  const lines = content.split('\n').map(l => l.trim()).filter(l => l)
  const channels = []
  let currentGroup = ''

  for (const line of lines) {
    // 跳过注释行（m3u 残留指令、自定义注释等）
    if (line.startsWith('#')) continue

    const commaIndex = line.indexOf(',')
    if (commaIndex === -1) continue

    const name = line.slice(0, commaIndex).trim()
    const rest = line.slice(commaIndex + 1).trim()
    if (!name || !rest) continue

    // 分组头：xxx,#genre#
    if (rest.toLowerCase() === '#genre#') {
      currentGroup = name
      continue
    }

    // 频道行：部分 txt 用 # 连接多个备用源，取第一个
    const url = rest.split('#')[0].trim()
    if (!url || !url.includes('://')) continue

    channels.push({
      name,
      group: currentGroup,
      logo: '',
      url
    })
  }

  return channels
}

/**
 * 解析订阅内容，自动识别 M3U/M3U8 或 TXT（diyp/TVBox）格式。
 * 含 #EXTM3U 头或 #EXTINF 行视为 M3U，否则按 TXT 解析。
 */
function parsePlaylistContent(content) {
  if (/^﻿?#EXTM3U/i.test(content) || /#EXTINF:/i.test(content)) {
    return parseM3uContent(content)
  }
  return parseTxtContent(content)
}

/**
 * 订阅源频道的最终分组：频道自带分组优先；为空、或仍是占位「未分组」时，
 * 回退到该源配置的「默认分组」(source.group)。issue #69 跟进——让订阅里没写
 * group-title 的频道整体归到用户指定的默认分组，而不是堆在「未分组」。
 * （m3u 解析对无 group-title 的频道填的就是字符串「未分组」，故与空值一并视作未分组。）
 *
 * 忽略源自带分组（issue #110）：勾选 ignoreGroups 的源，group-title 一律不采用，
 * 频道以「未分组」进入生成管道，让关键字自动分组规则接管。默认分组不能在这里
 * 回填——那会让频道绕开规则匹配——而是由 applyConfig 在规则未命中时兜底
 * （见 sourceGroupFallback.js）。
 */
export function resolveSubscriptionGroup(ch, source) {
  if (source && source.ignoreGroups === true) return '未分组'
  const own = ch && ch.group && ch.group !== '未分组' ? ch.group : ''
  return own || (source && source.group) || '未分组'
}

/**
 * 用 GBK 解码字节，环境无 GBK 解码器时回退宽松 UTF-8
 */
function decodeGbk(buffer) {
  try {
    return new TextDecoder('gbk').decode(buffer)
  } catch {
    return buffer.toString('utf-8')
  }
}

/**
 * 解码订阅内容字节，处理非 UTF-8 编码。
 * node-fetch 的 response.text() 始终按 UTF-8 解码，部分中文 IPTV 订阅是 GBK/GB2312，
 * 直接 .text() 会导致分组名/频道名乱码。这里按优先级判定编码：
 * 1) BOM 嗅探（UTF-8 / UTF-16）；2) Content-Type 的 charset；3) 严格 UTF-8 试解，失败回退 GBK。
 * @param {Buffer} buffer - 响应原始字节
 * @param {string|null} contentType - 响应 Content-Type 头
 * @returns {string}
 */
function decodeSubscriptionBody(buffer, contentType) {
  if (!buffer || buffer.length === 0) return ''

  // 1. BOM 嗅探
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return buffer.toString('utf-8', 3) // 去掉 UTF-8 BOM
  }
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    return new TextDecoder('utf-16le').decode(buffer)
  }
  if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
    return new TextDecoder('utf-16be').decode(buffer)
  }

  // 2. Content-Type 声明的 charset
  const charset = (contentType || '').toLowerCase().match(/charset=\s*"?([\w-]+)"?/)?.[1]
  if (charset) {
    if (/^(gb2312|gb18030|gbk)$/.test(charset)) return decodeGbk(buffer)
    if (/^utf-?8$/.test(charset)) return buffer.toString('utf-8')
  }

  // 3. 启发式：先按严格 UTF-8 试解，遇到非法字节说明不是 UTF-8，回退 GBK
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return decodeGbk(buffer)
  }
}

/**
 * 解码并解析「本地导入」的播放列表字节（base64）。复用订阅的字节解码（BOM/charset/UTF-8 试解/GBK 回退）
 * 与 m3u/txt 解析，使本地上传的文件与在线订阅得到一致的编码处理与频道结构（issue #43）。
 * @param {string} base64 - 文件原始字节的 base64
 * @returns {{ text: string, channels: Array }}
 */
function decodeAndParseLocalContent(base64) {
  const buffer = Buffer.from(String(base64 || ''), 'base64')
  const text = decodeSubscriptionBody(buffer, null)
  const channels = parsePlaylistContent(text)
  return { text, channels }
}

/**
 * 将 raw.githubusercontent.com 地址转换为 jsdelivr 格式 /gh/owner/repo@branch/path
 */
function toJsdelivr(url, base) {
  let u = url.replace('https://raw.githubusercontent.com/', base)
  if (u.includes('/refs/heads/')) {
    u = u.replace('/refs/heads/', '@')
  } else {
    // owner/repo/branch/path → owner/repo@branch/path
    u = u.replace(/(\/gh\/[^/]+\/[^/]+)\//, '$1@')
  }
  return u
}

/**
 * GitHub raw 镜像列表（当直连 raw.githubusercontent.com 失败时回退）
 */
const GITHUB_RAW_MIRRORS = [
  (url) => url, // 原始地址优先
  (url) => url.replace('https://raw.githubusercontent.com/', 'https://ghfast.top/https://raw.githubusercontent.com/'),
  (url) => url.replace('https://raw.githubusercontent.com/', 'https://gh-proxy.com/https://raw.githubusercontent.com/'),
  (url) => toJsdelivr(url, 'https://gcore.jsdelivr.net/gh/'),
  (url) => toJsdelivr(url, 'https://cdn.jsdelivr.net/gh/'), // 备用 jsdelivr 边缘节点
]

/**
 * 从 URL 中取出主机名（用于日志/错误信息）
 */
function hostOf(url) {
  try { return new URL(url).host } catch { return url }
}

/**
 * 拆出 URL 内嵌的 user:pass@ 凭据，转成 HTTP Basic 认证头。
 * node-fetch 会直接拒绝带凭据的 URL（抛 "url with embedded credentials"），
 * 故订阅地址形如 http://user:pass@host/x.m3u 时，需把凭据从 URL 取出、改用 Authorization 头。
 * 返回去掉凭据后的 URL 与对应请求头（无凭据时 headers 为空，行为不变）。
 * @param {string} rawUrl
 * @returns {{ url: string, headers: Record<string,string> }}
 */
function splitCredentials(rawUrl) {
  let u
  try { u = new URL(rawUrl) } catch { return { url: rawUrl, headers: {} } }
  if (u.username === '' && u.password === '') return { url: rawUrl, headers: {} }
  // URL 里的 user/pass 是百分号编码，解码还原真实凭据再做 base64（解码失败则原样使用）
  const dec = (s) => { try { return decodeURIComponent(s) } catch { return s } }
  const token = Buffer.from(`${dec(u.username)}:${dec(u.password)}`).toString('base64')
  u.username = ''
  u.password = ''
  return { url: u.toString(), headers: { Authorization: `Basic ${token}` } }
}

/**
 * 把 fetch 失败原因提炼成可读信息（node-fetch 的 reason 经常为空）
 */
function describeFetchError(error) {
  if (error?.name === 'AbortError' || error?.type === 'aborted') return '请求超时'
  // 经网络代理拉的（customSourceFetch 挂上的）：认得出是哪一段就用翻好的话，认不出照旧给错误码
  if (error?.proxyFailure?.stage) return error.proxyFailure.message
  return error?.code || error?.cause?.code || error?.cause?.message || error?.message || '未知错误'
}

// 拉订阅的默认 UA；订阅源设置里填了 User-Agent 就用填的（issue #170）
const DEFAULT_SUBSCRIPTION_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

// 订阅源的「拉取超时 / 失败重试」（issue #223）。默认值就是改动前的行为：每条线路 15 秒、不重试。
// 设上限是为了不让一个慢源拖住 5 分钟一轮的源刷新：那一轮串行、有防重入锁，
// 这个源拉多久，内置源、其它外部源、抓取模块就等多久（#195 就是这么全停的）
const SUBSCRIPTION_FETCH_LIMITS = Object.freeze({
  timeoutSeconds: { min: 5, max: 120, default: 15 },
  retries: { min: 0, max: 3, default: 0 },
})

/** 取整并夹到 [min, max]；留空、非数字用默认值 */
function clampInt(value, { min, max, default: fallback }) {
  if (value === null || value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * 订阅源设置 → fetchAndParseM3u 的参数（UA、超时、重试）。
 * fetchTimeout 单位是秒；超出范围的值夹到上下限而不是报错，后台输入框也按同一范围夹。
 */
function subscriptionFetchOptions(source) {
  return {
    userAgent: source?.userAgent,
    timeoutMs: clampInt(source?.fetchTimeout, SUBSCRIPTION_FETCH_LIMITS.timeoutSeconds) * 1000,
    retries: clampInt(source?.fetchRetries, SUBSCRIPTION_FETCH_LIMITS.retries),
  }
}

/**
 * 订阅拉取失败后给用户的可操作提示（issue #223）。只对超时类失败提示，且分情况：
 * 内置订阅（精选频道）后台没有卡片、本来就走 5 条镜像 + 本地快照兜底，不提示；
 * GitHub raw 地址「失败重试」不生效、5 条线路各算一次超时，只建议调超时；其它地址两项都建议。
 * 超时已调到上限时也不提示——再提就是让用户白忙。
 * @returns {string} 直接拼在错误信息后面的一句话；不该提示时为空串
 */
function subscriptionFailureHint(error, fetchOptions, source) {
  if (!error?.timedOut) return ''
  if (isBuiltInSubscriptionSource(source)) return ''
  if (fetchOptions.timeoutMs >= SUBSCRIPTION_FETCH_LIMITS.timeoutSeconds.max * 1000) return ''
  if (error.mirrored) {
    return '。订阅较大或服务器较慢的话，可在这个订阅的设置里调大「拉取超时」（GitHub 地址会依次试 5 条线路，每条各算一次超时；「失败重试」对它不生效）'
  }
  return '。订阅较大或服务器较慢的话，可在这个订阅的设置里调大「拉取超时」或「失败重试」'
}

/** 这些 HTTP 状态可能下次就好（服务器忙、限流、网关超时），值得重试 */
const isRetryableStatus = (status) => status >= 500 || status === 408 || status === 425 || status === 429

/**
 * 这次失败值不值得重试。超时、连接被断、DNS 一时解析不了、服务器 5xx/429 下次可能就好；
 * 404/403 这类明确拒绝、地址写错、内容解析不出频道，重试多少次都一样，不白等。
 */
function isRetryableFetchError(error) {
  if (typeof error?.retryable === 'boolean') return error.retryable
  if (error?.name === 'AbortError' || error?.type === 'aborted') return true
  // node-fetch 对不合法地址、不支持的协议抛 TypeError；网络层错误是 FetchError。
  // undici（开了「经网络代理转发」的源用它）的网络层错误也是 TypeError，固定写 fetch failed，原因在 cause 里
  if (error instanceof TypeError) return error.message === 'fetch failed' && error.cause != null
  return true
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 从远程 URL 获取并解析 m3u 播放列表（支持 GitHub 镜像回退）
 *
 * @param {object} [options]
 * @param {string} [options.userAgent] 自定义 UA；不合法或留空用默认值
 * @param {number} [options.timeoutMs] 每条线路每次尝试的总超时（含读完响应体），默认 15 秒；测试用来压缩
 * @param {number} [options.retries] 可重试的失败（超时、断连、5xx/429）之后再试几次，默认 0、最多 3。
 *   GitHub raw 地址不叠加：它失败时本来就会依次换 5 条镜像线路，那就是它的重试
 * @param {number} [options.retryDelayMs] 第 n 次重试前等 n × retryDelayMs，默认 2 秒；测试用来压缩
 */
async function fetchAndParseM3u(subscriptionUrl, { userAgent, timeoutMs = 15000, retries = 0, retryDelayMs = 2000, fetchImpl = fetch } = {}) {
  const ua = cleanUserAgent(userAgent) || DEFAULT_SUBSCRIPTION_UA
  const attemptMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000
  const isGithubRaw = subscriptionUrl.includes('raw.githubusercontent.com')
  const mirrors = isGithubRaw ? GITHUB_RAW_MIRRORS : [(url) => url]
  // GitHub raw 再按重试次数整组重跑，最坏耗时会翻好几倍，故只给单线路地址重试
  const extraRounds = isGithubRaw ? 0 : clampInt(retries, SUBSCRIPTION_FETCH_LIMITS.retries)

  const failures = []
  let timedOut = false

  for (let round = 0; round <= extraRounds; round++) {
    if (round > 0) {
      const waitMs = retryDelayMs * round
      printYellow(`订阅获取失败，${Math.round(waitMs / 100) / 10} 秒后第 ${round}/${extraRounds} 次重试: ${hostOf(subscriptionUrl)}`)
      await sleep(waitMs)
    }
    let worthRetrying = false

    for (const transformUrl of mirrors) {
      const transformedUrl = transformUrl(subscriptionUrl)
      // 拆出 URL 内嵌的 user:pass@ 凭据，转成 Basic 认证头（node-fetch 不接受带凭据的 URL）
      const { url: targetUrl, headers: authHeaders } = splitCredentials(transformedUrl)
      const controller = new AbortController()
      // 超时要管到读完响应体：只管到响应头的话，对方发完头就停住会让这次拉取永远挂着，
      // 进而卡死 5 分钟一轮的源刷新（防重入锁不释放，之后每轮都跳过，issue #195）
      const timeoutId = setTimeout(() => controller.abort(), attemptMs)

      try {
        const response = await fetchImpl(targetUrl, {
          signal: controller.signal,
          headers: {
            'User-Agent': ua,
            ...authHeaders
          }
        })

        if (!response.ok) {
          const error = new Error(`HTTP ${response.status}${response.statusText ? ' ' + response.statusText : ''}`)
          error.retryable = isRetryableStatus(response.status)
          throw error
        }

        // 读原始字节并按编码解码（兼容 GBK/GB2312 订阅，避免分组/频道名乱码）
        const buffer = Buffer.from(await response.arrayBuffer())
        clearTimeout(timeoutId)
        const content = decodeSubscriptionBody(buffer, response.headers.get('content-type'))
        const channels = parsePlaylistContent(content)

        if (channels.length === 0) {
          const error = new Error('未能从播放列表中解析出任何频道')
          error.retryable = false
          throw error
        }

        if (transformedUrl !== subscriptionUrl) {
          printGreen(`通过镜像获取成功: ${hostOf(targetUrl)}`)
        }
        if (round > 0) {
          printGreen(`第 ${round} 次重试获取成功: ${hostOf(targetUrl)}`)
        }

        return channels
      } catch (error) {
        clearTimeout(timeoutId)
        const reason = describeFetchError(error)
        if (reason === '请求超时') timedOut = true
        if (isRetryableFetchError(error)) worthRetrying = true
        failures.push(`${hostOf(targetUrl)}(${round > 0 ? `第 ${round + 1} 次 ` : ''}${reason})`)
        printYellow(`订阅获取失败 (${hostOf(targetUrl)}): ${reason}`)
        continue
      }
    }

    if (!worthRetrying) break
  }

  // 远程（raw + 所有镜像）都失败：内置订阅源回退读镜像里自带的本地快照，保证精选频道仍能加载（无外网/镜像也挂时）
  const localFile = BUILT_IN_SUBSCRIPTION_LOCAL_FALLBACK[subscriptionUrl]
  if (localFile) {
    try {
      const localPath = `${process.cwd()}/${localFile}`
      if (existsSync(localPath)) {
        const channels = parsePlaylistContent(decodeSubscriptionBody(readFileSync(localPath), ''))
        if (channels.length > 0) {
          printYellow(`远程订阅均失败，回退镜像内置 ${localFile}（${channels.length} 个频道，可能非最新）`)
          return channels
        }
      }
    } catch (e) {
      printYellow(`镜像内置 ${localFile} 兜底读取失败: ${e.message}`)
    }
  }

  // 所有线路都失败：给出可操作的提示，而不是单条被截断的 node-fetch 报错
  // 订阅拉取不走代理，别在提示里让用户去配代理；服务端拉不到时给能当场用的出路
  const error = new Error(`所有线路均无法获取订阅，请检查服务器能否访问这个地址；访问不了的话，可更换能访问的订阅地址，或在电脑上下载后改用「本地文件 / 粘贴」导入。已尝试: ${failures.join('，')}`)
  // 有线路是超时失败的：调用方据此提示「可以调大超时」（订阅源设置里有这一项，issue #223）；
  // mirrored 标明走的是 GitHub 镜像组，提示里要说明「失败重试」对它不生效
  error.timedOut = timedOut
  error.mirrored = isGithubRaw
  throw error
}

const EXTERNAL_SOURCES_PATH = dataPath('external-sources.json')

/**
 * 内置订阅源列表：新安装会自动写入，已有配置会在启动时补齐缺失项（按 subscriptionUrl 去重）
 */
const BUILT_IN_SUBSCRIPTIONS = [
  {
    name: '精选频道',
    group: '未分组',
    enabled: true,
    mode: 'subscription',
    m3u8Url: '',
    webUrl: '',
    subscriptionUrl: 'https://raw.githubusercontent.com/akiralereal/iptv/refs/heads/main/IPTV.m3u',
    parsedChannels: null,
    autoRefresh: true,
    refreshInterval: 360,
    updateOnStartup: true,
    lastUpdated: null
  }
]

// 内置订阅源「镜像内置本地文件」兜底：远程（raw + 所有 GitHub 镜像）都拉不到时，回退读镜像里自带的这份快照，
// 保证精选频道在「无外网、且第三方 GitHub 镜像也挂」的环境下仍能加载（issue：国内拉不到 raw.githubusercontent）。
// { 订阅 URL: 镜像内置文件名（位于 process.cwd()，由 Dockerfile `COPY . .` 打包） }
const BUILT_IN_SUBSCRIPTION_LOCAL_FALLBACK = {
  [BUILT_IN_SUBSCRIPTIONS[0].subscriptionUrl]: 'IPTV.m3u',
}

// 已退役的内置订阅源 URL（曾经内置、现已移除）。启动时一次性从老用户配置中清除，
// 避免「换掉常量 URL 后旧源仍残留、且因不在 BUILT_IN_SUBSCRIPTION_URLS 里而连开关都关不掉」的僵尸源问题。
const RETIRED_SUBSCRIPTION_URLS = [
  'https://raw.githubusercontent.com/YueChan/Live/refs/heads/main/GNTV.m3u',
  'https://raw.githubusercontent.com/YueChan/Live/refs/heads/main/Global.m3u'
]

function cloneBuiltInSubscription(entry) {
  return JSON.parse(JSON.stringify(entry))
}

// 默认自定义订阅：新装和升级各播种一次，作为普通「自定义源」卡片出现，和用户自己加的一样
// 能改名、停用、删除，删了不复活（账本 seededDefaultSubscriptions）。与上面的内置订阅不同：
// 不在后台隐藏、不受「内置订阅」开关的抓取 / 输出控制，只在开关关着时不播种。
// match 认的是同一份列表的各种写法（refs/heads/main、镜像前缀），用户手动加过就不再重复加。
const DEFAULT_CUSTOM_SUBSCRIPTIONS = [
  {
    match: /\/from-the-web\/from-the-web\.m3u(\?|#|$)/,
    source: {
      name: '网络分享',
      group: '未分组',
      enabled: true,
      mode: 'subscription',
      m3u8Url: '',
      webUrl: '',
      subscriptionUrl: 'https://raw.githubusercontent.com/akiralereal/iptv/main/from-the-web/from-the-web.m3u',
      parsedChannels: null,
      autoRefresh: true,
      refreshInterval: 1440,
      updateOnStartup: true,
      lastUpdated: null,
    },
  },
]

// 只迁移这份仓库订阅的两个旧名称；一次性执行，之后仍允许用户自行改名。
function migrateNetworkShareName(config) {
  if (!config || !Array.isArray(config.sources) || config.networkShareNameV1) return false
  for (const source of config.sources) {
    if (source?.mode !== 'subscription') continue
    const url = String(source.subscriptionUrl || '').trim()
    if (!/\/akiralereal\/iptv\/(?:refs\/heads\/)?main\/from-the-web\/from-the-web\.m3u(?:[?#]|$)/.test(url)) continue
    if (['海外', '来源于网络'].includes(String(source.name || '').trim())) source.name = '网络分享'
  }
  config.networkShareNameV1 = true
  return true
}

/**
 * 播种默认自定义订阅（只播一次，尊重删除）。已有同一份列表（任何写法）就只记账不加。
 * @returns {boolean} 配置是否被改动（需要落盘）
 */
function ensureDefaultCustomSubscriptions(config) {
  if (!config || !Array.isArray(config.sources)) return false
  if (!enableBuiltInSubscriptions) return false  // 「只去掉自带的额外源 / 订阅」的人不要它
  if (!Array.isArray(config.seededDefaultSubscriptions)) config.seededDefaultSubscriptions = []
  let mutated = false
  for (const def of DEFAULT_CUSTOM_SUBSCRIPTIONS) {
    const url = def.source.subscriptionUrl
    if (config.seededDefaultSubscriptions.includes(url)) continue
    const exists = config.sources.some(s => s && s.mode === 'subscription' && def.match.test(String(s.subscriptionUrl || '').trim()))
    if (!exists) {
      config.sources.push(cloneBuiltInSubscription(def.source))
      printBlue(`添加默认自定义订阅: ${def.source.name}`)
    }
    config.seededDefaultSubscriptions.push(url)
    mutated = true
  }
  return mutated
}

// 内置订阅源 URL 集合与判断：禁用内置订阅时，抓取层(updateAllSources/updateSubscriptionSource)
// 与服务层(getValidChannels)都据此跳过，避免无谓联网下载，并保证输出一致。
const BUILT_IN_SUBSCRIPTION_URLS = new Set(BUILT_IN_SUBSCRIPTIONS.map(b => b.subscriptionUrl))
function isBuiltInSubscriptionSource(source) {
  return !!(source && source.subscriptionUrl && BUILT_IN_SUBSCRIPTION_URLS.has(source.subscriptionUrl))
}

/**
 * 这个源有没有开「经网络代理转发」（customSourceProxy.js）。只认用户自己加的订阅源和直连源：
 * 内置「精选频道」订阅不认（它和内置模块一样不让用户改出站），抓取模式不认（网页抓取由浏览器做，不经这个代理）。
 */
function sourceUsesProxy(source) {
  if (!source || source.useProxy !== true || isBuiltInSubscriptionSource(source)) return false
  if (source.mode === 'subscription') return true
  const mode = source.mode || (String(source.webUrl || '').trim() ? 'fetch' : 'direct')
  return mode === 'direct'
}

// 两种处理共用稳定入口，出站是否经网络代理独立记录；普通频道仍保留原地址。
function customPlaybackFields(source, name, url, topFirst) {
  const mode = source.mode || (String(source.webUrl || '').trim() ? 'fetch' : 'direct')
  if (!source.id || isBuiltInSubscriptionSource(source) || !['subscription', 'direct'].includes(mode) || !proxiableUrl(url)) return {}
  const useProxy = sourceUsesProxy(source)
  if (!useProxy && topFirst !== true) return {}
  return { proxyRef: proxyRefFor(source.id, name, url), useProxy, topFirst: topFirst === true }
}

// 播种内置订阅源（精选频道）。
// 关键改动：从「缺了就加回来」改为「只播种从未播种过的 URL」，用 config.seededBuiltInUrls 记录已播种集合。
// 这样用户删除内置订阅后不会在重启时复活（修复 issue：默认源删不掉）。
// enableBuiltInSubscriptions=false 时不再播种。
function ensureBuiltInSubscriptions(config) {
  if (!config || !Array.isArray(config.sources)) return false
  let mutated = false
  // 首次升级迁移：把「当前已存在的内置订阅 URL」视为已播种，避免老用户之后删除被重新加回。
  if (!Array.isArray(config.seededBuiltInUrls)) {
    config.seededBuiltInUrls = BUILT_IN_SUBSCRIPTIONS
      .map(b => b.subscriptionUrl)
      .filter(url => config.sources.some(s => s && s.subscriptionUrl === url))
    mutated = true
  }
  if (!enableBuiltInSubscriptions) return mutated  // 关闭：不再播种
  for (const builtIn of BUILT_IN_SUBSCRIPTIONS) {
    const url = builtIn.subscriptionUrl
    if (config.seededBuiltInUrls.includes(url)) continue  // 已播种（含被用户删除过）→ 不再加
    if (!config.sources.some(s => s && s.subscriptionUrl === url)) {
      config.sources.push(cloneBuiltInSubscription(builtIn))
      printBlue(`补齐内置订阅源: ${builtIn.name}`)
    }
    config.seededBuiltInUrls.push(url)
    mutated = true
  }
  return mutated
}

// 外部源稳定 id（issue #29/#68 按档过滤源）：随源一次生成、永不改变，供「配置档 ↔ 源」绑定引用
// （数组下标会因删源移位，不能当标识）。幂等：已有 id 原样保留；存量配置补齐后由调用方持久化。
function ensureSourceIds(config) {
  if (!config || !Array.isArray(config.sources)) return false
  let mutated = false
  const used = new Set(config.sources.map(s => (s && typeof s.id === 'string') ? s.id : '').filter(Boolean))
  for (const s of config.sources) {
    if (!s || (typeof s.id === 'string' && s.id)) continue
    let id
    do { id = randomBytes(4).toString('hex') } while (used.has(id))
    used.add(id)
    s.id = id
    mutated = true
  }
  return mutated
}

// 无 id 的进货源若与现有源「身份」匹配（订阅地址 / 网页地址 / 名称+直连地址），继承其已有 id——
// 前端整份保存可能带着「服务端已发过 id 但客户端未回读」的旧副本，若任由 ensureSourceIds 重新发号，
// 「配置档 ↔ 源」绑定（disabledSources 引用的 ext:<id>）会悄悄变孤儿（issue #29/#68）。
function inheritExistingSourceIds(incoming, current) {
  if (!incoming || !Array.isArray(incoming.sources) || !current || !Array.isArray(current.sources)) return
  const keyOf = s => s.subscriptionUrl ? `sub|${s.subscriptionUrl}`
    : s.webUrl ? `web|${s.webUrl}`
    : s.m3u8Url ? `m3u|${s.name || ''}|${s.m3u8Url}`
    : `name|${s.name || ''}`
  const byKey = new Map()
  for (const s of current.sources) {
    if (s && typeof s.id === 'string' && s.id) {
      const k = keyOf(s)
      if (!byKey.has(k)) byKey.set(k, s.id)
    }
  }
  const used = new Set(incoming.sources.map(s => (s && typeof s.id === 'string') ? s.id : '').filter(Boolean))
  for (const s of incoming.sources) {
    if (!s || (typeof s.id === 'string' && s.id)) continue
    const id = byKey.get(keyOf(s))
    if (id && !used.has(id)) { s.id = id; used.add(id) }
  }
}

// 这份配置里有两个键是**服务端自己的账本**，前端完全不知道它们的存在：
//
//   · seededBuiltInUrls —— 「哪些内置订阅已经播种过」。它是「用户删掉的内置订阅
//     不再复活」这个承诺（README「已添加的可在源管理删除，删后不再复活」）的
//     唯一凭据。丢了 → 下次启动 ensureBuiltInSubscriptions 认为从没播种过 → 补回来。
//   · retiredBuiltInsV1 —— 「退役迁移已跑过」的标记。而退役迁移是会**删源**的
//     （见下方 retireBuiltInSubscriptions 里的 filter）。丢了 → 重跑 → 用户若手动
//     重新添加过已退役的那两个订阅，会被再删一次。
//
// 而前端的 normalizeExternalConfig 只保留 { enabled, includeInPlaylists,
// updateOnStartup, sources } 四个键，后台任何一次保存（编辑源 / 换序 / 导入订阅 /
// 抓取并保存…）都把整份对象 POST 回来，saveSources 又是整份覆盖写盘 ——
// 于是这两个账本每次保存都被静默抹掉。
//
// 实测：删掉「精选频道」→ 后台随便保存一次 → 重启，它就回来了。
// seededDefaultSubscriptions 同理：「哪些默认自定义订阅已经播种过」，丢了删掉的「网络分享」会复活
const SERVER_OWNED_KEYS = ['seededBuiltInUrls', 'retiredBuiltInsV1', 'seededDefaultSubscriptions', 'networkShareNameV1']

/**
 * 把内置订阅源**重新**播种回来（用户在「内置源」那一段主动打开开关时调用）。
 *
 * 与启动期的 ensureBuiltInSubscriptions 区别在于它**无视 seededBuiltInUrls**：
 * 那个账本的意思是「别自己复活」，而这里是用户明确点了开关说「我要它」——
 * 两回事。README 承诺的是删掉之后不会自己回来，不是永远回不来。
 *
 * 之所以必须有这个：内置订阅在「源管理」里已经不露面了，用户唯一的控制就是那个
 * 开关。若开关对「曾经删过它的人」是哑的（点开也不回来），那就等于没有控制。
 *
 * @returns {boolean} 是否真的加了东西
 */
function reseedBuiltInSubscriptions(config) {
  if (!config || !Array.isArray(config.sources)) return false
  if (!Array.isArray(config.seededBuiltInUrls)) config.seededBuiltInUrls = []
  let added = false
  for (const builtIn of BUILT_IN_SUBSCRIPTIONS) {
    const url = builtIn.subscriptionUrl
    if (config.sources.some(s => s && s.subscriptionUrl === url)) continue  // 已经在了
    config.sources.push(cloneBuiltInSubscription(builtIn))
    if (!config.seededBuiltInUrls.includes(url)) config.seededBuiltInUrls.push(url)
    printBlue(`重新加入内置订阅源: ${builtIn.name}`)
    added = true
  }
  return added
}

// 一次性退役迁移：把已退役的内置订阅源从用户配置中移除（用 retiredBuiltInsV1 标记，只跑一次，
// 之后尊重用户的手动增删，与 seededBuiltInUrls 的「只播种一次」哲学一致）。
function retireBuiltInSubscriptions(config) {
  if (!config || !Array.isArray(config.sources)) return false
  if (config.retiredBuiltInsV1) return false  // 已迁移过 → 不再处理
  const before = config.sources.length
  config.sources = config.sources.filter(s => !(s && RETIRED_SUBSCRIPTION_URLS.includes(s.subscriptionUrl)))
  const removed = before - config.sources.length
  if (removed > 0) printBlue(`移除已退役的内置订阅源 ${removed} 个（旧 YueChan 港澳/全球）`)
  // 同步清理已播种账本里的退役 URL
  if (Array.isArray(config.seededBuiltInUrls)) {
    config.seededBuiltInUrls = config.seededBuiltInUrls.filter(u => !RETIRED_SUBSCRIPTION_URLS.includes(u))
  }
  config.retiredBuiltInsV1 = true
  return true
}

/**
 * 一次刷新会改到的、进播放列表的那部分：直连/抓取源的 m3u8Url，订阅源的 parsedChannels。
 * 刷新前后一比就知道要不要重新生成播放列表。源已被删除时为 null（也算变了）。
 */
function playlistFingerprint(source) {
  if (!source) return null
  return JSON.stringify([source.m3u8Url ?? null, source.parsedChannels ?? null])
}

/**
 * 外部频道源管理类
 */
class ExternalSourceManager {
  
  constructor() {
    this.revision = 0
    this.sources = this.loadSources()
    // 网页抓取失败的退避（内存态）。抓取失败不会更新 lastUpdated，否则到期的源
    // 会在每个 5 分钟 tick 都起一次 Chromium 重抓（见 refreshBackoff.js）
    this.fetchBackoff = new FailureBackoff()
  }

  /**
   * 加载外部源配置
   */
  loadSources() {
    if (!existsSync(EXTERNAL_SOURCES_PATH)) {
      const seedSubs = enableBuiltInSubscriptions
      const defaultConfig = {
        enabled: true,
        includeInPlaylists: true,
        updateOnStartup: true,
        sources: seedSubs ? BUILT_IN_SUBSCRIPTIONS.map(cloneBuiltInSubscription) : [],
        // 记录已播种的内置订阅 URL（开启时为全部；关闭时为空，之后开启会按需补齐一次）
        seededBuiltInUrls: seedSubs ? BUILT_IN_SUBSCRIPTIONS.map(b => b.subscriptionUrl) : [],
        retiredBuiltInsV1: true, // 新装无需退役迁移，直接标记已处理
        updateInterval: 60,
        lastGlobalUpdate: null
      }
      ensureDefaultCustomSubscriptions(defaultConfig)
      migrateNetworkShareName(defaultConfig)
      ensureSourceIds(defaultConfig)

      this.saveSources(defaultConfig)
      return defaultConfig
    }

    try {
      const content = readFileSync(EXTERNAL_SOURCES_PATH, 'utf-8')
      const parsed = JSON.parse(content)
      if (Array.isArray(parsed)) {
        const sources = parsed.map(s => ({ ...s, updateOnStartup: s.updateOnStartup !== false }))
        const config = {
          enabled: true,
          includeInPlaylists: true,
          updateOnStartup: true,
          sources,
          updateInterval: 60,
          lastGlobalUpdate: null
        }
        const retired = retireBuiltInSubscriptions(config)
        const mutated = ensureBuiltInSubscriptions(config)
        const defaultsAdded = ensureDefaultCustomSubscriptions(config)
        const renamed = migrateNetworkShareName(config)
        const idsAdded = ensureSourceIds(config)   // 存量源补稳定 id（issue #29/#68）
        if (retired || mutated || defaultsAdded || renamed || idsAdded) this.saveSources(config)
        return config
      }
      if (typeof parsed === 'object' && parsed !== null) {
        if (!Array.isArray(parsed.sources)) {
          parsed.sources = []
        }
        if (typeof parsed.includeInPlaylists !== 'boolean') {
          parsed.includeInPlaylists = true
        }
        if (typeof parsed.updateOnStartup !== 'boolean') {
          parsed.updateOnStartup = true // 默认开启
        }
        // 为每个源添加默认的 updateOnStartup
        parsed.sources = parsed.sources.map(s => ({
          ...s,
          updateOnStartup: s.updateOnStartup !== false
        }))
        // 播种内置订阅源（只播种从未播种过的；尊重用户删除）
        const retired = retireBuiltInSubscriptions(parsed)
        const mutated = ensureBuiltInSubscriptions(parsed)
        const defaultsAdded = ensureDefaultCustomSubscriptions(parsed)   // 「网络分享」等，只播一次
        const renamed = migrateNetworkShareName(parsed)
        const idsAdded = ensureSourceIds(parsed)   // 存量源补稳定 id（issue #29/#68）
        if (retired || mutated || defaultsAdded || renamed || idsAdded) this.saveSources(parsed)
        return parsed
      }
      return { enabled: false, includeInPlaylists: true, updateOnStartup: true, sources: [] }
    } catch (error) {
      printRed(`加载外部源配置失败: ${error.message}`)
      return { enabled: false, includeInPlaylists: true, updateOnStartup: true, sources: [] }
    }
  }

  /**
   * 保存外部源配置
   */
  saveSources(sources = this.sources) {
    try {
      // 兜底：任何写盘路径（含前端整份保存的新建源）都保证每个源有稳定 id（issue #29/#68）
      // 先按「身份」继承现有 id（防前端未回读的旧副本让 id 漂移），再给真正的新源发号
      if (sources !== this.sources) {
        inheritExistingSourceIds(sources, this.sources)
        // 调用方没带的服务端账本键，从当前配置里补回来（见 SERVER_OWNED_KEYS 的注释）。
        // **不是**「合并所有缺失键」—— 只补这两个明确属于服务端的；其余字段仍以调用方
        // 为准，因为用户改的就是它们，替调用方"补回"会让删除操作失效。
        if (sources && typeof sources === 'object' && !Array.isArray(sources)) {
          for (const key of SERVER_OWNED_KEYS) {
            if (sources[key] === undefined && this.sources?.[key] !== undefined) {
              sources[key] = this.sources[key]
            }
          }
        }
      }
      ensureSourceIds(sources)
      writeJsonFileSync(EXTERNAL_SOURCES_PATH, sources)
      this.sources = sources
      // 改写过的频道地址都是落盘后才生效的：经代理转发的播放索引按这个版本号重建（customSourceProxy.js）
      this.revision++
      return { success: true }
    } catch (error) {
      printRed(`保存外部源配置失败: ${error.message}`)
      return { success: false, message: error.message }
    }
  }

  /**
   * 长耗时 await（网页抓取/订阅拉取）期间，前端整份保存（源排序/编辑）会用新数组替换 this.sources，
   * 进入时快照的 index 与对象引用都随之失效——直接按快照回写会把结果写进错误的源并落盘。
   * 回写前用本方法按稳定 id 在当前配置树里重新定位目标源；源已被删除时返回 null，
   * 调用方应放弃写入（丢一次抓取结果比写错源安全）。
   */
  relocateSource(source) {
    if (!source) return null
    const cur = source.id ? this.sources.sources.find(s => s && s.id === source.id) : null
    if (cur) return cur
    return this.sources.sources.includes(source) ? source : null
  }

  /**
   * 添加新的外部源
   */
  addSource(sourceConfig) {
    // 「复制到分组」的副本带上原频道的回看声明（issue #190），并记下声明对应的地址：
    // 之后在后台改了地址，声明就不再输出（见 getValidChannels 的直连分支）
    const catchup = sanitizeCatchup(sourceConfig)
    const newSource = {
      name: sourceConfig.name,
      group: sourceConfig.group || "其他",
      webUrl: sourceConfig.webUrl,
      playButtonSelector: sourceConfig.playButtonSelector,
      m3u8Url: sourceConfig.m3u8Url || "",
      logo: sourceConfig.logo || "",
      enabled: sourceConfig.enabled !== false,
      autoRefresh: sourceConfig.autoRefresh !== false, // 是否自动刷新，默认开启
      refreshInterval: sourceConfig.refreshInterval || 240, // 刷新间隔（分钟），默认240分钟（4小时）
      updateOnStartup: sourceConfig.updateOnStartup !== false, // 重启时是否更新，默认开启
      lastUpdated: null,
      extractOptions: {
        waitTime: sourceConfig.waitTime || 5000,
        headless: sourceConfig.headless !== false,
        ...sourceConfig.extractOptions
      },
      ...catchup,
      ...(Object.keys(catchup).length ? { catchupUrl: sourceConfig.m3u8Url || "" } : {}),
      // 从开了「经网络代理转发」的源复制出来的副本照样走代理（见 copyChannelToGroupsAPI）
      ...(sourceConfig.useProxy === true ? { useProxy: true } : {}),
      ...(sourceConfig.topFirst === true ? { topFirst: true } : {})
    }
    
    this.sources.sources.push(newSource)
    return this.saveSources()
  }

  /**
   * 删除外部源
   */
  removeSource(index) {
    if (index >= 0 && index < this.sources.sources.length) {
      this.sources.sources.splice(index, 1)
      return this.saveSources()
    }
    return { success: false, message: '索引无效' }
  }

  /**
   * 更新特定源的 m3u8 链接
   */
  async updateSource(index) {
    if (index < 0 || index >= this.sources.sources.length) {
      return { success: false, message: '索引无效' }
    }
    const source = this.sources.sources[index]
    if (!source.enabled) {
      return { success: false, message: '源已禁用' }
    }

    // 订阅模式：获取并解析 m3u 播放列表
    if (source.mode === 'subscription') {
      return await this.updateSubscriptionSource(index)
    }

    // 新增：如果 webUrl 为空且 m3u8Url 已填写，直接视为抓取成功
    if (!source.webUrl && source.m3u8Url) {
      this.sources.sources[index].lastUpdated = new Date().toISOString()
      this.saveSources()
      printGreen(`${source.name} 已手动填写m3u8，跳过网页抓取`)
      return { success: true, m3u8Url: source.m3u8Url, info: '已手动填写m3u8，跳过网页抓取' }
    }

    try {
      printBlue(`更新外部源: ${source.name}`)
      const extracted = await extractM3u8FromWeb(source.webUrl, {
        playButtonSelector: source.playButtonSelector,
        returnAll: true,
        ...source.extractOptions
      })
      const candidates = Array.isArray(extracted)
        ? extracted
        : extracted
          ? [extracted]
          : []
      if (candidates.length > 0) {
        // 验证链接有效性（逐个尝试）
        for (const candidate of candidates) {
          const isValid = await validateM3u8(candidate, { referer: source.webUrl })
          if (isValid) {
            const cur = this.relocateSource(source)
            if (!cur) return { success: false, message: '源已被删除，放弃写入抓取结果' }
            cur.m3u8Url = candidate
            cur.lastUpdated = new Date().toISOString()
            this.fetchBackoff.clear(this.backoffKey(cur))
            this.saveSources()
            printGreen(`${source.name} 更新成功: ${candidate}`)
            return { success: true, m3u8Url: candidate }
          }
        }
        // 校验失败时选择最有可能正确的链接（优先选择链接最长的，通常包含完整参数）
        const fallback = candidates.sort((a, b) => b.length - a.length)[0]
        const cur = this.relocateSource(source)
        if (!cur) return { success: false, message: '源已被删除，放弃写入抓取结果' }
        cur.m3u8Url = fallback
        cur.lastUpdated = new Date().toISOString()
        this.fetchBackoff.clear(this.backoffKey(cur))
        this.saveSources()
        printYellow(`${source.name} m3u8校验失败，已保存最长链接（共${candidates.length}个候选）`)
        printGrey(`  选中: ${fallback.substring(0, 100)}...`)
        return { success: true, m3u8Url: fallback, warning: `m3u8校验失败，已保存最长链接（共${candidates.length}个候选）` }
      } else {
        printRed(`${source.name} 未能提取到m3u8链接`)
        this.noteFetchFailure(source, '未能提取到m3u8链接')
        return { success: false, message: '未能提取到m3u8链接' }
      }
    } catch (error) {
      printRed(`${source.name} 更新失败: ${error.message}`)
      this.noteFetchFailure(source, error.message)
      return { success: false, message: error.message }
    }
  }

  /** 退避表的键：优先稳定 id，老数据没有 id 时退回网页地址 */
  backoffKey(source) {
    return source?.id || source?.webUrl || source?.name || ''
  }

  /** 记一次网页抓取失败并打印下次重试时间 */
  noteFetchFailure(source, error) {
    const key = this.backoffKey(source)
    if (!key) return
    const entry = this.fetchBackoff.record(key, source.refreshInterval || 240, { error })
    printYellow(`${source.name} 已连续失败 ${entry.count} 次，${entry.waitMinutes} 分钟后再试`)
  }

  /**
   * 更新订阅源：获取远程 m3u 播放列表并解析频道
   */
  async updateSubscriptionSource(index) {
    const source = this.sources.sources[index]
    // 本地导入源：内容已内联在 subscriptionContent，直接本地解析、不发网络请求（issue #43）
    if (typeof source.subscriptionContent === 'string' && source.subscriptionContent.trim()) {
      const channels = parsePlaylistContent(source.subscriptionContent)
      this.sources.sources[index].parsedChannels = channels
      this.sources.sources[index].lastUpdated = new Date().toISOString()
      delete this.sources.sources[index]._failCount   // 旧版落盘的失败计数，退避已改为内存态
      this.fetchBackoff.clear(this.backoffKey(this.sources.sources[index]))
      this.saveSources()
      printGreen(`${source.name} 本地导入解析成功，共 ${channels.length} 个频道`)
      return { success: true, channelCount: channels.length }
    }
    if (!source.subscriptionUrl) {
      return { success: false, message: '未填写订阅地址' }
    }
    // 内置订阅源已禁用：不抓取（兜底覆盖 60s 重试 / 手动导入等所有调用方）
    if (!enableBuiltInSubscriptions && isBuiltInSubscriptionSource(source)) {
      return { success: true, skipped: true, message: '内置订阅源已禁用，跳过抓取' }
    }

    // 开了「经网络代理转发」且有生效代理：列表也经代理拉（局域网地址照旧直连）；没有代理就照常直连
    const viaProxy = sourceUsesProxy(source) && Boolean(outboundProxyUrl())
    const fetchOptions = { ...subscriptionFetchOptions(source), ...(viaProxy ? { fetchImpl: customSourceFetch } : {}) }
    try {
      printBlue(`更新订阅源: ${source.name} (${source.subscriptionUrl})${viaProxy ? '，经网络代理' : ''}`)
      const channels = await fetchAndParseM3u(source.subscriptionUrl, fetchOptions)

      const cur = this.relocateSource(source)
      if (!cur) return { success: false, message: '源已被删除，放弃写入订阅结果' }
      cur.parsedChannels = channels
      cur.lastUpdated = new Date().toISOString()
      delete cur._failCount   // 旧版落盘的失败计数，退避已改为内存态
      this.fetchBackoff.clear(this.backoffKey(cur))
      this.saveSources()

      printGreen(`${source.name} 订阅更新成功，共 ${channels.length} 个频道`)
      return { success: true, channelCount: channels.length }
    } catch (error) {
      const message = `${viaProxy ? '经网络代理拉取失败：' : ''}${error.message}${subscriptionFailureHint(error, fetchOptions, source)}`
      printRed(`${source.name} 订阅更新失败: ${message}`)

      // 按 id 重新定位（await 期间快照 index 可能已失效）；源已被删则不记
      const cur = this.relocateSource(source)
      if (!cur) return { success: false, message }
      // 失败退避和网页抓取源用同一张内存表（10、20、40…分钟递增，上限为该源的刷新间隔，成功清零，
      // 重启后重新开始）。旧做法是把 lastUpdated 往回拨「间隔 − 等待」来编码退避：后台「上次更新」
      // 会显示成 23 小时前的假时间，页面整份保存一次又把它覆盖回去（issue #223 审查）。
      // 有缓存的订阅照旧保留旧频道，频道不会悄悄消失
      const entry = this.fetchBackoff.record(this.backoffKey(cur), cur.refreshInterval || 240, { error: message })
      const kept = Array.isArray(cur.parsedChannels) && cur.parsedChannels.length > 0
        ? `保留上次缓存的 ${cur.parsedChannels.length} 个频道，`
        : ''
      printYellow(`${source.name} ${kept}已连续失败 ${entry.count} 次，${entry.waitMinutes} 分钟后再试`)

      return { success: false, message }
    }
  }

  /**
   * 检查源是否需要刷新
   */
  needsRefresh(source) {
    // 未设置自动刷新
    if (source.autoRefresh === false) {
      return false
    }

    // 连续失败（网页抓取 / 订阅拉取）：在退避窗口内不重试
    if (this.fetchBackoff.isCooling(this.backoffKey(source))) {
      return false
    }
    
    // 从未更新过，需要刷新
    if (!source.lastUpdated) {
      return true
    }
    
    // 检查时间间隔
    const lastUpdateTime = new Date(source.lastUpdated).getTime()
    const now = Date.now()
    const intervalMs = (source.refreshInterval || 240) * 60 * 1000 // 转换为毫秒
    
    return (now - lastUpdateTime) >= intervalMs
  }

  /**
   * 更新所有启用的外部源
   * @param {Object} options - 选项
   * @param {boolean} options.autoOnly - 仅更新设置了自动刷新的源
   * @param {boolean} options.forceAll - 强制更新所有源（忽略时间间隔）
   * @param {boolean} options.startupMode - 启动模式，仅更新设置了updateOnStartup的源
   */
  async updateAllSources(options = {}) {
    const { autoOnly = false, forceAll = false, startupMode = false } = options
    
    const results = []
    let skipped = 0
    let hasWork = false
    
    // 快照当前源列表再遍历：循环里有多次 await，期间前端整份保存可能换序/增删源，
    // 按活动数组的下标遍历会更新到错误的源。每轮更新前按 id 重新定位当前下标，源已被删则跳过。
    const snapshot = [...this.sources.sources]
    for (let i = 0; i < snapshot.length; i++) {
      const source = snapshot[i]

      // 跳过禁用的源
      if (!source.enabled) {
        skipped++
        continue
      }

      // 内置订阅源已禁用：跳过抓取（避免无谓联网下载，与服务层一致）
      if (!enableBuiltInSubscriptions && isBuiltInSubscriptionSource(source)) {
        skipped++
        continue
      }

      // 启动模式：只更新设置了updateOnStartup的源
      if (startupMode && source.updateOnStartup === false) {
        skipped++
        continue
      }
      
      // 如果是仅自动模式，检查是否需要刷新
      // 注意：启动模式下不检查刷新间隔，强制更新所有启用的源
      if (autoOnly && !forceAll && !startupMode) {
        if (!this.needsRefresh(source)) {
          skipped++
          continue
        }
      }
      
      // 首次有实际工作时才打印日志
      if (!hasWork) {
        printBlue(`开始更新外部源${startupMode ? '（启动模式）' : ''}...`)
        hasWork = true
      }
      
      // 按 id 解析源的当前下标（await 间隔里可能被换序/删除）
      const curIndex = this.sources.sources.findIndex(s => s === source || (source.id && s && s.id === source.id))
      if (curIndex === -1) {
        skipped++
        continue
      }
      const before = playlistFingerprint(this.sources.sources[curIndex])
      const result = await this.updateSource(curIndex)
      results.push({
        index: curIndex,
        name: source.name,
        ...result,
        // 抓回来的地址 / 订阅内容和上一轮一样时，不必重新生成播放列表（issue #222）
        changed: playlistFingerprint(this.relocateSource(source)) !== before,
      })

      // 避免请求过快，添加延迟
      if (i < snapshot.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }
    
    // 仅在有源被实际处理时才保存配置，避免每小时无效写入
    if (results.length > 0) {
      this.sources.lastGlobalUpdate = new Date().toISOString()
      this.saveSources()
    }
    
    const successful = results.filter(r => r.success).length
    if (results.length > 0) {
      printGreen(`外部源更新完成: ${successful}/${results.length} 成功${skipped > 0 ? `, ${skipped} 个跳过` : ''}`)
    }
    
    return results
  }

  /**
   * 获取有效的外部频道列表（转换为标准格式）
   */
  getValidChannels() {
    if (!this.sources.enabled) {
      return []
    }

    const channels = []
    const groupMap = new Map()

    this.sources.sources.forEach(source => {
      if (!source.enabled) return
      // 内置订阅源已禁用：跳过输出（数据仍保留在 external-sources.json，开启后即恢复，可逆）
      if (!enableBuiltInSubscriptions && isBuiltInSubscriptionSource(source)) return

      // 订阅模式：展开 parsedChannels
      if (source.mode === 'subscription' && Array.isArray(source.parsedChannels)) {
        // 内置「精选频道」与地方官方同台时可被去重；其余外部源都是用户自己配的，
        // channelMerger 的内容组归并据此不替换、不删除（邮件反馈：粘贴的少儿组播被顶掉）
        const builtInSubscription = isBuiltInSubscriptionSource(source)
        // 「播放时也带上」：在这里补而不是解析时补——开关一改、保存即生效，不必重新拉订阅（issue #170）
        const playbackUa = source.playWithUserAgent === true ? source.userAgent : ''
        source.parsedChannels.forEach(ch => {
          const opts = withUserAgent(ch.opts, playbackUa, ch.url)
          const group = resolveSubscriptionGroup(ch, source)
          if (!groupMap.has(group)) {
            groupMap.set(group, {
              name: group,
              dataList: []
            })
          }
          groupMap.get(group).dataList.push({
            name: ch.name,
            url: ch.url,
            logo: ch.logo || "",
            groupTitle: group,
            sourceId: source.id ? `ext:${source.id}` : undefined,  // 源归属（issue #29/#68）
            ...(builtInSubscription ? { builtInSubscription: true } : {}),
            ...(opts && opts.length ? { opts } : {}),
            ...customPlaybackFields(source, ch.name, ch.url, ch.topFirst),
            ...sanitizeCatchup(ch)   // 源自带的回看声明（issue #190）；没有就不带，照旧继承订阅头
          })
        })
        return
      }
      
      // 直连/抓取模式：单频道
      if (source.m3u8Url) {
        if (!groupMap.has(source.group)) {
          groupMap.set(source.group, {
            name: source.group,
            dataList: []
          })
        }
        
        groupMap.get(source.group).dataList.push({
          name: source.name,
          url: source.m3u8Url,
          logo: source.logo || "",
          groupTitle: source.group,
          sourceId: source.id ? `ext:${source.id}` : undefined,   // 源归属（issue #29/#68）
          ...customPlaybackFields(source, source.name, source.m3u8Url, source.topFirst),
          // 复制来的副本保留原频道的回看声明（issue #190），地址改过就不再适用
          ...(source.catchupUrl && source.catchupUrl === source.m3u8Url ? sanitizeCatchup(source) : {})
        })
      }
    })
    
    return Array.from(groupMap.values())
  }

  /**
   * 经网络代理转发 / 最高画质起播改写过的频道（带 proxyRef），播放时按引用查原地址用。
   * 直接取 getValidChannels 的结果，保证与写进订阅的那份一致（含「播放时也带上这个 UA」补的请求头）。
   */
  proxiedChannels() {
    const names = new Map((this.sources.sources || []).filter(s => s && s.id).map(s => [`ext:${s.id}`, s.name]))
    const out = []
    for (const group of this.getValidChannels()) {
      for (const ch of group.dataList) {
        if (!ch.proxyRef) continue
        out.push({ ref: ch.proxyRef, name: ch.name, url: ch.url, opts: ch.opts, useProxy: ch.useProxy, topFirst: ch.topFirst, sourceId: ch.sourceId, sourceName: names.get(ch.sourceId) || '' })
      }
    }
    return out
  }

  /**
   * 手动设置 m3u8 链接（用于已知链接的情况）
   */
  setM3u8Url(index, m3u8Url) {
    if (index < 0 || index >= this.sources.sources.length) {
      return { success: false, message: '索引无效' }
    }
    
    this.sources.sources[index].m3u8Url = m3u8Url
    this.sources.sources[index].lastUpdated = new Date().toISOString()
    return this.saveSources()
  }

  /**
   * 启用/禁用外部源功能
   */
  toggleEnabled(enabled) {
    this.sources.enabled = enabled
    return this.saveSources()
  }

  /**
   * 设置重启时是否更新（全局-咪咕源）
   */
  setUpdateOnStartup(enabled) {
    this.sources.updateOnStartup = enabled
    return this.saveSources()
  }

  /**
   * 获取配置信息
   */
  /**
   * 各源最近一次拉取 / 抓取失败的记账（内存态，成功即清除），供后台卡片显示
   * 「上次拉取失败：原因，几点后再试」。不进 external-sources.json，页面整份保存也带不回来。
   * @returns {Object<string, {failCount:number, lastError:string, nextRetryAt:string}>} 按源 id
   */
  fetchStatus() {
    const status = {}
    for (const source of this.sources.sources || []) {
      if (!source?.id) continue
      const entry = this.fetchBackoff.get(this.backoffKey(source))
      if (!entry) continue
      status[source.id] = {
        failCount: entry.count,
        lastError: entry.lastError,
        nextRetryAt: new Date(entry.nextRetryAt).toISOString(),
      }
    }
    return status
  }

  getConfig() {
    return {
      enabled: this.sources.enabled,
      includeInPlaylists: this.sources.includeInPlaylists !== false,
      updateOnStartup: this.sources.updateOnStartup !== false,
      sourcesCount: this.sources.sources.length,
      validSourcesCount: this.sources.sources.filter(s => s.enabled && s.m3u8Url).length,
      lastGlobalUpdate: this.sources.lastGlobalUpdate
    }
  }
}

// 导出单例实例
const externalSourceManager = new ExternalSourceManager()

export default externalSourceManager
export { ExternalSourceManager, sourceUsesProxy, reseedBuiltInSubscriptions, fetchAndParseM3u, subscriptionFetchOptions, subscriptionFailureHint, SUBSCRIPTION_FETCH_LIMITS, parsePlaylistContent, decodeAndParseLocalContent, splitCredentials, isBuiltInSubscriptionSource, GITHUB_RAW_MIRRORS, BUILT_IN_SUBSCRIPTIONS, DEFAULT_CUSTOM_SUBSCRIPTIONS, ensureSourceIds, inheritExistingSourceIds }
