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
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, unlinkSync } from 'node:fs'
import { hostname as osHostname } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

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

/**
 * Alpine（Docker 镜像里的 /usr/bin/chromium）专用：把 V8 的 JS 栈预算压到 96KB。
 * 官方镜像 CI 实测（Alpine 3.24 / Chromium 152）：JS 递归到一定深度后渲染进程直接崩、不抛 RangeError——
 * 普通递归到 17000 层能正常抛错，但每层有分配（闭包 / 数组）的递归到一千多层就崩；obfuscator.io 的
 * debugProtection（jsjiami 等混淆器都带，纬来体育播放器页就是）恰恰是每 2 秒一轮「递归到栈溢出再 catch」，
 * 于是播放器 iframe 一进来就崩，表现为「frame 不响应脚本执行」「脚本无响应」。JS 栈预算压小后 V8 在撞穿
 * 之前就抛 RangeError，页面自己 catch 掉继续跑；64 / 96 / 128 都验证可用、160 仍崩。桌面 Chrome 没这个问题，
 * 所以只在 Alpine 上加，代价是页面的 JS 递归上限约八百层，对直播页够用。
 */
const ALPINE_RELEASE_FILE = '/etc/alpine-release'
const ALPINE_ARGS = ['--js-flags=--stack-size=96']

export function platformArgs(exists = existsSync) {
  return exists(ALPINE_RELEASE_FILE) ? ALPINE_ARGS : []
}

const LAUNCH_TIMEOUT_MS = 30 * 1000
const DEFAULT_WAIT_MS = 60 * 1000
const DEFAULT_CLOSE_TIMEOUT_MS = 5 * 1000
const EXIT_GRACE_MS = 5 * 1000
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

/**
 * Chromium（Linux / macOS）在 userDataDir 里放三个符号链接防止两个进程同开一个 profile：
 * SingletonLock →「主机名-pid」、SingletonSocket、SingletonCookie。正常退出会删，被 SIGKILL /
 * 容器被停 / 断电则残留。下次启动时 Chromium 若发现锁里的主机名和本机不同，就认定「另一台电脑
 * 在用」、以 Code 21 退出，不会自己解锁。Docker 容器每次重建（拉新镜像 / NAS 上「更新」「重建」）
 * hostname 都换成新的容器 ID，于是挂载到宿主机的央视频 profile 一重建就再也起不来（issue #153）。
 * 容器只是 restart 时主机名不变，但 pid 从头分配，锁里的 pid 可能恰好被别的 Chromium 占着，
 * Chromium 会把它当成卡死的自己、等一轮后强杀——杀掉的是别的模块正在用的浏览器。
 *
 * 所以启动持久 profile 前先判断锁是否陈旧：锁里的 pid 若是本机一个正开着这个 profile 的 Chromium
 * （Linux 读 /proc 核对 --user-data-dir，按真实路径比较，别名 / 相对路径也认得出）就保留，交给 Chromium；
 * 否则主机名不同、pid 已不存在、pid 已是别的进程，都删掉三个链接。锁不是符号链接（被备份 / 同步工具
 * 改写成普通文件）时 Chromium 自己也起不来，一并删掉。读不到进程信息（macOS）且主机名相同就不猜，保留。
 * 两个容器共用同一个 data 目录同时运行时，这里分不清「另一个容器还在跑」和「旧容器已被重建」，
 * 会按后者处理——那种部署下配置文件本身也会互相覆盖，不在支持范围内。
 * @returns {{ cleared: boolean, reason: string }}
 */
