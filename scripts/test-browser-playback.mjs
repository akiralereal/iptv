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
