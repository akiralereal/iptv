import { readFileSync, existsSync } from "node:fs"
import { writeJsonFileSync } from "./fileUtil.js"
import { dataPath } from "./paths.js"
import update from "./updateData.js"
import { clearUrlCache } from "./appUtils.js"
import { maskProxyUrl, normalizeProxyUrl, restoreMaskedProxy, settingProxyUrl, testOutboundProxy, TELEGRAM_TEST_TARGET } from "./outboundProxy.js"
import { proxyModules } from "../extractors/registry.js"
import { systemProxyUrl } from "./systemProxy.js"
import {
  reloadConfig, sanitizeSegment,
  port, host, rateType, pass,
  enableHDR, enableH265, programInfoUpdateInterval, refreshToken, adminPath,
  enableMigu, enableBuiltInSources, enableBuiltInSubscriptions, enableDisplayNameUnify, enableClientDispatch,
  enableExtractors
} from "../config.js"

const SYSTEM_CONFIG_PATH = dataPath('system-config.json')

/**
 * 获取系统配置
 */
// 各配置项对应的环境变量名（用于提示哪些项被环境变量控制）
const ENV_KEY_MAP = {
  port: 'mport',
  host: 'mhost',
  rateType: 'mrateType',
  pass: 'mpass',
  enableHDR: 'menableHDR',
  enableH265: 'menableH265',
  programInfoUpdateInterval: 'mupdateInterval',
  refreshToken: 'mrefreshToken',
  adminPath: 'madminPath',
  enableMigu: 'menableMigu',
  enableBuiltInSources: 'menableBuiltInSources',
  enableBuiltInSubscriptions: 'menableBuiltInSubscriptions',
  enableExtractors: 'menableExtractors',
  enableDisplayNameUnify: 'menableDisplayNameUnify',
  enableClientDispatch: 'menableClientDispatch'
}

export function getSystemConfigAPI() {
  try {
    // 返回「实际生效」的配置：config.js 已把 system-config.json + 环境变量 + 默认值 解析合并。
    // 这样无论各项是用环境变量还是配置文件设置的，管理页表单都能正确显示当前生效值
    //（修复换电脑/无浏览器自动填充时表单显示为空的问题）。

    // 标记哪些项被环境变量设置（前端据此提示：清空保存会回退到环境变量值，需改 compose）
    const envOverrides = {}
    for (const [field, envKey] of Object.entries(ENV_KEY_MAP)) {
      if (process.env[envKey] !== undefined && process.env[envKey] !== '') {
        envOverrides[field] = true
      }
    }

    // 刻意**不**回传 userId/token：账号已收进咪咕模块（后台「源管理」页，secret 掩码、
    // 只回「有没有值」），系统配置页的表单也不再渲染这两个字段。这里继续明文回显的话，
    // 未设访问密码的部署任何人 GET 一下就拿走等同登录态的 token，模块页的掩码被同一
    // 页面的另一个请求绕空。system-config.json 文件里的原值保留不动（供文件级回滚）。
    return {
      success: true,
      data: {
        port: parseInt(port) || 1905,
        host,
        rateType: parseInt(rateType) || 3,
        pass,
        enableHDR,
        enableH265,
        programInfoUpdateInterval,
        refreshToken,
        adminPath,
        enableMigu,
        enableBuiltInSources,
        enableBuiltInSubscriptions,
        enableExtractors,
        enableDisplayNameUnify,
        enableClientDispatch,
        // 网络代理：密码打码回显（没设访问密码时这个接口谁都能读）；保存时占位符换回原密码
        proxy: maskProxyUrl(settingProxyUrl()),
        // 留空时 所支持模块 是否会沿用 HTTPS_PROXY（只回有没有，不回地址）
        proxyEnvFallback: Boolean(systemProxyUrl()),
        // 走这个代理的模块（registry.js 的 outbound: 'proxy'）和各自要在代理规则里放行的域名后缀（proxyHosts），
        // 后台「网络代理」的说明按它列名单和域名；Telegram 推送固定另算，它的域名单独给
        proxyModules: proxyModules().map(module => ({ id: module.id, name: module.name, hosts: module.proxyHosts })),
        proxyTelegramHosts: TELEGRAM_TEST_TARGET.hosts
      },
      envOverrides
    }
  } catch (error) {
    return {
      success: false,
      message: error.message
    }
  }
}

