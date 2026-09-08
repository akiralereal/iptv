#!/usr/bin/env node
/**
 * 频道主键对「地址换签名」的稳定性回归测试（issue #123）
 *
 * 背景：buildChannelId 把播放地址算进频道主键（`ext-<sha1>`），而 hiddenChannels /
 * channelRenameMap / channelGroupMap / channelOrder 四张表全部按 `原始分组::频道ID` 存。
 * 源每次刷新若换一个带签名的地址，主键就变，这四项个性化设置会**静默全部失效**：
 * 隐藏的频道自己冒回分组、改过的名字复原、挪过的位置弹回原处，且用户在界面上
 * 看不到任何线索（「已隐藏」列表是按当前全集反查渲染的，失配的那条直接不显示）。
 *
 * 实测触发源：内置源纬来体育写盘地址形如 `...vl.m3u8?expire=<秒>&sign=<md5>`，
 * 每个抓取周期必变；B 站迁 relay 之前同样带 expires / sign。
 *
 * 不变量：
 *  1. 只有时效 / 签名参数变化 → 频道 ID 必须不变（本次修复点）
 *  2. 非时效参数（qn / quality 等可能区分频道的）不同 → ID 必须不同
 *     ——剥错会让两条频道算出同一个 ID，在 applyConfig 的 channelMap 里互相覆盖，
 *       表现为播放列表静默少一个频道，比原 bug 更严重
 *  3. 占位地址（咪咕单段 / 模块 proxy·relay）与系统公告频道的 ID 形态不受影响
 *
 * 注意：地址的**路径**变化（如 chunklist1.m3u8 → playlist.m3u8）仍会换 ID，
 * 本次有意不处理——见 issue #123 的讨论，那类交给「按名字的屏蔽规则」解决。
 *
 * 运行： node scripts/test-channel-id-stability.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { buildChannelId, applyConfig } from '../utils/playlistConfig.js'

for (const k of ['log', 'info', 'warn']) {
  const orig = console[k]
  console[k] = (...a) => { if (a.some(x => typeof x === 'string' && /应用播放列表配置|配置应用完成/.test(x))) return; orig.apply(console, a) }
}

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }

const id = (url, groupName = '体育', channelName = '纬来体育', tvgName = '纬来体育') =>
  buildChannelId({ groupName, channelName, tvgName, url })

console.log('频道主键稳定性回归测试 (issue #123)')

// ── 1. 修复点：签名 / 有效期变化不得改变频道 ID ──────────────────────────────
check('纬来体育实测形态：expire + sign 变化 → ID 不变', () => {
  const a = id('https://hlsz.yjjcfw.com/live/vl.m3u8?expire=1786948372&sign=2e4a56b89fe644db147552011f972714')
  const b = id('https://hlsz.yjjcfw.com/live/vl.m3u8?expire=1787034772&sign=ff0912ab77c3410e9a1d55e0c4b83a62')
  assert.equal(a, b)
})

check('B 站迁 relay 前的形态：expires / sign / sigparams 变化 → ID 不变', () => {
  const base = 'https://cn-live.bilivideo.com/live-bvc/123/live_456.m3u8'
  const a = id(`${base}?expires=1757200000&sign=aaaa&sigparams=cdn,expires&cdn=ov-gotcha05`)
  const b = id(`${base}?expires=1757900000&sign=bbbb&sigparams=cdn,expires&cdn=ov-gotcha05`)
  assert.equal(a, b)
})

check('时效参数大小写混写（wsSecret / txSecret）同样被剥离', () => {
  const base = 'http://push.example.com/live/ch1.m3u8'
  assert.equal(id(`${base}?wsSecret=abc&wsTime=1`), id(`${base}?wssecret=zzz&wsTime=1`))
})

check('只带时效参数时，剥完退化成无 query 的地址（与本来就没 query 的同一条频道一致）', () => {
  const bare = 'https://hlsz.yjjcfw.com/live/vl.m3u8'
  assert.equal(id(`${bare}?expire=1&sign=a`), id(bare))
})

// ── 2. 安全边界：不能剥过头，否则两条频道会撞成一个、播放列表静默少频道 ──────
check('非时效参数（qn 清晰度）不同 → ID 必须不同', () => {
  const base = 'http://cdn.example.com/live/ch.m3u8'
  assert.notEqual(id(`${base}?qn=10000`), id(`${base}?qn=250`))
})

check('非时效参数与时效参数混在一起：只剥时效的，保留 qn', () => {
  const base = 'http://cdn.example.com/live/ch.m3u8'
  const hd = id(`${base}?qn=10000&expire=111&sign=aaa`)
  const sd = id(`${base}?qn=250&expire=222&sign=bbb`)
  assert.notEqual(hd, sd)                                   // 清晰度仍然区分得开
  assert.equal(hd, id(`${base}?qn=10000&expire=999&sign=zzz`))  // 但时效变化不影响
})

check('地址路径变化仍然换 ID（本次有意不处理，守住边界不被误改）', () => {
  assert.notEqual(
    id('http://38.64.72.148/hls/modn/list/4005/chunklist1.m3u8'),
    id('http://38.64.72.148/hls/modn/list/4005/playlist.m3u8')
  )
})

check('分组 / 频道名 / tvg-name 仍参与主键（不同频道不得撞 ID）', () => {
  const u = 'http://cdn.example.com/live/ch.m3u8?expire=1&sign=a'
  assert.notEqual(id(u, '体育'), id(u, '央视'))
  assert.notEqual(id(u, '体育', 'A'), id(u, '体育', 'B'))
  assert.notEqual(id(u, '体育', 'A', 'tvg-A'), id(u, '体育', 'A', 'tvg-B'))
})

// ── 3. 其它主键形态不受影响 ────────────────────────────────────────────────
check('咪咕单段占位地址：ID 仍是 pID 原值，且 query 照旧被忽略', () => {
  assert.equal(id('${replace}/608807416'), '608807416')
  assert.equal(id('${replace}/608807416?x=1'), '608807416')
})

check('模块 proxy / relay 占位地址：ref 不变则 ID 不变', () => {
  const a = id('${replace}/relay/bili-123.m3u8')
  assert.equal(a, id('${replace}/relay/bili-123.m3u8'))
  assert.notEqual(a, id('${replace}/relay/bili-456.m3u8'))
  assert.ok(a.startsWith('ext-'))
})

check('无地址的频道：仍按 分组 / 名字 / tvg-name 算，不抛错', () => {
  const a = buildChannelId({ groupName: 'A', channelName: 'X', tvgName: 'X', url: '' })
  assert.match(a, /^[0-9a-f]{16}$/)
  assert.notEqual(a, buildChannelId({ groupName: 'A', channelName: 'Y', tvgName: 'Y', url: '' }))
})

check('带 fragment 的地址不被破坏（剥参数不得吃掉 #... 或误判参数名）', () => {
  const a = id('http://cdn.example.com/live/ch.m3u8?expire=1&qn=250#frag')
  const b = id('http://cdn.example.com/live/ch.m3u8?expire=2&qn=250#frag')
  assert.equal(a, b)
  assert.notEqual(a, id('http://cdn.example.com/live/ch.m3u8?expire=1&qn=250#other'))
})

// ── 4. 端到端：用户真正在意的不变量 ─────────────────────────────────────────
const groupsWith = url => ([{
  name: '体育',
  channels: [{ id: id(url), name: '纬来体育', url }]
}])
const baseConfig = () => ({
  channelGroupMap: {}, channelRenameMap: {}, channelOrder: {}, hiddenChannels: [],
  customGroups: [], groupOrder: [], deletedGroups: [], groupRenameMap: {}, groupSortMode: {}
})
const visible = (url, cfg) => applyConfig(groupsWith(url), cfg).some(g => g.channels.some(c => c.name === '纬来体育'))

const URL_T1 = 'https://hlsz.yjjcfw.com/live/vl.m3u8?expire=1786948372&sign=2e4a56b8'
const URL_T2 = 'https://hlsz.yjjcfw.com/live/vl.m3u8?expire=1787034772&sign=ff0912ab'

check('端到端：隐藏纬来体育后，源换了签名地址，它不得自己冒回分组', () => {
  const cfg = baseConfig()
  cfg.hiddenChannels = [`体育::${id(URL_T1)}`]
  assert.equal(visible(URL_T1, cfg), false, '当次刷新应隐藏')
  assert.equal(visible(URL_T2, cfg), false, '换签名后仍须隐藏（issue #123 的核心症状）')
})

check('端到端：重命名同样跨换签名保留', () => {
  const cfg = baseConfig()
  cfg.channelRenameMap = { [`体育::${id(URL_T1)}`]: '纬来体育台' }
  const after = applyConfig(groupsWith(URL_T2), cfg)
  assert.ok(after.some(g => g.channels.some(c => c.name === '纬来体育台')))
})

console.log(`\n全部通过：${passed}/14 ✅`)
