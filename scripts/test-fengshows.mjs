import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const dir = mkdtempSync(join(tmpdir(), 'iptv-fengshows-test-'))
process.env.mdataDir = dir
process.env.mFengshowsToken = ''
process.on('exit', () => rmSync(dir, { recursive:true, force:true }))
const { default: module } = await import('../extractors/fengshows/index.js')
const { CHANNELS, parseToken, officialMediaUrl, resolveChannel } = await import('../extractors/fengshows/api.js')
const { getModule, resolverFor } = await import('../extractors/registry.js')
const { redactConfig, validateConfig, resolveConfig, ExtractorManager } = await import('../utils/extractorManager.js')
const { parseInterfaceTxt, generateM3u8, applyConfig } = await import('../utils/playlistConfig.js')
const { channel } = await import('../utils/appUtils.js')
const { pipeFlv } = await import('../utils/flvProxy.js')
const ref = 'fengshows-info.flv'
const signed = 'http://dispatch.fengshows.cn:8484/live/0701pin72.flv?txSecret=a%2Fb&txTime=abc'

function mockApi({ token, status, blocked, error } = {}) {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url:new URL(url), options })
    assert.equal(options.headers.token, token)
    assert.equal(options.redirect, 'error')
    if (error) throw new Error(error)
    if (String(url).includes('auth-url')) {
      return Response.json(status ? {status, message:'private-test-token'} : {status:'0', data:{live_url:signed}})
    }
    return Response.json({status:'0',data:{live_type:'tv', ...(blocked ? {region_unauthorized:true} : {})}})
  }
  return { calls, fetchImpl }
}

test('注册名、香港分组和频道范围固定，未引入回看或点播', async () => {
  assert.equal(getModule('fengshows'), module)
  assert.equal(module.name, '凤凰卫视')
  assert.equal(module.streamType, 'flv')
  assert.equal(module.capabilities.epg, false)
  assert.equal(module.capabilities.catchup, false)
  assert.match(module.description, /无需付费会员/)
  const {groups} = await module.fetch({})
  assert.deepEqual(groups.map(g=>g.name), ['香港'])
  assert.deepEqual(groups[0].dataList.map(c=>c.name), ['凤凰资讯','凤凰中文','凤凰香港'])
  for (const row of groups[0].dataList) {
    assert.equal(resolverFor(row.deferredRef), module)
    assert.equal(row.catchup, 'none')
    assert.equal(row.wantsPlayback, undefined)
    assert.equal(row.url, undefined)
  }
  for (const bad of ['fengshows-movie.flv','fengshows-info.flv/extra','fengshows-info.flv?token=x','fengshows-info.m3u8']) assert.equal(module.claimsRef(bad), false)
  assert.equal(CHANNELS.length, 3)
})

test('Token/Cookie 提取及密钥配置持久化、掩码、空值保持', () => {
  assert.equal(parseToken('other=discard; App.user.token=%22private-test-token%22; x=1'), 'private-test-token')
  assert.throws(()=>parseToken('abc%0d%0aInjected:bad'))
  assert.throws(()=>parseToken('other=1; x=2'))
  assert.equal(parseToken(''), '')
  const stored = validateConfig(module, {token:'private-test-token'}).config
  assert.equal(validateConfig(module, {token:''}, stored).config.token, 'private-test-token')
  assert.equal(validateConfig(module, {token:null}, stored).config.token, undefined)
  const redacted = redactConfig(module, resolveConfig(module, stored))
  assert.equal(redacted.config.token, '')
  assert.equal(redacted.secretsSet.token, true)
  assert.equal(JSON.stringify(redacted).includes('private-test-token'), false)
  const manager = new ExtractorManager()
  manager.configPath = join(dir,'extractors.json'); manager.cachePath = join(dir,'extractor-cache.json')
  manager.load(); manager.updateModuleConfig('fengshows', stored)
  const restored = new ExtractorManager().load()
  assert.equal(restored.effectiveConfig(module).token, 'private-test-token')
  assert.equal(JSON.stringify(restored.getState()).includes('private-test-token'), false)
  restored.updateModuleConfig('fengshows', {token:null})
})

test('访客 HD、账号 FHD；仅对官方 API 带 Token，签名不改写也不缓存', async () => {
  for (const token of [undefined,'private-test-token']) {
    const api = mockApi({token})
    const ctx = {fetchImpl:api.fetchImpl, config:{token:token || ''}, account:{token:'migu-must-not-be-used'}}
    for (let i=0;i<2;i++) {
      const result = await resolveChannel(ref, ctx)
      assert.equal(result.url, signed)
      assert.equal(result.quality, token ? 'fhd' : 'hd')
      assert.equal(result.upstreamHeaders, undefined)
      assert.equal(result.validateMediaUrl, officialMediaUrl)
    }
    assert.equal(api.calls.length, 4)
    for (const call of api.calls) assert.equal(call.url.origin, 'https://api.fengshows.cn')
    for (const call of api.calls.filter(c=>c.url.pathname.endsWith('auth-url'))) assert.equal(call.url.searchParams.get('live_qa'), token ? 'fhd' : 'hd')
  }
})

