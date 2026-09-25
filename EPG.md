# 节目单（EPG）接入记录

各抓取模块的节目单接到哪一步、来源是什么、踩过哪些坑，都记在这里；下面的规则是新增或修改子模块时都要照着来的。`npm test` 里的 `scripts/test-epg-doc.mjs` 会检查：每个注册的模块都在状态表里，且标「已接入」的恰好是代码里挂了 `epg` 的那些——加了模块忘了登记，测试会直接指出来。新增模块或频道时台标与节目单的完整步骤见 [ADD-CHANNELS.md](ADD-CHANNELS.md)。

## 规则

1. **只用各台官方来源**：官网、官方 App、官方 CDN 上的节目单。不用 tvmao、epg.pw、51zmt、erw 这类聚合站，也不内置任何第三方 XMLTV 源——先后内置过的 51zmt 退化到只剩央视卫视、erw 于 2026-10-01 起停止免费下载，默认源的可用性不该系在个人站点上。找不到官方来源，就在状态表标「无官方节目单」，写明查过哪些地方。
2. **来源顺序**：咪咕自带 → 模块官方节目单 → 用户在后台「设置 → EPG 聚合」自己加的外部源。每个频道只取一家，前面给了的后面不再覆盖。
3. **用户可以让外部源优先**：外部源勾了「优先于官方节目单」（`epg-sources.json` 里的 `overrideOfficial: true`），它**当前还有没播完节目**的频道就改用它，咪咕与模块官方节目单让出来；源停更只剩过期数据时，自动让回官方。外部源之间，勾了的排在最前，其余按优先级数字从小到大。模块节目单不需要为此做任何事，流水线统一处理。
4. **节目单代码与取流代码分开**：每个模块的节目单放在 `extractors/<id>/epg.js`，契约见 `extractors/registry.js` 里的 `epg` 一节。`epg.js` 只 import 模块目录内的纯文件（签名、频道表这类共用逻辑拆成模块内的 `sign.js` / `auth.js` / `channels.js`，取流那边也改用它，行为不变）和下面这几个零依赖工具，只用注入的 `fetchImpl`。连同零依赖的 `utils/epgXmltv.js`、`utils/cntvEpg.js`（央视网通用提供者：北京、甘肃卫视、延边卫视共用，只需给「ref → 代号」表）与 `scripts/build-epg.mjs`，整套能拆出去独立维护。
5. **频道配对**：有 `deferredRef` 的按 ref 对；直链频道（没有 ref，如南京、福州）按「所属模块 + 频道名精确一致」对；同名频道来自不同模块时按播放列表顺序逐个试，前一个官方没发才轮到下一个。不按名字模糊猜。
6. **数据清理约定**：占位（「精彩节目」之类）、冻结模板、只有已播出内容的回看列表，都当「官方没发」返回 `[]`；不到一分钟的碎片和宣传片、片头片尾这类串联包装按需剔除，空档保留；同一时刻只留一条，重叠的截到下一条开始；时间一律显式按来源时区换算（大陆 +08:00，日韩 +09:00），不依赖运行机器的时区。
7. **每个模块都登记在状态表**：接上了、官方没有、不适用、还没查，都要写一行（测试强制）。
8. **探测别猛刷**：江西今视频的阿里云 WAF 猜了约 60 次路径就把本机 IP 封了半小时以上。大陆才能访问的接口用 Globalping 大陆探针确认。

单独产出 / 核对某个模块：`node scripts/build-epg.mjs <模块 id> [-o 文件]`，只用模块节目单产出一份 XMLTV，不经过播放列表。流水线的 iptv 一侧在 `utils/moduleEpg.js`（模块节目单）与 `utils/epgAggregator.js`（外部源）。

## 给新模块接节目单

