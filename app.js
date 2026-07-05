import http from "node:http"
import { readFileSync, mkdirSync, existsSync } from "node:fs"
import { createRequire } from "node:module"
import fetch from 'node-fetch'
import { adminPath, host, pass, port, programInfoUpdateInterval, token, userId, enableMigu, enableBuiltInSubscriptions, enableUserTokens } from "./config.js";
import { getDateTimeStr } from "./utils/time.js";
import update from "./utils/updateData.js";
import { printBlue, printGreen, printMagenta, printRed, printYellow } from "./utils/colorOut.js";
import { channel, interfaceStr } from "./utils/appUtils.js";
import { dataPath } from "./utils/paths.js";
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
import { readConfig, saveConfig, parseInterfaceTxt, validateGroupConfig, applyConfig,
         listProfiles, createProfile, renameProfile, deleteProfile } from "./utils/playlistConfig.js";
import { updateBuiltInSources, updateExternalSources, externalSourceManager, builtInSourceManager } from "./utils/channelMerger.js";
import { GITHUB_RAW_MIRRORS, isBuiltInSubscriptionSource } from "./utils/externalSources.js";

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

const server = http.createServer(async (req, res) => {

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

    // 源 ↔ 配置档 绑定（issue #29/#68）：GET=矩阵（源清单+档清单+每档禁用集），POST=切换某档某源的启用状态
    if (routePath === '/api/source-profiles' && method === 'GET') {
      try {
        const sources = []
        if (enableMigu) sources.push({ id: 'migu', name: '咪咕源（核心）', type: 'migu' })
        for (const s of (builtInSourceManager.getSourceList().sources || [])) {
          // 内置源 id 来自远程下发的 built-in-sources.json → 字符白名单消毒（防 HTML/EXTINF 属性注入）
          const safeId = s && s.id ? String(s.id).replace(/[^\w.-]/g, '') : ''
          if (safeId) sources.push({ id: `bi:${safeId}`, name: s.name || safeId, type: 'built-in', sourceEnabled: s.enabled !== false })
        }
        for (const s of (externalSourceManager.sources?.sources || [])) {
          if (s && s.id) sources.push({ id: `ext:${s.id}`, name: s.name || '未命名源', type: 'external', sourceEnabled: s.enabled !== false })
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
        // 格式校验：只接受已知形态的源 id（migu / bi:<白名单字符> / ext:<白名单字符>），防任意字符串入配置落盘
        if (!/^(migu|bi:[\w.-]{1,64}|ext:[\w.-]{1,64})$/.test(sid)) {
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
    urlUserId = userId
    urlToken = token
  }

  // 允许HEAD、OPTIONS预检请求
  if (method === "HEAD" || method === "OPTIONS") {
    res.writeHead(200, {
      'Content-Type': 'application/json;charset=UTF-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    });
    res.end();
    return
  }

  // 其他非GET/POST请求才报错
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
    const interfaceObj = interfaceStr(routeUrlPath, headers, urlUserId, urlToken, effectiveProfile, accessPrefix)
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

  // 频道
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

  res.writeHead(result.code, {
    'Content-Type': 'application/json;charset=UTF-8',
    location: result.playURL
  });

  res.end()
})

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

  // 定时任务2: 每 5 分钟检查外部源和内置源是否到刷新间隔（needsRefresh 按各源 refreshInterval 判定，不到点不抓）
  setInterval(async () => {
    try {
      const builtInResult = await updateBuiltInSources({ autoOnly: true })
      const externalResult = await updateExternalSources({ autoOnly: true })
      // 若有任何源成功刷新了新 URL，立即重新生成播放列表（regenerateOnly 模式不重抓咪咕/节目单，速度快）
      const builtInUpdated = Array.isArray(builtInResult?.results) && builtInResult.results.some(r => r.success)
      const externalUpdated = Array.isArray(externalResult?.results) && externalResult.results.some(r => r.success)
      if (builtInUpdated || externalUpdated) {
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
    }
  }, 5 * 60 * 1000); // 每 5 分钟检查一次：让各源的 refreshInterval 被准时执行（此前每小时才 check，间隔不精确）—— issue #73

  try {
    // 初始化数据（启动模式）
    await update(hours, { startupMode: true })
  } catch (error) {
    console.log(error)
    printRed("更新失败")
  }

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
  } else if (userId === "" || token === "") {
    printYellow("当前为游客模式（未配置咪咕账号），咪咕频道最高画质为 720p")
  }
})