export function clearStaleProfileLock(userDataDir, {
  hostname = osHostname(),
  isAlive = pidAlive,
  readCmdline = procCmdline,
  readCwd = procCwd,
  realpath = realpathSync,
  readlink = readlinkSync,
  unlink = unlinkSync,
} = {}) {
  const keep = { cleared: false, reason: '' }
  let target
  try {
    target = readlink(join(userDataDir, 'SingletonLock'))
  } catch (err) {
    // 没有锁：首次启动 / 上次正常退出 / Windows 不用这套机制
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return keep
    if (err?.code !== 'EINVAL') throw err
    target = null
  }
  const match = target === null ? null : /^(.*)-(\d+)$/.exec(String(target))
  let reason = ''
  if (target === null) {
    reason = 'SingletonLock 不是符号链接（可能被备份 / 同步工具改写过）'
  } else if (!match) {
    reason = `锁内容无法识别（${target}）`
  } else {
    const [, lockHost, pidText] = match
    const pid = Number(pidText)
    const alive = isAlive(pid)
    const cmdline = alive ? readCmdline(pid) : null
    if (cmdline && usesProfile(cmdline, userDataDir, () => readCwd(pid), realpath)) return keep
    if (lockHost !== hostname) {
      reason = `锁来自主机 ${lockHost}（pid ${pid}），本机是 ${hostname}；容器重建后主机名会变`
    } else if (!alive) {
      reason = `锁记录的 pid ${pid} 已不存在`
    } else if (cmdline === null) {
      return keep
    } else if (!cmdline.length) {
      // 僵尸 / 正在退出的进程 cmdline 为空，例如 closeBrowser 超时后刚被强杀的上一个实例
      reason = `锁记录的 pid ${pid} 已退出`
    } else {
      reason = `锁记录的 pid ${pid} 现在是别的进程（容器重启后 pid 从头分配）`
    }
  }
  // 锁最后删：中途失败时剩下的仍是一把完整的旧锁，而不是半套
  for (const name of ['SingletonSocket', 'SingletonCookie', 'SingletonLock']) {
    try {
      unlink(join(userDataDir, name))
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err
    }
  }
  return { cleared: true, reason }
}

/** 进程命令行里的 --user-data-dir 是否指向同一个目录；相对路径按该进程的 cwd 解析，读不到 cwd 就按「是」。 */
function usesProfile(cmdline, userDataDir, cwd, realpath) {
  const canonical = dir => {
    try { return realpath(dir) } catch { return resolve(dir) }
  }
  const own = canonical(userDataDir)
  return cmdline.some(arg => {
    // Chromium 也认单短横线写法 -user-data-dir=
    const dir = /^--?user-data-dir=(.*)$/.exec(arg)?.[1]
    if (dir === undefined) return false
    if (isAbsolute(dir)) return canonical(dir) === own
    const base = cwd()
    return base === null || canonical(resolve(base, dir)) === own
  })
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM：进程在，只是不归我们管
    return err?.code === 'EPERM'
  }
}

function procCmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
  } catch {
    return null
  }
}

function procCwd(pid) {
  try {
    return readlinkSync(`/proc/${pid}/cwd`)
  } catch {
    return null
  }
}

/**
 * profile 被占用：锁指向别的主机时 Chromium 以 Code 21 退出；同机另一个 Chromium 正开着它时，新进程把
 * 请求转交过去后自己退出，puppeteer 报「The browser is already running for …」。换别的二进制打开的
 * 还是同一个 profile，没有意义。
 */
export function isProfileInUseError(err) {
  const message = String(err?.message || '')
  return /\bCode: 21\b/.test(message)
    || /profile appears to be in use/i.test(message)
    || /browser is already running for/i.test(message)
}

let announcedExecutable = ''

/**
 * Chromium 建不了锁（目录只读 / 属主不对 / 文件系统不支持符号链接）时 puppeteer 报的也是「already running」，
 * 这时目录里根本没有 SingletonLock，叫人去删锁没用，要说成目录的问题。
 */
export function profileInUseMessage(userDataDir, err, lstat = lstatSync) {
  const detail = String(err?.message || '').match(/The profile appears to be in use[^\n]*?\(\d+\)(?: on another computer \([^)\n]*\))?|The browser is already running for [^\n]*/)?.[0]
  let locked = true
  try {
    lstat(join(userDataDir, 'SingletonLock'))
  } catch {
    locked = false
  }
  const head = locked
    ? `浏览器 profile 正被另一个 Chromium 进程占用（${userDataDir}）。若确认没有其它进程在用，删除该目录下的 SingletonLock / SingletonSocket / SingletonCookie 后重试。`
    : `Chromium 无法在浏览器 profile 目录加锁（${userDataDir}）。请确认该目录可写（挂载目录的属主 / 权限、是否只读挂载），且所在文件系统支持符号链接。`
  return `${head}原始错误: ${detail || firstLine(err)}`
}

