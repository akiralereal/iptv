# 外部源管理功能

本功能允许你将第三方直播源集成到 iPTV 项目中，与咪咕源一起管理和播放。

## 功能特性

- ✅ **自动提取** - 从网页自动提取 m3u8 直播链接
- ✅ **手动设置** - 直接设置已知的 m3u8 链接 
- ✅ **统一管理** - 咪咕源和外部源统一显示
- ✅ **分组支持** - 按分组组织外部频道
- ✅ **Logo 支持** - 外部源可配置频道图标
- ✅ **Web 界面** - 可视化管理界面
- ✅ **自动更新** - 定期更新外部源链接
- ✅ **播放列表开关** - 可控制外部源是否写入 m3u/txt
- ✅ **保留回看声明** - 订阅自带的 `catchup` / `catchup-days` / `catchup-source`（频道行或文件头）清洗后写回 m3u，声明了模板的频道按源自己的模板回看；没声明或只声明天数的频道，模板照旧继承订阅头的咪咕模板

## 使用方式

### 1. 手动添加外部源（推荐）

如果你已经有了 m3u8 链接：

```javascript
// 通过代码添加
import externalSourceManager from "./utils/externalSources.js"

externalSourceManager.addSource({
  name: "纬来体育",
  group: "体育", 
  webUrl: "https://www.example.com/tv.html", // 原网页地址
  m3u8Url: "https://stream.example.com/live.m3u8", // 直播链接
  logo: "https://example.com/logo.png",
  enabled: true
})

// 启用外部源功能
externalSourceManager.toggleEnabled(true)
```

### 2. 通过 Web 管理后台

1. 访问 http://localhost:1905/admin
2. 进入「🌐 源管理」页，找到「👤 自定义源」
3. 点击「＋ 添加自定义源」
4. 填入频道信息和 m3u8 链接
5. 保存配置

### 3. 自动提取 m3u8（高级功能）

```javascript
import { extractM3u8FromWeb } from "./utils/webSourceExtractor.js"

const m3u8Url = await extractM3u8FromWeb("https://www.example.com/tv.html", {
  playButtonSelector: ".play-btn",  // 播放按钮的 CSS 选择器
  waitTime: 5000,                   // 等待 m3u8 的最长时间（毫秒），嗅到即走
  headless: true                    // 无头浏览器模式
})
```

## 配置文件

外部源配置保存在 `external-sources.json`：

```json
{
  "enabled": true,
  "includeInPlaylists": true,
  "sources": [
    {
      "name": "纬来体育",
      "group": "体育",
      "webUrl": "https://www.jrkan66.com/wlty.html",
      "playButtonSelector": ".play-btn",
      "m3u8Url": "https://stream.example.com/live.m3u8",
      "logo": "https://example.com/logo.png",
      "enabled": true,
      "lastUpdated": "2024-01-01T00:00:00.000Z",
      "extractOptions": {
        "waitTime": 5000,
        "headless": true
      }
    }
  ],
  "updateInterval": 60,
  "lastGlobalUpdate": "2024-01-01T00:00:00.000Z"
}
```

订阅模式（`"mode": "subscription"`）的源另有几个可选字段，后台订阅源卡片里的「User-Agent」「拉取超时」「失败重试」几栏就是它们：

- `userAgent`：拉订阅时用的 User-Agent，留空用默认浏览器 UA。有些订阅要特定 UA 才肯返回列表，按订阅提供方的要求填。失效检测也用它去探这个源的频道
- `playWithUserAgent`：为 `true` 时，本源每个 http(s) 频道在 m3u 里都带上 `#EXTVLCOPT:http-user-agent=<userAgent>`，由播放器在播放时发出（需要播放器支持这一行，如 VLC、Kodi）。订阅里已自带 UA 的频道保持不变；带请求头的频道 TXT 格式放不下，不会出现在 TXT 订阅里
- `fetchTimeout`：拉订阅的超时（秒），从发起请求算到列表下载完，不填为 15，可填 5–120，超出范围按上下限算。订阅很大或服务器很慢、日志里总是「请求超时」时调大
- `fetchRetries`：拉取失败后再试几次，不填为 0（不重试），最多 3；第 n 次重试前等 2n 秒。只有超时、连接中断、服务器忙（5xx、408、429）这类可能下次就好的失败才重试，404、403、内容里解析不出频道直接算失败。`raw.githubusercontent.com` 地址失败时本来就会依次换 5 条镜像线路、每条各算一次超时，这一项对它不生效

两项都是每条线路、每次尝试各自计时，一个源最坏要等「超时 ×（重试次数 + 1）」（GitHub raw 是「超时 × 5 条线路」）。自动刷新是一个源一个源串行拉的，设得越大，这个源拉不到时其它源等得越久；后台前面有 nginx 等反向代理时，「导入并保存」的总耗时别超过它的超时（常见 60 秒），否则页面会先报错（后台仍会拉完并保存）。

订阅源和直连源还认 `useProxy`（后台卡片上的「经网络代理转发」，实现在 `utils/customSourceProxy.js`）：

- 为 `true` 且「设置 → 网络代理」有生效代理（后台填的，或沿用 `HTTPS_PROXY` / 系统代理）时，拉订阅经代理，局域网地址照旧直连
- 源里公网的 http(s) 频道在 m3u 里写成本机入口 `/proxy/cp-<16 位十六进制>.m3u8`。播放时服务器经代理取清单，清单和分片都由服务器转发，频道自带的 `#EXTVLCOPT` 请求头（含「播放时也带上这个 UA」）由服务器带上；播放器拼在后面的回看参数接回原地址
- 没有生效代理时，本机入口 302 回原地址，和没勾时一样；取回来不是 HLS 的（FLV、TS 裸流等）也 302 回原地址；经代理取不到回 502，不悄悄改成直连
- 局域网地址、非 HTTP 地址（rtmp / rtp / udp）、`.flv` 地址不改写，原样输出
- 本机入口按「源 id + 频道名 + 剥掉签名参数的原地址」算，订阅换签名入口不变；频道身份仍按原地址算（写盘时带内部属性 `identity-url`），开关一开一关，隐藏、改名、排序都不受影响
- 「检测失效」对会由服务器转发的频道同样经代理探
- 抓取模式和内置「精选频道」订阅不认这个字段；内置模块走不走代理由模块自己声明（`outbound: 'proxy'`），这里改不了

