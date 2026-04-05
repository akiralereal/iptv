import http from "node:http"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import fetch from 'node-fetch'
import { host, pass, port, programInfoUpdateInterval, token, userId } from "./config.js";
import { getDateTimeStr } from "./utils/time.js";
import update from "./utils/updateData.js";
import { printBlue, printGreen, printMagenta, printRed, printYellow } from "./utils/colorOut.js";
import { delay } from "./utils/fetchList.js";
import { channel, interfaceStr } from "./utils/appUtils.js";
import { getChannelsAPI, getExternalSourcesAPI, saveExternalSourcesAPI, 
         addExternalSourceAPI, removeExternalSourceAPI, updateExternalSourceAPI, 
         setExternalSourceM3u8API, importSubscriptionAPI, getBuiltInSourcesAPI } from "./utils/adminAPI.js";
import { getSystemConfigAPI, saveSystemConfigAPI } from "./utils/systemConfigAPI.js";
import { readConfig, saveConfig, parseInterfaceTxt, validateGroupConfig, applyConfig } from "./utils/playlistConfig.js";
import { updateBuiltInSources, updateExternalSources, externalSourceManager } from "./utils/channelMerger.js";
import { GITHUB_RAW_MIRRORS } from "./utils/externalSources.js";

// 运行时长
var hours = 0
let loading = false

