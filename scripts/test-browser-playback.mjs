#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const origin = 'http://iptv.test:1905'
const pageUrl = `${origin}/admin`
const cases = [
  ['普通咪咕入口', `${origin}/608807420`, `${origin}/proxy/608807420.m3u8`],
  ['相对地址', '/608807420', `${origin}/proxy/608807420.m3u8`],
  ['密码与账号前缀', `${origin}/my%20pass/user/token/608807420`, `${origin}/my%20pass/user/token/proxy/608807420.m3u8`],
  ['回看与配置档参数', `${origin}/608807420?playbackstart=20261005190000&playbackend=20261005200000&profile=family#live`, `${origin}/proxy/608807420.m3u8?playbackstart=20261005190000&playbackend=20261005200000&profile=family#live`],
  ['咪咕兼容入口', `${origin}/pass/relay/608807420.m3u8`, `${origin}/pass/proxy/608807420.m3u8`],
  ['已有全代理', `${origin}/proxy/608807420.m3u8`, `${origin}/proxy/608807420.m3u8`],
  ['山东齐鲁入口', `${origin}/iqilu-typd`, `${origin}/proxy/iqilu-typd.m3u8`],
  ['山东齐鲁兼容入口', `${origin}/pass/relay/iqilu-sdws.m3u8?profile=family`, `${origin}/pass/proxy/iqilu-sdws.m3u8?profile=family`],
  ['齐鲁已有全代理', `${origin}/proxy/iqilu-sdws.m3u8`, `${origin}/proxy/iqilu-sdws.m3u8`],
  ['宁波中继入口', `${origin}/pass/relay/ningbo-news.m3u8?profile=family`, `${origin}/pass/proxy/ningbo-news.m3u8?profile=family`],
  ['宁波旧式入口', `${origin}/ningbo-drama`, `${origin}/proxy/ningbo-drama.m3u8`],
  ['宁德不改写', `${origin}/relay/ningde-news.m3u8`, `${origin}/relay/ningde-news.m3u8`],
  ['央视频入口', `${origin}/relay/ysp-cctv1.m3u8`, `${origin}/relay/ysp-cctv1.m3u8`],
  ['其他 HLS 地址', `${origin}/live/index.m3u8`, `${origin}/live/index.m3u8`],
  ['本地短片', `${origin}/assets/announcement.mp4`, `${origin}/assets/announcement.mp4`],
  ['FLV', `${origin}/live/stream.flv`, `${origin}/live/stream.flv`],
  ['外部源', 'https://external.test/608807420', 'https://external.test/608807420'],
  ['不同端口', 'http://iptv.test:1906/608807420', 'http://iptv.test:1906/608807420'],
  ['空地址', null, null],
  ['无效地址', 'http://[invalid', 'http://[invalid'],
]

