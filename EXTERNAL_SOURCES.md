# 外部源管理功能

本功能允许你将第三方直播源集成到 iPTV 项目中，与咪咕源一起管理和播放。

## 功能特性

- ✅ **自动提取** - 从网页自动提取 m3u8 直播链接
- ✅ **手动设置** - 直接设置已知的 m3u8 链接 
- ✅ **统一管理** - 咪咕源和外部源统一显示
- ✅ **分组支持** - 按分类组织外部频道
- ✅ **Logo 支持** - 外部源可配置频道图标
- ✅ **Web 界面** - 可视化管理界面
- ✅ **自动更新** - 定期更新外部源链接
- ✅ **播放列表开关** - 可控制外部源是否写入 m3u/txt

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
2. 进入"外部源管理"页面
3. 点击"添加外部源"
4. 填入频道信息和 m3u8 链接
5. 保存配置

### 3. 自动提取 m3u8（高级功能）

```javascript
import { extractM3u8FromWeb } from "./utils/webSourceExtractor.js"

const m3u8Url = await extractM3u8FromWeb("https://www.example.com/tv.html", {
  playButtonSelector: ".play-btn",  // 播放按钮的 CSS 选择器
  waitTime: 5000,                   // 等待时间（毫秒）
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
  waitTime: 5000,                  // 点击后等待时间
  headless: true,                  // 无头模式（不显示浏览器）
  timeout: 30000                   // 页面加载超时时间
}
```

## 注意事项

1. **合法性**：请确保使用的直播源具有合法授权
2. **稳定性**：网页结构变化可能影响自动提取
3. **性能**：自动提取需要启动浏览器，较消耗资源
4. **推荐方式**：建议手动获取 m3u8 后直接配置
5. **播放列表开关**：`includeInPlaylists` 为 false 时，不会写入 m3u/txt

## 故障排除

### 1. 提取失败
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