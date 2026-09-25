#!/usr/bin/env node
/**
 * app.js 央视频本地媒体路由回归测试。
 *
 * 直接经过真实 HTTP 入口，覆盖密码/用户令牌前缀、master/子清单、HEAD、Range、
 * 404，以及远端 Host 对 browserLoginStart 的限制。测试预置内存 fMP4 片段，并把
 * ensureBrowser 换成“调用即失败”的哨兵，所以不会启动真实 Chromium。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PASS = 'routepass'
const USER_TOKEN = 'route_token_1234'
const DATA_DIR = mkdtempSync(join(tmpdir(), 'iptv-ysp-app-route-'))

async function freePort() {
  const probe = http.createServer()
  await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const selected = probe.address().port
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
  return selected
}

const PORT = await freePort()

// 项目模块会在 import 时读取这些值，必须先设置。空白模式让 app 启动回调不抓远端源。
process.env.mdataDir = DATA_DIR
process.env.mport = String(PORT)
process.env.mpass = PASS
process.env.mblank = 'true'
process.env.mbuiltInSourcesUrl = ''
process.env.NO_PROXY = process.env.no_proxy = '127.0.0.1,localhost'

writeFileSync(join(DATA_DIR, 'users.json'), JSON.stringify({
  requireToken: false,
  users: [{
    id: 'u_route_test',
    name: '路由测试用户',
    token: USER_TOKEN,
    enabled: true,
    expiresAt: null,
  }],
}))
writeFileSync(join(DATA_DIR, 'external-sources.json'), JSON.stringify({
  enabled: false,
  updateOnStartup: false,
  sources: [],
}))

const { AUTH_CHANNEL_BY_REF } = await import('../extractors/yangshipin/channels.js')
const { createTrackState } = await import('../extractors/yangshipin/vip-bridge.js')
const { runtime, runLoginKeepalive } = await import('../extractors/yangshipin/runtime.js')

const channel = AUTH_CHANNEL_BY_REF.get('ysp-vip-cctvfyzq')
const mediaBody = Buffer.from('0123456789')
const initBody = Buffer.from('fake-init')

function readyTrack() {
  return {
    ...createTrackState(),
    init: initBody,
    timescale: 90_000,
    lastChunkAt: Date.now(),
    segments: new Map([[
      7,
      { sequence: 7, sourceSequence: 7, duration: 4, epoch: 0, discontinuity: false, body: mediaBody },
    ]]),
    segmentBytes: mediaBody.length,
  }
}

let chromiumStarts = 0
runtime.browserSession.ensureBrowser = async () => {
  chromiumStarts++
  throw new Error('回归测试禁止启动 Chromium')
}
runtime.vipBridge.streams.set(channel.id, {
  channel,
  streamId: 23,
  touched: Date.now(),
  draining: null,
  ready: null,
  page: {
    isClosed: () => false,
    evaluate: async () => [],
    close: async () => {},
  },
  audio: readyTrack(),
  video: readyTrack(),
})

function request(path, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path,
      method,
      headers: {
        Host: `127.0.0.1:${PORT}`,
        Connection: 'close',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...headers,
      },
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }))
    })
    req.once('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

async function waitForApp() {
  let lastError
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await request('/favicon.ico')
      if (response.status === 204) return
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw lastError || new Error('app.js 未开始监听')
}

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed++
  console.log(`  ✅ ${name}`)
}

console.log('app.js 央视频本地媒体路由回归测试')

try {
  await import('../app.js')
  await waitForApp()

  await check('mpass + relay/proxy master 保留密码前缀，并指向本机音视频子清单', async () => {
    const response = await request(`/${PASS}/relay/ysp-vip-cctvfyzq.m3u8?session=pass`)
    assert.equal(response.status, 200)
    assert.match(response.headers['content-type'], /^application\/vnd\.apple\.mpegurl/)
    const text = response.body.toString()
    assert.match(text, new RegExp(`/${PASS}/ysp-vip/${channel.id}/audio\\.m3u8`))
    assert.match(text, new RegExp(`/${PASS}/ysp-vip/${channel.id}/video\\.m3u8`))

    // 全代理版订阅会套 /proxy/<ref>.m3u8；VIP 本身已是本机媒体，入口必须仍
    // 由模块接管，不能误落到通用上游代理或账号段解析。
    const proxied = await request(`/${PASS}/proxy/ysp-vip-cctvfyzq.m3u8?session=pass`)
    assert.equal(proxied.status, 200)
    assert.match(proxied.body.toString(), new RegExp(`/${PASS}/ysp-vip/${channel.id}/video\\.m3u8`))
  })

  await check('/u token + relay master 与子清单都保留用户令牌前缀', async () => {
    const master = await request(`/u/${USER_TOKEN}/relay/ysp-vip-cctvfyzq.m3u8?session=user`)
    assert.equal(master.status, 200)
    assert.match(master.body.toString(), new RegExp(`/u/${USER_TOKEN}/ysp-vip/${channel.id}/video\\.m3u8`))

    const child = await request(`/u/${USER_TOKEN}/ysp-vip/${channel.id}/video.m3u8`)
    assert.equal(child.status, 200)
    const text = child.body.toString()
    assert.match(text, new RegExp(`#EXT-X-MAP:URI="/u/${USER_TOKEN}/ysp-vip/${channel.id}/video/init\\.mp4\\?v=23-0"`))
    assert.match(text, new RegExp(`/u/${USER_TOKEN}/ysp-vip/${channel.id}/video/7\\.m4s\\?v=23-0`))
  })

  await check('mpass 子清单保留密码前缀，HEAD 本地回答且不返回正文', async () => {
    const child = await request(`/${PASS}/ysp-vip/${channel.id}/audio.m3u8`)
    assert.equal(child.status, 200)
    assert.match(child.body.toString(), new RegExp(`/${PASS}/ysp-vip/${channel.id}/audio/7\\.m4s\\?v=23-0`))

    const head = await request(`/${PASS}/relay/ysp-vip-cctvfyzq.m3u8?session=head`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.body.length, 0)
    assert.ok(Number(head.headers['content-length']) > 0)
  })

  await check('分片 GET/HEAD 支持 Range，过期分片明确 404', async () => {
    const path = `/${PASS}/ysp-vip/${channel.id}/video/7.m4s`
    const ranged = await request(path, { headers: { Range: 'bytes=2-5' } })
    assert.equal(ranged.status, 206)
    assert.equal(ranged.body.toString(), '2345')
    assert.equal(ranged.headers['content-range'], 'bytes 2-5/10')
    assert.equal(ranged.headers['content-length'], '4')

    const head = await request(path, { method: 'HEAD', headers: { Range: 'bytes=2-5' } })
    assert.equal(head.status, 206)
    assert.equal(head.body.length, 0)
    assert.equal(head.headers['content-range'], 'bytes 2-5/10')
    assert.equal(head.headers['content-length'], '4')

    const missing = await request(`/${PASS}/ysp-vip/${channel.id}/video/8.m4s`)
    assert.equal(missing.status, 404)
    assert.match(missing.body.toString(), /片段已过期/)
  })

  await check('远端 Host 拒绝 browserLoginStart，但允许只读 status', async () => {
    const headers = {
      Host: `nas.example.test:${PORT}`,
      'Content-Type': 'application/json',
    }
    const start = await request(`/${PASS}/api/extractors`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'browserLoginStart', id: 'yangshipin' }),
    })
    assert.equal(start.status, 403)
    assert.equal(JSON.parse(start.body).code, 'LOCAL_BROWSER_LOGIN_ONLY')

    const status = await request(`/${PASS}/api/extractors`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'browserLoginStatus', id: 'yangshipin' }),
    })
    assert.equal(status.status, 200)
    const payload = JSON.parse(status.body)
    assert.equal(payload.success, true)
    assert.equal(payload.data.running, false)
  })

  await check('导入登录态不受「仅本机」限制：远端 Host 可调用；内容不对时在解析阶段就拒绝，不启动 Chromium', async () => {
    const headers = { Host: `nas.example.test:${PORT}`, 'Content-Type': 'application/json' }
    const post = payload => request(`/${PASS}/api/extractors`, {
      method: 'POST', headers, body: JSON.stringify({ action: 'browserLoginImport', id: 'yangshipin', payload }),
    })
    const noIdentity = await post('ysp_pc=1; ysp_uv=2')
    // 动作失败按既有约定回 400 + {success:false}，但绝不能是 403 LOCAL_BROWSER_LOGIN_ONLY
    assert.equal(noIdentity.status, 400, noIdentity.body.toString())
    const denied = JSON.parse(noIdentity.body)
    assert.equal(denied.success, false)
    assert.notEqual(denied.code, 'LOCAL_BROWSER_LOGIN_ONLY')
    assert.match(denied.message, /会话 cookie/)

    const empty = JSON.parse((await post('')).body)
    assert.equal(empty.success, false)
    assert.match(empty.message, /粘贴/)

    const notString = JSON.parse((await request(`/${PASS}/api/extractors`, {
      method: 'POST', headers, body: JSON.stringify({ action: 'browserLoginImport', id: 'yangshipin', payload: { cookies: {} } }),
    })).body)
    assert.equal(notString.success, false)
  })

  await check('关联标记只在官网确认登录后写入、未登录即清除；未关联时保活直接跳过、不碰浏览器', async () => {
    const marker = runtime.loginLink.markerPath
    assert.ok(marker.startsWith(DATA_DIR), '标记必须落在数据目录')
    assert.equal(existsSync(marker), false)
    assert.deepEqual(await runLoginKeepalive(), { skipped: 'unlinked' })

    runtime.loginLink.remember({ authenticated: true, account: { nickname: '测试账号', vip: true } })
    assert.equal(existsSync(marker), true)
    assert.equal(runtime.loginLink.read().nickname, '测试账号')
    assert.equal(runtime.loginLink.read().vip, true)
    const linkedAt = runtime.loginLink.read().linkedAt
    runtime.loginLink.remember({ authenticated: true, account: { nickname: '测试账号', vip: false } })
    assert.equal(runtime.loginLink.read().linkedAt, linkedAt, '重复确认不改首次关联时间')

    runtime.loginLink.remember({ authenticated: false, account: null })
    assert.equal(existsSync(marker), false)
    assert.deepEqual(await runLoginKeepalive(), { skipped: 'unlinked' })
  })

  await check('客户端批量探测：同一客户端连续 GET 多个公开频道，第 6 个起本地拒绝、不再打上游；别的客户端不受影响', async () => {
    // 央视频取票走全局 fetch，这里桩成 403：前几路会真的进解析链（并失败），拒绝的一路不该碰它
    const realFetch = globalThis.fetch
    let upstream = 0
    globalThis.fetch = async () => { upstream++; return new Response('denied', { status: 403 }) }
    try {
      const outcomes = []
      for (const ref of ['cctv1', 'cctv2', 'cctv3', 'cctv4', 'cctv5', 'cctv6', 'cctv7', 'cctv8']) {
        const before = upstream
        const response = await request(`/${PASS}/relay/ysp-${ref}.m3u8`, { headers: { 'User-Agent': 'scan-test/1.0' } })
        outcomes.push({ status: response.status, body: response.body.toString(), hit: upstream > before })
      }
      assert.ok(outcomes.slice(0, 5).every(o => o.hit), '前 5 个台正常进解析链')
      assert.ok(outcomes.slice(5).every(o => !o.hit), '第 6 个起一枪都不打上游')
      assert.ok(outcomes.slice(5).every(o => o.status === 200 && o.body.includes('批量探测')), '拒绝仍是 code 200 + 中文原因')
      const before = upstream
      const other = await request(`/${PASS}/relay/ysp-cctv1.m3u8`, { headers: { 'User-Agent': 'viewer-test/1.0' } })
      assert.equal(other.body.toString().includes('批量探测'), false, '另一个客户端不受影响')
      assert.ok(upstream > before, '另一个客户端照常进解析链')
    } finally {
      globalThis.fetch = realFetch
    }
  })

  assert.equal(chromiumStarts, 0, '测试不应尝试启动 Chromium')
  assert.equal(runtime.browserSession.running, false)
  console.log(`\n全部通过 (${passed} 项，Chromium 启动 0 次)`)
  rmSync(DATA_DIR, { recursive: true, force: true })
  process.exit(0)
} catch (error) {
  console.error(error)
  rmSync(DATA_DIR, { recursive: true, force: true })
  process.exit(1)
}
