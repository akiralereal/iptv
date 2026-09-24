/**
 * 抓取模块注册表。
 *
 * 每个平台的抓取逻辑是 extractors/<id>/index.js 里的一个模块，分发平台
 * （合并 / 分组 / EPG / 令牌 / 播放列表生成）不含任何平台知识。想下掉一个
 * 平台，删掉它的目录 + 从下面的 MODULES 里去掉一行即可，不牵连其它任何东西。
 *
 * 用静态 import 而不是扫目录：ESM 的动态 import 在 Docker 打包后路径行为
 * 不好预期，而模块数量是个位数，静态列表更可控也更好审。
 *
 * ---------------------------------------------------------------------------
 * 模块契约
 * ---------------------------------------------------------------------------
 *
 *   id                    string  唯一，且必须过 MODULE_ID_RE——它会进 sourceId
 *                                 (`xt:<id>`) 并最终写进 EXTINF 的属性值里
 *   name                  string  后台显示名
 *   description           string  后台一句话说明
 *   category              string  可选；后台源管理分组。'account' 表示带账号/
 *                                 授权能力，'live' 表示网络直播平台；不声明即
 *                                 'standard'（免账号的普通官方抓取模块）
 *   capabilities          object  { cache: 'disk'|'memory'|'none',
 *                                   resolve: boolean, epg: boolean }
 *   catalogVersion        number  可选；代码内置频道表变更时递增。缓存版本不一致会在
 *                                 启动生成播放列表前主动重抓，成功后才写入新版本
 *   defaultRefreshMinutes number  默认刷新间隔
 *   minRefreshMinutes     number  可选；用户可配置的最小刷新间隔
 *   maxRefreshMinutes     number  可选；用户可配置的最大刷新间隔
 *   refreshConfigurable   boolean 可选；false 表示刷新策略由模块自动管理，后台只读
 *   refreshDescription    string  可选；自动刷新策略的后台说明
 *   outputGroupName       string  可选；播放列表统一分组名，并合并模块原有的多个子组
 *   preserveGroupSuffixes array   可选；命中这些后缀的特殊分组不被 outputGroupName 覆盖
 *   channelHlsMode        string  可选；'proxy' 或 'relay'，在输出时覆盖频道缓存中的
 *                                 HLS 路由标记，适合整个平台统一要求代理的模块
 *   relayProxyCompatible boolean 可选；true 表示模块的 relay 频道可被 `?relay=2`
 *                                 安全升级为全代理；默认不升级，避免破坏拒绝服务端分片的 CDN
 *   streamType            string  可选；默认 hls，flv 由本机流式代理且不转码。
 *                                 FLV resolve 须返回 validateMediaUrl 校验官方调度跳转。
 *   capabilities.catchup boolean 可选；false 表示纯直播，不透传回看查询参数。
 *   configSchema          array   字段描述，后台据此渲染表单、后端据此校验
 *
 *   async fetch(config, ctx) → { groups: [{ name, dataList }], meta }
 *       必需。返回**分组树**而不是扁平频道数组——channelMerger 的合并算法是
 *       「按 group.name 找同名分组再 push dataList」，扁平数组等于把
 *       groupTitle→分组 的映射重新发明一遍。
 *       一个模块可以返回多个分组（咪咕将来的「体育赛事」就是同一模块的第二批
 *       分组，不是另一个源）。
 *
 *   async resolve(ref, ctx) → { url, desc, segmentTransform?, upstreamHeaders?,
 *                                upstreamUrlTransform?, manifestText?, manifestUrl? }
 *       可选，capabilities.resolve 为真时必需。用于「播放时才算地址」的模块：
 *       fetch() 里频道给 deferredRef，写盘时落成 ${replace}/<ref>，播放请求
 *       到达时才调 resolve。B 站不需要——它是直链。
 *       url 为空串表示不可用，desc 是给客户端看的原因（措辞属平台知识）。
 *       segmentTransform(buffer) 可选；仅供必须全代理、且分片需要平台特有处理的
 *       模块使用。函数可原地修改 Buffer，也可返回新的 Buffer。
 *       upstreamHeaders 可选；可以是固定请求头对象，也可以是接收目标 URL、返回请求头的
 *       同步函数。仅由本机清单/分片代理向官方 CDN 发送（防盗链平台）。函数形态用于
 *       按 Cookie 的 Domain / Path 限定发送范围，不能把一个 CDN 的凭据泄漏给另一个 CDN。
 *       注意 User-Agent：固定对象里声明的会被代理层统一改写成自己的 UA，声明了也不生效，
 *       原因见 utils/hlsProxy.js 里 UA 常量上方的说明；函数形态返回的 User-Agent 会原样发出，
 *       留给 CDN 只认特定播放器标识的平台（安徽视讯）。Referer / Origin 等其余头正常透传。
 *       upstreamUrlTransform(url) 可选；全代理登记清单内的子清单/分片地址前调用。
 *       用于每条 HLS 路径都要独立签名的平台，函数必须把输入限制在平台自己的主机。
 *       manifestText + manifestUrl 可选；浏览器能读取、普通 HTTP 客户端会被指纹校验
 *       拦截的平台可直接交回本轮 HLS 文本及其基准地址，由代理层改写后下发。
 *       ctx: { account: { userId, token }, config }  config 是该模块的生效配置
 *       **绝不能抛异常**——app.js 的请求 handler 没有顶层 try，一个未捕获的
 *       异常等于请求永远不 res.end()、客户端挂死到超时。
 *       解析结果的缓存由模块自己管（TTL 往往是签名有效期这种平台属性）。
 *
 *   claimsRef(ref) → boolean
 *       capabilities.resolve 为真时必需。判断某个 ref 是不是自己的，
 *       播放请求靠它路由到模块。
 *
 *   clearResolveCache()
 *       可选。画质等参数变更后由 utils/appUtils.js 的 clearUrlCache 统一触发。
 *
 *   claimsLocalPath(path) → boolean + async handleLocalRequest(ctx) → response
 *       可选成对实现。供需要把进程内媒体 Buffer 作为 HLS 输出的模块使用；普通
 *       上游 HLS 不要走这里。ctx: { path, method, headers, accessPrefix }，response:
 *       { status, headers, body }。app.js 仍统一负责访问鉴权与 HTTP 写出。
 *
 *   async shutdown()
 *       可选。关闭模块持有的浏览器/页面等资源；服务重启与 SIGTERM 时调用。
 *
 *   epg                   object  可选；模块自带的官方节目单，放在 extractors/<id>/epg.js：
 *       {
 *         days: number                         从今天起取几天（上海日期）
 *         channels() → [{ ref, name, key }]    哪些频道有节目单：频道 ref → 平台内部 key
 *         async programmes(key, day, { fetchImpl, timeoutMs }) → [{ title, start, stop }]
 *                                              day 为 YYYYMMDD，start / stop 为毫秒时间戳
 *       }
 *       由 utils/moduleEpg.js 在咪咕之后、外部 XMLTV 聚合之前调用，按 ref 找频道、不按名字
 *       模糊配对；直链频道没有 ref，按本模块内频道名精确对应 channels() 里的 name。提供者只用注入的 fetchImpl，不 import 项目内部模块——配合零依赖的
 *       utils/epgXmltv.js 与 scripts/build-epg.mjs，整套能拆出去单独产出节目单。
 *       programmes() 抛错只让该频道本轮没有节目单；官方当天没发的返回空数组。
 *       来源、清理约定与各模块状态的整套规则见仓库根目录 EPG.md，新增模块要在那里登记。
 *
 * 频道对象（dataList 的元素）字段：
 *   name       必需，显示名，也是去重键的一半
 *   url        直链模块必需
 *   deferredRef  延迟解析模块必需（与 url 二选一）
 *   logo       官方台标的完整图片地址；官方确实没有才留空。默认没有台标库兜底，
 *              留空就是没有台标。取法与要求见仓库根目录 LOGO.md
 *   groupTitle 装饰用；真正的分组来自所在 group.name
 *   opts       string[]，#EXTVLCOPT 的 key=value，交给 utils/channelOpts.js 渲染
 *   proxyHls   可选；清单和分片都经本机代理
 *   relayHls   可选；只由本机刷新/改写清单，分片仍由播放器直连 CDN
 *   catchup    可选 'none'，显式关闭该台继承订阅头的全局回看能力
 *
 * sourceId / source 由 extractorManager 统一盖章，模块不用自己填——
 * `xt:` 这个前缀格式是注册表层的事，模块不该知道。
 */
