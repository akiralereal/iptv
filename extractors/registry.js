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
 *                                 授权能力，'live' 表示网络直播平台，'overseas' 表示
 *                                 面向大陆以外、默认关闭的海外模块（海外频道、澳门、
 *                                 YouTube 直播）；不声明即
 *                                 'standard'（免账号的普通官方抓取模块）
 *   defaultEnabled        boolean 可选；用户没在卡片上点过开关时开不开，不声明即开。
 *                                 只有面向海外、在大陆连不上或常卡顿的模块写 false
 *                                 （海外频道、澳门），由用户自己打开；频道量大、只有本地少数人
 *                                 看的市县模块也可以（山东市县，两百来台按地市分组；市县台各省模块）；
 *                                 福建百视通以重复频道备用为主，按用户要求默认关；WebSports 来自第三方赛事网站，不进默认内容；各模块在海外的
 *                                 实测见仓库根目录 OVERSEAS.md。v4.29.0 及以前已有的模块
 *                                 在存量配置里多已落成 enabled:true，改它们的默认值要另写迁移
 *   enableNotice          string  可选；用户在后台打开这个模块前要看的一句话。卡片开关先弹确认，
 *                                 点「取消」不打开；「批量开关」里勾上它，摘要下面列出这句话。
 *                                 给能不能播看部署网络的模块用（辽宁）；默认开的模块，用户关掉后再打开才看得到
 *   configSavedNotice     string  可选；后台「保存配置」成功后的提示。不写时提示「点立即刷新才生效」；
 *                                 配置只影响播放、不用重抓的模块（YouTube 的画质上限）写自己的说法
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
 *   region                string  可选；后台源管理「免账号」里的面板名。不声明时 outputGroupName
 *                                 是省级地区（REGION_NAMES）就用它；分组名不是地区（上海景观）、
 *                                 按地市拆组（山东市县）的显式声明。不是地区的专题面板（国际、
 *                                 直播中国、iPanda）也用它，排在各省面板前面
 *   county                boolean 可选；true 表示市县台模块（山东市县、各省「市县台·X」）。卡片照旧在本省
 *                                 面板里，后台「批量开关」把它们单独收成「市县台」一节，一次全开全关。
 *                                 只是归节，不是另一层开关。声明了就必须 defaultEnabled: false、region 是省级
 *                                 地区、不带 category；反过来，默认关、归省面板的免账号模块也必须声明
 *                                 （scripts/test-extractors.mjs 两头都查）
 *   preserveGroupSuffixes array   可选；命中这些后缀的特殊分组不被 outputGroupName 覆盖
 *   splitFrom             object  可选；{ id, groups }。这张卡是从模块 id 里拆出来的，原来由它输出 groups
 *                                 这几个分组（2026-11-08 景观从吉林、河北、南京、上海、北京拆出）。管理器据此
 *                                 做一次性搬家：原模块缓存里的这几组挪过来；原模块被关掉的，新卡也关；
 *                                 配置档按源停用了原模块的，也停用新卡（见 extractorManager #migrateSplitModules）。
 *                                 分组名和播放引用都不改，用户对这些频道做过的隐藏、改名、排序照旧生效
 *   channelHlsMode        string  可选；'proxy' 或 'relay'，在输出时覆盖频道缓存中的
 *                                 HLS 路由标记，适合整个平台统一要求代理的模块
 *   channelHlsModeForConfig(config) 可选；按当前生效配置返回 'proxy'/'relay'，覆盖上面的固定模式
 *   relayProxyCompatible boolean 可选；true 表示模块的 relay 频道可被 `?relay=2`
 *                                 安全升级为全代理；默认不升级，避免破坏拒绝服务端分片的 CDN
 *   resolveBurstGuard     boolean 可选；true 表示播放请求经 utils/clientScanGuard.js 的客户端
 *                                 批量探测防护：同一客户端短时间连续请求多个不同频道（播放器
 *                                 刷新预览图 / 检测可用性 / 失败自动换台）时本地拒绝、不打上游。
 *                                 给「服务端代所有观众向官方取票」且官方按 IP 限频的模块用；
 *                                 直链或分片播放器直连的模块不需要
 *   outbound              string  可选；'proxy' 表示模块的全部出站——取址、节目单、清单、分片、外部工具——
 *                                 都走后台「设置 → 网络代理」（utils/outboundProxy.js 的 outboundFetch，
 *                                 没配时沿用环境变量代理或直连）。后台「网络代理」的适用名单、「测试」
 *                                 按钮的目标、模块卡片上的「走代理」角标都从这个声明派生，不另外维护；
 *                                 scripts/test-extractors.mjs 静态检查：声明了的模块不许再用 proxyAwareFetch
 *                                 或全局 fetch，没声明的不许引用 outboundFetch。新增要走代理的模块按
 *                                 ADD-CHANNELS.md「要走代理的模块」那条做
 *   proxyProbe            object  outbound 为 'proxy' 时必需：{ url, name? }。「测试」按钮用来代表这个模块的
 *                                 一个 https 接口或清单（取址用的接口、或一路直播的主清单）；name 不写用模块名
 *   proxyHosts            array   outbound 为 'proxy' 时必需：模块出站真会连、大陆直连不通的域名，按后缀写
 *                                 （'tdm.com.mo'、'googlevideo.com'，不带协议、路径或通配符），要盖住 proxyProbe.url
 *                                 的主机。代理软件用规则模式时得放行这些域名才会走节点；后台「网络代理」的
 *                                 说明和「测试」里断在代理之后的失败项按它告诉用户往代理规则里加什么
 *   streamType            string  可选；默认 hls，flv 由本机流式代理且不转码。
 *                                 FLV resolve 须返回 validateMediaUrl 校验官方调度跳转。
 *   capabilities.catchup boolean 可选；false 表示纯直播，不透传回看查询参数。
 *   configSchema          array   字段描述，后台据此渲染表单、后端据此校验。值会进请求头的
 *                                 文本字段声明 headerValue: true，保存时去首尾空白、拦下非法字符。
 *                                 字段说明 hint 写一句话的字符串；三条以上要点写成字符串数组，
 *                                 后台按编号列表显示
 *   credentialCheck       object  要登录的模块（有 secret 字段或 browserLoginFlow）必需：
 *                                 { refresh: 刷新时检查凭证并报 meta.credentialRejected,
 *                                   playback: 播放时发现并经 credentialRejected(config) 上报,
 *                                   degrade: 一句话，凭证失效后播放怎么办 }。
 *                                 规矩：能降级到游客档就降级接着播；没有游客版的频道照留、
 *                                 不许从播放列表悄悄消失；两种都必须让后台提醒中心知道。
 *                                 见 ADD-CHANNELS.md「登录凭证」，测试在 test-extractors.mjs
 *
 *   async fetch(config, ctx) → { groups: [{ name, dataList }], meta }
 *       必需。返回**分组树**而不是扁平频道数组——channelMerger 的合并算法是
 *       「按 group.name 找同名分组再 push dataList」，扁平数组等于把
 *       groupTitle→分组 的映射重新发明一遍。
 *       一个模块可以返回多个分组（咪咕将来的「体育赛事」就是同一模块的第二批
 *       分组，不是另一个源）。
 *       meta: { skipped, warnings, credentialRejected? }。credentialRejected 是
 *       官网不认当前登录凭证时给用户看的一句话（空串 = 查过、没问题；不给 / undefined =
 *       这轮没查成，比如超时、502，后台沿用上一轮的结论），后台登录态徽标、
 *       模块卡片和「源管理」导航红点据此提醒；凭证被拒只提示，不该让 fetch 失败。
 *
 *   credentialRejected(config) → string
 *       可选。播放时才发现凭证被拒的模块用它把结论立刻交给后台，不等下一轮刷新；
 *       config 是生效配置，凭证换了就该返回空串。不能抛异常。
 *
 *   async resolve(ref, ctx) → { url, desc, segmentTransform?, upstreamHeaders?,
 *                                upstreamUrlTransform?, manifestText?, manifestUrl? }
 *       upstreamFamily 可选 4/6；显式直连该地址族，清单/子清单/分片/HEAD 共用，需同时要求 proxyHls。
 *       proxyHls=true 可要求旧 relay 入口也转发媒体，供 IPv6 上游与 IPv4 播放器组合使用。
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
 *   groupsFromConfig(config) 可选。纯本地目录在保存配置时同步重建，停用期间的修改也进入频道缓存。
 *   playbackRequiresEnabled 为真时，停用模块也关闭已收藏的频道地址和已发出的媒体地址。
 *   fetchProxyMedia(ref, config, url, options) 可选。主清单、子清单、分片与 HEAD 共用的回源函数；可选择出站代理或刷新过期签名。
 *   epgFetch(url, options) 可选。模块节目单的默认出站 fetch；显式测试注入仍优先。
 *   claimsRef(ref) → boolean
 *       capabilities.resolve 为真时必需。判断某个 ref 是不是自己的，
 *       播放请求靠它路由到模块。
 *
 *   clearResolveCache()
 *       可选。画质等参数变更后由 utils/appUtils.js 的 clearUrlCache 统一触发。
 *
 *   claimsLocalPath(path) → boolean + async handleLocalRequest(ctx) → response
 *       可选成对实现。供需要把进程内媒体 Buffer 作为 HLS 输出的模块使用；普通
 *       上游 HLS 不要走这里。ctx: { path, method, headers, accessPrefix, client }，response:
 *       { status, headers, body, dispose? }。body 支持 Buffer、字符串和 Web/Node
 *       Readable；流式媒体由 app.js 维持背压，HEAD/断连/结束时调用 dispose。
 *       app.js 仍统一负责访问鉴权与 HTTP 写出。
 *       client 是 { key, tag } 形式的客户端身份。这条路由不经 resolve，resolveBurstGuard
 *       管不到；要启动高成本本地会话（浏览器页等）的模块应自己在启动前调
 *       utils/clientScanGuard.js 的 checkModuleBurst，与 resolve 路径共用一本账。
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
 *   identityUrl 可选；迁移前的稳定直链，只用于保持频道 ID 与用户编排，不能作为播放地址。
 *   logo       官方台标的完整图片地址；官方确实没有才留空。默认没有台标库兜底，
 *              留空就是没有台标。取法与要求见仓库根目录 LOGO.md
 *   groupTitle 装饰用；真正的分组来自所在 group.name
 *   opts       string[]，#EXTVLCOPT 的 key=value，交给 utils/channelOpts.js 渲染
 *   proxyHls   可选；清单和分片都经本机代理
 *   relayHls   可选；只由本机刷新/改写清单，分片仍由播放器直连 CDN
 *   catchup    可选 'none'，显式关闭该台继承订阅头的全局回看能力
 *   trailing   可选 true，海外台：排到所在分组最后，跟在各台官方频道与精选列表等外部订阅
 *              之后（extractors/overseas）
 *   leading    可选 true，打头频道：排到所在分组的模块频道最前（多个时保持原顺序）。给并进
 *              别的模块先建好的分组、又该排第一的台用（市县台并进「山东-淄博」的淄博新闻综合）
 *   supplement 可选 true，补充频道：追加在同组所有模块频道之后，不决定分组位置
 *              （咪咕并进地区分组的频道，见 extractors/migu 的 MIGU_LOCAL_SUPPLEMENTS）
 *   supersedesFeatured 可选 true，模块接手了精选频道（IPTV.m3u）里的这台：同组同名的精选频道条目
 *              在输出时收掉（精选列表的条目留给没升级的部署；channelMerger.dropSupersededFeatured）
 *
 * sourceId / source 由 extractorManager 统一盖章，模块不用自己填——
 * `xt:` 这个前缀格式是注册表层的事，模块不该知道。
 */