1. **先找官方来源**：官网直播页的 JS（搜 `epg`、`program`、`playbill`、`schedule`、`节目单`）、模块取流已经在用的接口家族、App 分享页。用真实请求确认能取到哪几天、未来日期是真编排还是占位 / 模板（规则 1、8）。
2. **写 `extractors/<id>/epg.js`**：`days`（从今天起取几天）、`channels()`（同步返回 `{ ref, name, key }`）、`programmes(key, day, { fetchImpl, timeoutMs })`（`day` 是上海日期 YYYYMMDD，返回按开始时间排好的 `{ title, start, stop }` 毫秒时间戳）。官方当天没发返回 `[]`，接口出错才抛。按规则 4、5、6 写。
3. **挂上模块**：`index.js` 里加 `epg` 字段、`capabilities.epg: true`。
4. **测试**：`scripts/test-<id>-epg.mjs`，夹具按真实响应裁剪、全程离线，核对提供者的频道与模块实际输出一一对应，分别在本机时区、`TZ=UTC`、`TZ=America/Los_Angeles` 下跑；加进 `package.json` 的测试链。
5. **实测**：`node scripts/build-epg.mjs <id>`，抽查两三个节目的播出时间（央视《新闻联播》转播应在 19:00）。
6. **更新下面的状态表**。

## 各模块状态

状态只用这几种：**已接入**（模块挂了 `epg`）、**咪咕自带**、**无官方节目单**（调研过，官方没有可用的）、**不适用**（直播间、景观机位这类本来就没有节目单）、**未调研**。

2026-09-25 第二轮接入后本地一轮完整更新：模块节目单补上 146 个频道，全部频道中有节目单的 223 个（当时还含后来移除的大爱、GOOD TV 共 4 路；其后接入的陕西、天津、北京、甘肃卫视、延边卫视、宁夏、澳门莲花卫视、泉州未计入）。

