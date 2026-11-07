import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import youtube from '../extractors/youtube-live/index.js'
import { normalizeYouTubeInput, record, refOf, parseVideoChannel, parseBroadcasts, inspect, mediaUrl, parseLive, liveInfo, publicManifest, liveWindow, renewedLink, videoStatus, ytDlpError, unreachableMessage } from '../extractors/youtube-live/api.js'
import { topVariantFirst } from '../utils/hlsTopFirst.js'
import { lookup, toProxyManifest } from '../utils/hlsProxy.js'
import { ExtractorManager } from '../utils/extractorManager.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/youtube-live.json', import.meta.url)))
const { channel_id: channelId, entries: [event] } = fixture
const { id, title } = event
const channel = record(channelId, null, 'ABC News')
const pinned = record(channelId, id, title)
assert.equal(refOf(channel), 'yt-87985fa7f5573d6fb279d02b')
assert.notEqual(refOf(channel), refOf(pinned))
assert.deepEqual(normalizeYouTubeInput('IShowSpeed'), {channelUrl:'https://www.youtube.com/@IShowSpeed'})
assert.deepEqual(normalizeYouTubeInput(channelId), {channelUrl:'https://www.youtube.com/channel/' + channelId})
assert.deepEqual(normalizeYouTubeInput('@ABCNews'), normalizeYouTubeInput('youtube.com/@ABCNews/streams'))
assert.deepEqual(normalizeYouTubeInput('https://youtu.be/' + id), { videoId:id })
for (const raw of ['https://youtube.com.example/@ABCNews','https://youtube.com@localhost/@x','file:///etc/passwd','@ABCNews\n--proxy','https://youtube.com/watch?v=bad']) assert.throws(() => normalizeYouTubeInput(raw))
for (const raw of [
  '  https://m.youtube.com/@ABCNews/streams?si=share  ', '//www.youtube.com/@ABCNews/videos',
  'youtube.com/@ABCNews/community', 'https://www.youtube.com/@ABCNews/playlists?view=1',
]) assert.deepEqual(normalizeYouTubeInput(raw), { channelUrl:'https://www.youtube.com/@ABCNews' })
for (const raw of [`${channelId}`, `https://youtube.com/channel/${channelId}/live`,
  `https://www.youtube.com/embed/live_stream?channel=${channelId}`, `https://www.youtube-nocookie.com/embed/live_stream?channel=${channelId}`,
]) assert.deepEqual(normalizeYouTubeInput(raw), { channelUrl:'https://www.youtube.com/channel/' + channelId })
for (const raw of [
  `https://www.youtube.com/watch?v=${id}&list=ignored&si=share`, `https://youtube.com/live/${id}?feature=share`,
  `www.youtu.be/${id}?t=30`, `https://m.youtube.com/shorts/${id}?si=share`,
  `https://music.youtube.com/watch?v=${id}`, `https://www.youtube-nocookie.com/embed/${id}`,
  `https://www.youtube.com/v/${id}`, `https://youtube.com/attribution_link?u=${encodeURIComponent('/watch?v=' + id)}`,
  `https://youtube.com/redirect?q=${encodeURIComponent('https://youtu.be/' + id)}`,
]) assert.deepEqual(normalizeYouTubeInput(raw), { videoId:id }, raw)
for (const base of ['/c/ABCNews', '/user/ABCNews', '/ABCNews']) {
  assert.deepEqual(normalizeYouTubeInput('https://youtube.com' + base + '/streams'), { channelUrl:'https://www.youtube.com' + base })
}
assert.deepEqual(normalizeYouTubeInput('https://youtube.com/@中文频道/shorts'), { channelUrl:'https://www.youtube.com/@' + encodeURIComponent('中文频道') })
for (const raw of ['https://youtube.com:444/@ABCNews', 'https://youtube-nocookie.com/watch?v=' + id,
  'https://youtube.com/playlist?list=PL123', 'https://youtube.com/feed/subscriptions',
  'https://youtube.com/redirect?q=https%3A%2F%2Flocalhost%2Fprivate',
  'https://youtube.com/attribution_link?u=%2F%2Fevil.test%2Fwatch',
  'https://youtube.com/@ABC%2FNews', 'https://youtube.com/shorts/' + id + '/extra',
]) assert.throws(() => normalizeYouTubeInput(raw), raw)
const entries = [event, {...event, live_status:'is_upcoming'}, {...event,live_status:'was_live'}, {...event,channel_id:'foreign'}, {...event,availability:'subscriber_only'}]
assert.deepEqual(parseBroadcasts({...fixture,entries}, channelId).events.map(e => e.status), ['is_live','is_upcoming'])
assert.throws(() => parseBroadcasts(fixture, 'foreign'))
const page = (status, changes={}, live={}) => '<script>var ytInitialPlayerResponse = ' + JSON.stringify({
  videoDetails:{ videoId:id, channelId, title, author:'ABC News', isLiveContent:true, ...changes },
  microformat:{playerMicroformatRenderer:{liveBroadcastDetails:live}}, playabilityStatus:{status},
}) + '; throw new Error();</script>'
// 所有视频链接都关注发布频道，包括预约、回放、普通视频与 Shorts；不能用视频标题命名频道。
for (const html of [page('OK',{isLive:true}), page('LIVE_STREAM_OFFLINE'),
  page('OK',{isLiveContent:false}), page('OK',{}, {endTimestamp:'2026-11-03'})]) {
  assert.deepEqual(parseVideoChannel(html,id), channel)
}
for (const html of [page('OK',{videoId:'other-video'}), page('OK',{channelId:'wrong'}),
  page('OK',{author:undefined}), '<script>var ytInitialPlayerResponse={"playabilityStatus":{"status":"LOGIN_REQUIRED"}};</script>']) {
  assert.throws(() => parseVideoChannel(html,id))
}
const calls = []
const reads = {
  readWatchPage: async video => { calls.push(['watch',video]); return page('OK',{isLiveContent:false}) },
  readMetadata: async (url,args) => { calls.push(['metadata',url,args]); return fixture },
}
const fromVideo = await inspect('https://youtu.be/' + id, { ...reads, includeEvents:false })
assert.deepEqual(fromVideo, {item:channel,events:[]})
assert.deepEqual(calls, [['watch',id]], '保存频道不依赖场次列表，未开播也能关注')
calls.length = 0
const fromHandle = await inspect('@ABCNews', { ...reads, includeEvents:false })
assert.equal(refOf(fromHandle.item), refOf(fromVideo.item), '同一频道的不同链接归并到同一订阅')
assert.deepEqual(calls, [['metadata','https://www.youtube.com/@ABCNews',['--flat-playlist','--playlist-end','1']]])
calls.length = 0
const inspected = await inspect('https://youtube.com/shorts/' + id, reads)
assert.deepEqual(inspected.item, channel)
assert.equal(inspected.events[0].videoId, id)
assert.equal(calls[1][1], 'https://www.youtube.com/channel/' + channelId + '/streams', '查看场次查询已确认的所属频道')
await assert.rejects(inspect('https://youtu.be/' + id, { ...reads,
  readMetadata: async () => ({...fixture,channel_id:'UCaaaaaaaaaaaaaaaaaaaaaa'}) }), /频道身份/)

