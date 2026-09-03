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
 *   capabilities          object  { cache: 'disk'|'memory'|'none',
 *                                   resolve: boolean, epg: boolean }
 *   defaultRefreshMinutes number  默认刷新间隔
 *   minRefreshMinutes     number  可选；用户可配置的最小刷新间隔
 *   maxRefreshMinutes     number  可选；用户可配置的最大刷新间隔
 *   refreshConfigurable   boolean 可选；false 表示刷新策略由模块自动管理，后台只读
 *   refreshDescription    string  可选；自动刷新策略的后台说明
 *   outputGroupName       string  可选；播放列表统一分组名，并合并模块原有的多个子组
 *   preserveGroupSuffixes array   可选；命中这些后缀的特殊分组不被 outputGroupName 覆盖
 *   channelHlsMode        string  可选；'proxy' 或 'relay'，在输出时覆盖频道缓存中的
 *                                 HLS 路由标记，适合整个平台统一要求代理的模块
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
 *       upstreamHeaders 可选；仅由本机清单/分片代理向官方 CDN 发送（防盗链平台）。
 *       注意 User-Agent 是例外：代理层统一改写成自己的 UA，这里声明了也不会生效，
 *       原因见 utils/hlsProxy.js 里 UA 常量上方的说明。Referer / Origin 等其余头正常透传。
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
 *   async epg(channels, ctx) → XMLTV 片段
 *       可选，capabilities.epg 为真时必需。槽位先留着，本轮无人实现。
 *
 * 频道对象（dataList 的元素）字段：
 *   name       必需，显示名，也是去重键的一半
 *   url        直链模块必需
 *   deferredRef  延迟解析模块必需（与 url 二选一）
 *   logo       台标，空串即可
 *   groupTitle 装饰用；真正的分组来自所在 group.name
 *   opts       string[]，#EXTVLCOPT 的 key=value，交给 utils/channelOpts.js 渲染
 *   proxyHls   可选；清单和分片都经本机代理
 *   relayHls   可选；只由本机刷新/改写清单，分片仍由播放器直连 CDN
 *   catchup    可选 { mode, source }，槽位先留着（咪咕的回看将来用）
 *
 * sourceId / source 由 extractorManager 统一盖章，模块不用自己填——
 * `xt:` 这个前缀格式是注册表层的事，模块不该知道。
 */
import bilibiliLive from './bilibili-live/index.js'
import beidou from './beidou/index.js'
import cztv from './cztv/index.js'
import dalian from './dalian/index.js'
import douyuLive from './douyu-live/index.js'
import fjtv from './fjtv/index.js'
import gdtv from './gdtv/index.js'
import gztv from './gztv/index.js'
import gxtv from './gxtv/index.js'
import hebtv from './hebtv/index.js'
import hbtv from './hbtv/index.js'
import hnntv from './hnntv/index.js'
import hntv from './hntv/index.js'
import huyaLive from './huya-live/index.js'
import jstv from './jstv/index.js'
import iqilu from './iqilu/index.js'
import kankanews from './kankanews/index.js'
import livechina from './livechina/index.js'
import mgtv from './mgtv/index.js'
import migu from './migu/index.js'
import njtv from './njtv/index.js'
import qtv from './qtv/index.js'
import songjiang from './songjiang/index.js'
import sztv from './sztv/index.js'
import yangshipin from './yangshipin/index.js'

// 模块 id 会进 sourceId 并写进 EXTINF 属性值，不消毒就是注入面。
// 与 utils/configBackupAPI.js 的文件名白名单同款约束。
export const MODULE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

const MODULES = [
  // 顺序即后台展示顺序，也是 channelMerger 的合并顺序（先到的分组优先保留）
  migu,
  yangshipin,
  bilibiliLive,
  huyaLive,
  douyuLive,
  beidou,
  dalian,
  gdtv,
  gztv,
  gxtv,
  fjtv,
  hebtv,
  hbtv,
  hnntv,
  hntv,
  cztv,
  jstv,
  iqilu,
  sztv,
  njtv,
  qtv,
  kankanews,
  songjiang,
  livechina,
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
  if (module.capabilities?.resolve && typeof module.resolve !== 'function') {
    throw new Error(`抓取模块 ${module.id} 声明了 resolve 能力但没实现 resolve()`)
  }
  if (module.channelHlsMode != null && !['proxy', 'relay'].includes(module.channelHlsMode)) {
    throw new Error(`抓取模块 ${module.id} 的 channelHlsMode 非法: ${JSON.stringify(module.channelHlsMode)}`)
  }
  for (const field of module.configSchema || []) {
    // 单选 / 多选都必须给出可选值，否则校验层无从判断合法性
    if ((field.type === 'select' || field.type === 'multiselect') && !(field.options || []).length) {
      throw new Error(`抓取模块 ${module.id} 的字段 ${field.key} 声明了 ${field.type} 但没有 options`)
    }
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

/** 频道归属标记。改这里要同步 app.js 的 sourceId 正则白名单与源枚举。 */
export function sourceIdOf(moduleId) {
  return `xt:${moduleId}`
}