<!-- epg-status:start -->
| 模块 | 名称 | 状态 | 覆盖 | 天数 | 官方来源 | 备注 |
|---|---|---|---|---|---|---|
| `migu` | 咪咕视频 | 咪咕自带 | 自有频道 | 今天 | program-sc.miguvideo.com；部分央视走 CNTV epginfo3 | 旧通道（utils/playback.js），优先级最高 |
| `yangshipin` | 央视频 | 已接入 | 73/73 | 2 | capi.yangshipin.cn/api/yspepg/program/{livePid}/{日期} | 对象存储上的静态 protobuf；国学频道官方无文件（与河南国学频道同一个台，由河南补） |
| `fengshows` | 凤凰卫视 | 已接入 | 3/3 | 2 | api.fengshows.cn/live/{id}/resources | 开始时间是 UTC 时间戳 |
| `hkstv` | 香港卫视 | 已接入 | 1/1 | 2 | hkstv.tv/services/live/epg | 接口不带频道参数，给的是官网当前默认的那一路 |
| `lotustv` | 澳门莲花卫视 | 已接入 | 1/1 | 2 | www.lotustv.mo/zh/programme | 服务端渲染的 HTML，一页本周一到周日，标签只写日号、没有日期参数；只给开始时间，结束取下一档；周日取不到下周一；节目名繁体照原样 |
| `asian-live` | 亚洲与国际直播 | 已接入 | YTN、NHK World | 2 | NHK：masterpl.hls.nhkworld.jp/epg/w/{日期}.json；YTN：m.ytn.co.kr/schedule.php | UTC+9，上海的一天对应当地 01:00–次日 01:00；YTN 是网页抓取 |
| `bilibili-live` | 哔哩哔哩直播 | 不适用 | — | — | — | 直播间 |
| `huya-live` | 虎牙直播 | 不适用 | — | — | — | 直播间 |
| `douyu-live` | 斗鱼直播 | 不适用 | — | — | — | 直播间 |
| `anhui` | 安徽 | 无官方节目单 | — | — | — | 官网频道页已改跳新闻；安徽视讯 App 1.0.174（2026-09-25 拆包）是爱加密整包壳，桩 dex 13 KB、载荷在 assets/ijiami.dat，不脱壳、到此为止；公开网页端只有微直播活动接口 |
| `beidou` | 辽宁 | 无官方节目单 | — | — | — | getProgram 只列已开播的回看、没有预告；当前输出的 5 路在里面全空 |
| `beijing` | 北京广播电视台 | 已接入 | 7/9 电视 | 2 | api.cntv.cn/epg/getEpgInfoByChannelNew?c=btv{n} | 北京时间官网没有节目单，取央视网（代号 btv1 卫视…btv9 新闻，逐个试出来的）；体育休闲 btv6 官方为空，卡酷少儿试不出代号（咪咕、央视频也没有这两台）；北京时间 App 有节目单页面，但包是 360 加固、在模拟器里启动即自杀，正式版也不信任用户证书，接口拿不到，不再往下（不绕过 App 的防护）；电视频道要部署者 Cookie 才出现，公开部分是慢直播 |
| `chongqing` | 重庆 | 无官方节目单 | — | — | — | 频道详情的 playbillid / billcontent 为空，其余路径 404 |
| `sichuan` | 四川 | 无官方节目单 | — | — | — | 官网直播页与四川观察 App（9.11.2 拆包核对）都没有电视节目单；programs/{id}/dates 是栏目往期视频不是节目单；四川卫视由咪咕 / 央视频覆盖，康巴卫视央视网也没收 |
| `dalian` | 大连 | 已接入 | 3/3 | 2 | wan-dlrm.dlrm.cn/app/tv/programs | 与取流共用匿名 SM2 令牌 |
| `gansu` | 甘肃 | 已接入 | 1/6 | 2 | api.cntv.cn/epg/getEpgInfoByChannelNew?c=gansu | 甘肃台自己的 getTvProgramList 全空、也不是带时间的节目表；甘肃卫视取央视网（央视频也有），五个地面频道央视网、央视频都没收 |
| `gdtv` | 广东 | 已接入 | 14/17 | 2 | gdtv-api.gdtv.cn/api/tv/v2/tvMenu | HMAC-SHA256 签名，key/secret 取自官网 WASM 签名模块（别直接跑官网签名脚本，里面有反 Node 陷阱）；经典剧、纪录片、健康官方为空 |
| `gztv` | 广州 | 无官方节目单 | — | — | — | 广视网直播页没有节目单，频道数据里的节目字段为空；旧节目单域名已失效 |
| `gzstv` | 贵州 | 无官方节目单 | — | — | — | 官网接口只给标题与流地址；动静 App（2026-09-25 拆包，官网直链 120 MB）是梆梆 DexHelper + zxprotect 加固，单个 137 MB 的假 dex，不脱壳、到此为止 |
| `gxtv` | 广西 | 已接入 | 6/7 | 2 | api2019.gxtv.cn/memberApi/programList/selectListByChannelId | POST，实际按频道名查；只给开始时间与时长；广西移动官方不展示节目单 |
| `quanzhou-minnan` | 泉州 | 已接入 | 1/1 | 1 | wxqz2.qztv.cn（备 www.qztv.cn）闽南语播放页 | 服务端渲染的节目表，完整日期标签给最近七天到今天、没有明天；每档有起止时间，末档结束写次日时刻；官网偶发阿里云人机验证，两入口都被拦本轮就没有 |
| `fjtv` | 福建 | 已接入 | 9 路 | 2 | 省级 mapi-plus.fjtv.net 云直播 program/list；厦门 mapi1.kxm.xmtv.cn/api/v1/program.php；福州 app.zohi.tv/video/player/playbill | 东南卫视、厦视三套、海博地市只有占位；福州只列自办栏目、只有今天，少儿不收 |
| `jlntv` | 吉林 | 已接入 | 1/15 | 2 | api.cntv.cn/epg/getEpgInfoByChannelNew?c=yanbian | broadcast/programs 只维护广播，电视频道全空；延边卫视取央视网，节目名是朝鲜语（官方原样）；吉林卫视由咪咕 / 央视频覆盖，其余央视网没收 |
| `jxntv` | 江西 | 无官方节目单 | — | — | — | 官网与今视频 App 后端都没有；App 接口有阿里云 WAF；今视频 6.2.6（2026-09-25 拆包，官网只指向应用宝）是爱加密壳，桩 dex 13 KB，不脱壳、到此为止 |
| `hebtv` | 河北 | 已接入 | 6 路电视 | 2 | api.cmc.hebrts.cn/spidercrms/api/live/liveShowSet/findNoPage | POST，公开 tenantId；频道号与取流无关；美丽河北慢直播不适用 |
| `hbtv` | 湖北 | 已接入 | 6/6 | 2 | cjy-iptv.hbtv.com.cn/wxcms3/remote-wx/api/cj-cloud/play/{账号}/show | 长江云 TV 遥控页接口，固定公开 Authorization、账号段传 null（2026-09-25 确认保留） |
| `heilongjiang` | 黑龙江 | 无官方节目单 | — | — | — | 极光新闻 H5 只有流地址；旧节目单域名已解析不到；极光新闻 8.8.3（2026-09-25 拆包，业务 dex 明文）没有任何节目单接口、数据模型或界面文案，live/getTVInfo 只给台标与流地址，按日期的只有新闻联播回看，App 里也没有 |
| `hnntv` | 海南 | 已接入 | 7/7 | 1 | www.hnntv.cn/api/schedule/byDay | 一次给今天加过去 6 天，没有明天 |
| `hntv` | 河南 | 已接入 | 13/13 | 1 | pubmod.hntv.tv/program/getAuth/vod/originStream/program/{cid}/{零点秒} | sha256 签名；明天以后是冻结的周模板，按没发处理 |
| `cztv` | 浙江 | 已接入 | 9/9 | 2 | p.cztv.com/api/paas/program/{台号}/{日期} | 播出日志粒度，剔除广告、宣传片碎片；未来日期是「精彩节目」占位 |
| `jiaxing` | 嘉兴 | 无官方节目单 | — | — | — | 趣看播放器的节目表接口 qukanvideo.com/h5/channel/view/item/list?liveId=&day= 只有已播出的日子有数据（且多为「无版权」时段块），今天、明天都是空数组，和辽宁北斗一样只是回看列表；央视网试过 jiaxing / jiaxing1 / jxtv 都是 params error，央视频、咪咕也没收 |
| `jstv` | 江苏 | 已接入 | 10/10 | 1 | live-lizhi.jstv.com/api/Channel/Epg | 匿名 JWT；频道要用导航里的 extraId |
| `iqilu` | 山东 | 已接入 | 9/9 | 2 | sdxw.iqilu.com/v1/app/play/program/qilu | 闪电新闻后端，频道号 24–32（不是 _pdCid） |
| `sztv` | 深圳 | 已接入 | 6/7 | 1 | hls-api.sztv.com.cn/api/getEpgs | 深圳少儿官方为空 |
| `meizhou-hakka` | 梅州 | 无官方节目单 | — | — | — | hellohakka.cn 网页端（kan0512 融媒 App 壳）没有节目单页；接口 mzxjapi.hellohakka.cn/api/app/channel/static/list 在网页代码里只有地址、没有调用，裸请求回「必传参数不正确」，参数只在原生 App 里，不再往下拆；央视网试过 meizhou / meizhou1 都是 params error，央视频、咪咕也没收 |
| `njtv` | 南京 | 已接入 | 4 路电视 | 2 | apigateway.nbs.cn/Liveprogram/getEPGByTaskId | 直链频道，按名对上；13 路机位不适用 |
| `nmtv` | 内蒙古 | 无官方节目单 | — | — | — | broadcast/programs 只维护广播，电视频道停在 2023 年；央视网有蒙语台（代号 neimenggu2）但连日为空，内蒙古卫视由咪咕 / 央视频覆盖 |
| `shanxi` | 山西 | 已接入 | 9/16 | 2 | apphhplushttps.sxrtv.com/epg/{key}.json | JSONP；7 个地市台官方文件为空；末档拉到次日早上的按下一档截断 |
| `shaanxi` | 陕西 | 已接入 | 8/8 | 1 | qidian.sxtvs.com/api/v3/program/tv?channel={key} | 只给服务器当天、只有 HH:mm，按响应 Date 头认日期；同一时刻两条留后一条；末档 23:59 接到 24:00 |
| `tianjin` | 天津 | 已接入 | 7/7 | 2 | jyapi2.wisetv.com.cn:8684/v3/tv/programs/show/{起}/{止}/{频道ID} | 与取流共用津云 App 内置的 ak/sk 头；区间最远到后天；明天上午起是编排计划，三小时切段与零点切段合回一条、去掉「30’」类时长批注 |
| `qinghai` | 青海 | 无官方节目单 | — | — | — | 官网云直播 program/list 对任何日期（未来、频道建立之前）都即时生成 24 条整点「精彩节目」占位，每次请求 id 都是新的；与福建东南卫视同一平台同一情况 |
| `ningxia` | 宁夏 | 已接入 | 3/3 | 1 | api.ningxiahuangheyun.com/?mod=get_appdata&appid=nxtv-tv | 黄河云 App 页面配置，一次给三套（menu[].ename = nxws / nxgg / nxwl），秒级起止时间；只有今天，日期参数都不认；约 500KB，模块内缓存 10 分钟三套共用；宁夏卫视咪咕已有节目单，实际由咪咕给，黄河云补公共、文旅；每档带的官方回看地址没用 |
| `xinjiang` | 新疆 | 已接入 | 6/7 | 2 | slstapi.xjtvs.com.cn/api/TVLiveV100/TVGuideList | 新疆少儿官方为空 |
| `xizang` | 西藏 | 无官方节目单 | — | — | — | 珠峰云接口只给每台「正在播出」一条（卡片 date/enddate）；频道详情 videolive 的 ifschedule=0、节目列表全空，官网没有电视直播页。开着央视频时西藏卫视与它同名，共用央视频的节目单 |
| `yunnan` | 云南 | 已接入 | 4/7 | 2 | yntv-api.yntv.cn/index/jmd/getJmd | 防火墙要浏览器 UA + yntv.cn Referer；七彩云端三路没有节目单 |
| `qtv` | 青岛 | 不适用 | — | — | — | 城市景观机位 |
| `kankanews` | 上海 | 已接入 | 6/13 | 2 | kapi.kankanews.com/content/pc/tv/programs | MD5 签名头；魔都眼、新纪实官方没有；5 路景观不适用 |
| `songjiang` | 上海松江 | 不适用 | — | — | — | 慢直播 |
| `livechina` | 央视直播中国 | 不适用 | — | — | — | 景观直播 |
| `ipanda` | iPanda 官方直播 | 不适用 | — | — | — | 熊猫机位 |
| `mgtv` | 湖南 | 无官方节目单 | — | — | — | 芒果各接口只给 2010→2050 的占位；getLivePlayBill 要机顶盒参数且没有数据 |
<!-- epg-status:end -->