const server = http.createServer(async (req, res) => {

  while (loading) {
    await delay(50)
  }

  loading = true

  // 获取请求方法、URL 和请求头
  let { method, url, headers } = req;
  
  // 清理 URL，去除查询参数
  const urlPath = url.split('?')[0]
  
  // 处理 favicon.ico 请求
  if (urlPath === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    loading = false
    return
  }
  
  // 管理后台路由（支持 /admin 和 /密码/admin）
  if (urlPath === '/admin' || (pass !== "" && urlPath === `/${pass}/admin`)) {
    if (pass !== "" && urlPath !== `/${pass}/admin`) {
      // 需要密码但未提供或密码错误
      printRed(`管理后台访问需要密码，已拒绝未授权访问`)
      res.writeHead(403, { 'Content-Type': 'text/html;charset=UTF-8' });
      res.end(`<html><body><p>访问需要密码，请使用正确的密码路径访问管理后台。</p><p>格式: <code>/你的密码/admin</code></p></body></html>`);
      loading = false
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
    loading = false
    return
  }
  
  // 播放器页面路由（支持 /player 和 /密码/player）
  if (urlPath === '/player' || (pass !== "" && urlPath === `/${pass}/player`)) {
    if (pass !== "" && urlPath !== `/${pass}/player`) {
      // 需要密码但未提供或密码错误
      res.writeHead(403, { 'Content-Type': 'text/html;charset=UTF-8' });
      res.end(`<html><body><p>访问需要密码，请使用正确的密码路径访问。</p><p>格式: <code>/你的密码/player</code></p></body></html>`);
      loading = false
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
    loading = false
    return
  }
  
  // API 路由
  if (urlPath.startsWith('/api/')) {
    // 需要密码时检查
    if (pass !== "" && !req.headers.referer?.includes(`/${pass}/admin`)) {
      res.writeHead(403, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(JSON.stringify({ success: false, message: '未授权访问' }));
      loading = false
      return
    }
    
    if (urlPath === '/api/channels' && method === 'GET') {
      printBlue("API: 获取频道列表")
      const result = await getChannelsAPI()
      printGreen(`API: 返回 ${result.success ? result.data.length : 0} 个分组`)
      res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(JSON.stringify(result.success ? result.data : []));
      loading = false
      return
    }
    
    if (urlPath === '/api/system-config' && method === 'GET') {
      printBlue("API: 获取系统配置")
      const result = getSystemConfigAPI()
      res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(JSON.stringify(result.success ? result.data : {}));
      loading = false
      return
    }
    
    if (urlPath === '/api/system-config' && method === 'POST') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try {
          const config = JSON.parse(body)
          const result = saveSystemConfigAPI(config)
          res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json;charset=UTF-8' });
          res.end(JSON.stringify(result));
          printGreen(result.success ? "系统配置已保存" : "保存失败")
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json;charset=UTF-8' });
          res.end(JSON.stringify({ success: false, message: error.message }));
        }
        loading = false
      })
      return
    }
    
    // 重启服务API
    if (urlPath === '/api/restart' && method === 'POST') {
      printMagenta("API: 收到重启请求")
      res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(JSON.stringify({ success: true, message: '服务将在 2 秒后重启...' }));
      loading = false
      
      // 2秒后执行重启
      setTimeout(() => {
        printMagenta("正在重启服务...")
        process.exit(0)
      }, 2000)
      return
    }
    
    // 外部源管理API
    if (urlPath === '/api/external-sources' && method === 'GET') {
      printBlue("API: 获取外部源配置")
      const result = getExternalSourcesAPI()
      res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(JSON.stringify(result));
      loading = false
      return
    }
    
    // 内置源管理API
    if (urlPath === '/api/built-in-sources' && method === 'GET') {
      printBlue("API: 获取内置源配置")
      const result = getBuiltInSourcesAPI()
      res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(JSON.stringify(result));
      loading = false
      return
    }
    
    if (urlPath === '/api/external-sources' && method === 'POST') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', async () => {
        try {
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
        loading = false
      })
      return
    }
    
    // 我的播放列表API
    if (urlPath === '/api/my-playlist' && method === 'GET') {
      printBlue("API: 获取我的播放列表")
      try {
        const groups = parseInterfaceTxt()
        const config = readConfig()
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
      loading = false
      return
    }
    
    if (urlPath === '/api/my-playlist-config' && method === 'GET') {
      printBlue("API: 获取播放列表配置")
      try {
        const config = readConfig()
        res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify({ success: true, data: config }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify({ success: false, message: error.message }));
      }
      loading = false
      return
    }
    
    if (urlPath === '/api/check-update' && method === 'GET') {
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
            printRed(`镜像 ${targetUrl} 失败: ${e.message}`)
          }
        }
        if (!remotePkg) throw lastError || new Error('所有镜像均不可用')

        const latestVersion = remotePkg.version
        const hasUpdate = latestVersion !== currentVersion

        res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' })
        res.end(JSON.stringify({ success: true, currentVersion, latestVersion, hasUpdate }))
        printGreen(`当前版本: ${currentVersion}, 最新版本: ${latestVersion}${hasUpdate ? ' (有更新)' : ' (已是最新)'}`)
      } catch (error) {
        res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' })
        res.end(JSON.stringify({ success: false, message: error.message }))
        printRed(`检查更新失败: ${error.message}`)
      }
      loading = false
      return
    }

    if (urlPath === '/api/my-playlist-config' && method === 'POST') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try {
          const config = JSON.parse(body)
          const currentConfig = readConfig()
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
              loading = false
              return
            }
          }

          const result = saveConfig(config)
          res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json;charset=UTF-8' });
          res.end(JSON.stringify(result));
          printGreen("播放列表配置已保存")
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json;charset=UTF-8' });
          res.end(JSON.stringify({ success: false, message: error.message }));
        }
        loading = false
      })
      return
    }
  }
  
  // 身份认证
  if (pass != "") {
    const urlSplit = url.split("/")
    if (urlSplit[1] != pass) {
      printRed(`身份认证失败`)
      res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(`身份认证失败`); // 发送文件内容
      loading = false
      return
    } else {
      printGreen("身份认证成功")
      // 有密码且传入用户信息
      if (urlSplit.length > 3) {
        url = url.substring(pass.length + 1)
      } else {
        url = urlSplit.length == 2 ? "/" : "/" + urlSplit[urlSplit.length - 1]
      }
    }
  }

  let urlToken = ""
  let urlUserId = ""
  // 匹配是否存在用户信息
  if (/\/{1}[^\/\s]{1,}\/{1}[^\/\s]{1,}/.test(url)) {
    const urlSplit = url.split("/")
    if (urlSplit.length >= 3) {
      urlUserId = urlSplit[1]
      urlToken = urlSplit[2]
      url = urlSplit.length == 3 ? "/" : "/" + urlSplit[urlSplit.length - 1]
    }
  } else {
    urlUserId = userId
    urlToken = token
  }

  // printGreen("")
  // printMagenta("请求地址：" + url)

  // 允许HEAD、OPTIONS预检请求
  if (method === "HEAD" || method === "OPTIONS") {
    res.writeHead(200, { 
      'Content-Type': 'application/json;charset=UTF-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    });
    res.end();
    loading = false
    return
  }

  // 其他非GET/POST请求才报错
  if (method != "GET" && method != "POST") {
    res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
    res.end(JSON.stringify({
      data: '请使用GET或POST请求',
    }));
    printRed(`使用非GET/POST请求:${method}`)

    loading = false
    return
  }

  const interfaceList = "/,/interface.txt,/m3u,/txt,/playback.xml"

  // 接口
  if (interfaceList.indexOf(url) !== -1) {
    const interfaceObj = interfaceStr(url, headers, urlUserId, urlToken)
    if (interfaceObj.content == null) {
      interfaceObj.content = "获取失败"
    }
    // 设置响应头
    res.setHeader('Content-Type', interfaceObj.contentType);
    if (url == "/m3u") {
      res.setHeader('content-disposition', "inline; filename=\"interface.m3u\"");
    }
    res.statusCode = 200;
    res.end(interfaceObj.content); // 发送文件内容
    loading = false
    return
  }

  // 频道
  const result = await channel(url, urlUserId, urlToken)

  // 结果异常
  if (result.code != 302) {

    printRed(result.desc)
    res.writeHead(result.code, {
      'Content-Type': 'application/json;charset=UTF-8',
    });
    res.end(result.desc)
    loading = false
    return
  }

  res.writeHead(result.code, {
    'Content-Type': 'application/json;charset=UTF-8',
    location: result.playURL
  });

  res.end()

  loading = false
})

server.listen(port, async () => {
  const updateInterval = parseInt(programInfoUpdateInterval)
  
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

  // 定时任务2: 每小时检查外部源和内置源是否需要刷新
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
  }, 60 * 60 * 1000); // 每小时检查一次

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
      )
      if (failedSubs.length > 0) {
        printYellow(`检测到 ${failedSubs.length} 个订阅源未成功获取，正在重试...`)
        for (let i = 0; i < sources.length; i++) {
          const s = sources[i]
          if (s.enabled && s.mode === 'subscription' && s.subscriptionUrl && !Array.isArray(s.parsedChannels)) {
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
  printGreen(`管理平台地址: http://localhost:${port}${pass == "" ? "" : "/" + pass}/admin`)
  printGreen("开源地址: https://github.com/akiralereal/iptv ")
  if (host != "") {
    printGreen(`自定义地址: ${host}${pass == "" ? "" : "/" + pass}`)
  }
  if (userId === "" || token === "") {
    printYellow("当前为游客模式（未配置咪咕账号），咪咕频道最高画质为 720p")
  }
})
