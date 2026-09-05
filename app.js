import http from "node:http"
import { resolverFor } from './extractors/registry.js'
import { pipeFlv } from './utils/flvProxy.js'
import { readFileSync, mkdirSync, existsSync } from "node:fs"
import { createRequire } from "node:module"
import fetch from 'node-fetch'
import { adminPath, host, pass, port, programInfoUpdateInterval, token, userId, enableMigu, enableBuiltInSubscriptions, enableUserTokens } from "./config.js";
import { getDateTimeStr } from "./utils/time.js";
import update from "./utils/updateData.js";
import { printBlue, printGreen, printGrey, printMagenta, printRed, printYellow } from "./utils/colorOut.js";
import { channel, interfaceStr, fetchManifestDirect, rewriteManifest, inlineResolvedManifest } from "./utils/appUtils.js";
import { toProxyManifest, lookup as lookupProxyTarget, pipeUpstream, probeUpstream, fetchNested, manifestCooling, markManifestResult } from "./utils/hlsProxy.js";
import { dataPath } from "./utils/paths.js";
import { getExtractorManager, getModuleConfig } from "./utils/extractorManager.js";
import { getExtractorsAPI, startModuleLoginAPI, pollModuleLoginAPI, setExtractorEnabledAPI,
  updateExtractorConfigAPI, runExtractorNowAPI, setContentFlagAPI } from "./utils/extractorsAPI.js";
import { getChannelsAPI, getExternalSourcesAPI, saveExternalSourcesAPI,
         addExternalSourceAPI, removeExternalSourceAPI, updateExternalSourceAPI,
         setExternalSourceM3u8API, importSubscriptionAPI, parseLocalContentAPI,
         uploadLogoAPI, removeLogoAPI, copyChannelToGroupsAPI, getBuiltInSourcesAPI } from "./utils/adminAPI.js";
import { getEpgSourcesAPI, setEpgEnabledAPI, addEpgSourceAPI, updateEpgSourceAPI,
         removeEpgSourceAPI, expireEpgSourcesAPI } from "./utils/epgSourcesAPI.js";
import { userManager } from "./utils/userManager.js";
import { getUsersAPI, addUserAPI, updateUserAPI, removeUserAPI, regenUserTokenAPI, setRequireTokenAPI } from "./utils/usersAPI.js";
import { getAliasesAPI, setAliasRuleAPI, removeAliasRuleAPI } from "./utils/aliasesAPI.js";
import { getGroupRulesAPI, setGroupRuleAPI, removeGroupRuleAPI, moveGroupRuleAPI } from "./utils/groupRulesAPI.js";
import { getSystemConfigAPI, saveSystemConfigAPI } from "./utils/systemConfigAPI.js";
import { exportConfigAPI, importConfigAPI } from "./utils/configBackupAPI.js";
import { readConfig, saveConfig, parseInterfaceTxt, validateGroupConfig, applyConfig,
         listProfiles, createProfile, renameProfile, deleteProfile } from "./utils/playlistConfig.js";
import { updateBuiltInSources, updateExternalSources, updateExtractors, externalSourceManager, builtInSourceManager } from "./utils/channelMerger.js";
import { GITHUB_RAW_MIRRORS, isBuiltInSubscriptionSource } from "./utils/externalSources.js";
import { startProbe, getProbeStatus, cancelProbe } from "./utils/sourceProbe.js";
import { ANNOUNCEMENT, readAnnouncementAsset } from "./utils/announcement.js";

// 全代理/兼容模式（issue #98）的服务端可观测性。上一版的日志设计在实战里分不清三种情况
// （首行不带分片数、每 pid 每分钟一行会让 curl 与播放器互吞对方的行、分片 404 与上游失败全静默），
// 用户回报「还是播不了」时日志无法归属。这一版：
//   - 每行都带来源 IP + UA，curl 与播放器一眼可分；
//   - 限流键为「事件|pid|来源IP|UA|方法」，同一 IP 下 curl 与播放器也不会互吞；
//   - 分片计数拆「请求次数 / 转发成功数」，取了清单却不取分片（0/0）与取了分片但上游失败（N/0）可分。
const logWindows = new Map()   // 「事件|pid|IP|UA|方法」 -> 上次打行时间
function logOncePer(key, ms) {
  const now = Date.now()
  if (now - (logWindows.get(key) || 0) < ms) return false
  if (logWindows.size > 5000) logWindows.clear()   // 诊断辅助表，粗暴清空即可
  logWindows.set(key, now)
  return true
}

function clientOf(req) {
  const ip = (req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '?').replace(/^::ffff:/, '')
  const ua = String(req.headers['user-agent'] || '无UA').replace(/[\r\n]/g, ' ')
  return { ip, key: `${ip}|${ua.slice(0, 120)}`, tag: `${ip} UA:${ua.slice(0, 80)}` }
}

const proxyStats = new Map()   // pid|client -> { head, get, ok, since }  自该客户端上一条清单日志以来的计数

function proxyStat(pid, req) {
  const key = `${pid}|${clientOf(req).key}`
  let stat = proxyStats.get(key)
  if (!stat) {
    if (proxyStats.size > 5000) proxyStats.clear()
    stat = { head: 0, get: 0, ok: 0, since: 0 }
    proxyStats.set(key, stat)
  }
  return stat
}

function noteProxySegment(pid, req) {
  const stat = proxyStat(pid, req)
  if (req.method === 'HEAD') stat.head++
  else stat.get++
  // 每客户端每分钟报一次「分片请求确实到达了」——这是「取了清单却零分片」与否的直接分界
  const client = clientOf(req)
  if (logOncePer(`seg|${pid}|${client.key}|${req.method}`, 60 * 1000)) {
    const range = req.headers.range ? ` Range:${req.headers.range}` : ''
    printGrey(`全代理：${pid} ${req.method} 分片请求${range}｜${client.tag}`)
  }
}

function logProxySegmentResult(pid, req, result, elapsedMs) {
  const stat = proxyStat(pid, req)
  if (result.ok) stat.ok++
  const client = clientOf(req)
  const key = `seg-result|${result.ok ? 'ok' : 'fail'}|${pid}|${client.key}|${req.method}`
  if (logOncePer(key, result.ok ? 60 * 1000 : 10 * 1000)) {
    // 无 error 却不完整 = 传输中途断开（多为客户端切台提前挂断）——标出来，
    // 否则黄行里「-> 200」和「失败」并存会让读日志的人困惑
    const detail = result.error ? ` error:${result.error}` : (result.complete ? '' : ' 未完整')
    const line = `全代理：${pid} ${req.method} 分片 -> ${result.status}，${result.bytes} bytes，${elapsedMs}ms${detail}｜${client.tag}`
    if (result.ok) printGrey(line); else printYellow(line)
  }
}

function logProxyProbe(pid, req, result, elapsedMs) {
  const client = clientOf(req)
  const key = `probe|${result.ok ? 'ok' : 'fail'}|${pid}|${client.key}|${req.method}`
  if (logOncePer(key, result.ok ? 60 * 1000 : 10 * 1000)) {
    const length = result.contentLength ? ` Content-Length:${result.contentLength}` : ''
    const ranges = result.acceptRanges ? ` Accept-Ranges:${result.acceptRanges}` : ''
    const fallback = result.mode === 'fallback' ? ` 回退:${result.reason}` : ' 上游HEAD'
    const line = `全代理：${pid} HEAD 分片 -> ${result.status}，${elapsedMs}ms${length}${ranges}${fallback}｜${client.tag}`
    if (result.ok) printGrey(line); else printYellow(line)
  }
}

function logProxyManifest(pid, req, contentLength) {
  const client = clientOf(req)
  if (!logOncePer(`manifest|${pid}|${client.key}|${req.method}`, 60 * 1000)) return
  const stat = proxyStat(pid, req)
  const now = Date.now()
  const counts = stat.since
    ? `近 ${Math.round((now - stat.since) / 1000)} 秒分片 HEAD ${stat.head} 次、GET ${stat.get} 次、成功 ${stat.ok} 次`
    : '开始计数'
  printGrey(`全代理：${pid} ${req.method} 清单 -> 200，Content-Length:${contentLength}（${counts}）｜${client.tag}`)
  stat.head = 0; stat.get = 0; stat.ok = 0; stat.since = now
}

