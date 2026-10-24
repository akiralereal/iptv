# 四川市州官方直播

默认开启，18 个市州、25 路电视频道归入「四川」，与省台和成都模块并列；免登录、不转码、不启动浏览器。

| 市州 | 频道 | 已验证画质 | 官方入口 |
| --- | --- | --- | --- |
| 绵阳 | 新闻综合 | 1080p | [迈尚网](http://www.myntv.cn/html/zb/mytv1.asp) |
| 泸州 | 新闻综合、科教生活 | 720p | [大听网](https://www.luzhoubs.com/lztv1/index.html) |
| 遂宁 | 综合 | 1080p | [遂宁新闻网](https://www.snxw.com/) |
| 内江 | 综合 | 720p | [内江新闻网直播页](https://xmt.njrbs.cn/bencandy.php?fid=43&id=972) |
| 达州 | 新闻综合、文化生活、通川 | 1080p | [达州融媒网](https://www.dzrm.cn/cms/tv/13560916) |
| 巴中 | 综合、文旅生活 | 1080p | [巴中网](https://www.bzgd.com/1902/index) |
| 甘孜 | 综合 | 720p | [圣洁甘孜](https://www.ganzitv.com/cms/tv/1027139) |
| 阿坝 | 新闻综合、藏语综合 | 720p | [阿坝新闻网](https://www.aba-news.com.cn/) |
| 广元 | 新闻综合 | 720p | [广元手机台](https://m.dzsm.com/cms/a/1006352/content) |
| 宜宾 | 新闻综合、科教文旅 | 1080p | [宜人宜宾](https://m.yibinrm.cn/cms/a/43174882/content) |
| 凉山 | 新闻综合、彝语综合 | 720×404 | [云上凉山](https://m.i0834.cn/cms/a/1052185/content) |
| 雅安 | 新闻综合 | 1080p | [云小雅](https://m.yunxya.com/cms/a/1030244/content) |
| 乐山 | 新闻综合 | 1080p | [乐水乐山](https://www.leshan.cn/) |
| 眉山 | 综合 | 720p | [眉说之言](https://mszy.scmstv.cn/) |
| 资阳 | 新闻综合 | 1080p | [资阳网 / 资阳观察](https://www.zyrb.com.cn/#/bD074b747F?pkey=eb00c31e92) |
| 德阳 | 新闻综合 | 720p | [德阳新闻官方下载](https://download.deyangnews.cn/) |
| 攀枝花 | 新闻综合 | 1080p | [攀枝花开官方电视页](https://www.pzhxinwen.cn/html/rft/live.html?channelId=d1f8066886ea4ed1a4f55acea5ef42bc&type=1&siteId=4399a78804af48b285f25614750a77fe) |
| 南充 | 综合 | 720p | [南充融媒当前 App 入口](https://rmt.cnncw.cn/html/invite/nextPage.html?tenant=TjEzMDA=) |

## 播放链路

- 绵阳、泸州、遂宁读取官网实际启用的播放器地址，忽略 HTML 注释中的旧源。绵阳签名从网页实时读取，不写死。
- 内江读取官网 `live_id` / `live_type`，再请求同站 `web/video_ajax.php` 的直播地址。
- 达州、甘孜使用官网播放器的 `cms/home/content?id=…`，核对频道 ID 与电视类型。
- 广元、宜宾、凉山、雅安跟随官方客户端的 `cms/public/v2/contents/{id}` 与 `components`；宜宾、雅安优先使用播放器明确配置的 `fields.link_url`，广元、凉山按 `live_id` 获取组件地址。
- 乐山、眉山、南充读取 App 当前「看电视」节点；眉山、南充按同平台公开签名配置取址，乐山当前无需签名。
- 德阳读取官方安装包 H5 使用的 `cms-api/broadcast/list?mark=tv`，只使用明确返回的 `streamH5`。攀枝花从当前官方 H5 的公开配置生成匿名请求签名，再读 `rftapi/api/rft/getLiveList`，精确匹配已核验的一套新闻综合。配置和媒体签名均运行时读取，不保存真实密钥。
- 资阳按官网播放器调用 `tvradio/Tvfront/getTvInfo?tv_id=1`，使用匿名响应中的 `url`，不拼旧备用源。
- 巴中读取官网 `sctv/tv/index/tv.json`，按 `channelId` 精确选台。
- 阿坝使用官网公开 `nodeClient/node`（汉语租户 `c3200`）与 `getUnifiedConfiguration`。按官网前端 `a0d8` 模块的公开流程生成 `md5(key + pathname + 十进制到期时间)`，有效期 60 秒；配置只在内存中短缓存，不写入文件、日志或订阅，也不发给媒体 CDN。

目录按租户隔离短缓存 30 秒，同一请求合并并发；绵阳、阿坝、乐山、眉山、南充按官方播放器方式复用正在播放的合法网宿会话，每次读取媒体清单，空闲 10 分钟回收。`wsTime` 限制新建会话，已有 `wsSession` 可继续播放；不因短签到期强换会话，避免 TS 时间戳回退。CDN 明确拒绝会话时重新走官网流程一次，网络抖动不切会话。目录连接错误仅重试一次，目录 HTTP 拒绝和超时不重试。

播放列表仅保存稳定的 `sichuan-cities-*` 引用。遂宁、达州、凉山、资阳七路的清单与分片要求官网 Referer，默认全代理；其余十八路默认中继清单，分片直连。全代理兼容订阅也可用。绵阳、阿坝、乐山、眉山、南充的官方网宿调度节点按发布域名和本台完整目录校验，拒绝串台、陌生域和私网节点。

## 台标与节目单

25 路均有官方频道、所属广电或客户端标识，并已备份进内置台标包。宜宾使用与播出角标一致的官方站标；凉山、南充使用其官方 App 在 Apple 商店提供的标识，注明平台出处。没有把节目海报或电视直播封面当台标。泸州暂用大听网官方标识，遂宁使用官网图标。

凉山两套接入 `lives/{id}/playlists`，攀枝花接入现用 H5 的 `getEpgInfo`（参数 `dateTime`），均提供今明两天节目单，已核对日期、节目名及上海时区。其余 22 路暂无有效官方 EPG：绵阳仍是 2020 年旧表，内江仅占位，达州/甘孜/巴中/广元/宜宾/雅安当前表为空，资阳列表为空；阿坝/乐山/眉山/南充公开电视详情未给有效编排，德阳目录和泸州/遂宁页面没有节目单。央视网候选代号未命中。不接第三方节目单，不提供回看。

本次 App 追查的入口、版本和未接入原因见 [官方 App 追查](APPS.md)。

## 本轮未收录

这是对公开官网与官方客户端网页入口的排查结果，不能据此认定当地没有直播服务；未验证通过的均未加入频道表。

| 地区 | 本次核查结果 |
| --- | --- |
| 绵阳其他频道 | 公共旧签名 403；科技旧官方源无法建立可用播放链路 |
| 遂宁文化生活 | 当前官网已将旧播放器入口注释掉，不收录隐藏旧源 |
| 自贡 | 自贡观察旧下载入口落回门户，未取得当前公开电视接口；看度自贡已停止运营，不用旧入口代替 |
| 广安 | 魅力广安公开接口返回两套，但 live1.gatv.com.cn:90 媒体连接失败，未收录 |

本轮只纳入市州频道和达州官网同列的通川频道；广元、阿坝目录中的其他区县台未加入本次频道表。雅安文化生活目录条目的直播组件为空，不收录。

## 复测

```sh
node scripts/test-sichuan-cities.mjs
node scripts/probe-sichuan-cities.mjs --output /tmp/sichuan-cities.json
node scripts/probe-sichuan-cities.mjs --base http://127.0.0.1:1924 --output /tmp/sichuan-cities-local.json
```

复测逐台验证官方解析、调度/媒体清单、TS 分片、H.264/AAC 轨道和实际解码。报告不含签名地址。夹具从真实响应裁剪，签名改成离线假值；首轮 13 路实测见 `verification.json`，App 首轮新增九路见 `verification-apps.json`，深入追查三路见 `verification-deep.json`。
