import http from "node:http"
import { readFileSync } from "node:fs"
import { host, pass, port, programInfoUpdateInterval, token, userId } from "./config.js";
import { getDateTimeStr } from "./utils/time.js";
import update from "./utils/updateData.js";
import { printBlue, printGreen, printMagenta, printRed } from "./utils/colorOut.js";
import { delay } from "./utils/fetchList.js";
import { channel, interfaceStr } from "./utils/appUtils.js";
import { getChannelsAPI, getConfigAPI, saveConfigAPI, 
         getExternalSourcesAPI, saveExternalSourcesAPI, addExternalSourceAPI,
         removeExternalSourceAPI, updateExternalSourceAPI, setExternalSourceM3u8API,
         resetGroupsToDefaultAPI } from "./utils/adminAPI.js";
import { getSystemConfigAPI, saveSystemConfigAPI } from "./utils/systemConfigAPI.js";

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
  
  // 管理后台路由（需要密码访问）
  if (urlPath === '/admin' || urlPath.startsWith('/admin/')) {
    if (pass !== "" && !urlPath.includes(`/${pass}/admin`)) {
      // 需要密码但未提供
      const redirectUrl = `/${pass}/admin`
      printRed(`管理后台访问需要密码，请访问: ${redirectUrl}`)
      res.writeHead(200, { 'Content-Type': 'text/html;charset=UTF-8' });
      res.end(`<html><body>请访问: <a href="${redirectUrl}">${redirectUrl}</a></body></html>`);
      loading = false
      return
    }
    
    // 返回管理页面
    if (urlPath.endsWith('/admin') || urlPath === '/admin/') {
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
      printGreen(`API: 返回 ${result.success ? result.data.length : 0} 个分类`)
      res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(JSON.stringify(result.success ? result.data : []));
      loading = false
      return
    }
    
    if (urlPath === '/api/config' && method === 'GET') {
      printBlue("API: 获取配置")
      const result = getConfigAPI()
      res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(JSON.stringify(result.success ? result.data : {}));
      loading = false
      return
    }
    
    if (urlPath === '/api/config' && method === 'POST') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try {
          const config = JSON.parse(body)
          const result = saveConfigAPI(config)
          res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json;charset=UTF-8' });
          res.end(JSON.stringify(result));
          printGreen("配置已保存")
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json;charset=UTF-8' });
          res.end(JSON.stringify({ success: false, message: error.message }));
        }
        loading = false
      })
      return
    }
    
    if (urlPath === '/api/reset-groups' && method === 'POST') {
      printBlue("API: 重置分组为默认分组")
      const result = await resetGroupsToDefaultAPI()
      res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(JSON.stringify(result));
      printGreen(result.success ? "分组已重置为默认分组" : "重置失败")
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
    
    // 外部源管理API
    if (urlPath === '/api/external-sources' && method === 'GET') {
      printBlue("API: 获取外部源配置")
      const result = getExternalSourcesAPI()
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
  printMagenta("请求地址：" + url)

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
  // 更新
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

  try {
    // 初始化数据
    await update(hours)
  } catch (error) {
    console.log(error)
    printRed("更新失败")
  }

  printGreen(`本地地址: http://localhost:${port}${pass == "" ? "" : "/" + pass}`)
  printGreen("开源地址: https://github.com/akiralereal/iptv 欢迎使用")
  if (host != "") {
    printGreen(`自定义地址: ${host}${pass == "" ? "" : "/" + pass}`)
  }
})
