import builtInSourceManager from '../../utils/builtInSources.js'
import { decodeM3u8FromPage, SANDBOX_UA } from '../../utils/playerPageSandbox.js'
import { printBlue, printYellow } from '../../utils/colorOut.js'

export const GROUP_NAME = '赛事直播'
// 来源站常换域名：域名池放在 built-in-sources.json 的这一段，改完 push 到 main 即生效，不用发版
const SITE_CONFIG_KEY = 'websports'
// 拉不到远程、本地配置也没有那一段时的默认值（当前来源站）。jrkan.com 在国内 DNS 被污染，其余是同系备用域名；
// jrs13、jrs14 的首页只是引导壳，没有 PLAY_HOSTS，不放进来
const DEFAULT_SITE = {
  homeUrls: ['https://www.jrkan.com/', 'https://www.jrs03.com/', 'https://www.jrkan77.com/', 'https://www.jrs33.com/', 'https://www.jrkan66.com/', 'https://www.jrs15.com/'],
  playHosts: ['http://play.sportsteam368.com', 'http://play.jgdhds.com', 'http://play.sportsteam7777.com'],
  listUrl: 'https://im-imgs-bucket.oss-accelerate.aliyuncs.com/index.js?t_5',
}
const PLAY_PATH = { prefix: '/play/steam', suffix: '.html' }
const MAX_POOL_SIZE = 16
// 模块刷新有 90 秒总超时：远程配置全线路失败要 40 秒，留给首页的时间不能超过 30 秒
const MAX_HOME_ATTEMPTS = 6
const HOME_TIMEOUT_MS = 5000
// 模块 10 分钟刷新一次，略短一点才能每轮都拉到
const REMOTE_MAX_AGE_MS = 9 * 60 * 1000
const PAGE_TIMEOUT_MS = 6000
const FIND_BUDGET_MS = 20 * 1000
const MAX_LINES = 6
// 快到期的地址也留够这么久，不然每次清单刷新都要重走整条链路
const MIN_TTL_MS = 60 * 1000
// 个别线路时通时断（10-31 hello.ooo0ooo.top 通过一次检查后马上 404）：断过的地址先避开一阵，换别的线路
const AVOID_MS = 5 * 60 * 1000
// 一场解不出时播放器会连着重试，整条链路每次要打四五个请求
const FAILURE_TTL_MS = 30 * 1000
const EXPIRY_MARGIN_MS = 2 * 60 * 1000
const DEFAULT_TTL_MS = 60 * 60 * 1000

