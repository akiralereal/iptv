/**
 * 全进程共用的无头浏览器启动器。
 *
 * 此前网页抓取（内置源 / 外部源）、广东台续签、央视景观、湖北台防盗链四处各自
 * 起 Chromium、互不知情：一个 5 分钟 tick 里同时可以跑出 3~4 个 Chromium，每个
 * 都在真的播直播（解码 + 不停下载分片 + 写磁盘缓存）。低配机上内存一被挤爆就
 * 开始交换，表现就是用户反馈的「卡死、硬盘不停读写」，puppeteer 连启动等 WS
 * 端点的 30 秒超时都能拖到几十分钟。
 *
 * 这里做三件事：
 *   1. 全局上限：同时存活的 Chromium 不超过 mbrowserConcurrency（默认 2）。
 *      超出的调用者排队等待；等不到就明确失败，调用方走各自的退避 / 稍后重试。
 *   2. 空闲让位：常驻会话（广东台 / 央视景观 / 湖北台）在没有进行中的任务时，
 *      收到排队请求会主动关掉自己的浏览器把位子让出来，避免抢不到位子的一方饿死。
 *   3. 统一启动参数与回退顺序：Docker 必备的 --disable-dev-shm-usage、静音、
 *      关掉 GPU/后台联网/磁盘缓存；候选二进制去重；启动「超时」直接失败而不再
 *      换下一个二进制——超时说明机器已经过载，再拉一份只会更糟。
 */
import puppeteer from 'puppeteer'
import { existsSync } from 'node:fs'

import { printBlue, printRed, printYellow } from './colorOut.js'

// 各平台系统已安装的 Chrome / Chromium / Edge 常见可执行路径（按优先级）
const SYSTEM_CHROME_PATHS = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
}

export const BASE_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  // 部分站点（如 vtvgo.vn）检测到自动化特征后直接白屏
  '--disable-blink-features=AutomationControlled',
  // 多数直播页要起播才发起 m3u8 请求
  '--autoplay-policy=no-user-gesture-required',
  // Docker 默认 /dev/shm 只有 64MB，Chromium 用它做渲染进程共享内存，
  // 用满后渲染进程崩溃 / 卡死，是容器里无头浏览器挂死的头号原因
  '--disable-dev-shm-usage',
  // 无头 + 无 GPU 的服务器：关掉 GPU 进程与软渲染兜底，少一个进程少一份内存
  '--disable-gpu',
  '--mute-audio',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-extensions',
  '--disable-sync',
  '--disable-breakpad',
  // 我们只嗅探地址，不需要页面缓存：直播分片写盘缓存正是「硬盘不停读写」的来源
  '--disk-cache-size=1',
  '--media-cache-size=1',
]

const LAUNCH_TIMEOUT_MS = 30 * 1000
const DEFAULT_WAIT_MS = 60 * 1000
const DEFAULT_CLOSE_TIMEOUT_MS = 5 * 1000
const DEFAULT_MAX_BROWSERS = 2

function parseLimit(raw, fallback = DEFAULT_MAX_BROWSERS) {
  const n = parseInt(raw)
  return Number.isInteger(n) && n >= 1 ? n : fallback
}

/** 同时允许存活的 Chromium 数量，环境变量 mbrowserConcurrency 可调（≥1）。 */
export const MAX_BROWSERS = parseLimit(process.env.mbrowserConcurrency)

const firstLine = err => String(err?.message || err || '未知错误').split('\n')[0]

export function findSystemChrome(platform = process.platform, exists = existsSync) {
  return (SYSTEM_CHROME_PATHS[platform] || []).find(p => exists(p)) || ''
}

/** puppeteer 等 WS 端点 / 初始页超时。二进制在、进程也拉起来了，只是机器太慢。 */
export function isLaunchTimeoutError(err) {
  return err?.name === 'TimeoutError' || /Timed out after \d+ ms/i.test(err?.message || '')
}

let announcedExecutable = ''