// 运行时长
var hours = 0

// 本地台标文件夹：用户把 <频道名>.png 放进数据目录的 logos/，优先于 fanmingming 兜底。
// 放 mdataDir 下随数据卷持久化；启动时建好，方便用户找到位置。
const LOGOS_DIR = dataPath('logos')
try { mkdirSync(LOGOS_DIR, { recursive: true }) } catch (e) { /* 已存在或无法创建，读写时再报 */ }

// 读取请求体（Promise 化，避免回调式写法导致的释放/死锁问题）
// 注意：必须先把所有 Buffer 块拼接、再整体按 UTF-8 解码。
// 旧写法 `body += chunk` 是逐块 toString，当一个多字节汉字被拆在两个 TCP 数据块
// 边界时，两半各自解码会变成乱码（如「咪」→「���」）——自定义分组名含中文且配置体较大时必现。
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => { chunks.push(chunk) })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// 升级过渡自愈只试一次（issue #29/#68）：见 /api/source-profiles POST
let sourceIdsHealAttempted = false

/**
 * 请求处理主体。
 *
 * 抽成具名函数、由 createServer 的回调兜住异常——原本整段没有顶层 try，
 * 任何未捕获的异常（哪怕只是路径解析里的一个同步 throw）都不会产生响应：
 * 请求永远不 res.end()，客户端一直挂到自己超时，服务端只在 unhandledRejection
 * 留一行日志。挂死比报错难查得多。
 *
 * 各 /api/* 路由内部已各自有 try（共 24 处），这里是最外层的兜底。
 */