// 固定场次状态：后台据此标出已结束 / 失效、可以移除的
assert.equal(videoStatus(page('OK',{isLive:true}),id),'live')
assert.equal(videoStatus(page('LIVE_STREAM_OFFLINE',{isUpcoming:true}),id),'upcoming')
assert.equal(videoStatus(page('OK',{}, {endTimestamp:'2026-11-03'}),id),'ended')
assert.equal(videoStatus(page('OK',{}),id),'ended','直播内容、不在播也不是预约 = 已结束')
assert.equal(videoStatus('<script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"ERROR"}};</script>',id),'unavailable')
assert.equal(videoStatus(page('LOGIN_REQUIRED',{isLive:false}),id),'unknown','要求登录多半是出口被人机验证，不能据此说场次失效')
assert.equal(videoStatus('<html>consent</html>',id),'unknown')

// yt-dlp 报错 → 给用户看的原因；连不上时指到「网络代理」
assert.match(unreachableMessage(false),/网络代理.*填代理地址/)
assert.match(unreachableMessage(true),/点「测试」/)
assert.equal(ytDlpError('ERROR: [youtube] x: This live event will begin in 3 hours').message,'这场直播尚未开始或已经结束')
const botCheck = "ERROR: [youtube] x: Sign in to confirm you're not a bot"
const tooMany = 'ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests'
assert.match(ytDlpError(botCheck,{proxied:true}).message,/人机验证.*换一个代理节点/)
assert.match(ytDlpError(botCheck,{proxied:false}).message,/这台机器的出口 IP 做人机验证.*网络代理」填一个代理/,'没配代理时不叫人换节点')
assert.match(ytDlpError(tooMany,{proxied:true}).message,/限制了这个出口.*换一个代理节点/)
assert.match(ytDlpError(tooMany,{proxied:false}).message,/限制了这台机器出口.*网络代理/)
assert.ok(ytDlpError(botCheck).exitBlocked && ytDlpError(tooMany).exitBlocked,'人机验证与限流标为出口被拦，播放侧据此冷却')
assert.ok(!ytDlpError('ERROR: [youtube] x: Some new extractor failure').exitBlocked)
assert.match(ytDlpError('ERROR: [youtube] x: Join this channel to get access to members-only content').message,/无法匿名播放/)
for (const net of ['ERROR: Unable to download webpage: <urlopen error [Errno 111] Connection refused>', 'ERROR: [youtube] x: Read timed out. (read timeout=12.0)',
  "ERROR: Unable to download API page: ('Cannot connect to proxy.', ConnectionResetError(54, 'Connection reset by peer'))", 'Tunnel connection failed: 502 Bad Gateway']) {
  assert.match(ytDlpError(net).message,/网络代理/,net)
}
assert.match(ytDlpError('',{killed:true}).message,/网络代理/,'30 秒没解析完按网络问题提示')
assert.match(ytDlpError('ERROR: [youtube] x: Some new extractor failure').message,/检查更新/,'看不懂的失败提示更新解析组件')
assert.match(ytDlpError('',{code:'ENOENT'}).message,/缺少 yt-dlp/)