/** 「测试」的目标：声明了 outbound: 'proxy' 的模块各出一个代表性接口（按注册顺序）并带上要放行的域名，Telegram 推送固定排最后。 */
export function proxyTestTargets() {
  return [
    ...proxyModules().map(module => ({ name: module.proxyProbe.name || module.name, url: module.proxyProbe.url, hosts: module.proxyHosts })),
    TELEGRAM_TEST_TARGET,
  ]
}

/**
 * 后台「网络代理」的测试按钮：用输入框里的值（可能是打码回显、还没保存）检查官方接口与直播清单。
 */
export async function testProxyAPI(raw) {
  try {
    let saved = ''
    if (existsSync(SYSTEM_CONFIG_PATH)) {
      try { saved = JSON.parse(readFileSync(SYSTEM_CONFIG_PATH, 'utf-8')).proxy || '' } catch { saved = '' }
    }
    return { success: true, ...(await testOutboundProxy(restoreMaskedProxy(raw, saved), { targets: proxyTestTargets() })) }
  } catch (error) {
    return { success: false, message: error.message }
  }
}

/**
 * 只改 system-config.json 里的一个布尔开关。
 *
 * 「源模块」页上的几个内容开关（启用咪咕源 / 内置单频道源 / 内置订阅源 /
 * 启用源模块）走这条路。刻意不复用 saveSystemConfigAPI：那个会顺带
 * `update(0, { regenerateOnly: true })`，而 updateTV 里 `hours % 720` 遇上 0 恒真，
 * 每次都会打一次咪咕 token 刷新（config.js 原注释：可能导致封号）。
 * 播放列表的重新生成由调用方用非 0 的 hours 触发。
 */
export function setSystemFlagAPI(key, value) {
  const ALLOWED = new Set(['enableMigu', 'enableBuiltInSources', 'enableBuiltInSubscriptions', 'enableExtractors'])
  if (!ALLOWED.has(key)) return { success: false, message: `不支持的开关: ${key}` }
  try {
    let existing = {}
    if (existsSync(SYSTEM_CONFIG_PATH)) {
      try { existing = JSON.parse(readFileSync(SYSTEM_CONFIG_PATH, 'utf-8')) } catch { existing = {} }
    }
    writeJsonFileSync(SYSTEM_CONFIG_PATH, { ...existing, [key]: value !== false })
    reloadConfig()
    return { success: true }
  } catch (error) {
    return { success: false, message: error.message }
  }
}

/**
 * 把一次保存提交的字段合进已有配置：白名单字段做类型校验，没提交的一律沿用已有值。
 * 纯函数，不写盘、不触发刷新，测试直接调它。代理地址格式不对会抛错（整次保存失败，不写半截）。
 */