import bilibiliLive from './bilibili-live/index.js'
import asianLive from './asian-live/index.js'
import anhui from './anhui/index.js'
import beidou from './beidou/index.js'
import beijing from './beijing/index.js'
import chongqing from './chongqing/index.js'
import sichuan from './sichuan/index.js'
import cztv from './cztv/index.js'
import daai from './daai/index.js'
import dalian from './dalian/index.js'
import douyuLive from './douyu-live/index.js'
import fjtv from './fjtv/index.js'
import fengshows from './fengshows/index.js'
import gansu from './gansu/index.js'
import gdtv from './gdtv/index.js'
import goodtv from './goodtv/index.js'
import gztv from './gztv/index.js'
import gzstv from './gzstv/index.js'
import gxtv from './gxtv/index.js'
import hebtv from './hebtv/index.js'
import heilongjiang from './heilongjiang/index.js'
import hbtv from './hbtv/index.js'
import hkstv from './hkstv/index.js'
import hnntv from './hnntv/index.js'
import hntv from './hntv/index.js'
import huyaLive from './huya-live/index.js'
import ipanda from './ipanda/index.js'
import jlntv from './jlntv/index.js'
import jxntv from './jxntv/index.js'
import jstv from './jstv/index.js'
import iqilu from './iqilu/index.js'
import kankanews from './kankanews/index.js'
import livechina from './livechina/index.js'
import mgtv from './mgtv/index.js'
import migu from './migu/index.js'
import njtv from './njtv/index.js'
import nmtv from './nmtv/index.js'
import qtv from './qtv/index.js'
import shanxi from './shanxi/index.js'
import shaanxi from './shaanxi/index.js'
import songjiang from './songjiang/index.js'
import sztv from './sztv/index.js'
import yangshipin from './yangshipin/index.js'
import xinjiang from './xinjiang/index.js'
import xizang from './xizang/index.js'
import yunnan from './yunnan/index.js'

