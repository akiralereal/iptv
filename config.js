import { readFileSync, existsSync } from "node:fs"
import { dataPath } from "./utils/paths.js"

const SYSTEM_CONFIG_PATH = dataPath('system-config.json')

// 加载系统配置文件
function loadSystemConfig() {
  if (existsSync(SYSTEM_CONFIG_PATH)) {
    try {
      const content = readFileSync(SYSTEM_CONFIG_PATH, 'utf-8')
      return JSON.parse(content)
    } catch (error) {
      console.error('加载系统配置失败:', error.message)
      return {}
    }
  }
  return {}
}

// 解析布尔值：支持 system-config.json 的真布尔值，以及环境变量字符串 "false"/"0"/"off"/"no"
// （修复历史问题：旧写法 `env || true` 导致环境变量永远无法关闭开关）
function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback
  if (typeof value === 'boolean') return value
  const str = String(value).trim().toLowerCase()
  return str !== 'false' && str !== '0' && str !== 'off' && str !== 'no'
}

// 清洗 URL 路径段（用于自定义管理页路径）：去首尾斜杠，禁止内部斜杠/空白，
// 避开与内置路由冲突的保留字，非法时回退默认值
const RESERVED_SEGMENTS = ['api', 'player', 'favicon.ico']
function sanitizeSegment(value, fallback) {
  if (!value) return fallback
  const s = String(value).trim().replace(/^\/+|\/+$/g, '')
  if (!s || /[\/\s]/.test(s) || RESERVED_SEGMENTS.includes(s.toLowerCase())) return fallback
  return s
}

// 导出值使用 let，配合 reloadConfig() 实现热更新：
// ESM 命名导出是实时绑定，重新赋值后所有 import 方都会读到新值。
// 注意：port、programInfoUpdateInterval 在 server.listen / setInterval 时已被读取，
// 热更新不会改变已启动的监听端口与定时器周期，这两项仍需重启生效。
let userId, token, port, host, rateType, debug, pass, enableHDR, enableH265, programInfoUpdateInterval, refreshToken, adminPath, externalLogoBase, enableTvgNormalize, enableEpgAggregation, enableUserTokens, enableDisplayNameUnify, enableClientDispatch
// 内容开关：咪咕核心 / 内置单频道源 / 内置订阅源。默认全开（老用户零感知）
let enableMigu, enableBuiltInSources, enableBuiltInSubscriptions, enableExtractors