// 最高画质上限：只在不超过它的档里取最高；一档都不满足时取最低的视频档；竖屏按短边算
const ladder = ['#EXTM3U','#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",URI="a.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,AUDIO="a"','360.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=1920x1080,AUDIO="a"','1080.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,AUDIO="a"','720.m3u8'].join('\n')
const picked = (text, maxHeight) => topVariantFirst(text, { highestOnly: true, maxHeight }).split('\n').filter(l => l && !l.startsWith('#'))
assert.deepEqual(picked(ladder, 0), ['1080.m3u8'])
assert.deepEqual(picked(ladder, 720), ['720.m3u8'])
assert.deepEqual(picked(ladder, 1440), ['1080.m3u8'])
assert.deepEqual(picked(ladder, 240), ['360.m3u8'],'没有符合的档时取最低档，不至于没画面')
assert.match(topVariantFirst(ladder, { highestOnly: true, maxHeight: 720 }), /GROUP-ID="a"/,'配套音轨保留')
assert.deepEqual(picked(ladder.replace('1920x1080','1080x1920'), 1080), ['1080.m3u8'],'竖屏 1080×1920 算 1080p')
const unsorted = topVariantFirst(ladder, { maxHeight: 720 })
assert.ok(!unsorted.includes('1080.m3u8') && unsorted.indexOf('720.m3u8') < unsorted.indexOf('360.m3u8'),'不固定最高档时也去掉超出上限的档')

