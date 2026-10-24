# 辽宁直播调查：云盛京入口与北斗融媒鉴权

## 2026-10-22：移除沈阳三路，保留独立大连模块

云盛京 `mobile.yunshengjing.com` 的官方直播分享页、频道目录和三路 `getPlayableUrl` 现也全部返回阿里云 WAF 405。物理网卡直连（公共 DNS、原 Host/SNI、有效 TLS）及显式代理复测均失败，未取得可用官方替代入口。

按维护决定，主项目移除整个 `beidou` 模块及其解析、鉴权代码，不再认领原省台和沈阳引用；升级及导入旧备份时清理该模块的配置、频道缓存与健康记录。独立 `dalian` 模块、三路正式频道、节目单和「辽宁」分组保留。历史代码和调查证据继续保存在 tv-lab 的 `liaoning-live-lab` 中；以下记录仅代表当时的验证状态。

## 2026-10-21：曾恢复沈阳三路，暂时移除省台

原省台 `bdrm.bdy.lnyun.com.cn` 和沈阳 `sygbdst.bdy.lnyun.com.cn` 的网页、频道目录及播放接口持续返回阿里云 WAF 405。上海联通直连及两个不同美国代理出口得到相同结果，不能据此断言所有地区均不可用。省台 Android 4.0.71 可启动但内容为空；历史 4.0.67 分享代码没有设置独立替换域名，最新公开分享仍使用原域名，未发现经验证可用的省台替代入口。

沈阳来源核对：