for (const file of ['admin.html', 'player.html']) {
  const html = readFileSync(new URL(`../web/${file}`, import.meta.url), 'utf8')
  const helper = html.match(/        function browserPlaybackUrl\([\s\S]*?\n        }\n/)?.[0]
  assert.ok(helper, `${file} 必须提供网页播放地址转换`)
  const convert = runInNewContext(`${helper}\nbrowserPlaybackUrl`, { URL, window: { location: { href: pageUrl } } })
  for (const [name, input, expected] of cases) assert.equal(convert(input), expected, `${file}: ${name}`)
  assert.equal(convert('608807420', `${origin}/pass/admin`), `${origin}/pass/proxy/608807420.m3u8`, `${file}: 带前缀页面中的相对入口`)
  const reasonHelper = html.match(/        function hlsServerReason\([\s\S]*?\n        }\n/)?.[0]
  assert.ok(reasonHelper, `${file} 必须展示服务端失败原因`)
  const serverReason = runInNewContext(`${reasonHelper}\nhlsServerReason`)
  for (const reason of ['网络不通：部署机器连不上 YouTube', '出口被拦：YouTube 要求人机验证', '未开播：订阅已保留', '需要登录：此直播要求账号年龄验证']) {
    assert.equal(serverReason({response:{code:502, data:reason}}), reason, `${file}: ${reason}`)
  }
  // hls.js 1.7 对 4xx/5xx 只把 XHR 放在 networkDetails，response.data 为空（#244）
  const proxyFail = '服务器没取到直播清单（此频道须经服务器转发），请稍后重试'
  assert.equal(serverReason({response:{code:502}, networkDetails:{responseText:proxyFail}}), proxyFail, `${file}: 502 正文从 XHR 读`)
  assert.equal(serverReason({response:{code:403}, networkDetails:{responseText:'身份认证失败'}}), '身份认证失败', `${file}: 本机 403 说明`)
  assert.equal(serverReason({response:{code:403}, networkDetails:{responseText:'<!DOCTYPE html><title>403 Forbidden</title>'}}), '', `${file}: 上游 HTML 拒绝页不显示`)
  const throwing = { get responseText() { throw new Error('InvalidStateError') } }
  assert.equal(serverReason({response:{code:502}, networkDetails:throwing}), '', `${file}: 读不到 XHR 正文时不抛`)
  assert.equal(serverReason({response:{code:502}}), '', `${file}: 没有正文`)

  // 自定义源的第三方地址：先问本机能不能转发（/proxy/web.m3u8?u=<原地址>），不能就还是原地址
  const forwardSource = ['webForwardUrl', 'pickWebPlayback'].map(name => {
    const source = html.match(new RegExp(`        (?:async )?function ${name}\\([\\s\\S]*?\\n        }\\n`))?.[0]
    assert.ok(source, `${file} 必须提供 ${name}`)
    return source
  }).join('\n')
  const calls = []
  let reply = { status: 200, body: '#EXTM3U\n#EXTINF:8,\ns0123456789abcdef.ts\n' }
  const fetchStub = async (url, options) => {
    calls.push({ url, options })
    if (reply.throws) throw new TypeError('Failed to fetch')
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, text: async () => reply.body }
  }
  const forward = runInNewContext(`${forwardSource}\n({ webForwardUrl, pickWebPlayback })`,
    { URL, encodeURIComponent, fetch: fetchStub, window: { location: { href: `${origin}/pass/admin` } } })
  const raw = 'https://cdn.example/163189/chu?token=a b&x=1'
  const expected = `${origin}/pass/proxy/web.m3u8?u=${encodeURIComponent(raw)}`
  assert.equal(forward.webForwardUrl(raw), expected, `${file}: 第三方地址带上访问前缀去问本机，原地址整段编码`)
  assert.equal(forward.webForwardUrl('http://cdn.example/live', `${origin}/admin`), `${origin}/proxy/web.m3u8?u=${encodeURIComponent('http://cdn.example/live')}`, `${file}: 没有访问密码`)
  for (const skip of [`${origin}/pass/608807420`, '/608807420', 'rtp://239.0.0.1:5000', 'rtmp://cdn.example/live/a',
    'https://cdn.example/live/a.flv', 'https://cdn.example/clip.mp4?sign=1', 'https://cdn.example/a.mp3', 'http://[invalid', '', null]) {
    assert.equal(forward.webForwardUrl(skip), '', `${file}: 不问本机 ${skip}`)
  }
  assert.equal(new URL(forward.webForwardUrl('https://cdn.example/live?file=a.mp4')).searchParams.get('u'), 'https://cdn.example/live?file=a.mp4', `${file}: 只有路径像短片才不问`)
  calls.length = 0
  assert.deepEqual({ ...await forward.pickWebPlayback(raw) }, { url: expected, reason: '' }, `${file}: 本机能转发就播本机地址`)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, expected)
  reply = { status: 404, body: '这个地址不在已启用的自定义源里' }
  assert.deepEqual({ ...await forward.pickWebPlayback(raw) }, { url: raw, reason: '' }, `${file}: 不在源里 → 原地址，不带原因`)
  reply = { status: 502, body: '我的订阅「CCTV1」 取清单失败：对方回 HTTP 403' }
  assert.deepEqual({ ...await forward.pickWebPlayback(raw) }, { url: raw, reason: reply.body }, `${file}: 服务器没取到 → 原地址，原因留着`)
  reply = { status: 502, body: '<html><body>Bad Gateway</body></html>' }
  assert.deepEqual({ ...await forward.pickWebPlayback(raw) }, { url: raw, reason: '' }, `${file}: 反代的网页式报错不显示`)
  reply = { status: 200, body: '<!DOCTYPE html><title>登录</title>' }
  assert.deepEqual({ ...await forward.pickWebPlayback(raw) }, { url: raw, reason: '' }, `${file}: 回 200 但不是清单 → 原地址`)
  reply = { throws: true }
  assert.deepEqual({ ...await forward.pickWebPlayback(raw) }, { url: raw, reason: '' }, `${file}: 请求本机失败 → 原地址`)
  calls.length = 0
  assert.deepEqual({ ...await forward.pickWebPlayback(`${origin}/pass/608807420`) }, { url: `${origin}/pass/608807420`, reason: '' }, `${file}: 本机地址不问`)
  assert.equal(calls.length, 0)
  // 转发地址结尾可能正好像 .mp4，必须按「已转发」当 HLS，不能交给浏览器原生播放
  assert.match(html, /!forwarded && \/\\\.\(\?:mp4\|/, `${file}: 转发的地址不按后缀判成短片`)
}