const origin = 'https://manifest.googlevideo.com'
const expiry = Math.floor(Date.now()/1000) + 3600
const master = origin + '/api/manifest/hls_variant/expire/' + expiry + '/index.m3u8'
const format = {protocol:'m3u8_native',vcodec:'avc1',manifest_url:master,http_headers:{Cookie:'private','User-Agent':'player'}}
const data = {id,channel_id:channelId, live_status:'is_live', formats:[format]}
const highMaster = master.replace('index.m3u8','hd/index.m3u8')
assert.equal(parseLive({ ...data, formats: [
  { ...format, width:640, height:360 }, { ...format, width:1920, height:1080, manifest_url:highMaster },
  { ...format, width:3840, height:2160, manifest_url:master.replace(String(expiry), '1') },
] }, channel, id).url, highMaster)
// 同画质优先音视频合在一起的那份（mweb 的 91～96），哪怕码率略低；更高画质仍优先
const muxedMaster = master.replace('index.m3u8','muxed/index.m3u8')
assert.equal(parseLive({ ...data, formats: [
  { ...format, width:1920, height:1080, acodec:'none', tbr:5000 }, { ...format, width:1920, height:1080, acodec:'mp4a.40.2', tbr:4500, manifest_url:muxedMaster },
] }, channel, id).url, muxedMaster)
assert.equal(parseLive({ ...data, formats: [
  { ...format, width:1280, height:720, acodec:'mp4a.40.2', manifest_url:muxedMaster }, { ...format, width:1920, height:1080, acodec:'none', manifest_url:highMaster },
] }, channel, id).url, highMaster)
// 默认只用 yt-dlp 默认客户端；打开「音视频合流」才先试 mweb，失败或没有 HLS 再退回默认客户端；
// 没开播 / 出口被拦 / 连不上不再多跑一轮
const liveReads = []
const liveReader = (...results) => async (url, args) => {
  liveReads.push(args.join(' '))
  const next = results.shift()
  if (next instanceof Error) throw next
  return next
}
const MWEB = '--no-playlist --extractor-args youtube:player_client=mweb'
const muxedData = { ...data, formats: [{ ...format, width:1920, height:1080, acodec:'mp4a.40.2', manifest_url:muxedMaster }] }
assert.equal((await liveInfo(channel, id, {}, liveReader(data))).url, master)
assert.deepEqual(liveReads, ['--no-playlist'], '默认不开合流：只解析一次、不带 mweb')
liveReads.length = 0
assert.equal((await liveInfo(channel, id, { muxed:true }, liveReader(muxedData))).url, muxedMaster)
assert.deepEqual(liveReads, [MWEB])
for (const first of [ytDlpError('ERROR: [youtube] x: No video formats found!'), { ...data, formats: [] }]) {
  liveReads.length = 0
  assert.equal((await liveInfo(channel, id, { muxed:true }, liveReader(first, data))).url, master)
  assert.deepEqual(liveReads, [MWEB, '--no-playlist'])
}
for (const stop of [ytDlpError('ERROR: [youtube] x: This live event will begin in 3 hours'), ytDlpError(botCheck), ytDlpError('Tunnel connection failed: 502 Bad Gateway'), { ...data, live_status:'was_live' }]) {
  liveReads.length = 0
  await assert.rejects(liveInfo(channel, id, { muxed:true }, liveReader(stop, data)))
  assert.equal(liveReads.length, 1)
}
const muxedField = youtube.configSchema.find(f => f.key === 'muxedAudio')
assert.ok(muxedField && muxedField.type === 'boolean' && muxedField.default === false, '合流开关默认关')
const live = parseLive(data,channel,id)
assert.deepEqual(live.upstreamHeaders(master), {'User-Agent':'player'})
for (const bad of ['https://localhost/','http://manifest.googlevideo.com/test','https://manifest.googlevideo.com.evil.test/x']) {
  assert.throws(() => live.upstreamHeaders(bad))
  assert.throws(() => publicManifest('#EXTM3U\n#EXT-X-MEDIA:URI="'+bad+'"\n',master))
}
for (const edited of [{channel_id:'wrong'},{has_drm:true},{id:'other-video'},{live_status:'was_live'},{formats:[{...format,manifest_url: master.replace(String(expiry),'1')}] }]) assert.throws(() => parseLive({...data,...edited},pinned,id))
const track = (language='en',video=id) => origin+'/api/manifest/hls_playlist/id/'+video+'.1/itag/387/xtags/'+language+'/mime/text%2Fvtt/index.m3u8'
const cdn = 'https://rr3---sn-ip.googlevideo.com'
const segment = sq => cdn+'/videoplayback/id/'+id+'.1/itag/387/xtags/en/sq/'+sq+'/mime/text%2Fvtt/captions.webvtt'
const captions = publicManifest('#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,LANGUAGE="en",URI="'+track()+'"',master)
const getUri = manifest => manifest.match(/URI="([^"]+)"/)[1]
const local = getUri(toProxyManifest(captions,refOf(channel),undefined,live.upstreamHeaders,mediaUrl))
assert.match(local,/^s[0-9a-f]+\.m3u8$/)
assert.notEqual(getUri(toProxyManifest(captions,refOf(pinned))),local)
assert.equal(lookup(local.split('.')[0]).url,track())
const sublist = publicManifest('#EXTM3U\n'+segment(17),track())
assert.match(toProxyManifest(sublist,refOf(channel)),/\ns[0-9a-f]+\.vtt$/)
assert.equal(renewedLink('#EXTM3U\n'+track('fr')+'\n'+track(),master,track()),track())
assert.equal(renewedLink(sublist,track(),segment(17),true),segment(17))
assert.throws(() => renewedLink(sublist,track(),segment(16),true))
assert.throws(() => renewedLink('#EXTM3U\n'+track('en','other-video'),master,track()))
assert.throws(() => publicManifest('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES',master))

const long = ['#EXTM3U','#EXT-X-TARGETDURATION:5','#EXT-X-MEDIA-SEQUENCE:20','#EXT-X-DISCONTINUITY-SEQUENCE:2',
  '#EXT-X-DISCONTINUITY','#EXT-X-PROGRAM-DATE-TIME:2026-01-02T01:00:00Z','#EXT-X-MAP:URI="init.mp4"',
  ...Array.from({length:14},(_,i) => '#EXTINF:5,\n'+i+'.ts')].join('\n')