/**
 * 按顺序尝试：显式指定（PUPPETEER_EXECUTABLE_PATH / mchromePath）→ 系统已装浏览器
 * → puppeteer 自带 → channel:'chrome'。与旧实现的差别：
 *   - 显式路径与系统路径相同（Docker 镜像即如此）只试一次，不再重复；
 *   - 启动超时立即失败，不再逐级尝试（每一级都是再拉一份 Chromium 压到过载的机器上）；
 *   - 持久 profile（userDataDir）启动前先清陈旧的 Singleton 锁；仍报 profile 被占用 / 加不了锁就直接
 *     失败，换二进制打开的还是同一个 profile。
 * @param {object} deps 便于单测注入
 */
export async function launchWithFallback({
  headless = true,
  launchOptions = {},
  launchImpl = opts => puppeteer.launch(opts),
  env = process.env,
  platform = process.platform,
  exists = existsSync,
  clearProfileLock = clearStaleProfileLock,
} = {}) {
  const userDataDir = launchOptions.userDataDir
  if (userDataDir) {
    try {
      const { cleared, reason } = clearProfileLock(userDataDir)
      if (cleared) printYellow(`已清理浏览器 profile 残留的锁（${reason}）: ${userDataDir}`)
    } catch (err) {
      printYellow(`检查浏览器 profile 锁失败，照常启动: ${firstLine(err)}`)
    }
  }

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
      // userDataDir / protocolTimeout / defaultViewport 等由确实需要持久浏览器会话的
      // 模块传入；基础安全/容器参数仍由本层统一保留，调用方不能无意覆盖掉。
      const extraArgs = Array.isArray(launchOptions.args) ? launchOptions.args : []
      const browser = await launchImpl({
        ...launchOptions,
        headless,
        args: [...BASE_ARGS, ...platformArgs(exists), ...extraArgs],
        timeout: launchOptions.timeout ?? LAUNCH_TIMEOUT_MS,
        ...candidate.opts,
      })
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
      if (userDataDir && isProfileInUseError(err)) throw new Error(profileInUseMessage(userDataDir, err))
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
        browserSlots.set(browser, slot)
        // 归还时机以 Chromium 进程真正退出为准：CDP 连接断开（disconnected）比进程
        // 退出早几百毫秒，若在那一刻就放行下一个启动，实测会出现「上限 2 却有 3 个
        // 主进程同时存活」的窗口。exit 迟迟不来时（不该发生）5 秒后也兜底归还。
        const proc = typeof browser?.process === 'function' ? browser.process() : null
        const alreadyGone = (proc && (proc.exitCode !== null || proc.signalCode !== null))
          || browser?.connected === false
        if (alreadyGone) {
          // 启动到登记之间就已经退出（崩溃 / 被外部杀掉）：事件不会再来，立即归还，
          // 否则这个位子永远占着，上限一路缩水到 0。
          slot.release()
          return
        }
        if (proc) {
          proc.once('exit', slot.release)
          browser.once?.('disconnected', () => { setTimeout(slot.release, EXIT_GRACE_MS).unref?.() })
        } else {
          browser?.once?.('disconnected', slot.release)
        }
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
 * @param {object} [options.launchOptions] 受控附加选项（如专用 userDataDir）
 * @param {(opts: object) => Promise<import('puppeteer').Browser>} [options.launchImpl] 测试注入
 */
export async function launchBrowser({ headless = true, label = '浏览器', waitMs, onIdleRequest, launchOptions, launchImpl } = {}) {
  const slot = await pool.acquire({ label, waitMs, onIdleRequest })
  let browser
  try {
    browser = await launchWithFallback({ headless, launchOptions, launchImpl })
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
