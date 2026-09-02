#!/usr/bin/env node
/**
 * 无头浏览器启动器测试：实例数闸门、空闲让位、启动回退顺序、超时不再逐级重试。
 * 全程用假的 launchImpl，不会真的起 Chromium。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import {
  BASE_ARGS,
  BrowserPool,
  closeBrowser,
  isLaunchTimeoutError,
  launchBrowser,
  launchWithFallback,
} from '../utils/browserLauncher.js'
import { shouldBlockRequest } from '../utils/webSourceExtractor.js'

let passed = 0
const check = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

class FakeBrowser extends EventEmitter {
  constructor() {
    super()
    this.closed = false
    this.connected = true
  }
  process() { return null }
  async close() {
    this.closed = true
    this.connected = false
    this.emit('disconnected')
  }
}

console.log('浏览器启动器测试')

await check('启动参数带 Docker 必备的 --disable-dev-shm-usage 且关闭磁盘缓存', async () => {
  assert.ok(BASE_ARGS.includes('--disable-dev-shm-usage'))
  assert.ok(BASE_ARGS.includes('--disk-cache-size=1'))
  assert.ok(BASE_ARGS.includes('--no-sandbox'))
  assert.ok(BASE_ARGS.includes('--autoplay-policy=no-user-gesture-required'))
})

await check('闸门：超出上限的请求排队，位子归还后按顺序放行', async () => {
  const pool = new BrowserPool({ limit: 1 })
  const a = await pool.acquire({ label: 'A' })
  let granted = false
  const waiting = pool.acquire({ label: 'B', waitMs: 5000 }).then(slot => { granted = true; return slot })
  await tick()
  assert.equal(granted, false)
  assert.equal(pool.waiting, 1)
  a.release()
  const b = await waiting
  assert.equal(granted, true)
  assert.equal(pool.size, 1)
  a.release() // 重复归还是空操作
  assert.equal(pool.size, 1)
  b.release()
  assert.equal(pool.size, 0)
})

await check('闸门：等不到位子在 waitMs 后明确失败，且不再占队', async () => {
  const pool = new BrowserPool({ limit: 1 })
  const a = await pool.acquire({ label: 'A' })
  await assert.rejects(pool.acquire({ label: 'B', waitMs: 20 }), /浏览器实例已达上限（1 个/)
  assert.equal(pool.waiting, 0)
  a.release()
})

await check('闸门：位子被占满时会请空闲的持有者让位，忙碌的持有者不被打扰', async () => {
  const pool = new BrowserPool({ limit: 1 })
  let busy = true
  let asked = 0
  const holder = await pool.acquire({
    label: '常驻会话',
    onIdleRequest: async () => {
      asked++
      if (busy) return false
      holder.release()
      return true
    },
  })
  // 忙碌：排队方只能等
  await assert.rejects(pool.acquire({ label: '抓取', waitMs: 20 }), /等待 0 秒仍无空闲/)
  assert.equal(asked, 1)
  // 空闲：让位后排队方立刻拿到位子
  busy = false
  const slot = await pool.acquire({ label: '抓取', waitMs: 1000 })
  assert.equal(asked, 2)
  assert.equal(pool.size, 1)
  slot.release()
})

await check('位子随浏览器 disconnected 自动归还（含 closeBrowser 路径）', async () => {
  const pool = new BrowserPool({ limit: 1 })
  const slot = await pool.acquire({ label: 'A' })
  const browser = new FakeBrowser()
  slot.attach(browser)
  await closeBrowser(browser, { label: '测试' })
  assert.equal(browser.closed, true)
  assert.equal(pool.size, 0)
})

await check('closeBrowser：close() 卡住时超时返回，不会永久阻塞', async () => {
  const browser = new FakeBrowser()
  browser.close = () => new Promise(() => {})
  const started = Date.now()
  await closeBrowser(browser, { label: '测试', timeoutMs: 30 })
  assert.ok(Date.now() - started < 1000)
})

await check('回退顺序：显式路径与系统路径相同只试一次，失败后转 puppeteer 自带', async () => {
  const tried = []
  const browser = await launchWithFallback({
    env: { PUPPETEER_EXECUTABLE_PATH: '/usr/bin/chromium' },
    platform: 'linux',
    exists: p => p === '/usr/bin/chromium',
    launchImpl: async opts => {
      tried.push(opts.executablePath || opts.channel || 'bundled')
      if (opts.executablePath) throw new Error('spawn /usr/bin/chromium ENOENT')
      return new FakeBrowser()
    },
  })
  assert.ok(browser instanceof FakeBrowser)
  assert.deepEqual(tried, ['/usr/bin/chromium', 'bundled'])
})

await check('回退顺序：启动超时立刻失败，不再拿别的二进制往过载的机器上加负载', async () => {
  const tried = []
  const timeoutErr = new Error('Timed out after 30000 ms while waiting for the WS endpoint URL to appear in stdout!')
  timeoutErr.name = 'TimeoutError'
  assert.equal(isLaunchTimeoutError(timeoutErr), true)
  assert.equal(isLaunchTimeoutError(new Error('spawn ENOENT')), false)
  await assert.rejects(launchWithFallback({
    env: { PUPPETEER_EXECUTABLE_PATH: '/usr/bin/chromium' },
    platform: 'linux',
    exists: p => p === '/usr/bin/google-chrome' || p === '/usr/bin/chromium',
    launchImpl: async opts => { tried.push(opts.executablePath); throw timeoutErr },
  }), /启动超时（机器负载过高或内存不足/)
  assert.deepEqual(tried, ['/usr/bin/chromium'])
})

await check('回退顺序：全部候选都不可用时给出人能看懂的说明', async () => {
  await assert.rejects(launchWithFallback({
    env: {},
    platform: 'linux',
    exists: () => false,
    launchImpl: async () => { throw new Error('Could not find Chrome (ver. 1)') },
  }), /找不到可用的 Chrome\/Chromium/)
})

await check('launchBrowser：启动失败自动归还位子；成功后位子随浏览器关闭归还', async () => {
  const { getBrowserPool } = await import('../utils/browserLauncher.js')
  const pool = getBrowserPool()
  const before = pool.size
  await assert.rejects(launchBrowser({
    label: '测试',
    launchImpl: async () => { throw new Error('Could not find Chrome') },
  }), /找不到可用的 Chrome/)
  assert.equal(pool.size, before)
  const browser = await launchBrowser({ label: '测试', launchImpl: async () => new FakeBrowser() })
  assert.equal(pool.size, before + 1)
  await browser.close()
  assert.equal(pool.size, before)
})

await check('网页抓取只嗅探地址：分片 / 图片 / 字体被拦，m3u8 永远放行', async () => {
  const req = (url, type = 'xhr') => ({ url: () => url, resourceType: () => type })
  assert.equal(shouldBlockRequest(req('https://cdn.example/live/index.m3u8?auth=1')), false)
  assert.equal(shouldBlockRequest(req('https://cdn.example/live/index.m3u8', 'media')), false)
  assert.equal(shouldBlockRequest(req('https://cdn.example/live/seg-001.ts')), true)
  assert.equal(shouldBlockRequest(req('https://cdn.example/live/seg-001.m4s?x=1')), true)
  assert.equal(shouldBlockRequest(req('https://cdn.example/a.png', 'image')), true)
  assert.equal(shouldBlockRequest(req('https://cdn.example/a.woff2', 'font')), true)
  assert.equal(shouldBlockRequest(req('https://cdn.example/player.js', 'script')), false)
  assert.equal(shouldBlockRequest(req('https://cdn.example/api/play', 'xhr')), false)
})

console.log(`\n全部通过：${passed} 项`)