/**
 * 按顺序尝试：显式指定（PUPPETEER_EXECUTABLE_PATH / mchromePath）→ 系统已装浏览器
 * → puppeteer 自带 → channel:'chrome'。与旧实现的差别：
 *   - 显式路径与系统路径相同（Docker 镜像即如此）只试一次，不再重复；
 *   - 启动超时立即失败，不再逐级尝试（每一级都是再拉一份 Chromium 压到过载的机器上）。
 * @param {object} deps 便于单测注入
 */
export async function launchWithFallback({
  headless = true,
  launchImpl = opts => puppeteer.launch(opts),
  env = process.env,
  platform = process.platform,
  exists = existsSync,
} = {}) {
  const explicit = env.PUPPETEER_EXECUTABLE_PATH || env.mchromePath || ''
  const systemChrome = findSystemChrome(platform, exists)
  const candidates = []
  if (explicit) candidates.push({ label: `指定的浏览器(${explicit})`, opts: { executablePath: explicit } })
  if (systemChrome && systemChrome !== explicit) candidates.push({ label: `系统浏览器(${systemChrome})`, opts: { executablePath: systemChrome } })
  candidates.push({ label: 'puppeteer 自带 Chrome', opts: {} })
  candidates.push({ label: 'channel: chrome', opts: { channel: 'chrome' } })

  let lastErr = null
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]
    try {
      const browser = await launchImpl({ headless, args: BASE_ARGS, timeout: LAUNCH_TIMEOUT_MS, ...candidate.opts })
      if (candidate.opts.executablePath && announcedExecutable !== candidate.opts.executablePath) {
        announcedExecutable = candidate.opts.executablePath
        printBlue(`使用浏览器: ${candidate.opts.executablePath}`)
      }
      return browser
    } catch (err) {
      lastErr = err
      if (isLaunchTimeoutError(err)) {
        throw new Error(
          `${candidate.label}启动超时（机器负载过高或内存不足，请检查内存 / 交换分区占用）: ${firstLine(err)}`,
        )
      }
      const next = candidates[i + 1]
      if (next) printRed(`${candidate.label}不可用，改用${next.label}: ${firstLine(err)}`)
    }
  }
  throw new Error(
    '找不到可用的 Chrome/Chromium，网页抓取型的源与需要浏览器的模块无法工作。'
    + '容器部署请确认镜像内 /usr/bin/chromium 存在（部分架构如 arm/v6 的 Alpine 没有该包）；'
    + '裸跑请安装 Chrome，或用 mchromePath / PUPPETEER_EXECUTABLE_PATH 指定路径。'
    + `原始错误: ${firstLine(lastErr)}`,
  )
}

/**
 * 浏览器实例数闸门。acquire() 拿到一个「位子」，位子随浏览器 disconnected 自动归还，
 * 也可显式 release()。位子满时排队；排队期间会请空闲的持有者让位。
 */
export class BrowserPool {
  constructor({ limit = MAX_BROWSERS } = {}) {
    this.limit = Math.max(1, Number(limit) || 1)
    this.holders = new Set()
    this.waiters = []
    this.reclaiming = false
  }

  get size() {
    return this.holders.size
  }

  get waiting() {
    return this.waiters.length
  }

