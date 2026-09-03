# 北斗融媒直播鉴权调查：issue #112

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