export function mergeSystemConfig(existing, config) {
  const validated = { ...existing }
  // 端口、公网地址、访问密码、更新间隔同样「显式提交才写」：后台「网络代理」是单独的标签，
  // 只提交 proxy。无条件写的话，用户在那里点保存就会把端口重置成 1905、访问密码清空。
  if (config.port !== undefined) validated.port = parseInt(config.port) || 1905
  if (config.host !== undefined) validated.host = config.host || ""
  if (config.pass !== undefined) validated.pass = config.pass || ""
  if (config.programInfoUpdateInterval !== undefined) {
    validated.programInfoUpdateInterval = config.programInfoUpdateInterval || "8"
  }
  // 咪咕相关的五项改成「显式提交才写」，与下面那些内容开关一致。
  //
  // 原先是无条件写入：任何不带这些字段的 POST 都会把 rateType 钉死成 3、
  // HDR/H265 强开 true、账号清空。今天后台表单每次都全量提交所以没暴露，但
  // 一旦这几项从系统配置页挪走（它们是纯咪咕参数，本该归模块管），用户改个端口
  // 点保存就会把画质重置——而且是延迟发作，不在挪走那天。
  if (config.userId !== undefined) validated.userId = config.userId || ""
  if (config.token !== undefined) validated.token = config.token || ""
  if (config.rateType !== undefined) validated.rateType = parseInt(config.rateType) || 3
  if (config.enableHDR !== undefined) validated.enableHDR = config.enableHDR !== false
  if (config.enableH265 !== undefined) validated.enableH265 = config.enableH265 !== false
  if (config.refreshToken !== undefined) {
    validated.refreshToken = config.refreshToken !== false
  }
  if (config.adminPath !== undefined) {
    // 清洗为合法路径段（非法/保留字回退 admin），保证存储值与运行时一致
    validated.adminPath = sanitizeSegment(config.adminPath, 'admin')
  }
  // 内容开关：显式提交才写入（避免不带这些字段的旧调用把它们重置）
  if (config.enableMigu !== undefined) {
    validated.enableMigu = config.enableMigu !== false
  }
  if (config.enableBuiltInSources !== undefined) {
    validated.enableBuiltInSources = config.enableBuiltInSources !== false
  }
  if (config.enableBuiltInSubscriptions !== undefined) {
    validated.enableBuiltInSubscriptions = config.enableBuiltInSubscriptions !== false
  }
  if (config.enableExtractors !== undefined) {
    validated.enableExtractors = config.enableExtractors !== false
  }
  if (config.enableDisplayNameUnify !== undefined) {
    validated.enableDisplayNameUnify = config.enableDisplayNameUnify === true
  }
  // 客户端就近取流（issue #82）：默认关，显式提交才写入；保存后 clearUrlCache 会清掉旧解析结果，开关即时生效
  if (config.enableClientDispatch !== undefined) {
    validated.enableClientDispatch = config.enableClientDispatch === true
  }
  // 网络代理（只给声明了 outbound: 'proxy' 的模块和 Telegram 用）：显式提交才写；格式不对整次保存失败，不写半截
  if (config.proxy !== undefined) {
    validated.proxy = normalizeProxyUrl(restoreMaskedProxy(config.proxy, existing.proxy))
  }
  return validated
}

export function saveSystemConfigAPI(config) {
  try {
    // 读取已有配置，保留表单未提交的字段（如 refreshToken 等无 UI 的开关），
    // 避免每次保存把它们重置为默认值
    let existing = {}
    if (existsSync(SYSTEM_CONFIG_PATH)) {
      try {
        existing = JSON.parse(readFileSync(SYSTEM_CONFIG_PATH, 'utf-8'))
      } catch { existing = {} }
    }
    const validated = mergeSystemConfig(existing, config)

    // 原子写入，避免并发保存 / 写入中断损坏文件
    writeJsonFileSync(SYSTEM_CONFIG_PATH, validated)
    // 热更新配置：除端口和更新间隔外即时生效，无需重启
    reloadConfig()
    // 清空咪咕地址缓存：H265/HDR/清晰度等改动后，旧缓存（按 pid，3h）仍会发旧编码的流，
    // 导致开关「看起来没生效」。保存后清掉，下次播放即按新配置重新解析（issue #60）。
    clearUrlCache()
    // 内容开关（咪咕/内置源/内置订阅）影响频道列表，触发一次后台重新生成播放列表使其即时生效。
    // fire-and-forget：不阻塞保存响应；update() 内部 updateQueue 串行化，并发安全。
    update(0, { regenerateOnly: true }).catch(err => console.error('重新生成播放列表失败:', err))
    return {
      success: true,
      message: '配置保存成功（端口与更新间隔需重启生效；内容开关等已即时生效，播放列表正在后台刷新）',
      // 保存后**生效的**访问入口，由服务端算并回传。
      //
      // 前端算不出来：config.js 里 `pass = systemConfig.pass || process.env.mpass || ""`
      // 带环境变量兜底。用户把密码框清空时，生效密码可能是 mpass 的值 —— 而前端只拿得到
      // envOverrides.pass 这个布尔、拿不到值本身，按空串拼会拼出一个必然 403 的地址，
      // 把用户从一个本来正常的页面上踢出去。adminPath 同理（这边还多一层 sanitizeSegment）。
      //
      // pass / adminPath 是 config.js 的 live binding，上面 reloadConfig() 之后就是新值。
      // 拼法与 app.js 的 `/<pass>/<adminPath>` 判定同一口径。
      entry: '/' + [pass, adminPath].filter(Boolean).join('/'),
      apiPrefix: pass ? '/' + pass : ''
    }
  } catch (error) {
    return {
      success: false,
      message: error.message
    }
  }
}