// 模块 id 会进 sourceId 并写进 EXTINF 属性值，不消毒就是注入面。
// 与 utils/configBackupAPI.js 的文件名白名单同款约束。
export const MODULE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
export const MODULE_CATEGORIES = new Set(['account', 'live', 'standard'])

const MODULES = [
  // 顺序即后台展示顺序，也是 channelMerger 的合并顺序（先到的分组优先保留）
  migu,
  yangshipin,
  fengshows,
  hkstv,
  daai,
  goodtv,
  asianLive,
  bilibiliLive,
  huyaLive,
  douyuLive,
  anhui,
  beidou,
  beijing,
  chongqing,
  sichuan,
  dalian,
  gansu,
  gdtv,
  gztv,
  gzstv,
  gxtv,
  fjtv,
  jlntv,
  jxntv,
  hebtv,
  hbtv,
  heilongjiang,
  hnntv,
  hntv,
  cztv,
  jstv,
  iqilu,
  sztv,
  njtv,
  nmtv,
  shanxi,
  shaanxi,
  xinjiang,
  xizang,
  yunnan,
  qtv,
  kankanews,
  songjiang,
  livechina,
  ipanda,
  mgtv,
]

/**
 * 校验一个模块定义。不合法直接抛——把「模块写错了」变成启动失败，
 * 而不是运行期的诡异行为。导出是为了能被测试直接打，不用在测试里另写一份。
 */
