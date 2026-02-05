# 自定义频道分组说明

本项目支持通过配置文件自定义频道列表和分组。

## 快速开始

1. **编辑配置文件** `custom-channels.json`

2. **启用自定义分组**：将 `enableCustomGroups` 设为 `true`

3. **重启服务**，自定义配置将自动生效

## 配置说明

### 完整配置示例

```json
{
  "customGroups": [
    {
      "name": "我的收藏",
      "channels": [
        "CCTV1综合",
        "CCTV5体育",
        "湖南卫视"
      ]
    },
    {
      "name": "体育频道",
      "channels": [
        "CCTV5体育",
        "CCTV5+体育赛事"
      ]
    }
  ],
  "excludeChannels": [
    "购物",
    "广告"
  ],
  "enableCustomGroups": false
}
```

### 配置项说明

| 配置项 | 类型 | 说明 |
|--------|------|------|
| `enableCustomGroups` | Boolean | 是否启用自定义分组。`false`=使用原始分组，`true`=使用自定义分组 |
| `customGroups` | Array | 自定义分组列表 |
| `customGroups[].name` | String | 分组名称 |
| `customGroups[].channels` | Array | 该分组包含的频道名称列表 |
| `excludeChannels` | Array | 要排除的频道关键词（部分匹配） |

## 使用场景

### 场景 1：只保留常看的频道

```json
{
  "enableCustomGroups": true,
  "customGroups": [
    {
      "name": "常看频道",
      "channels": [
        "CCTV1综合",
        "CCTV5体育",
        "CCTV13新闻",
        "湖南卫视",
        "浙江卫视",
        "东方卫视"
      ]
    }
  ]
}
```

### 场景 2：按兴趣分组

```json
{
  "enableCustomGroups": true,
  "customGroups": [
    {
      "name": "新闻",
      "channels": ["CCTV1综合", "CCTV13新闻", "凤凰中文"]
    },
    {
      "name": "体育",
      "channels": ["CCTV5体育", "CCTV5+体育赛事", "广东体育"]
    },
    {
      "name": "影视",
      "channels": ["CCTV6电影", "CCTV8电视剧"]
    },
    {
      "name": "卫视",
      "channels": ["湖南卫视", "浙江卫视", "江苏卫视", "东方卫视"]
    }
  ]
}
```

### 场景 3：排除不想看的频道（保留原分组）

```json
{
  "enableCustomGroups": false,
  "excludeChannels": [
    "购物",
    "广告",
    "测试"
  ]
}
```

## 获取频道名称

不确定频道的准确名称？有两种方法：

**方法 1：查看生成的播放列表**
```bash
# 启动服务后查看
cat interface.txt | grep "tvg-name"
```

**方法 2：访问服务接口**
```
http://your-ip:1905/
```
查看返回的 M3U 文件中的频道名称。

## 注意事项

1. **频道名称必须完全匹配**（区分大小写）
2. **同一个频道可以出现在多个分组中**
3. **如果配置的频道不存在，会自动跳过**
4. **修改配置后需要重启服务才能生效**
5. **`excludeChannels` 支持模糊匹配**，如 "购物" 会排除所有包含"购物"的频道

## Docker 环境使用

### 方法 1：挂载配置文件（推荐）

```bash
docker run -d -p 1905:1905 \
  -v $(pwd)/custom-channels.json:/migu/custom-channels.json \
  --name iptv \
  akiralereal/iptv:latest
```

### 方法 2：Docker Compose

```yaml
services:
  iptv:
    image: akiralereal/iptv:latest
    container_name: iptv
    ports:
      - "1905:1905"
    volumes:
      - ./custom-channels.json:/migu/custom-channels.json
    restart: always
```

## 常见问题

**Q: 配置不生效？**
A: 确认 `enableCustomGroups` 设为 `true`，并重启服务。

**Q: 找不到某些频道？**
A: 检查频道名称是否完全匹配，可以先不启用自定义分组，查看原始频道列表。

**Q: 可以混合使用原分组和自定义分组吗？**
A: 不可以，`enableCustomGroups=true` 时只显示自定义分组。但可以在自定义分组中复制原分组结构。

**Q: 排除功能对自定义分组有效吗？**
A: `excludeChannels` 总是先执行，无论是否启用自定义分组。
