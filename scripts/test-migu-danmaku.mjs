#!/usr/bin/env node
/**
 * 咪咕体育赛事直播弹幕（extractors/migu/danmaku.js，协议见 DANMAKU.md）。
 *
 * 钉住的事：
 *   1. 官网聊天消息 → 统一弹幕条目的映射（id/time/颜色/长度），坏消息被丢。
 *   2. 聊天室记录按轮替换：抓到一半失败不丢上一份；pID 不在记录里的只回 available:false。
 *   3. 直播包：首包回最近 2×pollSeconds 秒；带游标只回更新的；同一条不重复发；
 *      失败一轮不清空手里的条目；30 秒没人请求就停。
 *   4. 老客户端的 segments?part=N 回合法空分段。
 *   5. 播放列表输出口只给有聊天室的「${replace}/纯数字」条目补 danmaku-url，
 *      其他条目、已带属性的、relay 形态的一律不动。
 *   6. 长连接：解官网帧（gzip+URL 编码 base64+protobuf）；注册成功才进房间；进房后停 chatcache，
 *      断线退回 chatcache 并重连；没人看就断开。
 *   7. time 打成收到的时刻（官网晚到的消息也能落进播放器窗口）；热词限流；排队太长就丢。
 *
 * 运行： node scripts/test-migu-danmaku.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { chatMessagesOf, createDanmakuService, toItem, POLL_SECONDS } from '../extractors/migu/danmaku.js'

const ROOM = 'room20261013104522520_SR4'
const msg = (id, timeMs, content, extra = {}) => ({ id, time: timeMs, content, type: 1, extendInfo: JSON.stringify({ cid: '1', c: '#FBFFFF', f: '6', ...extra }) })

// ---- 1. 映射 ----
{
  const item = toItem(msg('1369578900_1510743362', 1792765280767, '  老差一点\n力气 '))
  assert.deepEqual(item, { id: '1369578900_1510743362', timeMs: 1792765280767, time: 1792765280.767, text: '老差一点 力气', color: '#FBFFFF', mode: 'scroll' })
  assert.equal(toItem(msg('x', 1, 'a', { c: 'red' })).color, '#FFFFFF', '非法颜色退回白色')
  assert.equal(toItem({ id: 'x', time: 1, content: 'a', extendInfo: '{"textcolor":"#ebe562"}' }).color, '#EBE562', '长连接的颜色字段')
  assert.equal(toItem({ id: 'x', time: 1, content: 'a', extendInfo: '{bad json' }).color, '#FFFFFF')
  assert.equal(toItem(msg('x', 1, '   ')), null, '空内容丢弃')
  assert.equal(toItem(msg('', 1, 'a')), null, '无 id 丢弃')
  assert.equal(toItem(msg('x', 'nope', 'a')), null, '无时间丢弃')
  assert.equal(toItem(msg('x', 1, 'a'.repeat(400))).text.length, 300, '超长截断')
}

// ---- 可控时钟与定时器 ----
function harness({ pages, createSocket = () => { throw new Error('no socket') } }) {
  let clock = 1792765900000
  const timers = []
  let calls = 0
  const service = createDanmakuService({
    persist: false,
    createSocket,
    now: () => clock,
    setTimer: (fn, ms) => { const t = { fn, at: clock + ms, cleared: false }; timers.push(t); return t },
    clearTimer: t => { t.cleared = true },
    fetchImpl: async (url) => {
      if (url.endsWith('/getWsToken')) return { code: 200, body: { wsToken: 'tok' } }
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
    [msg('a', t0 - 400000, '太早了'), msg('b', t0 - 30000, '第一条'), msg('c', t0 - 1000, '第二条')],
    [msg('b', t0 - 30000, '第一条'), msg('c', t0 - 1000, '第二条'), msg('d', t0 + 4000, '第三条')],
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
  assert.deepEqual(first.items.map(i => i.text), ['第一条', '第二条'], '太旧的官网消息不上屏')
  assert.deepEqual(first.items.map(i => i.time), [t0 / 1000, (t0 + 300) / 1000], 'time 是收到的时刻，按间隔排开')
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
  assert.deepEqual(afterFail.items.map(i => i.text), ['第一条', '第二条', '第三条'], `失败一轮不清空手里的条目，首包回最近 ${2 * POLL_SECONDS} 秒`)

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

// ---- 6. 长连接 ----
function varint(n) {
  const out = []
  while (n >= 128) { out.push((n % 128) | 128); n = Math.floor(n / 128) }
  out.push(n)
  return Buffer.from(out)
}
const pbInt = (field, n) => Buffer.concat([varint(field * 8), varint(n)])
const pbBytes = (field, value) => { const b = Buffer.from(value); return Buffer.concat([varint(field * 8 + 2), varint(b.length), b]) }
const liveMsg = (id, timeMs, text, hot = false) => Buffer.concat([
  pbBytes(17, id), pbInt(18, timeMs), pbBytes(19, text), pbBytes(21, Buffer.from([0xff, 0x01])),
  ...(hot ? [pbInt(23, 1)] : []), pbBytes(24, '{"textcolor":"#EBE562"}'),
])
function chatFrame(...messages) {
  const broadcast = Buffer.concat([pbBytes(3, Buffer.from([0x90, 0x01, 0x01])), ...messages.map(m => pbBytes(4, m)), pbInt(6, 317140)])
  const packets = JSON.stringify([{ isProtobuf: true, msgId: 'm', protobuf: encodeURIComponent(broadcast.toString('base64')) }, { mgdbId: '1', ranking: [] }])
  return JSON.stringify({ compressType: 1, svrSign: 'PushSvrChat', msgType: 0, msg: gzipSync(packets).toString('latin1') })
}
class FakeSocket extends EventTarget {
  sent = []
  closed = false
  send(text) { this.sent.push(JSON.parse(text)) }
  close() { this.closed = true; this.dispatchEvent(new Event('close')) }
  emit(data) { this.dispatchEvent(Object.assign(new Event('message'), { data })) }
  open() { this.dispatchEvent(new Event('open')) }
}
{
  const t0 = 1792765900000
  assert.deepEqual(chatMessagesOf(JSON.parse(chatFrame(liveMsg('a_1', t0, '切尔西加油！')))), [{ id: 'a_1', time: t0, content: '切尔西加油！', extendInfo: '{"textcolor":"#EBE562"}' }])
  assert.deepEqual(chatMessagesOf({ svrSign: 'DataCenter', msg: 'x' }), [], '别的帧不认')

  const sockets = []
  const { service, advance, calls, now } = harness({
    pages: [[], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], []],
    createSocket: url => { assert.equal(url, 'wss://wsschatpush.miguvideo.com/push_ws'); const s = new FakeSocket(); sockets.push(s); return s },
  })
  service.beginRound(); service.recordRoom('1', { roomId: ROOM }); service.commitRound()
  const live = async cursor => JSON.parse((await service.handleLocalRequest({ path: '/danmaku/migu/1/live', url: `/danmaku/migu/1/live${cursor ? `?cursor=${cursor}` : ''}` })).body)

  const first = await live()
  await Promise.resolve()
  const socket = sockets[0]
  socket.open()
  assert.equal(socket.sent[0].type, 1, '先注册')
  assert.equal(socket.sent[0].wsToken, 'tok')
  assert.equal(socket.sent.length, 1, '注册成功前不进房间')
  socket.emit('{"msgType":8,"svrSign":"PushSvr","msg":{"optType":1,"result":"SUCC"}}')
  assert.deepEqual(socket.sent[1], { domainName: 'PushSvrChat', groupId: ROOM, wsToken: 'tok', type: 6 })
  assert.equal(service.feedState(ROOM).joined, true)

  // 7. 官网晚 30 秒才推来的消息，time 仍是收到的时刻
  socket.emit('不是 JSON')
  socket.emit(chatFrame(liveMsg('late', now() - 30000, '帕尔默红牌'), liveMsg('h1', now() - 280000, '足球会员足够精彩', true)))
  const fresh = await live(first.cursor)
  assert.deepEqual(fresh.items.map(i => i.text), ['帕尔默红牌', '足球会员足够精彩'])
  assert.equal(fresh.items[0].time, now() / 1000, '不用官网发送时间')
  assert.equal(fresh.items[0].color, '#EBE562')

  socket.emit(chatFrame(liveMsg('h2', now(), '足球会员，足够 精彩！', true), liveMsg('late', now(), '帕尔默红牌')))
  assert.deepEqual((await live(fresh.cursor)).items, [], '同样的话 10 秒内不放第二条，同 id 不重复')
  socket.emit(chatFrame(...Array.from({ length: 60 }, (_, i) => liveMsg(`n${i}`, now(), `话${i}`))))
  const burst = await live(fresh.cursor)
  assert.ok(burst.items.length > 0 && burst.items.length <= 17, '排队超过 5 秒的丢掉')
  assert.ok(burst.items.at(-1).time - now() / 1000 <= 5)
  assert.deepEqual(burst.items.map(i => i.time), burst.items.map(i => i.time).toSorted((a, b) => a - b))

  const pollsWhileJoined = calls()
  for (let i = 0; i < 4; i++) { await advance(5000); await live() }
  assert.equal(calls(), pollsWhileJoined, '进房后不打 chatcache')
  await advance(5000); await live()
  assert.ok(socket.sent.some(m => m.type === 8), '发心跳')
  socket.emit('{}')

  // 断线：退回 chatcache，过一会重连
  socket.close()
  assert.equal(service.feedState(ROOM).joined, false)
  await advance(5000); await live()
  assert.ok(calls() > pollsWhileJoined, '断线后 chatcache 兜底')
  assert.equal(sockets.length, 1, '重连有间隔')
  await advance(5000); await live()
  await Promise.resolve()
  assert.equal(sockets.length, 2, '自动重连')
  sockets[1].open()
  sockets[1].emit('{"msgType":8,"svrSign":"PushSvr","msg":{"optType":1,"result":"SUCC"}}')

  // 没人看就断开
  await advance(31000)
  assert.equal(service.feedState(ROOM).running, false)
  assert.equal(sockets[1].closed, true, '无人请求后断开长连接')
  service.shutdown()
}

console.log('test-migu-danmaku: all passed')
