# iPTV-Docker

[![GitHub](https://img.shields.io/badge/GitHub-akiralereal/iptv-181717?logo=github&logoColor=white&style=for-the-badge&logoSize=auto)](https://github.com/akiralereal/iptv)
[![Docker Hub](https://img.shields.io/badge/Docker%20Hub-akiralereal/iptv-2496ED?logo=docker&logoColor=white&style=for-the-badge&logoSize=auto)](https://hub.docker.com/r/akiralereal/iptv)

### ☕ 打赏支持 / Buy Me a Coffee

> 如果这个项目对你有帮助，欢迎支持一下 :)

<table>
  <tr>
    <td align="center"><b>☕ Ko-fi</b></td>
    <td align="center"><b>💰 USDT (TRC20)</b></td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://ko-fi.com/akirale" target="_blank"><img src="https://ko-fi.com/img/githubbutton_sm.svg" alt="Ko-fi"/></a>
    </td>
    <td align="center">
      <img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=TArpwDgewYSFCYX6XoJ6drwpEU6UGBw5yq" width="200" alt="USDT TRC20 QR Code"/><br/>
      <code>TArpwDgewYSFCYX6XoJ6drwpEU6UGBw5yq</code><br/><br/>
      <sub>⚠️ 仅支持 <b>TRON (TRC20)</b> 网络，请勿使用其他网络<br/>Only via <b>TRON (TRC20)</b> network</sub>
    </td>
  </tr>
</table>

**当前版本：v1.8.0**

> 一个基于 Docker 部署的 IPTV 直播源管理和分发系统，支持 GUI 管理，内置咪咕视频源抓取，支持外部直播源管理及自定义直播源订阅。
>
> - 📺 免费频道支持标清/高清（480p/720p），**1080P 蓝光画质需要咪咕 VIP 会员**
> - 🏆 咪咕体育直播（昨天/今天/明天赛事）**需开通对应咪咕体育会员**方可播放
> - 🎁 已内置多个稳定可靠的免费频道，如**纬来体育、Red Bull TV、港澳台**等，无需额外配置即可使用
> - 📡 内置**港澳台及地方频道**订阅源，开箱即用
> - 🔗 支持**订阅模式**，可导入 m3u/m3u8 播放列表批量添加频道
<div align="center">
  <img src="https://raw.githubusercontent.com/akiralereal/iPTV-Docker/main/Resources/111.png" width="800"/>
  <img src="https://raw.githubusercontent.com/akiralereal/iPTV-Docker/main/Resources/222.png" width="800"/>
  <img src="https://raw.githubusercontent.com/akiralereal/iPTV-Docker/main/Resources/333.png" width="800"/>
</div>

## 📖 项目简介

本项目提供完整的 IPTV 直播源解决方案，主要功能包括：

1. **📺 咪咕视频源抓取** - 自动获取咪咕视频的电视频道，包括 CCTV 和主要卫视频道（720P 高清画质）

2. **🎫 VIP 会员增强** - 配置开通相应会员的咪咕账号信息后，可抓取体育直播等会员频道（支持 1080P、蓝光或更高画质）

3. **🔗 外部源管理** - 支持添加外部 m3u8 直播链接、通过网页播放地址自动抓取直播源，或通过**订阅模式**导入 m3u/m3u8 播放列表批量添加频道

4. **🖥️ Web 管理后台** - 通过 `http://your-ip:1905/admin` 访问可视化管理平台，轻松管理所有直播源

📋 **详细功能说明和配置方法请参考下方文档**

---

## 🚀 快速开始 - Docker 部署（推荐）

### 使用 Docker Compose（最简单）

创建 `docker-compose.yml` 文件：

```yaml
services:
  iptv:
    image: akiralereal/iptv:latest              # 使用最新版本镜像
    container_name: iptv                        # 自定义容器名称
    ports:
      - "1905:1905"                             # 宿主机:容器端口映射
    environment:
      - muserId=                                # 可选：咪咕账号ID（留空为游客模式）
      - mtoken=                                 # 可选：咪咕登录令牌（用于高画质/VIP）
      - mport=1905                              # 必须：容器监听端口，与 ports 对应
      - mrateType=4                             # 画质：2=标清，3=高清，4=蓝光(需VIP)
      # - mhost=                                  # 可选：外部访问地址（如 http://test.com:1905）
      # - mpass=                                  # 可选：访问密码（设置后访问: http://ip:port/密码/...）
    restart: always                             # 容器异常退出后自动重启
```

启动服务：

```bash
docker-compose up -d
```

常用命令：

```bash
# 查看日志
docker-compose logs -f

# 停止服务
docker-compose down

# 重启服务
docker-compose restart

# 更新镜像
docker-compose pull && docker-compose up -d
```

### 使用 Docker 命令直接运行

#### 拉取镜像

```bash
docker pull akiralereal/iptv:latest
# 或指定版本
docker pull akiralereal/iptv:1.3.1
```

#### 快速运行（游客模式）

```bash
docker run -d -p 1905:1905 --name iptv akiralereal/iptv:latest
```

#### 自定义配置运行

```bash
docker run -d -p 1905:1905 \
  -e muserId=你的ID \
  -e mtoken=你的token \
  -e mport=1905 \
  -e mhost="http://192.168.1.100:1905" \
  -e mrateType=4 \
  -e mpass=mypassword \
  --name iptv \
  akiralereal/iptv:latest
```

### 🎯 访问服务

部署成功后，可以通过以下地址访问：

#### 📺 播放列表
- **M3U 格式**: `http://your-ip:1905/m3u`
- **TXT 格式**: `http://your-ip:1905/txt`
- **节目单（EPG）**: `http://your-ip:1905/playback.xml`

#### 🖥️ Web 管理后台（重要）

> [!TIP]
> **快速访问管理后台：**
> 
> - **无密码访问**: `http://your-ip:1905/admin`
> - **有密码访问**: `http://your-ip:1905/密码/admin`
> 
> 💡 *将 `your-ip` 替换为你的服务器IP地址，例如: `http://192.168.1.100:1905/admin`*

通过管理后台可以：
- ✅ 查看所有频道列表
- ✅ 添加/编辑/删除外部直播源
- ✅ 配置系统参数（画质、公网地址、访问密码等）
- ✅ 一键更新播放列表

---

## 📋 更新日志

### v1.8.0 (2026-04-05)
- 🆕 频道详情弹窗新增**一键调起本地播放器**按钮（VLC / IINA / PotPlayer）：通过新增后端接口 `POST /api/launch-player` 调用 `open -a`（macOS）或直接启动 exe（Windows，自动探测 VLC / PotPlayer 标准安装路径），跨平台稳定唤起，避免依赖不可靠的自定义 URL scheme
- 🎨 播放按钮改为品牌配色 + 内联 SVG 图标（VLC 橙 / IINA 紫 / PotPlayer 金），替换渲染不一致的 emoji
- 📺 新增内置订阅源「**全球频道**」（`Global.m3u`），与已有的「港澳地方频道」采用同一套处理方式；`BUILT_IN_SUBSCRIPTIONS` 常量化，新装默认写入，已有安装启动时自动补齐缺失内置源
- 🐛 修复内置订阅源展开出的频道在详情弹窗被错误标记为"外部源"：内置订阅的 `subscriptionUrl` 通过 `/api/built-in-sources` 暴露给前端，按 URL 命中判定归属，确保「全球频道」「港澳地方频道」下所有频道统一显示为"内置源"
- 💡 管理后台"我的频道"新增点击可查看详情的提示：标题下方加入操作说明，频道名前增加 ⓘ 提示图标（hover 高亮），降低用户发现成本
- 🗑️ 移除失效的内置频道 `新加坡亚洲新闻（CNA）` 与 `Bloomberg TV`
- 📝 README 重构：更名为 **iPTV-Docker**，将部署方式前置，新增 GitHub / Docker Hub 徽章与 Ko-fi / USDT 赞助入口


### v1.7.2 (2026-03-25)
- 🐛 修复频道数据缓存污染导致内置源/外部源频道重复累积的问题：`getAllChannels` 合并时使用浅拷贝，导致内置源和外部源频道被写入咪咕缓存，每次自动刷新触发 `regenerateOnly` 重新生成播放列表时重复叠加（如纬来体育出现多条）

### v1.7.1 (2026-03-23)
- 🐛 修复 Docker 环境下内置抓取源（如纬来体育）无法抓取的问题：Alpine Linux 的 Chromium 路径为 `/usr/bin/chromium`，而非 `/usr/bin/chromium-browser`，导致 Puppeteer 找不到浏览器，抓取静默失败
- 🔒 修复安全问题：未授权访问 `/admin` 或 `/player` 时，响应中会明文暴露访问密码；现改为返回 403 并仅提示密码路径格式
- 🐛 修复设置访问密码后，使用 `/密码/admin` 路径无法访问管理后台的问题（路由匹配未覆盖带密码前缀的路径）

### v1.7.0 (2026-03-18)
- 🆕 新增**手动分组**功能：可在「我的频道」中创建空分组，并在自定义源中直接使用这些分组
- 🗑️ 新增**手动分组删除**功能：删除后，该分组下的自定义直连/抓取频道会自动并入 `未分组`
- 🔒 调整分组操作边界：内置咪咕分组、订阅源分组仅支持隐藏，`未分组` 不允许重命名、删除或隐藏
- 🐛 修复自定义频道与分组管理问题：避免直连频道 ID 冲突导致“我的频道”丢失频道，并阻止重命名到已存在分组名

### v1.6.0 (2026-03-16)
- 🐛 修复频道去重逻辑：将全局按频道名去重改为**分类内去重**，允许同一频道出现在不同分组中，与咪咕 App 行为一致
- 🐛 修复隐藏频道逻辑：`hiddenChannels` 改为**按分组独立隐藏**，避免跨分组误隐藏同名频道
- 🔧 频道详情弹窗优化：清理冗余播放按钮，保留复制地址功能

### v1.5.0 (2026-03-11)
- 🔄 检查更新支持 **GitHub 镜像回退**：依次尝试原始地址、ghfast.top、gh-proxy.com、gcore.jsdelivr.net，解决国内 Docker 环境无法访问 GitHub 的问题
- 🐛 修复 jsDelivr 镜像 URL 转换错误导致该镜像始终 404 的问题
- 🔧 GitHub 镜像列表统一维护（`GITHUB_RAW_MIRRORS`），检查更新与订阅抓取共用，避免重复代码
- 🐛 修复管理页面版本号显示与实际版本不一致的问题
- 📦 新增 `bump-version.js` 版本号统一更新脚本，一条命令同步更新所有文件

### v1.4.3 (2026-03-11)
- 🌐 新增**外网访问协议自动检测**：通过 NAS 转发（绿联、群晖、威联通等）或自定义域名访问时，自动使用 HTTPS 协议生成频道地址，解决外网无法播放的问题
- 🔀 内网/外网/自定义域名三条路径互不影响，内网访问不走外网，避免上行带宽浪费
- 📺 根路径 `/` 默认返回 M3U 格式（`audio/x-mpegurl`），APTV 等客户端可直接用根地址导入

### v1.4.1 (2026-03-11)
- 🆕 新增**分组重命名**功能：可自定义分组名称，重命名后同名分组自动合并，支持重置恢复原名
- 🆕 新增**分组隐藏通配符**支持：在配置中使用 `体育-*` 可一次性隐藏所有体育赛事分组
- 🆕 新增**检查更新**功能：在「关于我们」页面可一键检查是否有新版本
- 🔧 重置功能改为弹窗选项式，支持分项重置（重命名 / 隐藏 / 排序），避免误操作
- 🐛 修复频道详情来源识别错误：正确区分咪咕源、内置源、外部源
- 🐛 修复编辑按钮在非外部源频道上错误显示的问题
- 🐛 修复订阅类型外部源编辑时无法定位到正确源的问题
- 🐛 修复 `/txt` 端点未应用用户配置过滤的问题
- 🗑️ 移除冗余的「保存配置」按钮（各操作已自动保存）

### v1.3.3 (2026-03-10)
- 🐛 修复 Docker 环境下播放列表文件写入不完整的问题：生成 `interface.txt` 时使用了异步文件写入（fire-and-forget），导致文件重命名时部分分组尚未写入完成，造成港澳台地方频道（浙江、河南、广东、宁夏、广西、云南等）分组缺失；现已改为同步写入，确保文件完整性
- 🔧 优化日志输出：精简定时检查源更新、频道请求等高频日志，大幅减少 Docker 容器日志量
- 🐛 修复订阅源（如港澳台频道）首次获取失败后无重试机制，导致频道缺失的问题；现在启动 60 秒后自动重试
- 🐛 修复订阅源获取失败时不保留已有缓存数据的问题；失败时保留旧频道数据，引入指数退避重试机制
- 🐛 修复外部源每小时定时检查时无条件写入配置文件的问题；现在仅在有源被实际更新时才保存
- 🆕 启动时新增游客模式提示：未配置咪咕账号时提示最高画质为 720p
- 📸 README 新增管理后台截图展示

### v1.3.0 (2026-03-10)
- 🆕 新增**订阅模式**（外部源第三种模式）：支持导入 m3u/m3u8 播放列表 URL，一次性批量添加多个频道，支持自动定时刷新
- 📺 新增内置**港澳台及地方频道**订阅源（港澳地方频道），默认启用，开箱即用
- 🖥️ 管理后台新增订阅模式 UI：支持填写订阅名称、m3u 地址、刷新间隔，一键导入并保存
- 📝 更新 `external-sources.json.example` 示例文件，新增订阅模式配置示例

### v1.2.8 (2026-03-05)
- 🔖 版本号升级到 `1.2.8`，同步更新 `package.json`、`package-lock.json`、README 展示版本及 Docker workflow 镜像版本标签
- ⚖️ 新增 GPL-3.0 开源许可（`LICENSE`），并在文档中补充 License 说明
- 🧹 清理运行时缓存文件 `pe-cache.json` 出仓库，并加入 `.gitignore` 防止误提交

### v1.2.7 (2026-02-28)
- 🐛 修复内置抓取源 URL 刷新后重建播放列表（regenerateOnly 模式）会丢失体育-昨天/今天/明天频道的问题；现在 `updatePE` 运行时同步保存赛事缓存，快速模式下直接从缓存恢复，无需重新调用 API

### v1.2.6 (2026-02-27)
- 🐛 修复内置抓取源（如纬来体育）URL 刷新后未重新生成播放列表，导致 APTV 等客户端拿到的仍是过期链接的问题；现在每次抓取到新 URL 后会立即以快速模式重建 `interface.txt`
- 📺 新增内置频道 Bloomberg TV（国际分组）
- 📺 新增内置频道 Eurosport 4K（体育分组）
- 📺 新增内置频道 Red Bull TV（体育分组）

### v1.2.5 (2026-02-27)
- 🐛 修复内置抓取源（如纬来体育）因 m3u8 链接过期导致无法播放的问题，将自动刷新间隔从 240 分钟缩短为 60 分钟
- 🐛 修复内置抓取源抓取失败时不清除旧缓存的问题，抓取失败时现在会自动清除过期缓存，避免继续使用无效链接

### v1.2.4
- 内置源管理功能
- Web 管理后台优化

---

## 📚 详细功能说明

### 核心功能

- ✅ **多种直播源支持**
  - 咪咕视频源（300+ 频道，含 CCTV、卫视、地方台）
  - 外部自定义直播源（m3u8 格式）
  - 订阅模式（m3u/m3u8 播放列表批量导入）
  - 内置港澳台及地方频道订阅源
  
- ✅ **灵活的画质选择**
  - 标清 (480p) - 游客可用
  - 高清 (720p) - 游客可用
  - 蓝光 (1080p) - 需要 VIP
  - 原画 (1080p+) - 需要 VIP
  - 4K (2160p) - 需要 VIP
  
- ✅ **回看功能** - 支持当天节目回看
  
- ✅ **Web 管理后台**
  - 📺 自动抓取网页中的 m3u8 播放地址
  - 🔧 手动添加已知的播放地址
  - 🔄 支持独立自动刷新功能
  - ⚡ 快速模式：删除/修改源 1-2 秒内生效
  
- ✅ **自动更新节目单（EPG）** - 定时同步最新节目信息

---

## 🔧 本地部署（进阶用户）

### 前置要求

- Node.js 18+ 环境
- 中国大陆网络环境（访问咪咕频道）

### 注意事项

1. 登录后使用请注意账号安全
2. 咪咕频道需要中国大陆网络环境才可正常访问

### 使用模式

#### 🎯 游客模式（推荐，无需配置）

- ✅ 无需配置账号，开箱即用
- ✅ 支持所有普通频道（央视、卫视、地方台等）
- ✅ 支持回看功能
- ⚠️ 画质限制为 **720p**

#### 🎫 VIP 会员模式

- ✅ 支持高清及以上画质（1080p、蓝光、4K）
- ✅ 支持体育赛事等会员内容
- ⚠️ 需要配置 `muserId` 和 `mtoken`
- ⚠️ 需要咪咕视频 VIP 会员

> **提示**：登录普通账号（无VIP）与游客模式效果相同，都是 720p 画质。只有 VIP 会员才能观看高清及以上画质。

#### 📝 如何获取 userId 和 token

如需使用 VIP 会员功能，需要获取咪咕账号的 `userId` 和 `token`。

> [!IMPORTANT]
> **获取步骤：**
> 1. 使用浏览器访问 [咪咕视频官网](https://www.miguvideo.com/)
> 2. 登录你的咪咕 VIP 账号
> 3. 打开浏览器开发者工具（F12）
> 4. 切换到"网络"(Network) 标签
> 5. 刷新页面，在请求中找到包含认证信息的 API 请求
> 6. 从请求头或响应中提取 `userId` 和 `token` 参数

<div align="center">
  <img src="https://raw.githubusercontent.com/akiralereal/iPTV-Docker/main/Resources/000.png" alt="获取userId和token示例" width="800"/>
  <p><i>浏览器开发者工具获取 userId 和 token 示例</i></p>
</div>

### 配置说明

| 变量名          | 默认值 | 类型    | 介绍                                                                                      |
| --------------- | ------ | ------- | ----------------------------------------------------------------------------------------- |
| muserId         |        | string  | 用户id（仅VIP用户需要配置）<br>可在网页端登录获取                                          |
| mtoken          |        | string  | 用户token（仅VIP用户需要配置）<br>可在网页端登录获取                                       |
| mport           | 1905   | number  | 本地运行端口号                                                                            |
| mhost           |        | string  | 公网/自定义访问地址<br>格式<http://ip:port>                                               |
| mrateType       | 3      | number  | 画质<br>2: 标清 (480p)<br>3: 高清 (720p)<br>4: 蓝光 (1080p，需VIP)<br>7: 原画 (1080p+，需VIP)<br>9: 4K (2160p，需VIP) |
| mpass           |        | string  | 访问密码 大小写字母和数字<br>添加后访问格式 <http://ip:port/mpass/>...                    |
                                           |

### 高级功能详解

#### 📡 公网地址配置 (mhost)

公网地址用于生成可分享的播放列表链接，支持内网和公网同时访问。

**使用场景：**
- ✅ 使用反向代理（如 nginx）访问服务
- ✅ 通过域名访问服务
- ✅ 需要分享播放列表给他人使用
- ❌ 仅本地/局域网使用（留空即可）

**配置方式：**

通过 Web 管理后台配置时：
- 只需输入域名/IP（如 `http://example.com`），端口会自动使用服务端口
- 也可手动指定端口（如 `http://example.com:8080`）

通过环境变量配置：
```bash
mhost="http://yourdomain.com:1905"
```

**智能路径选择：**
- **内网直接访问** → 播放列表使用内网地址（如 `http://192.168.1.100:1905`）
- **公网直接访问** → 播放列表使用访问时的地址
- **反向代理访问** → 自动使用配置的公网地址（检测到 `X-Forwarded-For` 或 `X-Real-IP` 请求头）

**示例：**
```bash
# 场景1: 内网访问
访问: http://192.168.1.100:1905/m3u
结果: 播放列表中的链接为 http://192.168.1.100:1905/...

# 场景2: 通过 nginx 反向代理访问（已配置 mhost）
访问: http://yourdomain.com/m3u
结果: 播放列表中的链接为 http://yourdomain.com:1905/...
```

#### 🔐 访问密码功能 (mpass)

设置访问密码后，所有服务（播放列表、管理后台、频道直播）都需要在 URL 中包含密码路径。

**配置方式：**

通过 Web 管理后台：
- 在"系统配置"中设置访问密码（只支持字母和数字）
- 保存并重启服务生效

通过环境变量：
```bash
mpass="yourpassword"
```

**访问格式：**

| 服务 | 无密码访问 | 有密码访问 |
|------|-----------|-----------|
| 播放列表 (m3u) | `http://ip:port/m3u` | `http://ip:port/密码/m3u` |
| 播放列表 (txt) | `http://ip:port/txt` | `http://ip:port/密码/txt` |
| 回放文件 | `http://ip:port/playback.xml` | `http://ip:port/密码/playback.xml` |
| 频道直播 | `http://ip:port/608807420` | `http://ip:port/密码/608807420` |
| 管理后台 | `http://ip:port/admin` | `http://ip:port/密码/admin` |

**自动路径注入：**

设置密码后，系统会自动处理：
- ✅ 播放列表中的所有频道链接自动包含密码路径
- ✅ 回放文件路径自动包含密码
- ✅ 管理后台 API 自动鉴权
- ✅ 未授权访问会返回友好提示信息

**测试示例：**
```bash
# 设置密码为 test123 后

# 场景1: 不带密码访问（失败）
curl http://localhost:1905/m3u
# 返回：身份认证失败

# 场景2: 带密码访问（成功）
curl http://localhost:1905/test123/m3u
# 返回：正常的播放列表
# 列表中的链接: http://localhost:1905/test123/608807420

# 场景3: 管理后台（无密码访问被拒绝）
访问: http://localhost:1905/admin
# 返回 403：访问需要密码，请使用正确的密码路径访问管理后台
```

**安全建议：**
- 🔒 使用复杂密码（字母+数字组合）
- 🔒 定期更换密码
- 🔒 不要在公开场合分享带密码的链接
- 🔒 如果只是内网使用，可以不设置密码

## Web 管理后台

本项目提供可视化的 Web 管理界面,方便您管理外部直播源。

### 访问地址

- **无密码**: `http://ip:port/admin`
- **有密码**: `http://ip:port/mpass/admin`

### 功能说明

#### 1. 查看所有频道
- 左侧面板显示从直播源获取的所有频道，按分组展示（央视、体育、卫视、地方等）
- 实时加载最新的频道列表

#### 2. 搜索频道
- 支持实时搜索，快速查找您想要的频道
- 支持模糊匹配频道名称

#### 3. 管理外部源

**添加外部源有三种方式：**

##### 方式一：自动抓取
1. 点击"添加源"按钮
2. 填写频道信息：
   - **频道名称**：自定义频道名称（如"纬来体育"）
   - **分组**：选择或输入分组名称（如"体育"）
   - **网页地址**：填写包含播放器的网页URL
   - **等待时间**：页面加载等待时间（毫秒，默认3000）
   - **独立自动刷新**：是否定期自动刷新该频道的播放地址
3. 点击"保存并抓取"
4. 系统会自动访问网页，抓取 m3u8 播放地址
5. 抓取成功后，频道会自动添加到播放列表

**优点**：
- ✅ 自动获取播放地址，无需手动查找
- ✅ 支持自动刷新，保持链接有效性
- ✅ 智能选择最优播放链接（优先长链接）

**适用场景**：
- 网页中有在线播放器的直播源
- 需要定期更新播放地址的源

##### 方式二：手动输入
1. 点击"添加源"按钮
2. 填写频道信息（同上）
3. **直接填写 m3u8 地址**：在"M3U8 地址"栏输入已知的播放地址
4. 点击"保存"
5. 频道立即添加到播放列表

**优点**：
- ✅ 无需等待抓取，立即生效
- ✅ 适用于已知播放地址的场景
- ✅ 不依赖网页结构

**适用场景**：
- 已知确切的 m3u8 播放地址
- 播放地址长期稳定不变的源

##### 方式三：订阅 m3u 播放列表（批量导入）
1. 点击"添加源"按钮
2. 切换到"订阅模式"
3. 填写订阅信息：
   - **订阅名称**：自定义名称（如"港澳地方频道"）
   - **M3U 地址**：填写 m3u/m3u8 播放列表的 URL
   - **刷新间隔**：自动刷新周期（分钟，默认1440即每天一次）
4. 点击"📥 导入并保存"
5. 系统会自动解析播放列表，批量导入所有频道

**优点**：
- ✅ 一次导入多个频道，无需逐个添加
- ✅ 自动解析频道名称、分组、Logo 等信息
- ✅ 支持定时自动刷新，保持频道列表最新
- ✅ 项目已内置港澳台及地方频道订阅，开箱即用

**适用场景**：
- 拥有 m3u/m3u8 格式的频道列表 URL
- 需要批量添加大量频道
- 使用第三方维护的频道列表

##### 管理现有外部源
- **修改**：点击频道旁的"编辑"按钮，修改后保存
- **删除**：点击"删除"按钮，确认后自动更新播放列表
- **启用/禁用**：通过开关快速控制频道的显示

**智能更新机制：**
- 添加/修改/删除外部源后，系统会自动重新生成播放列表
- 使用缓存机制加速更新（1-2秒内完成，无需重新抓取咪咕数据）
- 新添加的源显示在列表顶部，方便查看

**注意事项：**
- ⚠️ 自动抓取需要服务器能访问目标网页
- ⚠️ 部分网页可能有反爬虫机制，导致抓取失败
- ⚠️ 抓取失败时，系统会自动选择最长的候选链接作为备用
- ✅ 外部源配置保存在 `external-sources.json` 文件中

###配置文件说明

项目提供了示例配置文件，首次使用时需要复制并修改：

### 使用示例

```bash
# 杀掉进程
pkill -f "node app.js"
# 启动服务
node app.js

# 访问管理后台
http://localhost:1905/admin

# 如果设置了密码 (mpass=mypass)
http://localhost:1905/mypass/admin
```


## Node.js 本地运行

> 适合开发者和需要自定义修改的用户

### 环境要求

需要 NodeJS 18+ 环境

### 安装

```shell
git clone <your-repository-url>
cd iPTV
```

### 运行

```shell
node app.js
#lsof -ti:1905 | xargs kill -9 && node app.js
```

若需要修改配置，可以使用以下命令
Mac/Linux:

```shell
mport=1905 mhost="http://localhost:1905" node app.js
```

Windows下使用git-bash等终端:

```shell
set mport=1905 && set mhost="http://localhost:1905" && node app.js
```

Windows下使用PowerShell等终端:

```shell
$Env:mport=1905; $Env:mhost="http://localhost:1905"; node app.js
```

---

# 免责声明

>
> 本仓库仅供学习使用，请尊重版权，请勿利用此仓库从事商业行为及非法用途!

---

## License

本项目采用 GNU General Public License v3.0（GPL-3.0）开源许可。
详情请查看仓库根目录下的 `LICENSE` 文件。

<!--
## 🔖 版本发布

使用 `bump-version.js` 脚本统一管理版本号（自动更新 `package.json`、`package-lock.json`、`web/admin.html`、`README.md`、`.github/workflows/push_docker.yaml`）。

```bash
# 1. 更新版本号（自动修改 5 个文件）
node bump-version.js patch          # 1.4.3 → 1.4.4
node bump-version.js minor          # 1.4.3 → 1.5.0
node bump-version.js major          # 1.4.3 → 2.0.0
node bump-version.js 2.0.0          # 直接指定版本

# 2. 编辑 README.md 填写更新日志（脚本已自动插入占位条目）

# 3. 提交并打 tag
git add -A && git commit -m "release: vX.Y.Z"
git tag vX.Y.Z

# 4. 推送到 GitHub，手动触发 Actions 构建 Docker 镜像
git push && git push --tags
```
-->


