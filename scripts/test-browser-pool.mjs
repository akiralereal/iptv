#!/usr/bin/env node
/**
 * 无头浏览器启动器测试：实例数闸门、空闲让位、启动回退顺序、超时不再逐级重试。
 * 全程用假的 launchImpl，不会真的起 Chromium。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BASE_ARGS,
  BrowserPool,
  clearStaleProfileLock,
  closeBrowser,
  isLaunchTimeoutError,
  isProfileInUseError,
  launchBrowser,
  launchWithFallback,
  platformArgs,
  profileInUseMessage,
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

await check('持久会话附加 userDataDir 时仍保留统一基础参数', async () => {
  let seen
  await launchWithFallback({
    env: {}, platform: 'unknown', exists: () => false,
    launchOptions: {
      userDataDir: '/tmp/dedicated-profile',
      protocolTimeout: 12_345,
      defaultViewport: { width: 800, height: 600 },
      args: ['--window-size=800,600'],
    },
    launchImpl: async opts => { seen = opts; return new FakeBrowser() },
  })
  assert.equal(seen.userDataDir, '/tmp/dedicated-profile')
  assert.equal(seen.protocolTimeout, 12_345)
  assert.deepEqual(seen.defaultViewport, { width: 800, height: 600 })
  assert.ok(seen.args.includes('--disable-dev-shm-usage'))
  assert.ok(seen.args.includes('--window-size=800,600'))
})

await check('Alpine（Docker 镜像）才加 --js-flags=--stack-size=96，其它平台不加；启动时真的带上', async () => {
  const onAlpine = (p) => p === '/etc/alpine-release'
  assert.deepEqual(platformArgs(onAlpine), ['--js-flags=--stack-size=96'])
  assert.deepEqual(platformArgs(() => false), [])
  assert.ok(!BASE_ARGS.some(a => a.includes('--stack-size')), '基础参数里不该带 stack-size')
  const seen = []
  const fakeBrowser = () => ({ process: () => null, once() {}, on() {} })
  await launchWithFallback({ launchImpl: async opts => { seen.push(opts.args); return fakeBrowser() }, env: {}, platform: 'linux', exists: onAlpine })
  assert.ok(seen[0].includes('--js-flags=--stack-size=96'))
  await launchWithFallback({ launchImpl: async opts => { seen.push(opts.args); return fakeBrowser() }, env: {}, platform: 'linux', exists: () => false })
  assert.ok(!seen[1].includes('--js-flags=--stack-size=96'))
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

// 与 Chromium 真实残留同构：三个符号链接，SingletonLock 指向「主机名-pid」
function lockedProfile(lockTarget) {
  const dir = mkdtempSync(join(tmpdir(), 'iptv-profile-lock-'))
  symlinkSync(lockTarget, join(dir, 'SingletonLock'))
  symlinkSync('/tmp/.org.chromium.Chromium.gone/SingletonSocket', join(dir, 'SingletonSocket'))
  symlinkSync('11266088405643339909', join(dir, 'SingletonCookie'))
  return dir
}
const singletons = dir => ['SingletonLock', 'SingletonSocket', 'SingletonCookie'].filter(name => {
  try { return Boolean(readlinkSync(join(dir, name))) } catch { return false }
})

await check('profile 锁：容器重建后主机名变了（issue #153），三个 Singleton 链接全部清掉', async () => {
  const dir = lockedProfile('3f2a9c1d7e44-123')
  try {
    const result = clearStaleProfileLock(dir, { hostname: 'b81e0c55aa01', isAlive: () => true, readCmdline: () => [] })
    assert.equal(result.cleared, true)
    assert.match(result.reason, /3f2a9c1d7e44/)
    assert.deepEqual(singletons(dir), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await check('profile 锁：同主机但 pid 已不存在（被 SIGKILL / 断电）时清掉', async () => {
  const dir = lockedProfile('nas-box-4242')
  try {
    const result = clearStaleProfileLock(dir, { hostname: 'nas-box', isAlive: () => false, readCmdline: () => { throw new Error('不该读') } })
    assert.equal(result.cleared, true)
    assert.deepEqual(singletons(dir), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await check('profile 锁：容器 restart 后 pid 被别的进程复用时清掉，不让 Chromium 去强杀那个进程', async () => {
  const dir = lockedProfile('nas-box-45')
  try {
    const result = clearStaleProfileLock(dir, {
      hostname: 'nas-box',
      isAlive: () => true,
      readCmdline: () => ['/usr/lib/chromium/chromium', '--user-data-dir=/tmp/puppeteer_dev_chrome_profile-x', `--user-data-dir=${dir}2`],
    })
    assert.equal(result.cleared, true)
    assert.match(result.reason, /别的进程/)
    assert.deepEqual(singletons(dir), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await check('profile 锁：同主机确有 Chromium 正用这个 profile、或读不到进程信息（macOS）时保留', async () => {
  const dir = lockedProfile('nas-box-45')
  try {
    const inUse = clearStaleProfileLock(dir, { hostname: 'nas-box', isAlive: () => true, readCmdline: () => ['/usr/bin/chromium', `--user-data-dir=${dir}`] })
    assert.deepEqual(inUse, { cleared: false, reason: '' })
    const unknown = clearStaleProfileLock(dir, { hostname: 'nas-box', isAlive: () => true, readCmdline: () => null })
    assert.deepEqual(unknown, { cleared: false, reason: '' })
    assert.deepEqual(singletons(dir), ['SingletonLock', 'SingletonSocket', 'SingletonCookie'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await check('profile 锁：主机名不同但该 pid 就是本机正开着这个 profile 的 Chromium（另一个 UTS 命名空间）时保留', async () => {
  const dir = lockedProfile('otherbox-77')
  try {
    const result = clearStaleProfileLock(dir, { hostname: 'nas-box', isAlive: () => true, readCmdline: () => ['/usr/bin/chromium', `--user-data-dir=${dir}`] })
    assert.deepEqual(result, { cleared: false, reason: '' })
    assert.deepEqual(singletons(dir), ['SingletonLock', 'SingletonSocket', 'SingletonCookie'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await check('profile 锁：持有者用别名路径（符号链接 / 结尾斜杠 / 相对路径）打开同一个 profile 也认得出，保留', async () => {
  const root = mkdtempSync(join(tmpdir(), 'iptv-profile-alias-'))
  try {
    const real = join(root, 'data', 'chrome-profile')
    mkdirSync(real, { recursive: true })
    symlinkSync(join(root, 'data'), join(root, 'alias'))
    symlinkSync('nas-box-45', join(real, 'SingletonLock'))
    const holder = args => ({ hostname: 'nas-box', isAlive: () => true, readCmdline: () => ['/usr/bin/chromium', ...args], readCwd: () => root })
    for (const arg of [`--user-data-dir=${join(root, 'alias', 'chrome-profile')}`, `--user-data-dir=${real}/`, `--user-data-dir=${root}/./data/chrome-profile`, '--user-data-dir=data/chrome-profile']) {
      assert.deepEqual(clearStaleProfileLock(real, holder([arg])), { cleared: false, reason: '' }, arg)
    }
    // 相对路径但读不到持有者的 cwd：不猜，保留
    assert.equal(clearStaleProfileLock(real, { ...holder(['--user-data-dir=elsewhere']), readCwd: () => null }).cleared, false)
    // 同一别名机制指向的是另一个目录：照常清
    assert.equal(clearStaleProfileLock(real, holder([`--user-data-dir=${join(root, 'alias')}`])).cleared, true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

await check('profile 锁：pid 是刚被强杀、尚未回收的进程（cmdline 为空）时清掉，原因不误报成 pid 复用', async () => {
  const dir = lockedProfile('nas-box-45')
  try {
    const result = clearStaleProfileLock(dir, { hostname: 'nas-box', isAlive: () => true, readCmdline: () => [] })
    assert.equal(result.cleared, true)
    assert.match(result.reason, /已退出/)
    assert.doesNotMatch(result.reason, /容器重启/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await check('profile 锁：SingletonLock 被改写成普通文件（Linux 上 Chromium 自己也起不来）时清掉', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iptv-profile-lock-'))
  try {
    writeFileSync(join(dir, 'SingletonLock'), 'nas-box-45')
    const result = clearStaleProfileLock(dir, { hostname: 'nas-box', isAlive: () => { throw new Error('不该查') } })
    assert.equal(result.cleared, true)
    assert.match(result.reason, /不是符号链接/)
    assert.equal(existsSync(join(dir, 'SingletonLock')), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await check('profile 锁：没有锁 / 目录还不存在时什么也不做；默认探测能认出 pid 被非 Chromium 进程复用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iptv-profile-lock-'))
  try {
    assert.deepEqual(clearStaleProfileLock(dir), { cleared: false, reason: '' })
    assert.deepEqual(clearStaleProfileLock(join(dir, 'missing')), { cleared: false, reason: '' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
  // 默认探测：本进程（node）活着但命令行里没有 --user-data-dir=<dir>，能读 /proc 时应判为 pid 复用
  const own = lockedProfile(`${hostname()}-${process.pid}`)
  try {
    const result = clearStaleProfileLock(own)
    if (existsSync(`/proc/${process.pid}/cmdline`)) {
      assert.equal(result.cleared, true)
      assert.deepEqual(singletons(own), [])
    } else {
      assert.equal(result.cleared, false)
    }
  } finally { rmSync(own, { recursive: true, force: true }) }
})

await check('持久 profile 启动前先清锁；清锁出错不挡启动；没有 userDataDir 不碰', async () => {
  const cleaned = []
  await launchWithFallback({
    env: {}, platform: 'unknown', exists: () => false,
    launchOptions: { userDataDir: '/data/yangshipin/chrome-profile' },
    clearProfileLock: dir => { cleaned.push(dir); throw new Error('EACCES') },
    launchImpl: async () => new FakeBrowser(),
  })
  assert.deepEqual(cleaned, ['/data/yangshipin/chrome-profile'])
  await launchWithFallback({
    env: {}, platform: 'unknown', exists: () => false,
    clearProfileLock: dir => { cleaned.push(dir); return { cleared: false, reason: '' } },
    launchImpl: async () => new FakeBrowser(),
  })
  assert.deepEqual(cleaned, ['/data/yangshipin/chrome-profile'])
})

await check('默认接线：launchWithFallback 真的在启动前清掉别的主机留下的锁（issue #153 的生产路径）', async () => {
  const dir = lockedProfile('3f2a9c1d7e44-123')
  try {
    let lockAtLaunch
    await launchWithFallback({
      env: {}, platform: 'unknown', exists: () => false,
      launchOptions: { userDataDir: dir },
      launchImpl: async opts => { lockAtLaunch = singletons(opts.userDataDir); return new FakeBrowser() },
    })
    assert.deepEqual(lockAtLaunch, [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await check('profile 仍被占用（Code 21）时直接说清原因，不再换二进制、也不再报「找不到 Chrome」', async () => {
  const inUse = new Error('Failed to launch the browser process:  Code: 21\n\nstderr:\n[1:1:0930/1.2:ERROR:chrome/browser/process_singleton_posix.cc:358] The profile appears to be in use by another Chromium process (123) on another computer (3f2a9c1d7e44). Chromium has locked the profile so that it doesn\'t get corrupted.\n')
  assert.equal(isProfileInUseError(inUse), true)
  assert.equal(isProfileInUseError(new Error('Failed to launch the browser process:  Code: 210')), false)
  assert.equal(isProfileInUseError(new Error('spawn ENOENT')), false)
  assert.equal(isProfileInUseError(new Error('The browser is already running for /iptv/data/yangshipin/chrome-profile. Use a different `userDataDir` or stop the running browser first.')), true)
  const dir = lockedProfile('3f2a9c1d7e44-123')
  const tried = []
  try {
    await assert.rejects(launchWithFallback({
      env: { PUPPETEER_EXECUTABLE_PATH: '/usr/bin/chromium' },
      platform: 'linux',
      exists: p => p === '/usr/bin/chromium',
      launchOptions: { userDataDir: dir },
      clearProfileLock: () => ({ cleared: false, reason: '' }),
      launchImpl: async opts => { tried.push(opts.executablePath || opts.channel || 'bundled'); throw inUse },
    }), error => {
      assert.ok(error.message.includes(`profile 正被另一个 Chromium 进程占用（${dir}）`))
      assert.match(error.message, /SingletonLock/)
      assert.match(error.message, /on another computer \(3f2a9c1d7e44\)/)
      assert.doesNotMatch(error.message, /找不到可用的 Chrome/)
      return true
    })
  } finally { rmSync(dir, { recursive: true, force: true }) }
  assert.deepEqual(tried, ['/usr/bin/chromium'])
})

await check('Chromium 建不了锁（目录只读 / 属主不对）时说成目录问题，不叫人去删并不存在的锁', async () => {
  const running = new Error('The browser is already running for /iptv/data/yangshipin/chrome-profile. Use a different `userDataDir` or stop the running browser first.')
  const message = profileInUseMessage('/iptv/data/yangshipin/chrome-profile', running, () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) })
  assert.match(message, /无法在浏览器 profile 目录加锁（\/iptv\/data\/yangshipin\/chrome-profile）/)
  assert.match(message, /可写/)
  assert.doesNotMatch(message, /删除该目录下/)
  assert.match(message, /原始错误: The browser is already running for/)
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