async function handleRequest(req, res) {

  // 获取请求方法、URL 和请求头
  let { method, url, headers } = req;

  // 清理 URL，去除查询参数
  const urlPath = url.split('?')[0]

  // 多套 m3u 配置档：从 query ?profile= 取档名（仅 [a-z0-9_-]，非法/缺省=默认档）。
  // 放 query 而非路径段，避免被下方用户段正则吞成 userId/token、污染回看前缀。
  const profileParam = (url.match(/[?&]profile=([a-zA-Z0-9_-]{1,64})/)?.[1] || '').toLowerCase()

  // 处理 favicon.ico 请求
  if (urlPath === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return
  }

  // ---- 访问鉴权（两类钥匙，职责分离）----
  // passAuthed：站长密码 pass，全权（含后台 / 播放器 / API）。
  // userAuthed：用户访问令牌 /u/<token>，仅内容（进不了后台）。
  // accessPrefix：写回分发链接的前缀，让令牌 / 密码贯穿每个频道与 EPG 地址。
  let passAuthed = pass === ""
  let userAuthed = false
  let currentUser = null
  let accessPrefix = ""
  let routePath = urlPath

  // 用户访问令牌 /u/<token>/...：仅在启用且已有用户时才介入（无用户时对老部署完全无感）
  if (enableUserTokens && userManager.hasUsers()) {
    const tm = urlPath.match(/^\/u\/([A-Za-z0-9_-]{8,64})(?:\/(.*))?$/)
    if (tm) {
      const u = userManager.findByToken(tm[1])
      if (u && userManager.isUsable(u)) {
        userAuthed = true
        currentUser = u
        accessPrefix = `/u/${tm[1]}`
        routePath = "/" + (tm[2] || "")
        userManager.recordUsage(u)
      } else {
        // 令牌无效 / 已停用 / 已过期 → 直接拒绝，使吊销立即生效
        res.writeHead(403, { 'Content-Type': 'text/plain;charset=UTF-8' })
        res.end('访问令牌无效或已停用')
        return
      }
    }
  }

  // 站长密码前缀（未走用户令牌时）：pass 为空全部放行；pass 非空只有 /<pass>/... 授权
  if (!userAuthed && pass !== "" && (urlPath === `/${pass}` || urlPath.startsWith(`/${pass}/`))) {
    passAuthed = true
    accessPrefix = `/${pass}`
    routePath = urlPath.slice(`/${pass}`.length) || "/"
  }

  // 管理后台路由（路径可自定义，默认 /admin；支持 /<adminPath> 和 /密码/<adminPath>）
  if (routePath === `/${adminPath}`) {
    if (!passAuthed) {
      printRed(`管理后台访问需要密码，已拒绝未授权访问`)
      res.writeHead(403, { 'Content-Type': 'text/html;charset=UTF-8' });
      res.end(`<html><body><p>访问需要密码，请使用正确的密码路径访问管理后台。</p><p>格式: <code>/你的密码/${adminPath}</code></p></body></html>`);
      return
    }
    // 返回管理页面
    try {
      const html = readFileSync(`${process.cwd()}/web/admin.html`, 'utf-8')
      res.writeHead(200, { 'Content-Type': 'text/html;charset=UTF-8' });
      res.end(html);
      printGreen("管理后台访问")
    } catch (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Admin page not found');
      printRed("管理页面文件不存在")
    }
    return
  }

  // Public, fixed player library asset; no user content or credentials.
  if (urlPath === '/player-assets/mpegts.js') {
    if (!['GET', 'HEAD'].includes(method)) { res.writeHead(405); res.end(); return }
    const library = readFileSync(new URL('./web/vendor/mpegts.js', import.meta.url))
    res.writeHead(200, { 'Content-Type': 'text/javascript;charset=UTF-8', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' })
    res.end(method === 'HEAD' ? undefined : library)
    return
  }

  // 播放器页面路由（支持 /player 和 /密码/player）
  if (routePath === '/player') {
    if (!passAuthed) {
      res.writeHead(403, { 'Content-Type': 'text/html;charset=UTF-8' });
      res.end(`<html><body><p>访问需要密码，请使用正确的密码路径访问。</p><p>格式: <code>/你的密码/player</code></p></body></html>`);
      return
    }
    try {
      const html = readFileSync(`${process.cwd()}/web/player.html`, 'utf-8')
      res.writeHead(200, { 'Content-Type': 'text/html;charset=UTF-8' });
      res.end(html);
      printGreen("播放器页面访问")
    } catch (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Player page not found');
      printRed("播放器页面文件不存在")
    }
    return
  }

  // API 路由
  if (routePath.startsWith('/api/')) {
    // 鉴权：与页面一致，使用路径中的访问密码（前端在密码模式下会请求 /<pass>/api/...）。
    // 替代旧的、可被伪造的 Referer 头校验。
    if (!passAuthed) {
      res.writeHead(403, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(JSON.stringify({ success: false, message: '未授权访问' }));
      return
    }

    if (routePath === '/api/channels' && method === 'GET') {
      printBlue("API: 获取频道列表")
      const result = await getChannelsAPI()
      printGreen(`API: 返回 ${result.success ? result.data.length : 0} 个分组`)
      res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(JSON.stringify(result.success ? result.data : []));
      return
    }

    if (routePath === '/api/system-config' && method === 'GET') {
      printBlue("API: 获取系统配置")
      const result = getSystemConfigAPI()
      res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
      // 附带 envOverrides（哪些项被环境变量控制）与 blankModeEnv（是否 mblank 空白模式），供前端提示；不影响表单字段读取
      res.end(JSON.stringify(result.success ? { ...result.data, envOverrides: result.envOverrides || {}, blankModeEnv: !!result.blankModeEnv } : {}));
      return
    }

    if (routePath === '/api/system-config' && method === 'POST') {
      try {
        const body = await readBody(req)
        const config = JSON.parse(body)
        const result = saveSystemConfigAPI(config)
        res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify(result));
        printGreen(result.success ? "系统配置已保存" : "保存失败")
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify({ success: false, message: error.message }));
      }
      return
    }

    // 配置导出/导入（issue #99）：单 JSON 打包，前端触发下载/上传
    if (routePath === '/api/config-backup' && method === 'GET') {
      printBlue("API: 导出配置")
      const result = exportConfigAPI()
      res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(JSON.stringify(result));
      return
    }

    if (routePath === '/api/config-backup' && method === 'POST') {
      try {
        const body = await readBody(req)
        const payload = JSON.parse(body)
        const result = importConfigAPI(payload)
        res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify(result));
        printGreen(result.success ? "配置导入完成" : `配置导入失败: ${result.message}`)
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify({ success: false, message: error.message }));
      }
      return
    }

    // 重启服务API
    if (routePath === '/api/restart' && method === 'POST') {
      printMagenta("API: 收到重启请求")
      res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(JSON.stringify({ success: true, message: '服务将在 2 秒后重启...' }));

      // 2秒后退出进程。注意：本进程仅退出，不会自我拉起，
      // 依赖外部守护进程（Docker restart:always / pm2 / systemd）重新启动。
      setTimeout(() => {
        printMagenta("正在退出进程，等待守护进程（Docker/pm2/systemd）拉起...")
        process.exit(0)
      }, 2000)
      return
    }

    // 外部源管理API
    if (routePath === '/api/external-sources' && method === 'GET') {
      printBlue("API: 获取外部源配置")
      const result = getExternalSourcesAPI()
      res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(JSON.stringify(result));
      return
    }

    // 内置源管理API
    if (routePath === '/api/built-in-sources' && method === 'GET') {
      printBlue("API: 获取内置源配置")
      const result = getBuiltInSourcesAPI()
      res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(JSON.stringify(result));
      return
    }

    if (routePath === '/api/external-sources' && method === 'POST') {
      try {
        const body = await readBody(req)
        const data = JSON.parse(body)
        let result

        if (data.action === 'save') {
          result = await saveExternalSourcesAPI(data.sources)
        } else if (data.action === 'add') {
          result = addExternalSourceAPI(data.source)
        } else if (data.action === 'remove') {
          result = removeExternalSourceAPI(data.index)
        } else if (data.action === 'update') {
          result = await updateExternalSourceAPI(data.index || -1)
        } else if (data.action === 'setM3u8') {
          result = setExternalSourceM3u8API(data.index, data.m3u8Url)
        } else if (data.action === 'importSubscription') {
          result = await importSubscriptionAPI(data.index)
        } else if (data.action === 'parseLocalContent') {
          result = parseLocalContentAPI(data.contentBase64)
        } else if (data.action === 'probeStart') {
          // 失效检测（issue #88）：按源探测频道连通性。异步任务 + probeStatus 轮询，避免大订阅同步请求超时
          // 优先按源稳定 id 定位：前端排序防抖窗口内 index 可能与服务端不一致，按 index 会测错源；旧调用回退 index
          const srcList = externalSourceManager.sources?.sources || []
          const src = data.id ? srcList.find(s => s && s.id === data.id) : srcList[data.index]
          if (!src) {
            result = { success: false, message: '源不存在' }
          } else {
            const channels = []
            if (src.mode === 'subscription' && Array.isArray(src.parsedChannels)) {
              for (const ch of src.parsedChannels) channels.push({ name: ch.name, url: ch.url, group: ch.group })
            } else if (src.m3u8Url) {
              // 直连/抓取模式：检测当前 m3u8 地址
              channels.push({ name: src.name || '未命名源', url: src.m3u8Url, group: src.group })
            }
            result = channels.length === 0
              ? { success: false, message: '该源没有可检测的频道（请先导入/保存）' }
              : startProbe(srcList.indexOf(src), src.name || '未命名源', channels)
          }
        } else if (data.action === 'probeStatus') {
          result = getProbeStatus()
        } else if (data.action === 'probeCancel') {
          result = cancelProbe()
        } else {
          result = { success: false, message: '未知操作' }
        }

        res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify(result));
        printGreen(`外部源${data.action}操作完成`)
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify({ success: false, message: error.message }));
      }
      return
    }

    // EPG 节目单源管理 API（issue #38）
    if (routePath === '/api/epg-sources' && method === 'GET') {
      printBlue("API: 获取 EPG 源配置")
      const result = getEpgSourcesAPI()
      res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(JSON.stringify(result));
      return
    }

    if (routePath === '/api/epg-sources' && method === 'POST') {
      try {
        const data = JSON.parse(await readBody(req))
        let result
        switch (data.action) {
          case 'setEnabled': result = setEpgEnabledAPI(data.enabled); break
          case 'add': result = addEpgSourceAPI(data.source); break
          case 'update': result = updateEpgSourceAPI(data.index, data.fields || {}); break
          case 'remove': result = removeEpgSourceAPI(data.index); break
          case 'refresh':
            // 清空各源的 lastUpdated 强制重新下载，并后台触发一次完整更新以重建合并后的 playback.xml
            result = expireEpgSourcesAPI()
            if (result.success) {
              update(hours).catch(err => printRed(`EPG 手动刷新触发的更新失败: ${err?.message || err}`))
              result.message = '已触发后台刷新，节目单将在本次更新完成后生效（视源大小约数十秒~数分钟）'
            }
            break
          default: result = { success: false, message: '未知操作' }
        }
        res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify(result));
        printGreen(`EPG 源 ${data.action} 操作完成`)
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify({ success: false, message: error.message }));
      }
      return
    }

    // 用户访问令牌管理 API（一人一源）。仅站长 pass 可达（本 /api/ 块已由 passAuthed 把关）
    if (routePath === '/api/users' && method === 'GET') {
      const result = getUsersAPI()
      res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(JSON.stringify(result));
      return
    }

    if (routePath === '/api/users' && method === 'POST') {
      try {
        const data = JSON.parse(await readBody(req))
        let result
        switch (data.action) {
          case 'add': result = addUserAPI(data.user || {}); break
          case 'update': result = updateUserAPI(data.id, data.fields || {}); break
          case 'remove': result = removeUserAPI(data.id); break
          case 'regenToken': result = regenUserTokenAPI(data.id); break
          case 'setRequireToken': result = setRequireTokenAPI(data.requireToken); break
          default: result = { success: false, message: '未知操作' }
        }
        res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify(result));
        printGreen(`用户 ${data.action} 操作完成`)
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify({ success: false, message: error.message }));
      }
      return
    }

    // 频道别名管理 API（issue #56）。仅站长 pass 可达
    if (routePath === '/api/channel-aliases' && method === 'GET') {
      const result = getAliasesAPI()
      res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(JSON.stringify(result));
      return
    }

    if (routePath === '/api/channel-aliases' && method === 'POST') {
      try {
        const data = JSON.parse(await readBody(req))
        let result
        switch (data.action) {
          case 'setRule': result = setAliasRuleAPI(data.canonical, data.aliases); break
          case 'removeRule': result = removeAliasRuleAPI(data.canonical); break
          default: result = { success: false, message: '未知操作' }
        }
        res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify({ success: false, message: error.message }));
      }
      return
    }

    // 关键字自动分组规则（issue #69）
    if (routePath === '/api/group-keyword-rules' && method === 'GET') {
      const result = getGroupRulesAPI()
      res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(JSON.stringify(result));
      return
    }

    if (routePath === '/api/group-keyword-rules' && method === 'POST') {
      try {
        const data = JSON.parse(await readBody(req))
        let result
        switch (data.action) {
          case 'setRule': result = setGroupRuleAPI(data.group, data.keywords); break
          case 'removeRule': result = removeGroupRuleAPI(data.group); break
          case 'moveRule': result = moveGroupRuleAPI(data.group, data.direction); break
          default: result = { success: false, message: '未知操作' }
        }
        res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify({ success: false, message: error.message }));
      }
      return
    }

    // 抓取模块（extractors/）：GET=整份状态，POST=按 action 分发
    if (routePath === '/api/extractors' && method === 'GET') {
      const result = getExtractorsAPI()
      res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(JSON.stringify(result));
      return
    }

    if (routePath === '/api/extractors' && method === 'POST') {
      try {
        const data = JSON.parse(await readBody(req))
        let result
        switch (data.action) {
          case 'loginStart':
            result = await startModuleLoginAPI(data.id)
            break
          case 'loginPoll':
            result = await pollModuleLoginAPI(data.id, data.key)
            break
          case 'toggleModule':
            result = setExtractorEnabledAPI(data.id, data.enabled !== false)
            break
          case 'saveConfig':
            result = updateExtractorConfigAPI(data.id, data.config, data.refreshMinutes)
            break
          case 'refresh':
            result = runExtractorNowAPI(data.id)
            break
          case 'contentFlag':
            result = setContentFlagAPI(data.key, data.enabled !== false)
            break
          default:
            result = { success: false, message: `未知操作: ${data.action}` }
        }
        res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify({ success: false, message: error.message }));
      }
      return
    }

    // 源 ↔ 配置档 绑定（issue #29/#68）：GET=矩阵（源清单+档清单+每档禁用集），POST=切换某档某源的启用状态
    if (routePath === '/api/source-profiles' && method === 'GET') {
      try {
        const sources = []
        // 咪咕不在这里单列——它收编成抓取模块后由下方 listSourceIds() 以同一个
        // id 'migu' 供给本清单，这里再 push 一条就是同 id 双行（界面出现两个
        // 操作同一开关的复选框）。
        for (const s of (builtInSourceManager.getSourceList().sources || [])) {
          // 内置源 id 来自远程下发的 built-in-sources.json → 字符白名单消毒（防 HTML/EXTINF 属性注入）
          const safeId = s && s.id ? String(s.id).replace(/[^\w.-]/g, '') : ''
          if (safeId) sources.push({ id: `bi:${safeId}`, name: s.name || safeId, type: 'built-in', sourceEnabled: s.enabled !== false })
        }
        for (const s of (externalSourceManager.sources?.sources || [])) {
          if (s && s.id) sources.push({ id: `ext:${s.id}`, name: s.name || '未命名源', type: 'external', sourceEnabled: s.enabled !== false })
        }
        // 抓取模块的源一律列出：总开关已退休，每个模块的启用状态由它自己的开关决定，
        // 而这份清单是「配置档 ↔ 源」的绑定用的，与模块此刻开没开无关
        //（关掉的模块不出频道，但绑定关系要留着，开回来才不用重设）。
        for (const s of getExtractorManager().listSourceIds()) {
          sources.push({ id: s.id, name: s.name, type: 'extractor', sourceEnabled: true })
        }
        const profiles = listProfiles()
        const disabled = {}
        for (const p of profiles) {
          const cfg = readConfig(p.id)
          disabled[p.id] = Array.isArray(cfg.disabledSources) ? cfg.disabledSources : []
        }
        res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify({ success: true, data: { sources, profiles, disabled } }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify({ success: false, message: error.message }));
      }
      return
    }

    if (routePath === '/api/source-profiles' && method === 'POST') {
      try {
        const data = JSON.parse(await readBody(req))
        const pid = (typeof data.profileId === 'string' && data.profileId) ? data.profileId : 'default'
        const sid = typeof data.sourceId === 'string' ? data.sourceId.trim() : ''
        // 格式校验：只接受已知形态的源 id（migu / bi: 内置 / ext: 外部 / xt: 抓取模块），防任意字符串入配置落盘
        if (!/^(migu|bi:[\w.-]{1,64}|ext:[\w.-]{1,64}|xt:[\w.-]{1,64})$/.test(sid)) {
          res.writeHead(400, { 'Content-Type': 'application/json;charset=UTF-8' });
          res.end(JSON.stringify({ success: false, message: 'sourceId 无效' }));
          return
        }
        if (pid !== 'default' && !listProfiles().some(p => p.id === pid)) {
          res.writeHead(400, { 'Content-Type': 'application/json;charset=UTF-8' });
          res.end(JSON.stringify({ success: false, message: '配置档不存在' }));
          return
        }
        const cfg = readConfig(pid)
        let list = Array.isArray(cfg.disabledSources) ? cfg.disabledSources.slice() : []
        if (data.enabled === false) {
          if (!list.includes(sid)) list.push(sid)
        } else {
          list = list.filter(x => x !== sid)
        }
        if (list.length > 500) list = list.slice(-500)   // 上限兜底，防配置膨胀
        cfg.disabledSources = list
        const result = saveConfig(pid, cfg)
        // 升级过渡自愈：老 interface.txt 还没有 source-ids 标记时（升级后未重新生成过），
        // 触发一次「仅重生成播放列表」，让按档禁源立即可用，而不是等下一轮全量更新
        if (result.success !== false && !sourceIdsHealAttempted) {
          sourceIdsHealAttempted = true
          try {
            const ifPath = dataPath('interface.txt')
            if (existsSync(ifPath) && !readFileSync(ifPath, 'utf-8').includes('source-ids="')) {
              printBlue('interface.txt 尚无源归属标记，触发一次播放列表重生成（issue #29/#68 升级自愈）')
              update(0, { regenerateOnly: true }).catch(() => {})
            }
          } catch (e) { /* 自愈失败不影响本次保存 */ }
        }
        res.writeHead(result.success !== false ? 200 : 500, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify({ success: result.success !== false, data: { profileId: pid, disabledSources: list } }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify({ success: false, message: error.message }));
      }
      return
    }

    // 上传 / 移除频道台标（issue #40）
    if (routePath === '/api/upload-logo' && method === 'POST') {
      try {
        const data = JSON.parse(await readBody(req))
        const result = await uploadLogoAPI(data.name, data.imageBase64, data.ext)
        res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify({ success: false, message: error.message }));
      }
      return
    }
    if (routePath === '/api/remove-logo' && method === 'POST') {
      try {
        const data = JSON.parse(await readBody(req))
        const result = await removeLogoAPI(data.name)
        res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify({ success: false, message: error.message }));
      }
      return
    }

    // 复制频道到一个/多个分组（issue #37）
    if (routePath === '/api/copy-channel' && method === 'POST') {
      try {
        const data = JSON.parse(await readBody(req))
        const result = await copyChannelToGroupsAPI(data)
        res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify({ success: false, message: error.message }));
      }
      return
    }

    // 我的播放列表API
    if (routePath === '/api/my-playlist' && method === 'GET') {
      printBlue("API: 获取我的播放列表")
      try {
        const groups = parseInterfaceTxt()
        const config = readConfig(profileParam)
        const result = applyConfig(groups, config)
        res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
        // 同时返回原始数据和应用配置后的数据
        res.end(JSON.stringify({
          success: true,
          data: result,
          originalData: groups  // 原始未过滤的数据
        }));
        printGreen(`API: 返回 ${result.length} 个分组（原始: ${groups.length} 个）`)
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify({ success: false, message: error.message }));
      }
      return
    }

    if (routePath === '/api/my-playlist-config' && method === 'GET') {
      printBlue("API: 获取播放列表配置")
      try {
        const config = readConfig(profileParam)
        res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify({ success: true, data: config }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify({ success: false, message: error.message }));
      }
      return
    }

    if (routePath === '/api/check-update' && method === 'GET') {
      printBlue("API: 检查更新")
      try {
        const require = createRequire(import.meta.url)
        const pkg = require('./package.json')
        const currentVersion = pkg.version

        const rawUrl = 'https://raw.githubusercontent.com/akiralereal/iptv/main/package.json'

        let remotePkg = null
        let lastError = null
        for (const transform of GITHUB_RAW_MIRRORS) {
          const targetUrl = transform(rawUrl)
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 5000)
          try {
            const resp = await fetch(targetUrl, {
              headers: { 'User-Agent': 'iptv-update-checker' },
              signal: controller.signal
            })
            clearTimeout(timer)
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
            remotePkg = await resp.json()
            break
          } catch (e) {
            clearTimeout(timer)
            lastError = e
            // 单个镜像失败属正常回退（会自动尝试下一个），用黄色警告；全部失败才在下方标红
            printYellow(`镜像 ${targetUrl} 失败，尝试下一个: ${e.message}`)
          }
        }
        if (!remotePkg) throw lastError || new Error('所有镜像均不可用')

        const latestVersion = remotePkg.version
        const hasUpdate = latestVersion !== currentVersion

        res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' })
        res.end(JSON.stringify({ success: true, currentVersion, latestVersion, hasUpdate }))
        printGreen(`当前版本: ${currentVersion}, 最新版本: ${latestVersion}${hasUpdate ? ' (有更新)' : ' (已是最新)'}`)
      } catch (error) {
        // 软失败：保持 200，前端通过 success 字段判断
        res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' })
        res.end(JSON.stringify({ success: false, message: error.message }))
        printRed(`检查更新失败: ${error.message}`)
      }
      return
    }

    if (routePath === '/api/my-playlist-config' && method === 'POST') {
      try {
        const body = await readBody(req)
        const config = JSON.parse(body)
        // 只允许写「默认档」或已注册的配置档，避免任意 ?profile= 制造孤儿配置文件
        if (profileParam && profileParam !== 'default' && !listProfiles().some(p => p.id === profileParam)) {
          res.writeHead(400, { 'Content-Type': 'application/json;charset=UTF-8' });
          res.end(JSON.stringify({ success: false, message: '配置档不存在' }));
          return
        }
        const currentConfig = readConfig(profileParam)
        // disabledSources 单一写者是 /api/source-profiles（issue #29/#68）：
        // 本端点的整份保存一律沿用盘上现值，避免「我的频道」页加载的旧快照把刚设置的禁源冲掉
        config.disabledSources = Array.isArray(currentConfig.disabledSources) ? currentConfig.disabledSources : []
        const currentRenameMap = currentConfig.groupRenameMap || {}
        const nextRenameMap = config.groupRenameMap || {}
        const currentCustomGroups = currentConfig.customGroups || []
        const nextCustomGroups = config.customGroups || []
        const groupConfigChanged =
          JSON.stringify(currentRenameMap) !== JSON.stringify(nextRenameMap) ||
          JSON.stringify(currentCustomGroups) !== JSON.stringify(nextCustomGroups)

        if (groupConfigChanged) {
          const groups = parseInterfaceTxt()
          const validation = validateGroupConfig(groups, config)
          if (!validation.valid) {
            res.writeHead(400, { 'Content-Type': 'application/json;charset=UTF-8' });
            res.end(JSON.stringify({ success: false, message: validation.message }));
            return
          }
        }

        const result = saveConfig(profileParam, config)
        res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify(result));
        printGreen("播放列表配置已保存")
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify({ success: false, message: error.message }));
      }
      return
    }

    // 配置档（多套 m3u）管理：列表 / 新建(可复制) / 改名 / 删除
    if (routePath === '/api/my-playlist-profiles' && method === 'GET') {
      printBlue("API: 获取配置档列表")
      res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(JSON.stringify({ success: true, data: listProfiles() }));
      return
    }

    if (routePath === '/api/my-playlist-profiles' && method === 'POST') {
      try {
        const body = await readBody(req)
        const data = JSON.parse(body)
        let result
        if (data.action === 'create') {
          result = createProfile({ id: data.id, name: data.name, fromProfile: data.from })
        } else if (data.action === 'rename') {
          result = renameProfile({ id: data.id, name: data.name })
        } else if (data.action === 'delete') {
          result = deleteProfile(data.id)
        } else {
          result = { success: false, message: '未知操作' }
        }
        res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify(result));
        printGreen(`配置档${data.action}操作完成`)
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify({ success: false, message: error.message }));
      }
      return
    }

    // 未匹配的 /api/* 返回 404，而不是落到频道处理逻辑
    res.writeHead(404, { 'Content-Type': 'application/json;charset=UTF-8' });
    res.end(JSON.stringify({ success: false, message: '接口不存在' }));
    return
  }

  // 设置密码但未授权访问（非 admin/player/api 路由）：拒绝。用户访问令牌(userAuthed)放行内容
  if (pass !== "" && !passAuthed && !userAuthed) {
    printRed(`身份认证失败`)
    res.writeHead(403, { 'Content-Type': 'application/json;charset=UTF-8' });
    res.end(`身份认证失败`);
    return
  }

  // 项目自有公告短片与台标。视频支持 Range/HEAD，兼容 AVPlayer/APTV 等会先探测、
  // 再按字节分段读取 MP4 的播放器；路由放在鉴权之后，密码和用户令牌不会被绕过。
  // 兼容历史的 /<咪咕userId>/<token>/m3u 地址：该入口会把两段账号前缀带进
  // 播放列表里的本机 URL，所以这里也接受以资源路径结尾的形式。
  const announcementAssetPath = [ANNOUNCEMENT.videoPath, ANNOUNCEMENT.logoPath]
    .find(assetPath => routePath === assetPath || routePath.endsWith(assetPath))
  if (announcementAssetPath) {
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' })
      res.end()
      return
    }
    const asset = readAnnouncementAsset(announcementAssetPath)
    if (!asset) {
      res.writeHead(404, { 'Content-Type': 'text/plain;charset=UTF-8' })
      res.end('announcement asset not found')
      return
    }
    const total = asset.content.length
    const baseHeaders = {
      'Content-Type': asset.contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400',
    }
    const range = String(headers.range || '').match(/^bytes=(\d*)-(\d*)$/)
    if (headers.range && !range) {
      res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${total}` })
      res.end()
      return
    }
    let start = 0
    let end = total - 1
    if (range) {
      if (!range[1] && range[2]) {
        const suffix = Number(range[2])
        start = Math.max(0, total - suffix)
      } else {
        start = Number(range[1] || 0)
        if (range[2]) end = Number(range[2])
      }
      end = Math.min(end, total - 1)
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= total) {
        res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${total}` })
        res.end()
        return
      }
    }
    const body = asset.content.subarray(start, end + 1)
    const status = range ? 206 : 200
    res.writeHead(status, {
      ...baseHeaders,
      'Content-Length': body.length,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}),
    })
    if (method === 'HEAD') res.end(); else res.end(body)
    return
  }

  // 本地台标：/logos/<文件名>（也兼容前面带 /userId/token 段的情况），从数据目录 logos/ 读取。
  // 必须放在下方「用户段解析」之前，否则 /logos/x.png 会被当成 /userId/token 拆掉。
  const logosIdx = routePath.indexOf('/logos/')
  if (logosIdx !== -1) {
    let logoName
    try {
      logoName = decodeURIComponent(routePath.slice(logosIdx + '/logos/'.length))
    } catch (e) {
      // 畸形百分号编码（如 /logos/%）会让 decodeURIComponent 抛 URIError，必须接住否则请求挂起
      res.writeHead(400); res.end(); return
    }
    if (!logoName || logoName.includes('/') || logoName.includes('\\') || logoName.includes('..')) {
      res.writeHead(400); res.end(); return
    }
    try {
      const buf = readFileSync(dataPath(`logos/${logoName}`))
      const ext = logoName.slice(logoName.lastIndexOf('.') + 1).toLowerCase()
      const mime = ext === 'png' ? 'image/png'
        : (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg'
        : ext === 'webp' ? 'image/webp'
        : ext === 'svg' ? 'image/svg+xml'
        : 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' })
      res.end(buf)
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('logo not found')
    }
    return
  }

  // 剥离密码前缀后的完整 url（保留查询串），用于频道/接口处理
  let routeUrl = routePath
  const queryIndex = url.indexOf('?')
  if (queryIndex !== -1) {
    routeUrl += url.substring(queryIndex)
  }

  // 清单直出兼容模式（issue #98）：/relay/<pid> 的 relay 段必须在下方「/userId/token」
  // 两段解析之前剥掉，否则会被误当成账号注入前缀（relay 当 userId、pid 当 token）返回订阅内容。
  // 支持前面带账号注入段的组合（/userId/token/relay/<pid>），剥掉 relay 段、其余原样保留。
  let relayMode = false
  // 可选 .m3u8 后缀：极影视等播放器按 URL 后缀识别流格式，无后缀会被判定不可播（issue #98 追踪）；
  // 兼容版订阅输出 /relay/<pid>.m3u8，旧的无后缀形式继续支持
  const relayMatch = routeUrl.match(/^(.*)\/relay\/([a-z0-9][a-z0-9_-]{0,63})(?:\.m3u8)?((?:\?.*)?)$/i)
  if (relayMatch) {
    relayMode = true
    routeUrl = `${relayMatch[1]}/${relayMatch[2]}${relayMatch[3]}`
  }

  // 全代理兼容模式（issue #98 续）：/proxy/<pid>.m3u8 下发的清单里只有同源同目录的相对地址，
  // 分片走 /proxy/s<key>.<ext> 由服务器转发——给「清单里的绝对地址取不动」的播放器
  // （极空间极影视：兼容版清单本身完全合法却仍播不了，而同一条 CDN 地址直接填就能播）。
  // key 带 s 前缀，与频道 ref 天然不冲突；两条路由都必须先于下方「/userId/token」两段解析匹配，
  // 否则会被拆成账号段。
  // i 标志与清单路由对齐：个别播放器会把相对地址大写化，漏匹配会静默落进下方账号段解析
  const proxySegMatch = routeUrl.match(/^.*\/proxy\/(s[0-9a-f]{16})\.[a-z0-9]{1,8}(?:\?.*)?$/i)
  if (proxySegMatch) {
    if (method === "OPTIONS") {
      const client = clientOf(req)
      if (logOncePer(`options|segment|${client.key}`, 60 * 1000)) {
        printGrey(`全代理：OPTIONS 分片探测 -> 200｜${client.tag}`)
      }
      res.writeHead(200, {
        'Content-Type': /\.m3u8(?:\?|$)/i.test(routeUrl) ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      })
      res.end()
      return
    }
    const target = lookupProxyTarget(proxySegMatch[1].toLowerCase())
    if (!target) {
      // 只可能是清单过期后播放器还在拿老地址重试：回 404，播放器会重新拉清单。
      // 必须打行：这曾是完全静默的分支，「key 过期/被淘汰」与「播放器压根没来」在日志里分不出来
      const client = clientOf(req)
      if (logOncePer(`seg404|${proxySegMatch[1]}|${client.key}|${method}`, 10 * 1000)) {
        printYellow(`全代理分片 key 未登记/已过期，${method} 回 404: ${proxySegMatch[1]}｜${client.tag}`)
      }
      res.writeHead(404, { 'Content-Type': 'text/plain;charset=UTF-8' })
      res.end('分片地址已过期')
      return
    }
    if (method === "HEAD") {
      // 极影视等严格播放器会先 HEAD 第一个分片；向上游取真实 Content-Length / Accept-Ranges。
      // 上游不支持 HEAD 或分片需要转换时 probeUpstream 会回退旧的合成 200，GET 行为不变。
      noteProxySegment(target.pid, req)
      const started = Date.now()
      const result = await probeUpstream(target.url, req, res, target.transform, target.upstreamHeaders)
      logProxyProbe(target.pid, req, result, Date.now() - started)
      return
    }
    // 上游若给的是嵌套子清单（拍平失败时才会出现），同样改写成同源相对地址再下发，
    // 直接透传会让播放器拿着 CDN 的相对路径去请求本机、必然 404
    if (/\.m3u8(?:\?|$)/i.test(routeUrl)) {
      const nested = await fetchNested(target.url, target.upstreamHeaders)
      if (nested) {
        const body = Buffer.from(toProxyManifest(
          rewriteManifest(nested.text, nested.finalUrl),
          target.pid,
          target.transform,
          target.upstreamHeaders,
          target.upstreamUrlTransform,
        ), 'utf-8')
        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache, no-store',
          'Content-Length': body.length,
        })
        res.end(body)
        return
      }
      // 子清单取回失败时不能落到下方分片透传：那会把未改写的清单（内含 CDN 相对路径）
      // 原样 pipe 给播放器——正是上面注释声明必须避免的形态。回 502 让播放器重试。
      printYellow(`嵌套子清单取回失败，回 502: ${target.url.split('?')[0]}`)
      res.writeHead(502, { 'Content-Type': 'text/plain;charset=UTF-8' })
      res.end('上游子清单获取失败')
      return
    }
    noteProxySegment(target.pid, req)
    const started = Date.now()
    const result = await pipeUpstream(target.url, req, res, target.transform, target.upstreamHeaders)
    logProxySegmentResult(target.pid, req, result, Date.now() - started)
    return
  }

  let proxyMode = false
  let proxyPid = ""
  // ref 同时兼容咪咕纯数字与模块命名空间（如 gxtv-gxws）。收紧到与模块 id
  // 同级的安全字符，不能用宽泛的 [^/]+ 把路径/查询串吞进 resolver。
  const proxyMatch = routeUrl.match(/^(.*)\/proxy\/([a-z0-9][a-z0-9_-]{0,63})(?:\.m3u8)?((?:\?.*)?)$/i)
  if (proxyMatch) {
    proxyMode = true
    proxyPid = proxyMatch[2]
    routeUrl = `${proxyMatch[1]}/${proxyMatch[2]}${proxyMatch[3]}`
  }

  // 带 relay/proxy 段却没被上面任何一条路由认出（播放器把清单地址当目录拼相对路径、
  // 多余斜杠等畸形解析）：必须 404 收口。落到下方账号段解析会把 relay/proxy 误当
  // userId、返回整份订阅 + HTTP 200——播放器拿订阅文本当分片解码必失败且全程无痕。
  // 豁免 /relay/<pid>/playback.xml：v3.15 时代订阅曾把 relay 段拼进 x-tvg-url，
  // 存量播放器缓存的 EPG 地址仍走账号段解析取 playback.xml，不能 404。
  if (!relayMode && !proxyMode && /\/(?:relay|proxy)\//i.test(routeUrl) && !/\/playback\.xml(?:\?|$)/.test(routeUrl)) {
    printYellow(`无法识别的 relay/proxy 路径，回 404: ${routeUrl.split('?')[0]}｜${clientOf(req).tag}`)
    res.writeHead(404, { 'Content-Type': 'text/plain;charset=UTF-8' })
    res.end('地址格式不正确')
    return
  }

  let urlToken = ""
  let urlUserId = ""
  // 匹配是否存在用户信息 /userId/token/...
  if (/\/{1}[^\/\s]{1,}\/{1}[^\/\s]{1,}/.test(routeUrl)) {
    const urlSplit = routeUrl.split("/")
    if (urlSplit.length >= 3) {
      urlUserId = urlSplit[1]
      urlToken = urlSplit[2]
      routeUrl = urlSplit.length == 3 ? "/" : "/" + urlSplit[urlSplit.length - 1]
    }
  } else {
    // 地址里没带账号段时，用咪咕模块配置里的账号兜底。
    // `/userId/token/` 这个 URL 约定本身仍是咪咕特有的、留在路由层——搬的是
    // 账号的存储位置，不是这条约定；把约定也模块化是更大的一次路由重构。
    const migu = getModuleConfig('migu')
    urlUserId = migu.userId || ""
    urlToken = migu.token || ""
  }

  // OPTIONS 与 HEAD 一律本地回答，绝不触发上游解析链。
  //
  // 播放器打开订阅时会把里面每个频道逐一探活一遍（APTV 实测：约 2 秒内 HEAD 了 29 个频道）。
  // 若清单 HEAD 走真实生成链，每个频道都要取一次票再拉一次清单，几十个频道瞬间打出上百个
  // 上游请求，直接撞上平台按 IP 的频率限制——被限的不只是探活本身，连用户正在看的那个频道
  // 的分片请求也一起回 403，表现为「有的能播、有的播一会儿卡、有的打不开」。
  //
  // 探活只需要知道「这是不是一条可播的 HLS」，答案在 Content-Type 里（issue #98：回
  // application/json 会被判定不可播）。至于 Content-Length，直播清单每几秒滚动一次、
  // 长度本就在变，HEAD 报的值与随后 GET 的必然对不上，为这个达不到的准确性付整条解析链
  // 的代价并不划算。
  if (method === "OPTIONS" || method === "HEAD") {
    const streamType = resolverFor(routeUrl.split('?')[0].replace(/^\//, ''))?.streamType
    if (relayMode || proxyMode) {
      const client = clientOf(req)
      const kind = proxyMode ? '全代理' : '兼容'
      // 频道标识与下方播放日志保持同一形态（不带前导斜杠），排查时两类行才对得上
      const label = proxyMode ? proxyPid : routeUrl.split('?')[0].replace(/^\//, '')
      if (logOncePer(`probe|manifest|${routeUrl}|${client.key}|${method}`, 60 * 1000)) {
        printGrey(`${kind}：${label} ${method} 探活 -> 200（本地应答，未打上游）｜${client.tag}`)
      }
    }
    res.writeHead(200, {
      // 清单直出地址按 HLS 类型应答 HEAD 探测：部分播放器播放前先 HEAD 判断类型，
      // 回 application/json 会被判定「不可播放」（issue #98）
      'Content-Type': streamType === 'flv' ? 'video/x-flv' : (relayMode || proxyMode) ? 'application/vnd.apple.mpegurl' : 'application/json;charset=UTF-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    });
    res.end();
    return
  }

  // HEAD/OPTIONS 已在上面本地收口；其他非 GET/POST 请求才报错
  if (method != "GET" && method != "POST") {
    res.writeHead(405, { 'Content-Type': 'application/json;charset=UTF-8' });
    res.end(JSON.stringify({
      data: '请使用GET或POST请求',
    }));
    printRed(`使用非GET/POST请求:${method}`)
    return
  }

  // /interface.m3u 是 /m3u 的别名：内容相同，只为带 .m3u 后缀——某些客户端（如飞牛影视）按后缀校验订阅地址，/m3u 会被拒
  const interfaceList = "/,/interface.txt,/interface.m3u,/m3u,/txt,/playback.xml"

  // 去掉 query（含 ?profile=）后再做接口匹配/选盘；profile 走 profileParam 传入，回看/EPG 自动沿用同一 base
  const routeUrlPath = routeUrl.split('?')[0]

  // 接口
  if (interfaceList.indexOf(routeUrlPath) !== -1) {
    // 用户绑定了档则用其绑定档（一人一内容），否则用 query 的 ?profile=
    const effectiveProfile = (currentUser && currentUser.profile) ? currentUser.profile : profileParam
    // 兼容版订阅（issue #98）：?relay=1 输出 /relay/<pid> 清单直出路径；?relay=2 输出
    // /proxy/<pid> 全代理路径（分片也经服务器转发）。其他取值按不开启处理。
    const relayParam = routeUrl.match(/[?&]relay=([12])(?:&|$)/)?.[1] || ''
    // 订阅拉取留痕（issue #98）：核心排查判据是「播放器拉订阅时带没带 ?relay=、是谁在拉」，
    // 此前这里零日志，App 二次拉订阅丢参数的场景完全无痕
    printGrey(`订阅拉取: ${method} ${routeUrlPath}${relayParam ? `?relay=${relayParam}` : '（无 relay 参数）'}｜${clientOf(req).tag}`)
    const interfaceObj = interfaceStr(routeUrlPath, headers, urlUserId, urlToken, effectiveProfile, accessPrefix, relayParam)
    if (interfaceObj.content == null) {
      interfaceObj.content = "获取失败"
    }
    // 设置响应头
    res.setHeader('Content-Type', interfaceObj.contentType);
    // 禁止客户端按内容嗅探覆盖声明的类型，确保飞牛/浏览器严格按 text/plain 当文本处理（与 GitHub raw 一致）
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (routeUrlPath == "/m3u" || routeUrlPath == "/interface.m3u") {
      res.setHeader('content-disposition', "inline; filename=\"interface.m3u\"");
    }
    res.statusCode = 200;
    res.end(interfaceObj.content); // 发送文件内容
    return
  }

  // 频道（relayMode = 清单直出兼容模式，issue #98：极影视等播放器不跟随 302 跳转；
  // relay 段已在「/userId/token」解析前剥离，此处 routeUrl 即普通频道地址）
  const result = await channel(routeUrl, urlUserId, urlToken)

  // 结果异常
  if (result.code != 302) {

    printRed(result.desc)
    res.writeHead(result.code, {
      'Content-Type': 'application/json;charset=UTF-8',
    });
    res.end(result.desc)
    return
  }

  if (result.streamType === 'flv') {
    const streamed = await pipeFlv(result.playURL, req, res, result.validateMediaUrl)
    if (!streamed.ok && !streamed.disconnected) printYellow(`FLV 直播 ${routeUrl.split('?')[0]}：${streamed.error}`)
    return
  }

  if (relayMode || proxyMode || result.relayHls) {
    // 服务端取回清单、相对路径改写为绝对地址后直出，播放器无需跟随任何跳转
    const failKey = proxyMode ? proxyPid : routeUrl.split('?')[0]
    let manifest = null
    if (manifestCooling(failKey)) {
      // 熔断窗口内：直接走下方 302 回退，不再替播放器把重试打到上游
    } else {
      manifest = inlineResolvedManifest(result)
      if (manifest == null) manifest = await fetchManifestDirect(result.playURL, result.upstreamHeaders)
      markManifestResult(failKey, manifest != null)
    }
    // 全代理：再把清单里的绝对地址换成本机同源相对地址，分片改由 /proxy/s<key>.ts 转发
    if (manifest != null && proxyMode) {
      manifest = toProxyManifest(
        manifest,
        proxyPid,
        result.segmentTransform,
        result.upstreamHeaders,
        result.upstreamUrlTransform,
      )
    }
    if (manifest != null) {
      const body = Buffer.from(manifest, 'utf-8')
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*',
        // 直播媒体清单会被播放器周期性轮询，必须禁缓存，否则拿到旧分片列表会卡住不前
        'Cache-Control': 'no-cache, no-store',
        // 显式 Content-Length（避免 chunked 传输）：部分简易播放器的 HTTP 客户端对分块传输支持不佳
        'Content-Length': body.length,
      });
      if (proxyMode) logProxyManifest(proxyPid, req, body.length)
      res.end(body)
      return
    }
    // 取清单失败（网络抖动/非 HLS 内容）：回退 302，能跟随跳转的播放器仍可播。
    // 打一行日志：不跟随跳转的播放器此时会播不了，用户排查时能从日志看出走了回退。
    // 同频道每 5 秒一行——播放器失败后是 100ms 级别的连环重试，逐次打印只会淹没日志。
    if (logOncePer(`manifestfail|${failKey}`, 5 * 1000)) {
      printYellow(`清单直出取回失败，回退 302（不跟随跳转的播放器将无法播放）: ${routeUrl.split('?')[0]}`)
    }
  }

  // 302 成功下发此前全程零日志（issue #98）：播放器拿着旧形态地址回退播放时服务端毫无痕迹。
  // 每频道每客户端每分钟一行，既留痕又不被 6 秒一次的清单轮询刷屏
  {
    const client = clientOf(req)
    const pidPath = routeUrl.split('?')[0]
    if (logOncePer(`302|${pidPath}|${client.key}|${method}`, 60 * 1000)) printGrey(`302 跳转下发: ${method} ${pidPath}｜${client.tag}`)
  }
  res.writeHead(302, {
    'Content-Type': 'application/json;charset=UTF-8',
    location: result.playURL
  });

  res.end()
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(error => {
    printRed(`请求处理异常 ${req.method} ${req.url}: ${error?.message || error}`)
    // 已经开始写响应了就只能收口，再 writeHead 会抛 ERR_HTTP_HEADERS_SENT，
    // 那样又变回「不 end」的挂死形态。
    if (res.headersSent) {
      try { res.end() } catch { /* 连接可能已断 */ }
      return
    }
    try {
      res.writeHead(500, { 'Content-Type': 'text/plain;charset=UTF-8' })
      res.end('服务异常')
    } catch { /* 连接可能已断 */ }
  })
})

// Node 默认 keepAliveTimeout 5 秒，而直播媒体清单 TARGETDURATION=6 秒——简易播放器复用
// 刚被服务端 FIN 掉的连接会撞 RST（issue #98 H5）。拉长到 65 秒覆盖轮询节拍；
// headersTimeout 必须大于 keepAliveTimeout，否则空闲连接上的下一个请求会被误杀
server.keepAliveTimeout = 65 * 1000
server.headersTimeout = 66 * 1000

// 客户端发送畸形 HTTP 或在请求中途断开时，优雅丢弃连接而不是让进程崩溃
server.on('clientError', (err, socket) => {
  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  } else {
    socket.destroy()
  }
})