console.log(`网页播放地址测试通过（管理台和独立播放器，共 ${(cases.length + 1) * 2} 项；自定义源转发判断同样两页各一遍）`)

// Detail UI regression uses only static records: it never fetches Migu channels.
const admin = readFileSync(new URL('../web/admin.html', import.meta.url), 'utf8')
const names = ['dynamicSportsSource', 'blockDynamicSportsDetailEdit', 'dynamicSportsDetail', 'channelDetailPlayback',
  'showChannelDetail', 'channelsMissingLogo', 'channelStatusDots', 'setAliasFromDetail', 'uploadCurrentChannelLogo',
  'removeCurrentChannelLogo', 'copyCurrentChannelToGroups', 'moveCurrentChannel', 'renameCurrentChannel', 'editChannelFromDetail',
  'sameNameKey', 'channelConfigKey', 'collectChannelLines', 'lineHostLabel', 'initSameNameSection', 'renderSameNameSection', 'sameNameLineMarkup']
const functions = names.map(name => {
  const source = admin.match(new RegExp(`^ {8}(?:async )?function ${name}\\([^]*?^ {8}\\}`, 'm'))?.[0]
  assert.ok(source, `missing detail helper ${name}`)
  return source
}).join('\n')
const nodes = new Map()
const messages = []
const miguEvent = { id: 'migu-event', name: '篮球赛事 中文回放', sourceIds: ['migu'], url: '${replace}/123456789', originalGroup: '体育-昨天' }
const television = { id: 'fixed-tv', name: 'CCTV5体育', sourceIds: ['migu'], url: '${replace}/608807420', originalGroup: '央视', epgMatched: false }
const groups = [{ name: '体育-昨天', channels: [miguEvent] }, { name: '央视', channels: [television] }]
const sandbox = {
  URL, window: { location: { origin, href: pageUrl, pathname: '/admin' } },
  document: { getElementById(id) { if (!nodes.has(id)) nodes.set(id, { style: {}, innerHTML: '', textContent: '', scrollTop: 0, classes: new Set(), classList: { toggle(name, on) { const set = nodes.get(id).classes; on ? set.add(name) : set.delete(name) }, contains(name) { return nodes.get(id).classes.has(name) } } }); return nodes.get(id) } },
  builtInConfig: {}, externalConfig: {}, myPlaylistOriginalData: groups, myPlaylistData: groups,
  myPlaylistConfig: { hiddenChannels: [] }, PLAYERS_BY_PLATFORM: {}, getClientPlatform: () => 'test',
  hiddenAreaGroups: () => [], channelMovedTo: () => '', currentProfileName: () => '默认', selectedGroupIndex: 1,
  sourceNamesFor: () => ['咪咕'], isSystemAnnouncementChannel: () => false, isSystemAnnouncementGroup: () => false,
  escapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  showStatus: (...args) => messages.push(args), fetch: () => { throw new Error('Detail UI regression must not fetch channels') },
}
const ui = runInNewContext(`let currentChannelDetail = null; let sameNameTarget = null; let sameNameLines = [];\n${functions}\n({${names.join(',')}})`, sandbox)
assert.equal(ui.dynamicSportsSource(miguEvent), '咪咕')
assert.equal(ui.dynamicSportsSource({ ...miguEvent, sourceIds: [], originalGroup: '体育-今天' }), '咪咕', 'legacy Migu schedule')
assert.equal(ui.dynamicSportsSource({ ...miguEvent, originalGroup: '体育-明天' }, '我的分组'), '咪咕', 'moved events retain their original schedule identity')
assert.equal(ui.dynamicSportsSource(television), '', 'fixed sports TV keeps ordinary controls')
assert.equal(ui.dynamicSportsSource({ ...television, name: '[回放] 看起来像赛事' }), '', 'labels alone do not decide channel type')
assert.equal(ui.dynamicSportsSource({ ...miguEvent, sourceIds: ['ext:custom'], url: 'https://other.test/123456789' }), '', 'external sports groups are not Migu events')
for (const record of [miguEvent]) {
  ui.showChannelDetail(record.id, false)
  const html = nodes.get('channelDetailContent').innerHTML
  assert.match(html, /赛事信息/); assert.match(html, /内容来源/); assert.match(html, /播放地址/); assert.match(html, /打开.*官网/)
  assert.doesNotMatch(html, /channelMoveSelect|channelRenameInput|channelCopySelect|channelLogoPreview|detailAliasCanonical|配对状态|频道台标|TVG ID/)
  assert.equal(nodes.get('channelDetailEditBtn').style.display, 'none')
  assert.match(nodes.get('channelDetailTitle').textContent, /^赛事详情/)
  assert.equal(ui.channelStatusDots(record), '', 'events do not ask users to match TV logos/EPG')
}
ui.showChannelDetail(miguEvent.id, false)
for (const name of ['setAliasFromDetail', 'uploadCurrentChannelLogo', 'removeCurrentChannelLogo', 'copyCurrentChannelToGroups', 'moveCurrentChannel', 'renameCurrentChannel', 'editChannelFromDetail']) {
  await ui[name]({ files: [] })
}
assert.equal(messages.length, 7, 'stale edit handlers cannot modify a dynamic detail')
ui.showChannelDetail(television.id, false)
const tvHtml = nodes.get('channelDetailContent').innerHTML
for (const control of ['channelMoveSelect', 'channelRenameInput', 'channelLogoPreview', 'detailAliasCanonical']) assert.ok(tvHtml.includes(control), `fixed TV retains ${control}`)
assert.deepEqual(Array.from(ui.channelsMissingLogo(), item => item.id), ['fixed-tv'])
// 源管理模块名单点进来的只读详情：同一个固定电视频道，编辑项全不出现，叠在模块详情上面
ui.showChannelDetail(television.id, true, { readOnly: true })
const readOnlyHtml = nodes.get('channelDetailContent').innerHTML
for (const control of ['channelMoveSelect', 'channelRenameInput', 'channelCopySelect', 'detailAliasCanonical', 'type="file"', 'removeCurrentChannelLogo']) assert.ok(!readOnlyHtml.includes(control), `read-only detail hides ${control}`)
assert.match(readOnlyHtml, /播放地址/); assert.match(readOnlyHtml, /频道台标/); assert.match(readOnlyHtml, /当前档未显示/); assert.match(readOnlyHtml, /请到「我的频道」里修改/)
assert.equal(nodes.get('channelDetailEditBtn').style.display, 'none')
assert.ok(nodes.get('channelDetailModal').classList.contains('is-stacked'))
ui.showChannelDetail(television.id, false)
assert.ok(!nodes.get('channelDetailModal').classList.contains('is-stacked'), 'group view detail is not stacked')
assert.doesNotMatch(ui.dynamicSportsDetail({ ...miguEvent, name: '<script>bad</script>' }, '咪咕'), /<script>/)