import bilibiliLive from './bilibili-live/index.js'
import douyinLive from './douyin-live/index.js'
import youtubeLive from './youtube-live/index.js'
import asianLive from './asian-live/index.js'
import redbull from './redbull/index.js'
import anhui from './anhui/index.js'
import beijing from './beijing/index.js'
import beijingScenic from './beijing/scenic.js'
import chongqing from './chongqing/index.js'
import sichuan from './sichuan/index.js'
import chengdu from './chengdu/index.js'
import sichuanCities from './sichuan-cities/index.js'
import cztv from './cztv/index.js'
import dalian from './dalian/index.js'
import liaoning from './liaoning/index.js'
import douyuLive from './douyu-live/index.js'
import fjtv from './fjtv/index.js'
import bestvFj from './bestv-fj/index.js'
import fengshows from './fengshows/index.js'
import gansu from './gansu/index.js'
import gdtv from './gdtv/index.js'
import gdsportEvents from './gdsport-events/index.js'
import websports from './websports/index.js'
import gztv from './gztv/index.js'
import hangzhou from './hangzhou/index.js'
import gzstv from './gzstv/index.js'
import gxtv from './gxtv/index.js'
import qingdao from './qingdao/index.js'
import hebtv from './hebtv/index.js'
import hebtvScenic from './hebtv/scenic.js'
import heilongjiang from './heilongjiang/index.js'
import hbtv from './hbtv/index.js'
import hkstv from './hkstv/index.js'
import hnntv from './hnntv/index.js'
import hntv from './hntv/index.js'
import huyaLive from './huya-live/index.js'
import ipanda from './ipanda/index.js'
import jlntv from './jlntv/index.js'
import jlntvScenic from './jlntv/scenic.js'
import jxntv from './jxntv/index.js'
import jstv from './jstv/index.js'
import jiaxing from './jiaxing/index.js'
import taizhou from './taizhou/index.js'
import shaoxing from './shaoxing/index.js'
import zhejiangLocal from './zhejiang-local/index.js'
import iqilu from './iqilu/index.js'
import kankanews from './kankanews/index.js'
import kankanewsScenic from './kankanews/scenic.js'
import livechina from './livechina/index.js'
import lotustv from './lotustv/index.js'
import meizhouHakka from './meizhou-hakka/index.js'
import mgtv from './mgtv/index.js'
import migu from './migu/index.js'
import ningbo from './ningbo/index.js'
import ningde from './ningde/index.js'
import ningxia from './ningxia/index.js'
import njtv from './njtv/index.js'
import njtvScenic from './njtv/scenic.js'
import nmtv from './nmtv/index.js'
import putian from './putian/index.js'
import qtv from './qtv/index.js'
import qinghai from './qinghai/index.js'
import quanzhouMinnan from './quanzhou-minnan/index.js'
import quanzhouCounty from './quanzhou-county/index.js'
import shanxi from './shanxi/index.js'
import shaanxi from './shaanxi/index.js'
import songjiang from './songjiang/index.js'
import sztv from './sztv/index.js'
import tianjin from './tianjin/index.js'
import yangshipin from './yangshipin/index.js'
import xinjiang from './xinjiang/index.js'
import xizang from './xizang/index.js'
import wuxi from './wuxi/index.js'
import yangzhou from './yangzhou/index.js'
import nantong from './nantong/index.js'
import yancheng from './yancheng/index.js'
import yunnan from './yunnan/index.js'
import tdm from './tdm/index.js'
import guangdianyunModules from './guangdianyun/index.js'
import shandongCounties from './shandong-counties/index.js'
import overseas from './overseas/index.js'

