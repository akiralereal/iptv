import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  BEIJING_ACCOUNT_API,
  BEIJING_CHANNELS,
  BEIJING_LIVE_PAGE,
  BEIJING_PAGE,
  BEIJING_PLAY_API,
  COOKIE_REJECTED_NOTICE,
  buildGroups,
  claimsRef,
  clearCache,
  credentialRejected,
  fetchCatalog,
  officialMediaUrl,
  parseChannels,
  parseCredential,
  parseLiveEvents,
  resetCredentialState,
  resolveChannel,
  signPlayRequest,
} from '../extractors/beijing/api.js'
import beijing from '../extractors/beijing/index.js'
import { getModule, resolverFor } from '../extractors/registry.js'
import { redactConfig, resolveConfig, validateConfig } from '../utils/extractorManager.js'

const cookie = 'lf=1; usid=user-1; btv_key=secret-token'
const liveUrl = gid => `https://hls.playlive.360.v.btime.com/live/${gid}/index.m3u8?token=signed`
const response = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
const tvHtml = BEIJING_CHANNELS.map(channel => `{"gid":"${channel.gid}","data":{"title":"${channel.name}"}}`).join('')
const liveHtml = `before{"template":"live_module","news":[
  {"gid":"eventone","type":6,"data":{"title":"慢直播｜北京一号"}},
  {"gid":"eventtwo","type":6,"data":{"title":"已经下线的活动"}}
]}after`

function playPayload(url, encoded = false) {
  let stream = url
  if (encoded) stream = [...Buffer.from(Buffer.from(url).toString('base64')).toString('base64')].reverse().join('')
  return { errno: 0, data: { video_stream: [{ stream_url: stream }] } }
}

// 官网不认 Cookie 时的真实回应（2026-10-06 用乱填的 Cookie 实测）：账号接口 code 1016，取流接口 errno 401
const ACCOUNT_REJECTED = { code: 1016, message: '用户未登录', data: [] }

function fixture({ account = { code: 0, data: { nickname: '测试用户' } }, playRejected = false } = {}) {
  const calls = []
  const fetchImpl = async (raw, options = {}) => {
    const url = new URL(raw)
    calls.push({ url, headers: options.headers || {} })
    if (url.href === BEIJING_PAGE) return response(tvHtml)
    if (url.href === BEIJING_LIVE_PAGE) return response(liveHtml)
    if (url.href === BEIJING_ACCOUNT_API) return response(account)
    if (url.origin + url.pathname === BEIJING_PLAY_API) {
      const gid = url.searchParams.get('id')
      const typeId = url.searchParams.get('type_id')
      const timestamp = url.searchParams.get('timestamp')
      assert.equal(url.searchParams.get('sign'), signPlayRequest(gid, timestamp, typeId))
      if (playRejected && typeId === '151') return response({ errno: 401, errmsg: '用户未登录' })
      return response(playPayload(liveUrl(gid), typeId === '151'))
    }
    if (url.href === liveUrl('eventone')) return response('#EXTM3U\n#EXTINF:6,\nsegment.ts\n')
    if (url.href === liveUrl('eventtwo')) return response('gone', 404)
    throw new Error(`unexpected URL: ${url.href}`)
  }
  return { calls, fetchImpl }
}

test('模块注册、频道范围与全代理模式正确', () => {
  assert.equal(getModule('beijing'), beijing)
  assert.equal(beijing.channelHlsMode, 'proxy')
  assert.equal(beijing.capabilities.catchup, false)
  assert.equal(beijing.helper, 'beijing-cookie')
  assert.equal(BEIJING_CHANNELS.length, 9)
  for (const ref of ['beijing-tv-sn', 'beijing-live-6-eventone']) {
    assert.equal(claimsRef(ref), true)
    assert.equal(resolverFor(ref), beijing)
  }
  for (const ref of ['beijing-tv-bad', 'beijing-live-eventone', 'beijing-live-6-eventone/extra']) assert.equal(claimsRef(ref), false)
})

test('Cookie 支持请求头、字符串和浏览器 JSON，配置只回传掩码', () => {
  assert.equal(parseCredential(`Cookie: ${cookie}`), cookie)
  assert.equal(parseCredential(JSON.stringify({ cookies: [
    { domain: '.btime.com', name: 'usid', value: 'user-1' },
    { domain: '.example.com', name: 'discard', value: 'x' },
  ] })), 'usid=user-1')
  assert.throws(() => parseCredential('usid=x\r\nInjected: yes'))
  const stored = validateConfig(beijing, { cookie }).config
  assert.equal(validateConfig(beijing, { cookie: '' }, stored).config.cookie, cookie)
  const redacted = redactConfig(beijing, resolveConfig(beijing, stored))
  assert.equal(redacted.config.cookie, '')
  assert.equal(redacted.secretsSet.cookie, true)
  assert.equal(JSON.stringify(redacted).includes('secret-token'), false)
})

test('解析官网电视台目录与公开直播模块', () => {
  assert.deepEqual(parseChannels(tvHtml).map(row => row.name), BEIJING_CHANNELS.map(row => row.name))
  assert.deepEqual(parseLiveEvents(liveHtml), [
    { gid: 'eventone', name: '慢直播｜北京一号', typeId: '6' },
    { gid: 'eventtwo', name: '已经下线的活动', typeId: '6' },
  ])
  const expected = createHash('md5').update('eventone61777777777TtJSg@2g*$K4PjUH').digest('hex').slice(0, 8)
  assert.equal(signPlayRequest('eventone', '1777777777', '6'), expected)
})