  /**
   * @param {object} options
   * @param {string} options.label 日志用途
   * @param {number} options.waitMs 排队上限，超时抛错
   * @param {() => Promise<boolean>} [options.onIdleRequest]
   *   有人排队且位子满时被调用：持有者若当前空闲应关掉浏览器并返回 true
   */
  acquire({ label = '浏览器', waitMs = DEFAULT_WAIT_MS, onIdleRequest = null } = {}) {
    return new Promise((resolve, reject) => {
      const waiter = { label, onIdleRequest, resolve, reject, timer: null }
      if (this.holders.size < this.limit && this.waiters.length === 0) {
        this.#grant(waiter)
        return
      }
      waiter.timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter)
        if (idx >= 0) this.waiters.splice(idx, 1)
        reject(new Error(
          `浏览器实例已达上限（${this.limit} 个，可用环境变量 mbrowserConcurrency 调整），`
          + `等待 ${Math.round(waitMs / 1000)} 秒仍无空闲，本次放弃`,
        ))
      }, waitMs)
      this.waiters.push(waiter)
      printYellow(`${label} 等待空闲浏览器实例（当前 ${this.holders.size}/${this.limit} 个在用）`)
      void this.#reclaimIdle()
    })
  }

  #grant(waiter) {
    clearTimeout(waiter.timer)
    const holder = { label: waiter.label, onIdleRequest: waiter.onIdleRequest, released: false }
    this.holders.add(holder)
    const slot = {
      release: () => this.#release(holder),
      attach: browser => {
        browser?.once?.('disconnected', slot.release)
        browserSlots.set(browser, slot)
      },
    }
    waiter.resolve(slot)
  }

  #release(holder) {
    if (holder.released) return
    holder.released = true
    this.holders.delete(holder)
    this.#pump()
  }

  #pump() {
    while (this.waiters.length && this.holders.size < this.limit) {
      this.#grant(this.waiters.shift())
    }
  }

  /** 逐个请空闲的持有者让位；腾出足够的位子就停。同一时间只跑一轮。 */
  async #reclaimIdle() {
    if (this.reclaiming) return
    this.reclaiming = true
    try {
      for (const holder of [...this.holders]) {
        if (!this.waiters.length || this.holders.size < this.limit) break
        if (holder.released || typeof holder.onIdleRequest !== 'function') continue
        let yielded = false
        try {
          yielded = await holder.onIdleRequest()
        } catch {
          yielded = false
        }
        if (yielded) {
          printBlue(`${holder.label} 空闲，已让出浏览器实例给排队的任务`)
          this.#release(holder)
        }
      }
    } finally {
      this.reclaiming = false
    }
  }
}

const browserSlots = new WeakMap()
const pool = new BrowserPool()

export function getBrowserPool() {
  return pool
}

/**
 * 占一个位子并启动浏览器。位子随浏览器 disconnected 自动归还；
 * 启动失败自动归还并抛错。
 * @param {object} options
 * @param {boolean} [options.headless]
 * @param {string} [options.label]
 * @param {number} [options.waitMs]
 * @param {() => Promise<boolean>} [options.onIdleRequest]
 * @param {(opts: object) => Promise<import('puppeteer').Browser>} [options.launchImpl] 测试注入
 */
export async function launchBrowser({ headless = true, label = '浏览器', waitMs, onIdleRequest, launchImpl } = {}) {
  const slot = await pool.acquire({ label, waitMs, onIdleRequest })
  let browser
  try {
    browser = await launchWithFallback({ headless, launchImpl })
  } catch (err) {
    slot.release()
    throw err
  }
  slot.attach(browser)
  return browser
}

function killProcessTree(proc) {
  if (!proc?.pid) return
  try {
    // POSIX 下 puppeteer 以 detached 方式启动，chromium 的 pid 即进程组组长：
    // 连 renderer / zygote 子进程一起清掉
    process.kill(-proc.pid, 'SIGKILL')
  } catch {
    try { proc.kill('SIGKILL') } catch { /* 进程可能已退出 */ }
  }
}

/**
 * 健壮地关闭浏览器：close() 设超时，超时或异常则强杀进程组，最后归还位子。
 * @param {import('puppeteer').Browser|null} browser
 */
export async function closeBrowser(browser, { label = '浏览器', timeoutMs = DEFAULT_CLOSE_TIMEOUT_MS } = {}) {
  if (!browser) return
  const proc = typeof browser.process === 'function' ? browser.process() : null
  let timer
  try {
    await Promise.race([
      browser.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('browser.close() 超时')), timeoutMs)
      }),
    ])
  } catch (error) {
    printRed(`${label}关闭异常，强制结束 Chromium 进程: ${error?.message || error}`)
    killProcessTree(proc)
  } finally {
    clearTimeout(timer)
    browserSlots.get(browser)?.release()
  }
}