- [云盛京 App Store](https://apps.apple.com/cn/app/id1481558002)开发者为沈阳广播电视台；[小米商店](https://app.mi.com/details?id=com.taihe.sjtvim)核对 Android 包名。
- [应用宝分发页](https://a.app.qq.com/o/simple.jsp?pkgname=com.taihe.sjtvim)取得 Android 3.0.7 / versionCode 107，大小 139272079 字节，MD5 `9b5cd75420ce2c2a140a94c69f189ab8`，与分发元数据一致。
- 该 APK 的 `MyApplication` 设置 sceneId=`sygbdst`、原 API 域名=`sygbdst.bdy.lnyun.com.cn`，并显式设置分享替换域名 `mobile.yunshengjing.com`、直播鉴权版本 3。分享实现会将原 API 域名替换成这个域名。
- [官方直播分享页](https://mobile.yunshengjing.com/lib/Livestudio/index2.html?domainId=d447fcc472f14c7f14872d4e26b12d8f)、`tabId=2` 目录、`getPlayableUrl` 和 v3 `getOauth` 均正常。v5 被该租户拒绝，不能只替换域名而沿用省台 v5。
- v3 配置解码材料来自上述 APK 内置 `libcoder-lib.so` / `rsaLiveDecoder(version=3)`；它用于匿名直播配置，非用户凭证。仓库不保存实时 Referer、服务器 pullKey 或播放签名。

主项目的 `beidou` 模块现仅启用沈阳新闻综合、经济、公共三路，保留原频道引用、辽宁分组和全媒体代理。通过 `claimsRef` 剔除旧省台磁盘缓存，目录版本升级后会主动重抓；旧省台引用不再触发上游请求。仍校验官方目录、live/replay、租户 CDN、动态 Referer 和短效 HLS 签名。没有把沈阳接口用于省台频道，也没有加入第三方转播。实验台此前三路均完成本机 M3U 代理下 6 秒 FFmpeg 解码（H.264 1080p25 / AAC）。

完整调查与脱敏实播证据保存在独立 tv-lab 仓库的 `liaoning-live-lab/research/`，实验台本地提交 `2b28fe6`；主项目的 v3 回归使用合成数据，保留旧 v5 测试以核对解码版本隔离和既有协议。

主项目迁入后的验证：`scripts/test-beidou.mjs` 15 项及全量 `npm test` 通过。使用独立数据目录启动真实 `app.js`，预置的旧省台缓存启动时被清理，目录版本触发重抓要求；手动刷新后模块状态为 `ok`、频道数 3、warnings 为空。实际 `/interface.m3u` 仅包含三条沈阳频道引用，没有省台条目或上游播放签名。三路 `/proxy/beidou-shenyang-<ID>.m3u8` 均经 FFmpeg 成功解码 6 秒 H.264 1920×1080 / 25fps 与 AAC 音频。这是短时播放验证，没有进行长播或跨真实鉴权轮换时刻的实播验收。测试服务已停止，现有部署的数据与配置未被覆盖。

## 2026-09-03：issue #112 历史修复

调查日期：2026-09-03。问题：[辽宁省台不能播放但沈阳可以](https://github.com/akiralereal/iptv/issues/112)。

## 结论

原模块固定了 8 月 30 日取得的省台 Referer `http://dggb.bdy.lnyun.com.cn`。
这个值不是永久配置。官方 `getOauth` 返回 `referTimeOut`（剩余有效秒数），Referer 会轮换。
9 月 3 日同一客户端解出的值已变成 `http://iywv.bdy.lnyun.com.cn`，省台拉流密钥没有变化。
旧 Referer 请求省台 CDN 返回 `403 denied by Referer ACL`，新 Referer 请求相同清单成功。
沈阳当前 Referer 同样已从 `doxe` 变为 `dquo`，虽然抽测时其 CDN 也接受不带 Referer 的请求。

issue 中的 302 是服务端抓取清单失败后的回退。服务端已经传递 Referer，错误在于固定值过期；
因此此次修复保留通用代理路由，改为动态取得鉴权参数。

## 官方调用链

来源为北斗融媒 Android **4.0.66 / versionCode 366** 的 `libcoder-lib.so`、
`com.bdkj.bdcoder.Coder`、直播接口与播放器代码。官网的
[公开页面](https://bdrm.bdy.lnyun.com.cn/lib/Livestudio/index-bdrm.html)
引用 `sms/api/basicSetting/getParam`，该接口提供官方应用下载入口。

1. `GET /cloud/apis/facade/app/tab/page?tabId=3`：读取辽宁正式电视频道。
2. `GET /cloud/apis/live/api/program/getPlayableUrl?domainId=<频道 ID>`：取得当前 `live` / `replay` 状态。
3. `POST /cloud/apis/live/api/domain/getOauth?domainId=<频道 ID>&version=5&sign=<签名>`：
   匿名取得当前 `refer`、`pullKey`、`domain`、`referTimeOut`。无请求体。
4. 用客户端 version 5 内置材料解码两个配置值；无协议头的 Referer 按客户端规则补 `http://`。
5. 为官方 HTTPS HLS 地址生成 30 分钟 `auth_key`，服务端带 Referer 读取清单与分片。

`sign` 的还原方式已与客户端原生函数实测输出逐字匹配：

- 随机数字 `r ∈ [0,9]`；四个递增插入位置 `a ∈ [1,2]`、`b ∈ [a+1,4]`、
  `c ∈ [b+1,6]`、`d ∈ [c+1,9]`。
- 在频道 ID 的上述原始位置后插入同一数字，得到 `text`。
- `digest = uppercase(md5(lowercase(sha256(text)) + Unix秒))`。
- 最终签名为 `base64(r + a + b + c + d + Unix秒)` 拼接 `digest`，所有加法均为字符串拼接。

响应值是 1024 位 RSA / PKCS#1 v1.5 加密块，客户端内置解码材料的实际 DER 格式为 PKCS#8。
Node 实现验证密文长度、填充、UTF-8、CDN 域名与 Referer 格式；运行时无需 APK、模拟器或新增依赖。

## 修复与验证

- 省台、沈阳分别按 CDN 租户缓存鉴权，同时播放多个频道只发一次鉴权请求。
- 每次缓存最长十分钟，且在官方剩余有效期结束前三十秒失效；之后播放时重取。
- 请求失败退避五秒，不回退使用过期参数；清除解析缓存也会清除鉴权缓存。
- 原有频道白名单和 `live` / `replay` 筛选保持原逻辑。

2026-09-03 实测时处于 `live` 的频道：

| 频道 | 清单 | 分片 Range GET |
| --- | --- | --- |
| 辽宁卫视 | 200 | 206，188 字节 TS 包 |
| 辽宁影视剧 | 200 | 206，188 字节 TS 包 |
| 新动漫 | 200 | 206，188 字节 TS 包 |
| 辽宁移动电视 | 200 | 206，188 字节 TS 包 |
| 家庭理财 | 200 | 206，188 字节 TS 包 |
| 沈阳新闻综合 | 200 | 206，188 字节 TS 包 |
| 沈阳经济 | 200 | 206，188 字节 TS 包 |
| 沈阳公共 | 200 | 206，188 字节 TS 包 |

另外五路省台在最终抽测时为 `replay`，未计入直播成功数。
隔离数据目录启动实际 `app.js` 后，issue 所列辽宁影视剧与沈阳公共 `/proxy/...m3u8`
入口均直接返回 200、没有 Location，清单内相对分片入口也成功返回 206。
这是清单与分片读取验证，没有做长时间视频解码播放或跨真实轮换时刻的持续播放测试。

`npm test` 全部通过。新增回归覆盖原生签名样本、两次官方加密响应、Referer 轮换、
并发请求合并、过期后的失败与恢复、十分钟上限及清缓存重取。