// 兜底：任何未捕获的 Promise rejection / 异常只记录日志，不让常驻媒体服务整体退出
process.on('unhandledRejection', (reason) => {
  printRed(`未处理的 Promise rejection: ${reason?.message || reason}`)
})
process.on('uncaughtException', (err) => {
  printRed(`未捕获的异常: ${err?.message || err}`)
})

server.listen(port, async () => {
  const updateInterval = parseInt(programInfoUpdateInterval)

  // 用户令牌用量（最近访问 / 次数）节流落盘：内存累加，每 60 秒 flush 一次，避免每请求写磁盘
  setInterval(() => userManager.flushUsage(), 60 * 1000)

  // 定时任务1: 完整更新（咪咕 + 外部源 + 节目单）
  setInterval(async () => {
    printBlue(`准备更新文件 ${getDateTimeStr(new Date())}`)
    hours += updateInterval
    try {
      await update(hours)
    } catch (error) {
      console.log(error)
      printRed("更新失败")
    }

    printBlue(`当前已运行${hours}小时`)
  }, updateInterval * 60 * 60 * 1000);

  // 定时任务2: 每 5 分钟检查外部源、内置源、抓取模块是否到刷新间隔（needsRefresh 按各自间隔判定，不到点不抓）
  // 这一轮本身可能超过 5 分钟（外部源串行且每源之间硬睡 2 秒），必须自己防重入，
  // 否则两轮会同时改同一批状态并写同一个文件，后写者覆盖前者。
  // 周期默认 5 分钟。msourceTickSeconds 仅供本地测试压缩周期（如 =20），生产不要设
  const sourceTickMs = (parseInt(process.env.msourceTickSeconds) > 0 ? parseInt(process.env.msourceTickSeconds) : 5 * 60) * 1000
  if (sourceTickMs !== 5 * 60 * 1000) printYellow(`源刷新检查周期被 msourceTickSeconds 改为 ${sourceTickMs / 1000} 秒（仅供测试）`)
  let sourceTickRunning = false
  setInterval(async () => {
    if (sourceTickRunning) {
      printYellow("上一轮源刷新检查尚未结束，跳过本次")
      return
    }
    sourceTickRunning = true
    try {
      const builtInResult = await updateBuiltInSources({ autoOnly: true })
      const externalResult = await updateExternalSources({ autoOnly: true })
      const extractorResult = await updateExtractors({ autoOnly: true })
      // 若有任何源成功刷新了新 URL，立即重新生成播放列表（regenerateOnly 模式不重抓咪咕/节目单，速度快）
      const builtInUpdated = Array.isArray(builtInResult?.results) && builtInResult.results.some(r => r.success)
      const externalUpdated = Array.isArray(externalResult?.results) && externalResult.results.some(r => r.success)
      const extractorUpdated = Array.isArray(extractorResult?.results) && extractorResult.results.some(r => r.success)
      if (builtInUpdated || externalUpdated || extractorUpdated) {
        printBlue("检测到源 URL 已更新，重新生成播放列表...")
        try {
          await update(hours, { regenerateOnly: true })
          printGreen("播放列表已更新为最新源 URL")
        } catch (regenError) {
          console.log(regenError)
          printRed("播放列表重新生成失败")
        }
      }
    } catch (error) {
      console.log(error)
      printRed("源更新检查失败")
    } finally {
      sourceTickRunning = false
    }
  }, sourceTickMs); // 每 5 分钟检查一次：让各源的 refreshInterval 被准时执行（此前每小时才 check，间隔不精确）—— issue #73

  // 需要网页抓取的内置源（纬来体育等）的启动抓取。放到首份播放列表生成之后、不 await 地在
  // 后台跑：此前它排在启动流程最前面且串行，内网抓不到时一轮十几分钟，其它所有源都得等它。
  // 抓到了走「仅重新生成播放列表」把新地址补进去；抓取本身有防重入，5 分钟 tick 撞上会跳过
  async function refreshBuiltInSourcesAfterStartup() {
    // 用户配置了「启动时不更新」：启动那轮连咪咕都不刷，内置源也照旧不抓，交给定时刷新
    if (externalSourceManager.sources?.updateOnStartup === false) return
    try {
      printBlue("启动模式：后台抓取需要网页抓取的内置源...")
      const result = await updateBuiltInSources({ startupMode: true })
      if (Array.isArray(result?.results) && result.results.some(r => r.success)) {
        printBlue("内置源启动抓取拿到新地址，重新生成播放列表...")
        await update(hours, { regenerateOnly: true })
        printGreen("播放列表已补入内置源最新地址")
      }
    } catch (error) {
      printRed(`内置源启动抓取失败: ${error?.message || error}`)
    }
  }

  try {
    // 初始化数据（启动模式）
    await update(hours, { startupMode: true })
  } catch (error) {
    console.log(error)
    printRed("更新失败")
  }

  void refreshBuiltInSourcesAfterStartup()

  // 启动后检查：如果有订阅源首次获取失败（parsedChannels 为空），60秒后自动重试
  setTimeout(async () => {
    try {
      const sources = externalSourceManager.sources?.sources || []
      const failedSubs = sources.filter((s, i) =>
        s.enabled && s.mode === 'subscription' && s.subscriptionUrl && !Array.isArray(s.parsedChannels)
        && (enableBuiltInSubscriptions || !isBuiltInSubscriptionSource(s))  // 内置订阅禁用时不重试
      )
      if (failedSubs.length > 0) {
        printYellow(`检测到 ${failedSubs.length} 个订阅源未成功获取，正在重试...`)
        for (let i = 0; i < sources.length; i++) {
          const s = sources[i]
          if (s.enabled && s.mode === 'subscription' && s.subscriptionUrl && !Array.isArray(s.parsedChannels)
            && (enableBuiltInSubscriptions || !isBuiltInSubscriptionSource(s))) {
            await externalSourceManager.updateSubscriptionSource(i)
          }
        }
        // 重试后若有成功的，立即重新生成播放列表
        const hasNew = sources.some(s => s.mode === 'subscription' && Array.isArray(s.parsedChannels) && s.parsedChannels.length > 0)
        if (hasNew) {
          printBlue("订阅源重试成功，重新生成播放列表...")
          await update(hours, { regenerateOnly: true })
        }
      }
    } catch (error) {
      printRed(`订阅源重试失败: ${error.message}`)
    }
  }, 60 * 1000) // 60秒后重试

  printGreen(`本地地址: http://localhost:${port}${pass == "" ? "" : "/" + pass}`)
  printGreen(`管理平台地址: http://localhost:${port}${pass == "" ? "" : "/" + pass}/${adminPath}`)
  printGreen("开源地址: https://github.com/akiralereal/iptv ")
  if (host != "") {
    printGreen(`自定义地址: ${host}${pass == "" ? "" : "/" + pass}`)
  }
  if (!enableMigu) {
    printYellow("咪咕源已禁用（enableMigu=false），当前为纯频道管理模式，仅分发内置/外部源")
  } else {
    const migu = getModuleConfig('migu')
    if (!migu.userId || !migu.token) {
      printYellow("当前为游客模式（未配置咪咕账号），咪咕频道最高画质为 540p，填免费账号可到 720p")
    }
  }
})
