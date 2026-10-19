# 成都官方直播

默认开启，27 路归入「四川」：成都六套电视、蓉城先锋，以及 20 路区县电视。龙泉旧源连续返回 404，未确认可用官方替代入口，暂不收录。

频道编号来自用户提供的 NAS 脚本，已逐路核对看度官方接口 `https://mob.api.cditv.cn/show/192-{code}.html`。CDTV-4 编号为 45；蓉城先锋使用 `dangjiao` 路径，金牛使用独立 CDN。

每次播放获取新的官方签名。成都主频道优先 `android_HDlive_url`，缺少时取 `android_url`，并将 HTTP 升为 HTTPS；区县保留官方协议。默认由主项目返回 302，播放器直连官方 CDN，不转码、不启动浏览器。签名地址不写进频道缓存，不提供回看。

不跟随 HTTP 302 跳转的播放器（如极影视）无法播放成都频道：官方总清单把子清单绑定到请求方 IP，只中转清单行不通，模块只能用 302 把官方签名地址交给播放器。

官方主机与路径不写死：只接受 `cditv.cn` 及其子域、HTTP/HTTPS、`.m3u8` 结尾且带 `wsSecret`、`wsTime` 的地址，路径中的频道标识须与本台一致；主频道高清地址不合规时退回标清。

## 台标和节目单

24 路频道图来自[成都电视直播官网](https://www.cditv.cn/wap/show/4845-563.html)和[区县直播官网](https://www.cditv.cn/wap/show/4844-578.html)移动版的 `showClass.thumbs`，图片地址及具体出处保存在 `logos.js`。旧接口使用的 `xysj.cditv.cn` 图床已不可用，新版为 `cmsimg.cditv.cn`。官方图同时备份在项目内置台标包。

崇州、都江堰、新津使用手工收录的内置台标，资料库出处保存在 `logo-pack/index.json`，不配置外部台标库。崇州已按实际播出画面核对，使用 CZM 标志。

新闻综合、公共两台通过央视网 `cdtv1`、`cdtv5` 取得今明两天节目单，按频道引用精确匹配。其余频道暂缺官方节目单；看度详情 `billcontent` 全空，所查官网 `playbill` 接口没有可用编排。

## 验证

2026-10-17 当前 27 路均通过「官方接口 → 调度清单 → 媒体清单 → 实际 TS 分片 → ffprobe」检查（H.264 / AAC），为短时验证，不代表长期或其它网络下始终可用；结果未随模块保存，可用 `node scripts/probe-chengdu.mjs --all --output /tmp/chengdu-check.json` 复测。

在项目根目录复测默认两个样本或全部频道，需要 Node.js 20+ 和 FFmpeg：

```sh
node scripts/probe-chengdu.mjs
node scripts/probe-chengdu.mjs --all --output /tmp/chengdu-check.json
```

探针不输出签名地址；有频道失败时退出码为 1。离线回归测试已加入 `npm test`：

```sh
node scripts/test-chengdu.mjs
node scripts/test-chengdu-epg.mjs
```
