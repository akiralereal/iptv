#!/usr/bin/env node
/**
 * 本地台标缓存失效回归测试（issue #119）。
 *
 * 不变量：
 * 1. findLocalLogo 写进订阅的地址带 ?v=<文件修改时间>，同名换图后地址必须变化，
 *    否则播放器按地址缓存的旧图永远不刷新；
 * 2. /logos/ 路由按路径取文件、忽略 query，并回 ETag / Last-Modified，
 *    条件请求命中回 304、换图后旧 ETag 拿到新图；HEAD 不带正文。
 * 经真实 HTTP 入口验证，密码前缀与裸路径两种形式都覆盖。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PASS = 'logopass'
const DATA_DIR = mkdtempSync(join(tmpdir(), 'iptv-local-logo-'))
const LOGO_DIR = join(DATA_DIR, 'logos')
const NAME = 'CCTV怀旧剧场'

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

mkdirSync(LOGO_DIR, { recursive: true })
writeFileSync(join(DATA_DIR, 'external-sources.json'), JSON.stringify({ enabled: false, updateOnStartup: false, sources: [] }))

const FIRST = Buffer.from('89504e470d0a1a0a-first-image', 'utf8')
const SECOND = Buffer.from('89504e470d0a1a0a-second-image-longer', 'utf8')
const logoFile = join(LOGO_DIR, `${NAME}.png`)

// 明确设置修改时间：真实场景两次上传相隔数秒到数分钟，测试里用固定时间戳避免同毫秒
function putLogo(content, mtimeSeconds) {
  writeFileSync(logoFile, content)
  utimesSync(logoFile, mtimeSeconds, mtimeSeconds)
}

const { findLocalLogo } = await import('../utils/updateData.js')

function request(path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path,
      method,
      headers: { Host: `127.0.0.1:${PORT}`, Connection: 'close', ...headers },
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.once('error', reject)
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

console.log('本地台标缓存失效回归测试')

const encoded = encodeURIComponent(NAME)

try {
  await check('★ 订阅里的台标地址带文件修改时间版本号，换图后地址变化', async () => {
    putLogo(FIRST, 1_700_000_000)
    const first = findLocalLogo(NAME)
    assert.equal(first, `\${replace}/logos/${encoded}.png?v=1700000000000`)

    // 模拟「移除后重传」：同名同扩展，只有内容和修改时间变了
    putLogo(SECOND, 1_700_000_090)
    const second = findLocalLogo(NAME)
    assert.equal(second, `\${replace}/logos/${encoded}.png?v=1700000090000`)
    assert.notEqual(first, second)
  })

  await check('没有本地台标时仍返回空串；扩展名优先级不受版本号影响', async () => {
    assert.equal(findLocalLogo('不存在的频道'), '')
    assert.equal(findLocalLogo(''), '')
    writeFileSync(join(LOGO_DIR, '双图.jpg'), FIRST)
    writeFileSync(join(LOGO_DIR, '双图.png'), FIRST)
    assert.match(findLocalLogo('双图'), /\/logos\/%E5%8F%8C%E5%9B%BE\.png\?v=\d+$/)
  })

  await import('../app.js')
  await waitForApp()

  let etag = ''
  let lastModified = ''
  await check('GET 带 query 的台标地址：路由忽略 query，回 200 + ETag + Last-Modified', async () => {
    const response = await request(`/${PASS}/logos/${encoded}.png?v=1700000090000`)
    assert.equal(response.status, 200)
    assert.equal(response.headers['content-type'], 'image/png')
    assert.equal(response.headers['content-length'], String(SECOND.length))
    assert.equal(response.headers['cache-control'], 'public, max-age=86400')
    assert.ok(response.body.equals(SECOND))
    etag = response.headers.etag
    lastModified = response.headers['last-modified']
    assert.match(etag, /^"[0-9a-f]+-[0-9a-f]+"$/)
    assert.equal(lastModified, new Date(1_700_000_090_000).toUTCString())
  })

  await check('If-None-Match / If-Modified-Since 命中回 304 且无正文', async () => {
    const byTag = await request(`/${PASS}/logos/${encoded}.png`, { headers: { 'If-None-Match': etag } })
    assert.equal(byTag.status, 304)
    assert.equal(byTag.body.length, 0)
    assert.equal(byTag.headers.etag, etag)

    const weak = await request(`/${PASS}/logos/${encoded}.png`, { headers: { 'If-None-Match': `"other", ${etag}` } })
    assert.equal(weak.status, 304)

    const byDate = await request(`/${PASS}/logos/${encoded}.png`, { headers: { 'If-Modified-Since': lastModified } })
    assert.equal(byDate.status, 304)
    assert.equal(byDate.body.length, 0)
  })

  await check('换图后旧 ETag / 旧日期不再命中，拿到新图与新 ETag', async () => {
    putLogo(FIRST, 1_700_000_500)
    const response = await request(`/${PASS}/logos/${encoded}.png`, { headers: { 'If-None-Match': etag, 'If-Modified-Since': lastModified } })
    assert.equal(response.status, 200)
    assert.ok(response.body.equals(FIRST))
    assert.notEqual(response.headers.etag, etag)
    assert.equal(response.headers['last-modified'], new Date(1_700_000_500_000).toUTCString())
  })

  await check('HEAD 只回头不回正文；台标路由仍在鉴权之后，缺密码前缀拿不到图', async () => {
    const head = await request(`/${PASS}/logos/${encoded}.png`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.body.length, 0)
    assert.equal(head.headers['content-length'], String(FIRST.length))
    assert.ok(head.headers.etag)

    const bare = await request(`/logos/${encoded}.png?v=1`)
    assert.equal(bare.status, 403)
  })

  await check('不存在 404，越权路径 400', async () => {
    const missing = await request(`/${PASS}/logos/nope.png`)
    assert.equal(missing.status, 404)
    const traversal = await request(`/${PASS}/logos/..%2F..%2Fpackage.json`)
    assert.equal(traversal.status, 400)
  })

  await check('托管台标 /logo-cache/：按哈希文件名取图、带缓存头，文件名不合规回 400，同样在鉴权之后', async () => {
    const CACHE_DIR = join(DATA_DIR, 'logo-cache')
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(join(CACHE_DIR, '0123456789abcdef0123.png'), SECOND)
    const response = await request(`/${PASS}/logo-cache/0123456789abcdef0123.png?v=1&from=auto`)
    assert.equal(response.status, 200)
    assert.equal(response.headers['content-type'], 'image/png')
    assert.ok(response.body.equals(SECOND))
    assert.match(response.headers.etag, /^"[0-9a-f]+-[0-9a-f]+"$/)
    assert.equal((await request(`/${PASS}/logo-cache/0123456789abcdef9999.png`)).status, 404)
    for (const bad of ['index.json', '..%2Findex.json', 'ABCDEF0123456789ABCD.png', '0123456789abcdef0123.exe']) {
      assert.equal((await request(`/${PASS}/logo-cache/${bad}`)).status, 400, bad)
    }
    assert.equal((await request('/logo-cache/0123456789abcdef0123.png')).status, 403)
  })

  console.log(`\n全部通过 (${passed} 项)`)
  rmSync(DATA_DIR, { recursive: true, force: true })
  process.exit(0)
} catch (error) {
  console.error(error)
  rmSync(DATA_DIR, { recursive: true, force: true })
  process.exit(1)
}