test('访问限制、凭证过期和错误信息均正确收口，不静默回退为 480p', async () => {
  const blocked = mockApi({blocked:true})
  assert.equal((await resolveChannel(ref, {fetchImpl:blocked.fetchImpl})).url, '')
  assert.equal(blocked.calls.length, 1)
  const expired = mockApi({token:'private-test-token',status:'10005'})
  const result = await resolveChannel(ref, {fetchImpl:expired.fetchImpl,config:{token:'private-test-token'}})
  assert.equal(result.url, ''); assert.match(result.desc, /已过期/); assert.equal(expired.calls.length, 2)
  const failure = mockApi({error:'request headers token=private-test-token'})
  assert.equal(JSON.stringify(await resolveChannel(ref,{fetchImpl:failure.fetchImpl})).includes('private-test-token'), false)
  assert.equal((await resolveChannel('fengshows-movie.flv',{fetchImpl:()=>assert.fail('invalid ref must not fetch')})).url, '')
})

test('模块路由保留签名，明确忽略回看查询；FLV 类型传至主路由', async () => {
  const original = module.resolve
  module.resolve = async () => ({url:signed,validateMediaUrl:officialMediaUrl})
  try {
    const result = await channel('/fengshows-info.flv?playbackbegin=1&playbackend=2','migu-user','migu-token')
    assert.equal(result.playURL, signed)
    assert.equal(result.streamType, 'flv')
    assert.equal(result.validateMediaUrl, officialMediaUrl)
  } finally { module.resolve = original }
})

test('catchup=none 经过解析、分组和个性化 M3U 重生成仍保留', async () => {
  const {groups} = await module.fetch({})
  const lines = groups[0].dataList.map(c=>`#EXTINF:-1 tvg-id="${c.name}" tvg-name="${c.name}" catchup="none" group-title="香港",${c.name}\n\${replace}/${c.deferredRef}\n`).join('')
  writeFileSync(join(dir,'interface.txt'), '#EXTM3U catchup="append"\n'+lines)
  const parsed = parseInterfaceTxt()
  assert.equal(parsed[0].name, '香港')
  assert.ok(parsed[0].channels.every(c=>c.catchup==='none'))
  const generated = generateM3u8(applyConfig(parsed,{}))
  assert.equal((generated.match(/catchup="none"/g)||[]).length, 3)
  assert.equal((generated.match(/fengshows-[a-z]+\.flv/g)||[]).length, 3)
})

test('每次媒体调度都限制为官方 FLV 地址', () => {
  assert.equal(officialMediaUrl(signed).port, '8484')
  for(const url of ['http://127.0.0.1/x.flv','http://fengshows.cn.evil.test/x.flv','https://u:p@qctv.fengshows.cn/x.flv','http://qctv.fengshows.cn:9999/x.flv','http://qctv.fengshows.cn/x.m3u8']) assert.throws(()=>officialMediaUrl(url))
})

async function serverFor(t, fetchImpl) {
  const server = http.createServer((req,res)=>pipeFlv(signed,req,res,officialMediaUrl,{fetchImpl}))
  server.listen(0,'127.0.0.1'); await once(server,'listening')
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve))})
  return `http://127.0.0.1:${server.address().port}`
}

test('真实 HTTP 代理跟随官方调度、保持 FLV 类型且不带凭证', async t => {
  let calls = 0
  const url = await serverFor(t, async (target, options) => {
    calls++; assert.equal(options.headers.token, undefined); assert.equal(options.headers.Cookie, undefined)
    if(calls===1)return new Response(null,{status:301,headers:{Location:'http://qctv.fengshows.cn/live/a.flv?txSecret=opaque'}})
    return new Response(new Uint8Array([70,76,86,1,5,0,0,0,9,0,0,0,0]))
  })
  const res = await fetch(url)
  assert.equal(res.status,200);assert.equal(res.headers.get('content-type'),'video/x-flv')
  assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0,3).toString(),'FLV')
  assert.equal(calls,2)
})

test('禁止越界重定向与假 FLV，客户端断开会取消上游', async t => {
  let calls=0
  const rejected=await serverFor(t,async()=>{calls++;return new Response(null,{status:302,headers:{Location:'http://127.0.0.1/private.flv'}})})
  assert.equal((await fetch(rejected)).status,502);assert.equal(calls,1)
  const invalid=await serverFor(t,async()=>new Response('<html>denied</html>'))
  assert.equal((await fetch(invalid)).status,502)
  let cancelled=false, ticker
  const live=await serverFor(t,async()=>new Response(new ReadableStream({
    start(c){c.enqueue(Buffer.from('FLV\x01\x05\0\0\0\x09\0\0\0\0'));ticker=setInterval(()=>c.enqueue(new Uint8Array(188)),10)},
    cancel(){clearInterval(ticker);cancelled=true},
  })))
  const res=await fetch(live);const reader=res.body.getReader();await reader.read();await reader.cancel()
  for(let i=0;i<40&&!cancelled;i++)await delay(10)
  assert.equal(cancelled,true)
})
