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
}

console.log(`网页播放地址测试通过（管理台和独立播放器，共 ${(cases.length + 1) * 2} 项）`)

// Detail UI regression uses only static records: it never fetches Migu channels.
const admin = readFileSync(new URL('../web/admin.html', import.meta.url), 'utf8')
const names = ['dynamicSportsSource', 'blockDynamicSportsDetailEdit', 'dynamicSportsDetail', 'channelDetailPlayback',
  'showChannelDetail', 'channelsMissingLogo', 'channelStatusDots', 'setAliasFromDetail', 'uploadCurrentChannelLogo',
  'removeCurrentChannelLogo', 'copyCurrentChannelToGroups', 'moveCurrentChannel', 'renameCurrentChannel', 'editChannelFromDetail']
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
  document: { getElementById(id) { if (!nodes.has(id)) nodes.set(id, { style: {}, innerHTML: '', textContent: '', scrollTop: 0 }); return nodes.get(id) } },
  builtInConfig: {}, externalConfig: {}, myPlaylistOriginalData: groups, myPlaylistData: groups,
  myPlaylistConfig: { hiddenChannels: [] }, PLAYERS_BY_PLATFORM: {}, getClientPlatform: () => 'test',
  sourceNamesFor: () => ['咪咕'], isSystemAnnouncementChannel: () => false, isSystemAnnouncementGroup: () => false,
  escapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  showStatus: (...args) => messages.push(args), fetch: () => { throw new Error('Detail UI regression must not fetch channels') },
}
const ui = runInNewContext(`let currentChannelDetail = null;\n${functions}\n({${names.join(',')}})`, sandbox)
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
assert.doesNotMatch(ui.dynamicSportsDetail({ ...miguEvent, name: '<script>bad</script>' }, '咪咕'), /<script>/)
console.log('动态赛事详情测试通过：咪咕赛事精简，固定电视频道保留原有编辑功能（纯静态样例）')

