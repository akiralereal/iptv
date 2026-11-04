import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import youtube from '../extractors/youtube-live/index.js'
import { normalizeYouTubeInput, record, refOf, parseVideo, parseBroadcasts, mediaUrl, parseLive, publicManifest, liveWindow, renewedLink } from '../extractors/youtube-live/api.js'
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
const entries = [event, {...event, live_status:'is_upcoming'}, {...event,live_status:'was_live'}, {...event,channel_id:'foreign'}, {...event,availability:'subscriber_only'}]
assert.deepEqual(parseBroadcasts({...fixture,entries}, channelId).events.map(e => e.status), ['is_live','is_upcoming'])
assert.throws(() => parseBroadcasts(fixture, 'foreign'))
const page = (status, changes={}, live={}) => '<script>var ytInitialPlayerResponse = ' + JSON.stringify({
  videoDetails:{ videoId:id, channelId, title, isLiveContent:true, ...changes },
  microformat:{playerMicroformatRenderer:{liveBroadcastDetails:live}}, playabilityStatus:{status},
}) + '; throw new Error();</script>'
assert.deepEqual(parseVideo(page('OK',{isLive:true}),id),pinned)
assert.deepEqual(parseVideo(page('LIVE_STREAM_OFFLINE'),id),pinned)
for (const html of [page('LOGIN_REQUIRED'),page('OK',{videoId:'other-video',isLive:true}),page('OK',{isLiveContent:false}),page('OK',{}, {endTimestamp:'2026-11-03'})]) assert.throws(() => parseVideo(html,id))

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
console.log('✅ YouTube 订阅、当前场次、配置持久化、HLS 换签及原始字幕')