export function validateModule(module) {
  if (!module || !MODULE_ID_RE.test(module.id || '')) {
    throw new Error(`抓取模块 id 非法: ${JSON.stringify(module?.id)}`)
  }
  if (typeof module.fetch !== 'function') {
    throw new Error(`抓取模块 ${module.id} 没有实现 fetch()`)
  }
  if (module.category != null && !MODULE_CATEGORIES.has(module.category)) {
    throw new Error(`抓取模块 ${module.id} 的 category 非法: ${JSON.stringify(module.category)}`)
  }
  if (module.catalogVersion != null
    && (!Number.isInteger(module.catalogVersion) || module.catalogVersion < 1)) {
    throw new Error(`抓取模块 ${module.id} 的 catalogVersion 必须是正整数`)
  }
  if (module.capabilities?.resolve && typeof module.resolve !== 'function') {
    throw new Error(`抓取模块 ${module.id} 声明了 resolve 能力但没实现 resolve()`)
  }
  if (module.channelHlsMode != null && !['proxy', 'relay'].includes(module.channelHlsMode)) {
    throw new Error(`抓取模块 ${module.id} 的 channelHlsMode 非法: ${JSON.stringify(module.channelHlsMode)}`)
  }
  if (module.relayProxyCompatible != null && typeof module.relayProxyCompatible !== 'boolean') {
    throw new Error(`抓取模块 ${module.id} 的 relayProxyCompatible 必须是布尔值`)
  }
  const hasLocalClaim = typeof module.claimsLocalPath === 'function'
  const hasLocalHandler = typeof module.handleLocalRequest === 'function'
  if (hasLocalClaim !== hasLocalHandler) {
    throw new Error(`抓取模块 ${module.id} 的 claimsLocalPath/handleLocalRequest 必须成对实现`)
  }
  for (const field of module.configSchema || []) {
    // 单选 / 多选都必须给出可选值，否则校验层无从判断合法性
    if ((field.type === 'select' || field.type === 'multiselect') && !(field.options || []).length) {
      throw new Error(`抓取模块 ${module.id} 的字段 ${field.key} 声明了 ${field.type} 但没有 options`)
    }
  }
  if (module.epg != null && (typeof module.epg.channels !== 'function' || typeof module.epg.programmes !== 'function')) {
    throw new Error(`抓取模块 ${module.id} 的 epg 必须提供 channels() 与 programmes()`)
  }
  if (module.streamType != null && !['hls', 'flv'].includes(module.streamType)) {
    throw new Error(`抓取模块 ${module.id} 的 streamType 非法`)
  }
}

const registry = new Map()
for (const module of MODULES) {
  validateModule(module)
  if (registry.has(module.id)) {
    throw new Error(`抓取模块 id 重复: ${module.id}`)
  }
  registry.set(module.id, module)
}

/** 全部模块，顺序即后台展示顺序。 */
export function listModules() {
  return [...registry.values()]
}

/** 按 id 取模块；不存在返回 undefined（调用方自己决定是报错还是跳过）。 */
export function getModule(id) {
  return registry.get(String(id || ''))
}

/** 该 id 是否是本版本认识的模块。 */
export function hasModule(id) {
  return registry.has(String(id || ''))
}

/**
 * 找出该 ref 归哪个模块解析（播放请求到达时用）。
 *
 * 模块用 claimsRef(ref) 自己认领——判定属于平台知识，不该硬编码在注册表里。
 * 按 MODULES 顺序首个认领者胜出。
 *
 * ⚠️ 不能改成「只认 fetch() 产出过的 ref」：体育赛事在 utils/updateData.js 里
 * 直接写 ${replace}/<pID> 追加到播放列表，完全绕开 extractorManager；老订阅里
 * 缓存的历史地址同理。按索引路由会让这些地址全部 404。
 */
export function resolverFor(ref) {
  for (const module of registry.values()) {
    if (typeof module.claimsRef === 'function' && module.claimsRef(ref)) return module
  }
  return null
}

/** 找出哪个模块认领本机媒体路径；只做路由，不在注册表里放平台正则。 */
export function localRequestHandlerFor(path) {
  for (const module of registry.values()) {
    if (typeof module.claimsLocalPath === 'function' && module.claimsLocalPath(path)) return module
  }
  return null
}

/** 服务退出前清理所有模块持有的浏览器等长生命周期资源。 */
export async function shutdownModules() {
  await Promise.allSettled([...registry.values()]
    .filter(module => typeof module.shutdown === 'function')
    // Promise.resolve().then 同时兜住同步 throw；一个模块清理失败不能妨碍其余模块退出。
    .map(module => Promise.resolve().then(() => module.shutdown())))
}

/** 频道归属标记。改这里要同步 app.js 的 sourceId 正则白名单与源枚举。 */
export function sourceIdOf(moduleId) {
  return `xt:${moduleId}`
}