// 模块 id 会进 sourceId 并写进 EXTINF 属性值，不消毒就是注入面。
// 与 utils/configBackupAPI.js 的文件名白名单同款约束。
export const MODULE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
// proxyHosts 的每一项：小写域名后缀，至少两段，不带协议、端口、路径、通配符
const PROXY_HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/
export const MODULE_CATEGORIES = new Set(['account', 'live', 'standard', 'overseas'])

const MODULES = [
  // 顺序即后台展示顺序，也是 channelMerger 的合并顺序（先到的分组优先保留）
  migu,
  yangshipin,
  fengshows,
  hkstv,
  lotustv,
  tdm,
  asianLive,
  bilibiliLive,
  douyinLive,
  youtubeLive,
  huyaLive,
  douyuLive,
  websports,
  anhui,
  beijing,
  beijingScenic,
  chongqing,
  sichuan,
  chengdu,
  sichuanCities,
  dalian,
  liaoning,
  gansu,
  gdtv,
  gdsportEvents,
  gztv,
  gzstv,
  gxtv,
  fjtv,
  bestvFj,
  quanzhouMinnan,
  quanzhouCounty,
  putian,
  ningde,
  jlntv,
  jlntvScenic,
  jxntv,
  hebtv,
  hebtvScenic,
  hbtv,
  heilongjiang,
  hnntv,
  hntv,
  cztv,
  hangzhou,
  ningbo,
  jiaxing,
  taizhou,
  shaoxing,
  zhejiangLocal,
  jstv,
  wuxi,
  yangzhou,
  nantong,
  yancheng,
  iqilu,
  sztv,
  meizhouHakka,
  // 江门官方直播 CDN 持续 502，2026-10-27 暂时取消注册；解析模块保留供恢复。
  njtv,
  njtvScenic,
  nmtv,
  shanxi,
  shaanxi,
  tianjin,
  qinghai,
  ningxia,
  xinjiang,
  xizang,
  yunnan,
  qingdao,
  qtv,
  kankanews,
  kankanewsScenic,
  songjiang,
  livechina,
  ipanda,
  mgtv,
  // 山东市县在市县台之前：「山东-济南」…「山东-菏泽」按它的地市顺序先建好，市县台的淄博、菏泽两台再并进去
  shandongCounties,
  // 市县台（广电云，按省拆成 20 个模块）跟在各省级、地市模块之后：并进同省分组时排在省台、市台后面
  ...guangdianyunModules,
  // 海外频道排最后：并进体育、文旅等现有分组时，跟在各台官方频道后面
  redbull,
  overseas,
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
  if (module.defaultEnabled != null && typeof module.defaultEnabled !== 'boolean') {
    throw new Error(`抓取模块 ${module.id} 的 defaultEnabled 必须是布尔值`)
  }
  if (module.enableNotice != null && (typeof module.enableNotice !== 'string' || !module.enableNotice.trim())) {
    throw new Error(`抓取模块 ${module.id} 的 enableNotice 必须是非空字符串`)
  }
  if (module.configSavedNotice != null && (typeof module.configSavedNotice !== 'string' || !module.configSavedNotice.trim())) {
    throw new Error(`抓取模块 ${module.id} 的 configSavedNotice 必须是非空字符串`)
  }
  if (module.category != null && !MODULE_CATEGORIES.has(module.category)) {
    throw new Error(`抓取模块 ${module.id} 的 category 非法: ${JSON.stringify(module.category)}`)
  }
  if (module.county != null && typeof module.county !== 'boolean') {
    throw new Error(`抓取模块 ${module.id} 的 county 必须是布尔值`)
  }
  if (module.county && (module.defaultEnabled !== false || module.category != null)) {
    throw new Error(`抓取模块 ${module.id} 声明了 county（市县台），必须 defaultEnabled: false 且不带 category`)
  }
  if (module.splitFrom != null) {
    const { id, groups } = module.splitFrom
    if (!MODULE_ID_RE.test(id || '') || id === module.id
      || !Array.isArray(groups) || !groups.length || groups.some(name => typeof name !== 'string' || !name.trim())) {
      throw new Error(`抓取模块 ${module.id} 的 splitFrom 要写成 { id: '原模块 id', groups: ['原来由它输出的分组名'] }`)
    }
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
  if (module.channelHlsModeForConfig != null && typeof module.channelHlsModeForConfig !== 'function') {
    throw new Error(`抓取模块 ${module.id} 的 channelHlsModeForConfig 必须是函数`)
  }
  if (module.relayProxyCompatible != null && typeof module.relayProxyCompatible !== 'boolean') {
    throw new Error(`抓取模块 ${module.id} 的 relayProxyCompatible 必须是布尔值`)
  }
  if (module.resolveBurstGuard != null && typeof module.resolveBurstGuard !== 'boolean') {
    throw new Error(`抓取模块 ${module.id} 的 resolveBurstGuard 必须是布尔值`)
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
  if (module.outbound != null && module.outbound !== 'proxy') {
    throw new Error(`抓取模块 ${module.id} 的 outbound 非法: ${JSON.stringify(module.outbound)}（只有 'proxy'）`)
  }
  if (module.outbound === 'proxy') {
    const probe = module.proxyProbe
    if (!probe || typeof probe !== 'object' || !/^https?:\/\/\S+$/.test(probe.url || '')) {
      throw new Error(`抓取模块 ${module.id} 声明了 outbound: 'proxy'，必须给 proxyProbe: { url, name? }（测试按钮用的代表性接口）`)
    }
    if (probe.name != null && (typeof probe.name !== 'string' || !probe.name.trim())) {
      throw new Error(`抓取模块 ${module.id} 的 proxyProbe.name 必须是非空字符串`)
    }
    const hosts = module.proxyHosts
    if (!Array.isArray(hosts) || !hosts.length || hosts.some(host => typeof host !== 'string' || !PROXY_HOST_RE.test(host))) {
      throw new Error(`抓取模块 ${module.id} 声明了 outbound: 'proxy'，必须给 proxyHosts: ['域名后缀', …]（只写小写域名，如 'tdm.com.mo'，不带协议、路径或通配符）`)
    }
    const probeHost = new URL(probe.url).hostname
    if (!hosts.some(host => probeHost === host || probeHost.endsWith('.' + host))) {
      throw new Error(`抓取模块 ${module.id} 的 proxyProbe.url 主机 ${probeHost} 不在 proxyHosts 里：测试目标得是模块真会连的域名`)
    }
  } else if (module.proxyProbe != null || module.proxyHosts != null) {
    throw new Error(`抓取模块 ${module.id} 没声明 outbound: 'proxy'，不该有 proxyProbe / proxyHosts`)
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
for (const module of registry.values()) {
  if (module.splitFrom && !registry.has(module.splitFrom.id)) {
    throw new Error(`抓取模块 ${module.id} 的 splitFrom 指向不存在的模块 ${module.splitFrom.id}`)
  }
}

// 后台按地区收面板用的地区名：省、自治区、直辖市和港澳台
export const REGION_NAMES = new Set([
  '北京', '天津', '上海', '重庆',
  '河北', '山西', '辽宁', '吉林', '黑龙江',
  '江苏', '浙江', '安徽', '福建', '江西', '山东',
  '河南', '湖北', '湖南', '广东', '海南',
  '四川', '贵州', '云南', '陕西', '甘肃', '青海',
  '内蒙古', '广西', '西藏', '宁夏', '新疆',
  '香港', '澳门', '台湾',
])

/** 模块所属面板（后台用）：省级地区或专题名；不归面板的返回空串。 */
export function moduleRegion(module) {
  if (typeof module?.region === 'string') return module.region
  return REGION_NAMES.has(module?.outputGroupName) ? module.outputGroupName : ''
}

/** 全部模块，顺序即后台展示顺序。 */
export function listModules() {
  return [...registry.values()]
}

/** 走后台「网络代理」的模块（outbound: 'proxy'），按注册顺序：后台名单、测试目标、要放行的域名和角标都从这里拿。 */
export function proxyModules() {
  return listModules().filter(module => module.outbound === 'proxy')
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
 * 不是抓取模块、但也要认领播放引用的解析者：目前只有自定义源「经网络代理转发」
 * （utils/customSourceProxy.js，由 app.js 挂上）。它不进注册表——后台没有它的卡片，
 * 也不在 proxyModules 名单里。模块总是先认领，挂上来的只接模块都不认的引用。
 */
const extraResolvers = []

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
  for (const resolver of extraResolvers) {
    if (resolver.claimsRef(ref)) return resolver
  }
  return null
}

export function registerRefResolver(resolver) {
  if (!resolver || typeof resolver.claimsRef !== 'function' || typeof resolver.resolve !== 'function') {
    throw new Error('registerRefResolver 需要 claimsRef 与 resolve')
  }
  if (!extraResolvers.includes(resolver)) extraResolvers.push(resolver)
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