test('有效登录加入 9 个电视台，公开直播自动排除失效项目', async () => {
  clearCache()
  const f = fixture()
  const catalog = await fetchCatalog({ cookie, fetchImpl: f.fetchImpl, timeoutMs: 1000, now: 1777777777000 })
  assert.equal(catalog.tvRows.length, 9)
  assert.deepEqual(catalog.publicRows.map(row => row.gid), ['eventone'])
  assert.match(catalog.warnings.join('\n'), /1 个活动流已失效/)
  const groups = buildGroups(catalog)
  assert.deepEqual(groups.map(group => [group.name, group.dataList.length]), [['北京', 9], ['北京景观', 1]])
  const accountCall = f.calls.find(call => call.url.href === BEIJING_ACCOUNT_API)
  assert.equal(accountCall.headers.Cookie, cookie)
  const mediaCalls = f.calls.filter(call => call.url.hostname.endsWith('.v.btime.com'))
  assert.ok(mediaCalls.length > 0)
  assert.ok(mediaCalls.every(call => !('Cookie' in call.headers) && call.headers.Origin === 'https://www.btime.com' && call.headers.Referer === BEIJING_LIVE_PAGE))
})

test('Cookie 过期时电视台照留并提醒，免登录直播继续输出；检查通过即清除', async () => {
  clearCache(); resetCredentialState()
  const catalog = await fetchCatalog({ cookie, fetchImpl: fixture({ account: ACCOUNT_REJECTED }).fetchImpl, timeoutMs: 1000 })
  // 不让 9 个台从播放列表里悄悄消失：照留，靠后台提醒中心告诉用户
  assert.equal(catalog.tvRows.length, 9)
  assert.equal(catalog.publicRows.length, 1)
  assert.equal(catalog.credentialRejected, COOKIE_REJECTED_NOTICE)
  assert.doesNotMatch(catalog.warnings.join('\n'), /Cookie/)
  assert.equal(credentialRejected({ cookie }), COOKIE_REJECTED_NOTICE)
  assert.equal(credentialRejected({ cookie: 'lf=1; usid=other' }), '')

  const fetched = await beijing.fetch({ cookie }, { fetchImpl: fixture({ account: ACCOUNT_REJECTED }).fetchImpl })
  assert.equal(fetched.meta.credentialRejected, COOKIE_REJECTED_NOTICE)
  assert.deepEqual(fetched.groups.map(group => [group.name, group.dataList.length]), [['北京', 9], ['北京景观', 1]])

  const valid = await fetchCatalog({ cookie, fetchImpl: fixture().fetchImpl, timeoutMs: 1000 })
  assert.equal(valid.credentialRejected, '')
  assert.equal(credentialRejected({ cookie }), '')
})

test('账号接口别的错误只说检查没做完，不冤枉 Cookie，电视台照留', async () => {
  clearCache(); resetCredentialState()
  const catalog = await fetchCatalog({ cookie, fetchImpl: fixture({ account: { code: 500, message: '服务繁忙', data: [] } }).fetchImpl, timeoutMs: 1000 })
  assert.equal(catalog.tvRows.length, 9)
  assert.equal(catalog.credentialRejected, undefined, '没查成不下结论，后台沿用上一轮')
  assert.match(catalog.warnings.join('\n'), /北京时间 Cookie 检查没有完成：账号接口返回 500 服务繁忙/)
  assert.equal(credentialRejected({ cookie }), '')
})

test('播放时取流接口回 401 立刻记为失效，后台不用等下一轮刷新', async () => {
  clearCache(); resetCredentialState()
  const result = await resolveChannel('beijing-tv-sn', { config: { cookie }, fetchImpl: fixture({ playRejected: true }).fetchImpl, now: 1777777777000 })
  assert.equal(result.url, '')
  assert.match(result.desc, /Cookie 已失效/)
  assert.equal(credentialRejected({ cookie }), COOKIE_REJECTED_NOTICE)
  resetCredentialState()
})

test('电视台与公开活动按需取址，登录 Cookie 不传给媒体 CDN', async () => {
  clearCache()
  const f = fixture()
  const tv = await resolveChannel('beijing-tv-sn', { config: { cookie }, fetchImpl: f.fetchImpl, now: 1777777777000 })
  assert.equal(tv.url, liveUrl(BEIJING_CHANNELS[0].gid))
  // 电视台 CDN 校验 Referer 的完整页面路径，根路径会 403（2026-09-07 实测），此处必须是频道页地址
  assert.deepEqual(tv.upstreamHeaders, { Referer: BEIJING_PAGE, Origin: 'https://www.btime.com' })
  const tvApi = f.calls.find(call => call.url.searchParams.get('type_id') === '151')
  assert.equal(tvApi.headers.Cookie, cookie)

  clearCache()
  const publicResult = await resolveChannel('beijing-live-6-eventone', { fetchImpl: f.fetchImpl, now: 1777777777000 })
  assert.equal(publicResult.url, liveUrl('eventone'))
  assert.deepEqual(publicResult.upstreamHeaders, { Referer: BEIJING_LIVE_PAGE, Origin: 'https://www.btime.com' })
  const publicApi = f.calls.filter(call => call.url.searchParams.get('type_id') === '6').at(-1)
  assert.equal(publicApi.headers.Cookie, undefined)
  assert.equal((await resolveChannel('beijing-tv-sn', { config: {} })).url, '')
})

test('只接受北京时间官方 HTTPS HLS 地址', () => {
  assert.equal(officialMediaUrl(liveUrl('ok')), liveUrl('ok'))
  for (const bad of [
    'http://hls.playlive.360.v.btime.com/live/x/index.m3u8',
    'https://v.btime.com.evil.test/live/x/index.m3u8',
    'https://hls.playlive.360.v.btime.com/live/x/file.mp4',
    'https://127.0.0.1/private.m3u8',
  ]) assert.throws(() => officialMediaUrl(bad))
})