/** 与广东体育赛事同一处理：比赛名会写进 EXTINF 属性，引号、逗号不能原样留着 */
function cleanTitle(value) {
  return String(value || '').replace(/\\/g, '').replace(/[\x00-\x1f]+/g, ' ').replace(/"/g, "'").replace(/,/g, '，').replace(/\s+/g, ' ').trim()
}

/** 首页内联脚本：PLAY_HOSTS（base64 的播放域名）、getPlayUrl 的路径规则、列表脚本 index.js 的地址 */
export function parseSite(html, baseUrl) {
  const hosts = []
  for (const m of html.matchAll(/\bline\d+\s*:\s*atob\(\s*["']([A-Za-z0-9+/=]+)["']\s*\)/g)) {
    const origin = originOf(Buffer.from(m[1], 'base64').toString().trim())
    if (origin) hosts.push(origin)
  }
  const path = html.match(/host\s*\+\s*["']([^"']*)["']\s*\+\s*id\s*\+\s*["']([^"']*)["']/)
  const script = html.match(/<script\b[^>]*\bsrc=["']([^"']*\/index\.js[^"']*)["']/i)?.[1]
  if (!hosts.length || !path || !script) return null
  return { hosts, prefix: path[1], suffix: path[2], home: baseUrl, listUrl: new URL(script, baseUrl).href }
}

/** index.js 用 document.write 一行行写比赛，每场一个 <ul class="item play"> */
export function parseMatches(script) {
  const matches = new Map()
  for (const block of script.split(/<ul class="item play/).slice(1)) {
    const id = block.match(/getPlayUrl\("\w+",\s*"(\d{1,12})"\)/)?.[1]
    const time = block.match(/lab_time">(\d{2}-\d{2} \d{2}:\d{2})/)?.[1]
    const league = block.match(/lab_events"[^>]*><span class="name">([^<]*)/)?.[1]
    const home = block.match(/lab_team_home"><strong class="name">([^<]*)/)?.[1]
    const away = block.match(/lab_team_away"><strong class="name">([^<]*)/)?.[1]
    if (id && time && home && away && !matches.has(id)) matches.set(id, { id, time, league: cleanTitle(league), home: cleanTitle(home), away: cleanTitle(away) })
  }
  return [...matches.values()]
}

// 10-31 博洛尼亚对蒙扎实测：pao 是 1080p，mgxl、wlive、wen 都是 720p。pao 有的场次会 404，不通往后换。
// sm.html 不走下面的播放器包装，放最后
const lineRank = path => (path.startsWith('/play/pao/') ? 0 : path.startsWith('/play/sm.html') ? 2 : 1)

/** 入口页的线路：高画质优先，其余保持站点顺序；被注释掉的和「=&id2=」这种空线路不算 */
export function linePaths(html) {
  const paths = [...html.replace(/<!--[\s\S]*?-->/g, ' ').matchAll(/\bdata-play="(\/[^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&'))
  return [...new Set(paths)].sort((a, b) => lineRank(a) - lineRank(b))
}

/** 线路页把播放器地址拆开放：playerUrlBase64 是前缀，encodedStr 是加密参数，pjs.js 拼成 iframe */
export function wrappedPlayerUrl(html) {
  const base = html.match(/playerUrlBase64\s*:\s*"([A-Za-z0-9+/=]+)"/)?.[1]
  const param = html.match(/encodedStr\s*=\s*"([^"]+)"/)?.[1]
  if (!base || !param) return ''
  const prefix = Buffer.from(base, 'base64').toString().trim()
  return /^https?:\/\/[a-z0-9.-]+\/\S*[?&]id=$/i.test(prefix) ? `${prefix}${param}` : ''
}

/** 地址来自第三方页面或远程配置，服务端要去取：只放行公网域名，不碰内网和 IP 字面量 */
export function isPublicUrl(raw) {
  try {
    const { protocol, hostname, username, password } = new URL(raw)
    return /^https?:$/.test(protocol) && !username && !password && hostname.includes('.')
      && !/^[\d.]+$/.test(hostname) && !hostname.startsWith('[') && !/\.(local|localhost|internal|lan|test)$/i.test(hostname)
  } catch { return false }
}

/** 只有域名、没有路径的地址，返回它的 origin；其余返回空串 */
function originOf(raw) {
  if (typeof raw !== 'string' || !isPublicUrl(raw)) return ''
  const url = new URL(raw)
  return url.pathname === '/' && !url.search && !url.hash ? url.origin : ''
}

/** 远程配置可能经第三方 GitHub 镜像送达，且模块会去访问这些地址：逐项校验、超量截断，哪个字段不可用就只退回它的默认值 */
export function normalizeSiteConfig(raw) {
  const origins = list => [...new Set((Array.isArray(list) ? list : []).map(originOf).filter(Boolean))].slice(0, MAX_POOL_SIZE)
  const homes = origins(raw?.homeUrls), hosts = origins(raw?.playHosts)
  return {
    homeUrls: homes.length ? homes.map(origin => `${origin}/`) : DEFAULT_SITE.homeUrls,
    playHosts: hosts.length ? hosts : DEFAULT_SITE.playHosts,
    listUrl: typeof raw?.listUrl === 'string' && isPublicUrl(raw.listUrl) ? raw.listUrl : DEFAULT_SITE.listUrl,
  }
}

const readSiteConfig = () => builtInSourceManager.moduleSiteConfig(SITE_CONFIG_KEY, REMOTE_MAX_AGE_MS)

export function isLiveManifest(text) {
  return text.trimStart().startsWith('#EXTM3U') && !/#EXT-X-ENDLIST/.test(text) && /#EXTINF|#EXT-X-STREAM-INF/.test(text)
}

/** 签名到期时间：auth_key=<秒>-… 或 expire=<秒>；没有签名的线路给默认值，到期后重走一遍 */
export function expiryOf(raw, now) {
  const { searchParams } = new URL(raw)
  const seconds = Number(searchParams.get('auth_key')?.match(/^(\d{10})-/)?.[1] || searchParams.get('expire'))
  return seconds > 0 ? seconds * 1000 - EXPIRY_MARGIN_MS : now + DEFAULT_TTL_MS
}

export function createProvider({ fetchImpl = fetch, now = Date.now, decode = decodeM3u8FromPage, siteConfig = readSiteConfig } = {}) {
  let site = null, lastHome = ''
  const streams = new Map()  // 场次 id → { url, line, expiresAt }
  const failures = new Map() // 场次 id → { message, until }
  const avoided = new Map()  // 播放地址 → 避开到什么时候
  const pending = new Map()

  async function request(url, { referer, timeout = PAGE_TIMEOUT_MS } = {}) {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': SANDBOX_UA, Accept: '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9', ...(referer ? { Referer: referer } : {}) },
      redirect: 'follow', signal: AbortSignal.timeout(timeout),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status })
    }
    return response
  }
  const read = (url, options) => request(url, options).then(response => response.text())

  /** 取在播的清单；不在播、取不到都返回 null。text 交回给 resolve 直出，播放器不再等本机二次回源 */
  async function liveManifest(url) {
    try {
      const response = await request(url)
      const text = await response.text()
      return isLiveManifest(text) ? { text, manifestUrl: response.url || url } : null
    } catch { return null }
  }

  async function loadSite() {
    const pool = normalizeSiteConfig(await siteConfig().catch(() => null))
    // 上次打开过的排最前，死域名不用每轮都等一遍超时
    const homes = pool.homeUrls.includes(lastHome) ? [lastHome, ...pool.homeUrls.filter(home => home !== lastHome)] : pool.homeUrls
    for (const home of homes.slice(0, MAX_HOME_ATTEMPTS)) {
      const parsed = await read(home, { timeout: HOME_TIMEOUT_MS }).then(html => parseSite(html, home)).catch(() => null)
      if (parsed) {
        lastHome = home
        return (site = parsed)
      }
    }
    // 首页全打不开：列表在阿里云 OSS，不受首页域名影响。配置里的播放域名排前面，上次从首页读到的留作备用
    return (site = { ...PLAY_PATH, home: pool.homeUrls[0], listUrl: pool.listUrl, hosts: [...new Set([...pool.playHosts, ...(site?.hosts || [])])] })
  }

  async function lineStream(lineUrl, entryUrl) {
    const player = wrappedPlayerUrl(await read(lineUrl, { referer: entryUrl }).catch(() => ''))
    if (!player) return null
    const { links } = await decode(player, { referer: lineUrl })
    for (const url of links.filter(isPublicUrl)) {
      if ((avoided.get(url) || 0) > now()) continue
      const manifest = await liveManifest(url)
      if (manifest) return { url, ...manifest }
    }
    return null
  }

  async function findStream(id) {
    const { hosts, prefix, suffix, home } = site || await loadSite()
    const deadline = now() + FIND_BUDGET_MS
    let blocked = 0
    for (const host of hosts) {
      const entryUrl = `${host}${prefix}${id}${suffix}`
      let html
      try { html = await read(entryUrl, { referer: home }) } catch (error) {
        if (error.status === 403) blocked++
        continue
      }
      // 三个域名是同一份页面，能打开一个就够了，解不出换域名也没用
      for (const path of linePaths(html).slice(0, MAX_LINES)) {
        if (now() > deadline) break
        const stream = await lineStream(new URL(path, entryUrl).href, entryUrl).catch(() => null)
        if (stream) return { ...stream, line: path }
      }
      throw new Error('这场暂无可用线路（可能未开赛或已结束）')
    }
    throw new Error(blocked ? '入口页拒绝访问：这台机器的网络需要是大陆或香港出口' : '入口页打不开，请检查网络')
  }

  async function freshStream(id) {
    const failed = failures.get(id)
    if (failed && now() < failed.until) throw new Error(failed.message)
    try {
      const found = await findStream(id)
      streams.set(id, { url: found.url, line: found.line, expiresAt: Math.max(expiryOf(found.url, now()), now() + MIN_TTL_MS) })
      failures.delete(id)
      printBlue(`WebSports ${id}：${found.line.split('?')[0]} → ${new URL(found.url).host}`)
      return found
    } catch (error) {
      failures.set(id, { message: error.message, until: now() + FAILURE_TTL_MS })
      printYellow(`WebSports ${id}：${error.message}`)
      throw error
    }
  }

  async function resolve(id) {
    const hit = streams.get(id)
    if (hit && now() < hit.expiresAt) {
      // 播放器几秒刷新一次清单、每次都到这里：清单由这里取，断了当场换线路，不用等播放器报错
      const manifest = await liveManifest(hit.url)
      if (manifest) return { ...hit, ...manifest }
      avoided.set(hit.url, now() + AVOID_MS)
    }
    streams.delete(id)
    if (!pending.has(id)) pending.set(id, freshStream(id).finally(() => pending.delete(id)))
    return pending.get(id)
  }

  async function discover() {
    const { listUrl, home } = await loadSite()
    const matches = parseMatches(await read(listUrl, { referer: home, timeout: 15000 }))
    if (!matches.length) throw new Error('赛事列表为空或页面已改版')
    return matches
  }

  return { discover, resolve }
}