const window = liveWindow(long, 12)
assert.match(window, /MEDIA-SEQUENCE:22\n/)
assert.match(window, /DISCONTINUITY-SEQUENCE:3\n/)
assert.match(window, /PROGRAM-DATE-TIME:2026-01-02T01:00:10.000Z/)
assert.match(window, /MAP:URI="init.mp4"/)
assert.equal(window.match(/^#EXTINF:/gm).length,12)
assert.equal(liveWindow(long+'\n#EXT-X-ENDLIST'),long+'\n#EXT-X-ENDLIST')

const dir = mkdtempSync(join(tmpdir(),'iptv-youtube-test-'))
function manager() {
  const m = new ExtractorManager()
  m.configPath=join(dir,'config.json'); m.cachePath=join(dir,'cache.json'); m.legacyConfigPath=join(dir,'legacy.json')
  return m.load()
}
try {
  const m = manager()
  assert.equal(m.isModuleEnabled(youtube),false)
  assert.ok(!m.getValidChannels().some(g => g.name === youtube.name))
  m.setModuleEnabled(youtube.id, true)
  assert.ok(!m.getValidChannels().some(g => g.name === youtube.name))
  m.setModuleEnabled(youtube.id, false)
  m.updateModuleConfig(youtube.id,{subscriptions:JSON.stringify([channel,pinned])})
  assert.throws(() => m.updateModuleConfig(youtube.id,{subscriptions:'broken'}))
  m.setModuleEnabled(youtube.id,true)
  const rows = manager().getValidChannels().find(g => g.name===youtube.name).dataList
  assert.deepEqual(rows.map(r=>r.deferredRef),[refOf(channel),refOf(pinned)])
  assert.ok(rows.every(r => r.proxyHls && r.catchup==='none'))
  m.updateModuleConfig(youtube.id,{subscriptions:'[]'})
  assert.ok(!manager().getValidChannels().some(g=>g.name===youtube.name))
  assert.equal((await youtube.resolve(refOf(channel),{config:{}})).status,404)
} finally { rmSync(dir,{recursive:true,force:true}) }

// 出口被人机验证：1 分钟内不再跑 yt-dlp；并发请求共用的同一次失败和冷却期内的重试只记一行
const fakeDir = mkdtempSync(join(tmpdir(),'iptv-youtube-bot-'))
const runs = join(fakeDir,'runs')
const fakeBin = join(fakeDir,'yt-dlp')
writeFileSync(fakeBin, `#!/bin/sh\necho run >> "${runs}"\necho "${botCheck}" >&2\nexit 1\n`, { mode:0o755 })
const ytDlpRuns = () => { try { return readFileSync(runs,'utf8').split('\n').filter(Boolean).length } catch { return 0 } }
const savedBin = process.env.YTDLP_BIN, realNow = Date.now
process.env.YTDLP_BIN = fakeBin
try {
  youtube.clearResolveCache()
  const config = { subscriptions: JSON.stringify([pinned]) }
  const play = () => youtube.resolve(refOf(pinned), { config })
  const burst = await Promise.all([play(), play()])
  assert.equal(ytDlpRuns(), 1)
  assert.deepEqual(burst.map(r => r.status), [502, 502])
  assert.equal(burst.filter(r => !r.silent).length, 1, '同一次失败只打一行红字')
  assert.match(burst.find(r => !r.silent).desc, /人机验证.*已暂停向 YouTube 请求 1 分钟/)
  const again = await play()
  assert.ok(again.silent && ytDlpRuns() === 1, '2 秒内复用同一次失败，也不再记')
  Date.now = () => realNow() + 3000
  const retry = await play()
  assert.equal(ytDlpRuns(), 1, '冷却期内的重试不跑 yt-dlp')
  assert.ok(retry.silent)
  assert.match(retry.desc, /人机验证.*约 \d+ 秒后再试）$/)
  assert.ok(!/1 分钟）.*1 分钟）/.test(retry.desc), '冷却说明不重复叠加')
  Date.now = () => realNow() + 61000
  const later = await play()
  assert.equal(ytDlpRuns(), 2, '冷却过后重新解析')
  assert.ok(!later.silent, '冷却过后再失败重新记一行')
  Date.now = realNow
  youtube.clearResolveCache()
  await play()
  assert.equal(ytDlpRuns(), 3, '保存配置等清缓存时一并解除冷却')
} finally {
  Date.now = realNow
  if (savedBin === undefined) delete process.env.YTDLP_BIN
  else process.env.YTDLP_BIN = savedBin
  youtube.clearResolveCache()
  rmSync(fakeDir,{recursive:true,force:true})
}
console.log('✅ YouTube 订阅、当前场次、配置持久化、HLS 换签及原始字幕')
