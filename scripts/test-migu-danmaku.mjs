#!/usr/bin/env node
/**
 * 咪咕体育赛事直播弹幕（extractors/migu/danmaku.js，协议见 DANMAKU.md）。
 *
 * 钉住的事：
 *   1. 官网聊天消息 → 统一弹幕条目的映射（id/time/颜色/长度），坏消息被丢。
 *   2. 聊天室记录按轮替换：抓到一半失败不丢上一份；pID 不在记录里的只回 available:false。
 *   3. 直播包：首包回最近 2×pollSeconds 秒；带游标只回更新的；同一条不重复发；
 *      失败一轮不清空手里的条目；30 秒没人请求就停轮询。
 *   4. 老客户端的 segments?part=N 回合法空分段。
 *   5. 播放列表输出口只给有聊天室的「${replace}/纯数字」条目补 danmaku-url，
 *      其他条目、已带属性的、relay 形态的一律不动。
 *
 * 运行： node scripts/test-migu-danmaku.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { createDanmakuService, toItem, POLL_SECONDS } from '../extractors/migu/danmaku.js'

const ROOM = 'room20261013104522520_SR4'
const msg = (id, timeMs, content, extra = {}) => ({ id, time: timeMs, content, type: 1, extendInfo: JSON.stringify({ cid: '1', c: '#FBFFFF', f: '6', ...extra }) })

// ---- 1. 映射 ----
{
  const item = toItem(msg('1369578900_1510743362', 1792765280767, '  老差一点\n力气 '))
  assert.deepEqual(item, { id: '1369578900_1510743362', timeMs: 1792765280767, time: 1792765280.767, text: '老差一点 力气', color: '#FBFFFF', mode: 'scroll' })
  assert.equal(toItem(msg('x', 1, 'a', { c: 'red' })).color, '#FFFFFF', '非法颜色退回白色')
  assert.equal(toItem({ id: 'x', time: 1, content: 'a', extendInfo: '{bad json' }).color, '#FFFFFF')
  assert.equal(toItem(msg('x', 1, '   ')), null, '空内容丢弃')
  assert.equal(toItem(msg('', 1, 'a')), null, '无 id 丢弃')
  assert.equal(toItem(msg('x', 'nope', 'a')), null, '无时间丢弃')
  assert.equal(toItem(msg('x', 1, 'a'.repeat(400))).text.length, 300, '超长截断')
}

// ---- 可控时钟与定时器 ----
function harness({ pages }) {
  let clock = 1792765900000
  const timers = []
  let calls = 0
  const service = createDanmakuService({
    persist: false,
    now: () => clock,
    setTimer: (fn, ms) => { const t = { fn, at: clock + ms, cleared: false }; timers.push(t); return t },
    clearTimer: t => { t.cleared = true },
    fetchImpl: async (url) => {
      assert.match(url, /msg-chat\/room20261013104522520_SR4$/)
      calls++
      const page = pages.shift()
      if (page === 'fail') return undefined
      return { code: 200, body: page }
    },
  })
  async function advance(ms) {
    clock += ms
    while (true) {
      const due = timers.filter(t => !t.cleared && t.at <= clock).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      due.cleared = true
      await due.fn()
    }
  }
  return { service, advance, calls: () => calls, now: () => clock, timers }
}

// ---- 2. 记录按轮替换 ----
{
  const { service } = harness({ pages: [] })
  assert.equal(service.recordRoom('968658897', { roomId: ROOM }), false, '没开轮不记')
  service.beginRound()
  assert.equal(service.recordRoom('968658897', { roomId: ROOM, title: '斯诺克 20:00', mgdbId: '120000596300', endTime: 1 }), true)
  assert.equal(service.recordRoom('abc', { roomId: ROOM }), false, 'pID 必须纯数字')
  assert.equal(service.recordRoom('1', { roomId: 'bad room/../x' }), false, 'roomId 只许安全字符')
  assert.equal(service.roomCount(), 0, '没提交前不生效')
  service.commitRound()
  assert.equal(service.roomCount(), 1)
  service.beginRound()
  service.recordRoom('2', { roomId: 'room2' })
  service.abandonRound()
  assert.equal(service.roomOf('968658897').roomId, ROOM, '放弃的一轮不覆盖上一份')

  const miss = await service.handleLocalRequest({ path: '/danmaku/migu/555' })
  assert.equal(miss.status, 200)
  assert.equal(JSON.parse(miss.body).available, false, '不认识的 pID 只说没有弹幕')
  assert.equal(await service.handleLocalRequest({ path: '/danmaku/migu/x' }), null, '不认领的路径交回')
  assert.equal(service.claimsLocalPath('/u/abc/danmaku/migu/968658897/live'), true, '带访问前缀也认')
  assert.equal(service.claimsLocalPath('/danmaku/migu/968658897/other'), false)
  assert.equal((await service.handleLocalRequest({ path: '/danmaku/migu/968658897', method: 'POST' })).status, 405)
}

// ---- 3. 直播包 ----
{
  const t0 = 1792765900000
  const pages = [
    [msg('a', t0 - 20000, '太早了'), msg('b', t0 - 3000, '第一条'), msg('c', t0 - 1000, '第二条')],
    [msg('b', t0 - 3000, '第一条'), msg('c', t0 - 1000, '第二条'), msg('d', t0 + 4000, '第三条')],
    'fail',
    [msg('d', t0 + 4000, '第三条'), msg('e', t0 + 14000, '第四条')],
  ]
  const { service, advance, calls } = harness({ pages })
  service.beginRound(); service.recordRoom('968658897', { roomId: ROOM, title: '斯诺克' }); service.commitRound()

  const meta = JSON.parse((await service.handleLocalRequest({ path: '/danmaku/migu/968658897' })).body)
  assert.equal(meta.live, true)
  assert.equal(meta.available, true)
  assert.equal(meta.videoID, `migu:${ROOM}`)
  assert.equal(meta.liveURL, '968658897/live')
  assert.equal(meta.segmentSeconds, 60)
  assert.equal(calls(), 0, '元数据不拉聊天室')

  const first = JSON.parse((await service.handleLocalRequest({ path: '/danmaku/migu/968658897/live', url: '/danmaku/migu/968658897/live' })).body)
  assert.equal(calls(), 1, '首次请求同步拉一次')
  assert.deepEqual(first.items.map(i => i.text), ['第一条', '第二条'], `首包只回最近 ${2 * POLL_SECONDS} 秒`)
  assert.equal(first.pollSeconds, POLL_SECONDS)
  assert.equal(first.serverTime, t0 / 1000)
  assert.ok(first.cursor && first.cursor.length <= 128)
  assert.deepEqual(Object.keys(first.items[0]), ['id', 'time', 'text', 'color', 'mode'], '不泄露内部 timeMs')

  const again = JSON.parse((await service.handleLocalRequest({ path: '/danmaku/migu/968658897/live', url: `/danmaku/migu/968658897/live?cursor=${first.cursor}` })).body)
  assert.deepEqual(again.items, [], '没有新条目就空')
  assert.equal(again.cursor, first.cursor, '游标不变')

  await advance(5000)
  assert.equal(calls(), 2, '5 秒轮询一次')
  const second = JSON.parse((await service.handleLocalRequest({ path: '/danmaku/migu/968658897/live', url: `/danmaku/migu/968658897/live?cursor=${first.cursor}` })).body)
  assert.deepEqual(second.items.map(i => i.text), ['第三条'], '只回比游标新的，已发过的不重复')

  await advance(5000)
  assert.equal(calls(), 3, '失败那一轮也算一次')
  const afterFail = JSON.parse((await service.handleLocalRequest({ path: '/danmaku/migu/968658897/live', url: '/danmaku/migu/968658897/live' })).body)
  assert.deepEqual(afterFail.items.map(i => i.text), ['第三条'], '失败一轮不清空手里的条目')

  await advance(5000)
  assert.equal(calls(), 4)
  const third = JSON.parse((await service.handleLocalRequest({ path: '/danmaku/migu/968658897/live', url: `/danmaku/migu/968658897/live?cursor=${second.cursor}` })).body)
  assert.deepEqual(third.items.map(i => i.text), ['第四条'])
  assert.equal(service.feedState(ROOM).running, true)

  // 30 秒没人要 → 停
  await advance(31000)
  assert.equal(service.feedState(ROOM).running, false, '无人请求 30 秒后停轮询')
  const callsBefore = calls()
  await advance(60000)
  assert.equal(calls(), callsBefore, '停了就不再打官网')

  const bad = JSON.parse((await service.handleLocalRequest({ path: '/danmaku/migu/968658897/live', url: '/danmaku/migu/968658897/live?cursor=%%%' })).body)
  assert.ok(Array.isArray(bad.items), '坏游标当首包处理')
  assert.equal(service.feedState(ROOM).running, true, '再有人要就重新开始')
  service.shutdown()
  assert.equal(service.feedState(ROOM).running, false)

  // 4. 老客户端分段
  const seg = JSON.parse((await service.handleLocalRequest({ path: '/danmaku/migu/968658897/segments', url: '/danmaku/migu/968658897/segments?part=3' })).body)
  assert.deepEqual(seg, { schemaVersion: 1, videoID: `migu:${ROOM}`, part: 3, start: 120, end: 180, items: [] })
}

// ---- 5. 播放列表注入 ----
{
  const { service } = harness({ pages: [] })
  const m3u = [
    '#EXTM3U x-tvg-url="${replace}/playback.xml"',
    '#EXTINF:-1 tvg-id="a" tvg-name="斯诺克" tvg-logo="http://x/l.png" source-ids="migu" group-title="体育-今天",斯诺克 20:00',
    '${replace}/968658897',
    '#EXTINF:-1 tvg-id="CCTV5" tvg-name="CCTV5体育" group-title="央视",CCTV5体育',
    '${replace}/608807420',
    '#EXTINF:-1 tvg-id="b" group-title="体育-今天",已带',
    '${replace}/968658897',
    '#EXTINF:-1 tvg-id="c" group-title="外部",外部直链',
    'https://example.com/live/968658897',
    '',
  ].join('\n')
  assert.equal(service.decorateM3u(m3u), m3u, '没有聊天室记录时原样')
  service.beginRound(); service.recordRoom('968658897', { roomId: ROOM }); service.commitRound()
  const out = service.decorateM3u(m3u.replace('tvg-id="b" group-title', 'tvg-id="b" danmaku-url="x" group-title'))
  const lines = out.split('\n')
  assert.equal(lines[1], '#EXTINF:-1 danmaku-url="${replace}/danmaku/migu/968658897" tvg-id="a" tvg-name="斯诺克" tvg-logo="http://x/l.png" source-ids="migu" group-title="体育-今天",斯诺克 20:00')
  assert.equal(lines[3], '#EXTINF:-1 tvg-id="CCTV5" tvg-name="CCTV5体育" group-title="央视",CCTV5体育', '没有聊天室的 pID 不动')
  assert.equal(lines[5], '#EXTINF:-1 tvg-id="b" danmaku-url="x" group-title="体育-今天",已带', '已带属性的不重复加')
  assert.equal(lines[7], '#EXTINF:-1 tvg-id="c" group-title="外部",外部直链', '第三方直链不动')
  assert.equal(service.decorateM3u('${replace}/968658897\n'), '${replace}/968658897\n', '只有地址行没有 EXTINF 不动')
  assert.equal(service.decorateM3u(''), '')
}

console.log('test-migu-danmaku: all passed')
