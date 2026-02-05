# iPTV

**当前版本：v1.0.0**

# 功能特性

- ✅ 支持多种直播源（咪咕、其他源）
- ✅ 支持回看功能（当天内容）
- ✅ 多画质选择（标清/高清/蓝光/原画/4K）
- ✅ Docker 一键部署
- ✅ **Web 管理后台** - 可视化自定义频道分组
- ✅ 自动更新节目单

# 快速开始

## 在线播放列表

直接使用以下地址添加到播放器（支持回看当天内容）：

```
https://raw.githubusercontent.com/akiralereal/iptv/main/interface.txt

https://akiralereal.github.io/iptv/interface.txt
```

## 本地部署

### 注意事项

1. 登录后使用请注意账号安全
2. 需要中国大陆网络环境才可正常访问

### 配置说明

服务默认支持本机和局域网访问。如需使用账号登录获取高画质，请配置以下参数。

| 变量名          | 默认值 | 类型    | 介绍                                                                                      |
| --------------- | ------ | ------- | ----------------------------------------------------------------------------------------- |
| muserId         |        | string  | 用户id<br>可在网页端登录获取                                                              |
| mtoken          |        | string  | 用户token<br>可在网页端登录获取                                                           |
| mport           | 1905   | number  | 本地运行端口号                                                                            |
| mhost           |        | string  | 公网/自定义访问地址<br>格式<http://ip:port>                                               |
| mrateType       | 3      | number  | 画质<br>2: 标清<br>3: 高清<br>4: 蓝光<br>7: 原画<br>9: 4k<br>ps:蓝光及以上需要登录且有VIP |
| mpass           |        | string  | 访问密码 大小写字母和数字<br>添加后访问格式 <http://ip:port/mpass/>...                    |
| menableHDR      | true   | boolean | 是否开启HDR                                                                               |
| menableH265     | true   | boolean | 是否开启h265(原画画质)，开启后可能存在兼容性问题，比如浏览器播放没有画面                  |
| mupdateInterval | 6      | string  | 节目信息更新间隔，单位小时，不建议设置太短                                                |

## Web 管理后台

本项目提供可视化的 Web 管理界面，方便您自定义频道分组。

### 访问地址

- **无密码**: `http://ip:port/admin`
- **有密码**: `http://ip:port/mpass/admin`

### 功能说明

#### 1. 查看所有频道
- 左侧面板显示从直播源获取的所有频道，按分类展示（央视、体育、卫视、地方等）
- 实时加载最新的频道列表

#### 2. 搜索频道
- 支持实时搜索，快速查找您想要的频道
- 支持模糊匹配频道名称

#### 3. 创建自定义分组
- 点击"➕ 新建分组"按钮创建自定义分组
- 支持自定义分组名称（如"常看频道"、"体育频道"、"家人最爱"等）
- 可创建多个分组进行分类管理

#### 4. 添加频道到分组
- 点击频道旁的"添加 ➜"按钮快速将频道加入分组
- 自动去重，避免重复添加
- 支持批量添加多个频道

#### 5. 管理分组
- **编辑分组名称** - 修改分组名称
- **删除分组** - 删除整个分组及其所有频道
- **移除频道** - 从分组中移除单个频道
- **重置所有分组** - 一键清空所有自定义分组（需确认）

#### 6. 启用/禁用自定义分组
- 勾选"启用自定义分组"后，播放列表将**只显示**您自定义的频道
- 取消勾选后恢复显示所有原始频道
- 可随时切换，方便灵活使用

#### 7. 保存配置
- 点击"💾 保存配置"按钮保存您的所有设置
- 配置保存在 `custom-channels.json` 文件中
- 服务重启后自动加载配置

### 使用示例

```bash
# 启动服务
node app.js

# 访问管理后台
http://localhost:1905/admin

# 如果设置了密码 (mpass=mypass)
http://localhost:1905/mypass/admin
```

### Docker 环境使用

如果使用 Docker，配置会自动持久化。也可以挂载配置文件：

```yaml
volumes:
  - ./custom-channels.json:/migu/custom-channels.json
```

## node

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
```

若需要修改配置，可以使用以下命令
Mac/Linux:

```shell
mport=3000 mhost="http://localhost:3000" node app.js
```

Windows下使用git-bash等终端:

```shell
set mport=3000 && set mhost="http://localhost:3000" && node app.js
```

Windows下使用PowerShell等终端:

```shell
$Env:mport=3000; $Env:mhost="http://localhost:3000"; node app.js
```

## docker

### Docker Pull

```shell
docker pull akiralereal/iptv:latest
# 或指定版本
docker pull akiralereal/iptv:1.0.0
```

### 快速运行

```shell
docker run -d -p 1905:1905 --name iptv akiralereal/iptv:latest
```

### 自定义配置运行

```shell
docker run -d -p 1905:1905 \
  -e muserId=你的ID \
  -e mtoken=你的token \
  -e mport=1905 \
  -e mhost="http://192.168.1.100:1905" \
  -e mrateType=4 \
  --name iptv \
  akiralereal/iptv:latest
```

### Docker Compose 部署

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
      - mhost=                                  # 可选：外部访问地址（如 http://192.168.1.100:1905）
      - mrateType=3                             # 画质：2=标清，3=高清，4=蓝光(需VIP)
      - mpass=                                  # 可选：访问密码（设置后访问: http://ip:port/密码/...）
      - menableHDR=true                         # 可选：是否开启HDR
      - menableH265=true                        # 可选：是否开启H265原画（可能有兼容性问题）
      - mupdateInterval=6                       # 可选：节目信息更新间隔（小时）
    restart: always                             # 容器异常退出后自动重启
```

启动服务：

```shell
docker-compose up -d
```

常用命令：

```shell
# 查看日志
docker-compose logs -f

# 停止服务
docker-compose down

# 重启服务
docker-compose restart

# 更新镜像
docker-compose pull && docker-compose up -d
```

### 手动构建镜像

若需要手动构建镜像，可以使用以下命令

```shell
docker build -t akiralereal/iptv:latest .
```

# 免责声明

> [!important]
>
> 1. 本仓库仅供学习使用，请尊重版权，请勿利用此仓库从事商业行为及非法用途!
> 2. 使用本仓库的过程中可能会产生版权数据。对于这些版权数据，本仓库不拥有它们的所有权。为了避免侵权，使用者务必在 24小时内清除使用本仓库的过程中所产生的版权数据。
> 3. 由于使用本仓库产生的包括由于本协议或由于使用或无法使用本仓库而引起的任何性质的任何直接、间接、特殊、偶然或结果性损害（包括但不限于因商誉损失、停工、计算机故障或故障引起的损害赔偿，或任何及所有其他商业损害或损失）由使用者负责。
> 4. **禁止在违反当地法律法规的情况下使用本仓库。** 对于使用者在明知或不知当地法律法规不允许的情况下使用本仓库所造成的任何违法违规行为由使用者承担，本仓库不承担由此造成的任何直接、间接、特殊、偶然或结果性责任。
> 5. 如果官方平台觉得本仓库不妥，可联系本仓库更改或移除。