function applyConfig(systemConfig) {
  // 用户id
  userId = systemConfig.userId || process.env.muserId || ""
  // 用户token 可以使用网页登录获取
  token = systemConfig.token || process.env.mtoken || ""
  // 本地运行端口号：做区间校验兜底——配置文件可能被手改/由备份导入写入非法值，
  // 非法端口会让 server.listen 启动即崩（999999）或静默绑到 unix socket（"abc"），必须回退默认
  const rawPort = parseInt(systemConfig.port ?? process.env.mport)
  port = (Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535) ? rawPort : 1905
  // 公网/自定义访问地址
  host = systemConfig.host || process.env.mhost || ""
  // 画质
  // 4蓝光(1080p，需要登录且账号有VIP)
  // 3高清(720p)
  // 2标清(480p)
  rateType = systemConfig.rateType || process.env.mrateType || 3
  debug = process.env.mdebug || false
  // 访问密码 大小写字母和数字 添加后访问格式 http://ip:port/mpass/...
  pass = systemConfig.pass || process.env.mpass || ""
  // 是否开启hdr
  enableHDR = systemConfig.enableHDR !== undefined ? systemConfig.enableHDR : parseBool(process.env.menableHDR, true)
  // 是否开启h265(原画画质)，开启可能存在兼容性问题，比如浏览器播放没有画面
  enableH265 = systemConfig.enableH265 !== undefined ? systemConfig.enableH265 : parseBool(process.env.menableH265, true)
  // 节目信息更新间隔 单位小时 不建议设置太短
  programInfoUpdateInterval = systemConfig.programInfoUpdateInterval || process.env.mupdateInterval || "8"
  // 是否每月刷新token（可能是导致封号的原因，可关闭）
  refreshToken = systemConfig.refreshToken !== undefined ? systemConfig.refreshToken : parseBool(process.env.mrefreshToken, true)
  // 管理页面自定义路径（默认 admin）：改名后用 /<adminPath> 访问后台，裸 /admin 失效
  adminPath = sanitizeSegment(systemConfig.adminPath || process.env.madminPath, 'admin')
  // 外部/精选频道无台标时，按中文名兜底的台标 CDN 基址（默认 fanmingming 台标库，留空字符串则关闭）。
  // 仅写进 m3u 由播放器侧拉取静态图，服务器不发请求；故默认开。空值用 !== undefined 判定以允许显式关闭。
  // 默认走 jsDelivr 的 gcore 镜像而不是原站 live.fanmingming.com / .cn：两个原站域名在大陆都被 DNS 污染，
  // 2026-09 大陆探针 30/30 连不上（issue #25 / #114 台标全裂），镜像与原站文件一一对应、大陆 10/10 可达。
  // cdn.jsdelivr.net / fastly.jsdelivr.net 的 Fastly 节点会把这个超大仓库 301 到 raw.githubusercontent.com（大陆同样不可达），故只用 gcore。
  externalLogoBase = systemConfig.externalLogoBase !== undefined
    ? systemConfig.externalLogoBase
    : (process.env.mexternalLogoBase !== undefined ? process.env.mexternalLogoBase : "https://gcore.jsdelivr.net/gh/fanmingming/live@main/tv/")
  // EPG 名称规整（issue #39）：把异构源频道的 tvg-id/tvg-name 归一到规范名（EPG 频道名），默认开。
  enableTvgNormalize = systemConfig.enableTvgNormalize !== undefined ? systemConfig.enableTvgNormalize : parseBool(process.env.menableTvgNormalize, true)
  // EPG 聚合（issue #38）：把外部 XMLTV 源的节目单归一后合并进 playback.xml，给咪咕没覆盖的频道补节目单。默认开，
  // 源列表见 data/epg-sources.json（内置默认源、开箱即用）。此处为部署级总开关（环境变量可关）。
  enableEpgAggregation = systemConfig.enableEpgAggregation !== undefined ? systemConfig.enableEpgAggregation : parseBool(process.env.menableEpgAggregation, true)
  // 用户访问令牌（一人一源）：开启后台「用户管理」生成的 /u/<token>/ 链接才生效。默认开，但无任何用户时完全不激活（对老部署零影响）。
  enableUserTokens = systemConfig.enableUserTokens !== undefined ? systemConfig.enableUserTokens : parseBool(process.env.menableUserTokens, true)
  // 统一频道显示名（issue #56）：按归一规则把异构源的频道显示名也统一到规范名（如 CCTV1/CCTV-1 → CCTV1综合）。
  // 默认关（opt-in，避免改动老用户的显示名）；手动重命名优先级更高。
  enableDisplayNameUnify = systemConfig.enableDisplayNameUnify !== undefined ? systemConfig.enableDisplayNameUnify : parseBool(process.env.menableDisplayNameUnify, false)
  // 咪咕客户端就近取流（issue #82）：开启后播放时不在服务端解析 CDN 调度地址，直接把调度地址 302 给播放器，
  // 由观看设备的网络就近分配节点。解决服务器与观看设备运营商不同（如服务器移动宽带、电视联通网）时的跨网卡顿。
  // 默认关（opt-in）：多数部署服务器与设备同网，服务端解析可少一跳 302，且个别老盒子对多级跳转兼容性存疑。
  enableClientDispatch = systemConfig.enableClientDispatch !== undefined ? systemConfig.enableClientDispatch : parseBool(process.env.menableClientDispatch, false)

  // 空白模式总开关：开启后下面三项内容开关「默认」翻转为关（一行得到空白 docker）。
  // 优先级：细粒度开关显式值 > 总开关推出的默认 > 全开。所以可 mblank=true + menableMigu=true 单独留咪咕。
  const blank = parseBool(systemConfig.blank ?? process.env.mblank, false)
  const defOn = !blank
  // 咪咕核心（CCTV/卫视抓取 + 体育赛事 + EPG + token刷新）
  enableMigu = systemConfig.enableMigu !== undefined ? systemConfig.enableMigu : parseBool(process.env.menableMigu, defOn)
  // 内置单频道源（built-in-sources.json：纬来体育/RedBull/4K卫视等）
  enableBuiltInSources = systemConfig.enableBuiltInSources !== undefined ? systemConfig.enableBuiltInSources : parseBool(process.env.menableBuiltInSources, defOn)
  // 内置订阅源（精选频道）
  enableBuiltInSubscriptions = systemConfig.enableBuiltInSubscriptions !== undefined ? systemConfig.enableBuiltInSubscriptions : parseBool(process.env.menableBuiltInSubscriptions, defOn)
  // ⚠️ 已退休的「抓取模块总开关」。现在**只**被 extractorManager 的一次性迁移读一次
  //（把它的关闭态固化进各模块自己的开关，见 #migrateMasterSwitch），此后不再有任何
  // 运行时效果 —— 每个模块的开关就是唯一真相。
  //
  // 为什么撤：它管不到走 enabledGetter 的咪咕，又会覆盖模块卡片上已经明确保存的
  // 选择。界面上看似管全部、实际语义不一致，只会制造「我明明开了却不生效」。
  //
  // 保留读取而不是删掉：老部署的 system-config.json / menableExtractors 里可能有值，
  // 迁移那一次要用它判断用户此前的意图。mblank 仍然管 README 里写的那三项内容开关。
  enableExtractors = systemConfig.enableExtractors !== undefined ? systemConfig.enableExtractors : parseBool(process.env.menableExtractors, defOn)
}

applyConfig(loadSystemConfig())

// 重新加载系统配置（保存系统配置后调用，避免必须重启进程）
function reloadConfig() {
  applyConfig(loadSystemConfig())
  return { userId, token, port, host, rateType, pass, enableHDR, enableH265, programInfoUpdateInterval, refreshToken, adminPath, externalLogoBase, enableTvgNormalize, enableEpgAggregation, enableUserTokens, enableDisplayNameUnify, enableClientDispatch, enableMigu, enableBuiltInSources, enableBuiltInSubscriptions, enableExtractors }
}

export { userId, token, port, host, rateType, debug, pass, enableHDR, programInfoUpdateInterval, enableH265, refreshToken, adminPath, externalLogoBase, enableTvgNormalize, enableEpgAggregation, enableUserTokens, enableDisplayNameUnify, enableClientDispatch, enableMigu, enableBuiltInSources, enableBuiltInSubscriptions, enableExtractors, reloadConfig, sanitizeSegment }