## 不做对外发布

2026-09-25 评估过「像内置台标一样，把节目单公开给别人用」（GitHub Actions 定时跑 `build-epg`，推到单独分支，走 jsDelivr 对外）。结论：**不做**，口子留着。

- **实测**：同一个 `scripts/probe-epg.mjs` 在本机和 GitHub Actions（美国凤凰城，微软 Azure 机房）各跑一次。245 个模块频道里，本机 230 个有当天节目、0 失败；GitHub 只有 198 个、40 个失败。
- **海外被挡的**：山西（16 路，403 / 410）、江苏（10 路，连接失败）、新疆（7 路，403）、云南（4 路，403），深圳偶发 1 路（上面的 245 / 198 / 40 当时还含后来移除的大爱 2 路，Cloudflare 拦机房 IP）。都是按地域拦截，不是临时故障。这几省的卫视央视频能补上，丢的是省内地方频道。咪咕、央视网的节目单接口在海外正常。
- **为什么不做**：
  - iptv 用户各自的 `/playback.xml` 本来就全（本机 230 个），对外那份只服务不用 iptv 的人。
  - 放在海外 CI 上永远缺那几省，要补全就得常开一台大陆机器、存推仓库的令牌。
  - 一公开就成了别人的依赖，断更、缺台都会找上门，等于自己当 erw。
  - 台标能公开是因为它是静态文件、没有地域限制；节目单每天要重取，受地域限制。
- **留着的口子**：想要一份 XMLTV 的跑 `node scripts/build-epg.mjs`；部署了 iptv 的直接用自己实例的 `/playback.xml`。以后要重新评估，先在目标环境跑 `node scripts/probe-epg.mjs --md 结果.md` 对比覆盖。

## 已知短板与后续

- **零点后的空档**：多数省台官方只发当天的节目单，零点后到下一轮更新（默认 8 小时）前，这些频道没有新一天的节目单。可考虑零点后单独刷一次节目单。
- **未调研**：没有了。北京、四川的电视频道都要部署者登录后才出现，2026-09-25 查过：北京取央视网，四川官网与 App 都没有节目单。