订阅拉取失败时：手里有上次的频道就继续用，不会从播放列表里消失；连续失败按 10、20、40…分钟递增等待再拉，最长等到这个订阅自己的刷新间隔，拉成功一次就清零（重启后重新计）。后台订阅卡片会显示最近一次失败的原因和下次重试时间，「上次更新」始终是最后一次拉成功的时间。

## API 接口

### 获取外部源配置
```
GET /api/external-sources
```

### 管理外部源
```
POST /api/external-sources
Content-Type: application/json

{
  "action": "add",
  "source": {
    "name": "频道名称",
    "group": "分组",
    "webUrl": "网页地址",
    "m3u8Url": "直播链接"
  }
}
```

支持的操作：
- `save` - 保存整个配置
- `add` - 添加新源
- `remove` - 删除源（需要 `index`）
- `update` - 更新源链接（需要 `index`，-1 表示更新所有）
- `setM3u8` - 手动设置链接（需要 `index` 和 `m3u8Url`）

## 网页提取说明

### 常用选择器示例

| 网站类型 | 播放按钮选择器示例 |
|---------|-------------------|
| 通用 | `.play-btn`, `#play-button`, `.video-play` |
| Video.js | `.vjs-big-play-button` |
| DPlayer | `.dplayer-play-icon` |
| 自定义 | `button[aria-label="播放"]` |

### 提取参数说明

```javascript
{
  playButtonSelector: ".play-btn", // 播放按钮CSS选择器
  waitTime: 5000,                  // 点击后等待 m3u8 的最长时间（毫秒），嗅到即走
  headless: true,                  // 无头模式（不显示浏览器）
  timeout: 15000                   // 页面导航超时上限（毫秒，嗅到 m3u8 即提前结束；默认 15000）
}
```

## 注意事项

1. **合法性**：请确保使用的直播源具有合法授权
2. **稳定性**：网页结构变化可能影响自动提取
3. **性能**：自动提取需要启动浏览器，较消耗资源
4. **推荐方式**：建议手动获取 m3u8 后直接配置
5. **播放列表开关**：`includeInPlaylists` 为 false 时，不会写入 m3u/txt
6. **`${replace}` 是内部占位符**：输出订阅时它会被换成本机地址和访问密码 / 令牌，外部源（订阅、直连）里不能用。频道名、分组名、播放地址或台标带它的频道会被丢弃，日志里会点名是哪个源；`#EXTVLCOPT` 和回看模板里带它的那一项直接忽略（频道保留，日志不提示）

## 故障排除

### 1. 提取失败
- 订阅源报「请求超时」：订阅较大或服务器较慢时，在订阅源卡片里调大「拉取超时」，或设「失败重试」
- 检查网页是否能正常访问
- 确认播放按钮选择器是否正确
- 增加等待时间 `waitTime`
- 尝试设置 `headless: false` 查看浏览器行为

### 2. 链接无效
- 验证 m3u8 链接是否可直接播放
- 检查链接是否有时效性
- 确认网络环境是否支持访问

### 3. 频道不显示
- 确认外部源功能已启用 (`enabled: true`)
- 检查频道配置是否正确
- 查看控制台日志输出

### 4. Docker 中出现僵尸(defunct)进程
- 自动提取(`fetch` 模式)会启动 Chromium；容器内 Node 以 PID 1 运行时，Chromium 退出后重新挂到 Node 名下的子进程不会被回收，长期累积会出现 `<defunct>` 僵尸进程
- 镜像已内置 `tini` 作为 init 进程来回收它们：请使用**重新构建后的镜像**（带 tini 的 `ENTRYPOINT`），或在 `docker-compose.yml` 设置 `init: true`（用 `docker run` 时加 `--init`）后执行 `docker compose up -d` **重建容器**使其生效
- `browser.close()` 已带超时与强杀进程组兜底，单次抓取卡死不会阻塞后续更新

## 示例场景

### 添加体育频道
```javascript
// 添加纬来体育
externalSourceManager.addSource({
  name: "纬来体育",
  group: "体育",
  webUrl: "https://www.jrkan66.com/wlty.html",
  m3u8Url: "获取到的m3u8链接"
})

// 启用功能
externalSourceManager.toggleEnabled(true)
```

### 批量添加频道
```javascript
const channels = [
  { name: "频道1", group: "电影", m3u8Url: "链接1" },
  { name: "频道2", group: "电视剧", m3u8Url: "链接2" }
]

channels.forEach(ch => externalSourceManager.addSource(ch))
```

## 开发扩展

你可以基于现有功能进行扩展：

1. **支持更多提取方式** - 修改 `webSourceExtractor.js`
2. **添加链接检测** - 扩展 `validateM3u8` 函数
3. **优化更新策略** - 调整 `updateInterval` 和更新逻辑
4. **集成更多源** - 创建专门的源管理模块

## 技术实现

- **Puppeteer** - 网页自动化和链接提取
- **JSON 配置** - 外部源配置管理
- **API 集成** - RESTful 接口设计
- **数据合并** - 咪咕源与外部源统一处理