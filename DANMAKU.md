# 统一弹幕接口（含直播扩展）

播放器（Ceau 等）读 M3U 条目上的 `danmaku-url` 属性取弹幕。地址必须与该条目的播放地址**同源**（同协议、同主机、同端口），不含账号密码和 `#` 片段；本项目生成时写成 `${replace}/danmaku/<模块>/<id>`，输出时与频道地址一起展开成带访问前缀的本机地址，所以密码 / 用户令牌天然贯穿。

两种形态共用同一个元数据地址，播放器按 `live` 字段分流：

| | 点播（schema v1） | 直播扩展 |
|---|---|---|
| 时间轴 | 视频开头起的绝对秒 | 墙钟（服务器时间） |
| 取法 | 按分钟取 `?part=N`，每分钟一次 | 带游标每 `pollSeconds` 秒轮询一次 |
| 条目 `time` | 视频内秒 | 发送时刻的 Unix 秒 |
| 现用来源 | 爱奇艺影视（已下线，代码在 backup 分支） | 咪咕体育赛事聊天室 |

## 元数据 `GET <danmaku-url>`

```json
{
  "schemaVersion": 1,
  "videoID": "migu:room20261013104522520_SR4",
  "title": "斯诺克北爱尔兰公开赛 麦克吉尔PK囧哥 20:00",
  "available": true,
  "live": true,
  "pollSeconds": 5,
  "liveURL": "968658897/live",
  "duration": 86400,
  "segmentSeconds": 60,
  "segmentsURL": "968658897/segments"
}
```

- `videoID` 对同一场直播稳定，≤128 字符；换场次就换值。
- `liveURL` / `segmentsURL` 都是**相对元数据地址**解析的路径（也允许同源绝对地址），不许跨源。
- `duration` / `segmentSeconds` / `segmentsURL` 在直播时只为兼容老客户端保留：老客户端按分钟取 `segments?part=N`，服务端返回合法的空分段，不报错、也没有字。
- 直播结束后 `available` 变 `false`，播放器显示「暂无弹幕」。

## 点播分段 `GET <segmentsURL>?part=N`

N 从 1 起，每段 60 秒。返回 `schemaVersion`、`videoID`、`part`、`start`、`end` 和 `items`；`time` 为视频内绝对秒，必须落在 `[start, end]`。

## 直播增量 `GET <liveURL>[?cursor=<游标>]`

```json
{
  "schemaVersion": 1,
  "videoID": "migu:room20261013104522520_SR4",
  "live": true,
  "serverTime": 1792765929.1,
  "pollSeconds": 5,
  "cursor": "MTc5Mjc2NTkyODAwMDoxMzY5NTc4OTAwXzE1MTA3NDMzNjI",
  "items": [
    { "id": "1369578900_1510743362", "time": 1792765928.0, "text": "老差一点力气", "color": "#FBFFFF", "mode": "scroll" }
  ]
}
```

- 第一次不带 `cursor`：返回最近 `2 × pollSeconds` 秒的条目，开播画面不至于空着。
- 带 `cursor`：只返回比游标新的条目。游标是不透明字符串（≤128 字符），原样带回即可。
- `items` 按 `time` 升序；`time` 是发送时刻的 Unix 秒；`serverTime` 是服务器应答时的 Unix 秒。
- 条目限制与点播一致：`id` 非空 ≤128、`text` 非空 ≤300、`mode` 只有 `scroll` / `top` / `bottom`、单包 ≤2 MiB、≤10000 条。
- 状态码：403 = 拒绝（客户端显示「无权限」），其他非 200 = 暂不可用；都不影响播放。

### 播放器怎么画

直播没有共同的「视频内时间」，所以**不看播放器进度**，一律按服务器墙钟画：

1. 每次应答算一次时钟偏差 `skew = serverTime − 本机当前时间`。
2. 渲染轴 `t = 本机当前时间 + skew − (pollSeconds + 1)`。晚这几秒是为了让一包里的条目按各自 `time` 依次滚出来，而不是一次全涌上屏。
3. 条目在 `time` 过了 `t` 的那一刻入场，滚动时长与点播相同；比 `t` 旧 60 秒以上的条目直接丢掉。
4. 播放中每 `pollSeconds` 秒带最新游标取一次；暂停 / 退到后台 / 关弹幕就停；一次失败不清屏，下一轮照常；`videoID` 变了就清屏重来。
5. 咪咕官网自己也是消息一到就滚出来、不和画面对齐，画面比真实时间慢十几秒这件事两边一样，不用补偿。用户手动的「弹幕偏移」仍可叠加在 `t` 上。

## 咪咕体育赛事（本项目实现）

- 聊天室 ID 来自赛事 `basic-data` 的 `roomId`，不是 pID / mgdbId。抓赛事列表时按直播 pID 记下 `roomId`、标题、结束时间，落盘在数据目录 `migu-danmaku-rooms.json`，重启后仍可用。
- 弹幕用官网 `chatcache/v1/msg/msg-chat/<roomId>` 接口，不用登录；有人在看时每 5 秒拉一次、按消息 id 去重；30 秒没人请求就停止拉取。
- 只有赛事条目带 `danmaku-url`（`${replace}/danmaku/migu/<pID>`），固定电视频道（CCTV5 等）在咪咕上没有聊天室，不带。
- 接口路径：`/danmaku/migu/<pID>`（元数据）、`/danmaku/migu/<pID>/live`、`/danmaku/migu/<pID>/segments`。与频道地址走同一套访问密码 / 用户令牌鉴权。