// 同名线路：只有一条时不出现；另一分组有同名线路时列出全部，同组的才有 ↑↓；只读详情不放这一节
ui.showChannelDetail(television.id, false)
assert.match(nodes.get('channelDetailContent').innerHTML, /id="sameNameSection"/)
assert.equal(nodes.get('sameNameSection').hidden, true, 'single line hides the same-name section')
groups.push({ name: '央视频', channels: [
  { id: 'ysp-cctv5', name: ' cctv5体育 ', sourceIds: ['xt:yangshipin'], url: '${replace}/relay/ysp-cctv5.m3u8', originalGroup: '央视频' },
  { id: 'ext-line', name: 'CCTV5体育', sourceIds: ['ext:a'], url: 'http://line.example.com/live/5.m3u8', originalGroup: '央视频' },
  { id: 'other', name: 'CCTV5+体育赛事', sourceIds: ['migu'], url: '${replace}/641886683', originalGroup: '央视频' },
] })
ui.showChannelDetail(television.id, false)
const sameName = nodes.get('sameNameSection')
assert.equal(sameName.hidden, false)
assert.match(sameName.innerHTML, /同名线路 · 3 条/)
assert.doesNotMatch(sameName.innerHTML, /CCTV5\+/, 'only exact same names, not prefixes')
assert.equal((sameName.innerHTML.match(/moveSameNameLine\(/g) || []).length, 4, 'arrows only for the two lines sharing a group')
assert.match(sameName.innerHTML, /line\.example\.com/, 'external line shows its host')
ui.showChannelDetail(television.id, true, { readOnly: true })
assert.doesNotMatch(nodes.get('channelDetailContent').innerHTML, /sameNameSection/, 'read-only detail has no same-name section')
console.log('动态赛事详情测试通过：咪咕赛事精简，固定电视频道保留原有编辑功能，同名线路按显示名列出（纯静态样例）')

