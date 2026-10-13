/**
 * 提醒中心（服务端）。
 *
 * 后台各处「现在确实有问题、用户能处理」的事汇成一份列表：登录凭证失效、模块抓取失败、
 * EPG 源失败或是停用的老源、加了一人一源用户却没设访问密码、抓取模块配置损坏。
 *
 * 以前这段判断写在 admin.html 的 collectAlerts 里，只有后台页开着才有人算；挪到服务端后：
 *   - 后台页直接拉 GET /api/alerts 显示，显示效果不变；
 *   - AlertTracker 每分钟（以及每轮源刷新后）自己评估一次，记下上一轮的结果，比较出
 *     「新出现」「已恢复」，供将来的消息推送使用（推送只在状态变化时触发，不会每轮都发）。
 *
 * 评估只读各管理器已经记在内存 / 小配置文件里的结论，不联网、不触发任何检查。
 * 纯函数 collectAlerts 与 AlertTracker 都可注入输入，测试见 scripts/test-alerts.mjs。
 * 新增一类提醒：在 collectAlerts 里加一段，并给它一个稳定的 id。
 */
import { existsSync, readFileSync } from "node:fs"
import { writeJsonFileSync } from "./fileUtil.js"
import { dataPath } from "./paths.js"
import { printGreen, printYellow } from "./colorOut.js"

const STATE_FILE = 'alerts-state.json'
const EVALUATE_INTERVAL_MS = 60 * 1000

const levelRank = level => level === 'error' ? 0 : 1

/**
 * 由各处状态算出当前提醒列表。纯函数。
 *
 * @param {object} inputs
 * @param {{corrupt: object|null, modules: Array}} [inputs.extractors]  ExtractorManager#alertSnapshot()
 * @param {{enabled?: boolean, sources?: Array}|null} [inputs.epg]      epg-sources.json 内容
 * @param {string[]} [inputs.epgLegacyUrls]                              停用的老默认源地址
 * @param {boolean} [inputs.passSet]                                     是否设了访问密码
 * @param {number} [inputs.userCount]                                    一人一源用户数
 * @returns {Array<{id, level, where, title, text, action, target, moduleId?, configKey?}>}
 *   target 是后台「去处理」按钮的跳转目标：{ kind: 'module'|'extractors'|'epg'|'password', moduleId? }
 */
export function collectAlerts({ extractors, epg, epgLegacyUrls = [], passSet = true, userCount = 0 } = {}) {
  const alerts = []
  if (extractors?.corrupt) {
    alerts.push({
      id: 'extractors-corrupt', level: 'error', where: 'extractors', title: '抓取模块配置文件损坏', action: '查看',
      text: '配置文件损坏，已保留原文件并另存 .corrupt 副本；修复前模块的所有改动都会被拒绝，以免覆盖原数据。',
      target: { kind: 'extractors' },
    })
  }
  for (const m of extractors?.modules || []) {
    if (!m.enabled) continue
    const h = m.health || {}
    const owner = { moduleId: m.id, configKey: m.configKey || '' }
    if (h.credentialRejected) {
      alerts.push({
        id: `module-credential:${m.id}`, level: 'error', where: 'extractors', title: `${m.name}登录凭证已失效`, action: '去更新',
        text: h.credentialRejected, target: { kind: 'module', moduleId: m.id }, ...owner,
      })
    } else if (h.status === 'failed' || h.status === 'risk') {
      const kept = h.usingCachedChannels ? `；暂时沿用上次抓到的 ${h.channelCount || 0} 个频道` : ''
      alerts.push({
        id: `module-failed:${m.id}`, level: 'error', where: 'extractors',
        title: `${m.name}${h.status === 'risk' ? '被风控' : '抓取失败'}`, action: '查看',
        text: `${h.lastError || '最近一次抓取没有成功'}${kept}。会自动重试；长期失败又用不到的话，可以关掉这个模块。`,
        // 连续失败次数：后台照旧一次就显示，消息推送要连续两次才发（一闪而过的不打扰）
        failures: Math.max(1, Number(h.consecutiveFailures) || 0),
        target: { kind: 'module', moduleId: m.id }, ...owner,
      })
    }
  }
  if (epg && epg.enabled !== false) {
    for (const src of epg.sources || []) {
      if (!src || src.enabled === false) continue
      const name = src.name || '未命名'
      const url = String(src.url || '').trim()
      if (epgLegacyUrls.includes(url)) {
        alerts.push({
          id: `epg-legacy:${url}`, level: 'warning', where: 'epg', title: `EPG 源「${name}」已停用`, action: '去设置',
          text: '这是停用的老默认源：51zmt 只剩央视和卫视，erw 已停止免费下载。节目单现由咪咕和各模块的官方接口提供，这条留着只会挂上过期节目单，建议删掉。',
          target: { kind: 'epg' },
        })
      } else if (typeof src.lastStatus === 'string' && src.lastStatus.includes('失败')) {
        alerts.push({
          id: `epg-failed:${url || name}`, level: 'error', where: 'epg', title: `EPG 源「${name}」抓取失败`, action: '去设置',
          text: src.lastStatus, target: { kind: 'epg' },
        })
      }
    }
  }
  // 只在已经加了一人一源用户时提醒：没加用户、不设密码是很多局域网用户的正常用法，不该常亮
  if (!passSet && userCount > 0) {
    alerts.push({
      id: 'users-no-pass', level: 'warning', where: 'system', title: '没设访问密码，一人一源没生效', action: '去设置',
      text: '已经添加了一人一源用户，但没设访问密码：去掉令牌的地址谁都能直接用，后台也没上锁。设置访问密码后，已发出去的 /u/<令牌>/… 链接不受影响。',
      target: { kind: 'password' },
    })
  }
  // 稳定排序：error 在前，同级保持上面的收集顺序
  return alerts
    .map((alert, index) => ({ alert, index }))
    .sort((a, b) => levelRank(a.alert.level) - levelRank(b.alert.level) || a.index - b.index)
    .map(item => item.alert)
}

/** 给后台的形态：去掉只供服务端判断用的 configKey。 */
export function publicAlert(alert) {
  const { configKey, ...rest } = alert
  return rest
}

/** 读 epg-sources.json 原文。不用 loadEpgConfig：它会在缺文件时建文件、损坏时每次打红字，每分钟一次会刷屏。 */
function readEpgConfigQuietly() {
  try {
    const parsed = JSON.parse(readFileSync(dataPath('epg-sources.json'), 'utf-8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** 从运行中的各管理器收集 collectAlerts 的输入。动态 import 避免与 extractorManager 等形成环。 */
export async function gatherAlertInputs() {
  const [{ getExtractorManager }, { LEGACY_EPG_SOURCE_URLS }, { userManager }, config] = await Promise.all([
    import("./extractorManager.js"),
    import("./epgAggregator.js"),
    import("./userManager.js"),
    import("../config.js"),
  ])
  let extractors = { corrupt: null, modules: [] }
  try { extractors = getExtractorManager().alertSnapshot() } catch { /* 管理器起不来时其他提醒照常 */ }
  return {
    extractors,
    epg: readEpgConfigQuietly(),
    epgLegacyUrls: LEGACY_EPG_SOURCE_URLS,
    passSet: config.pass !== "",
    userCount: Array.isArray(userManager.config?.users) ? userManager.config.users.length : 0,
  }
}

/**
 * 记录提醒的状态变化。
 *
 * active 是「已经报过、还没确认恢复」的提醒，落盘在数据目录 alerts-state.json，重启后接着用，
 * 不会因为重启把每条提醒重新报一遍。它不进配置备份（是运行状态，不是配置）。
 *
 * 判定「已恢复」：
 *   - 模块类提醒（凭证失效、抓取失败）消失时，要有证据才算恢复：模块被关了、生效配置换过了
 *     （用户更新了凭证），或者提醒出现之后模块又抓过一轮。原因是咪咕、北京、凤凰的「播放时发现
 *     凭证被拒」只记在内存里，重启后会暂时看不到，不能当成恢复；下一轮刷新会重新检查。
 *   - 其他提醒（EPG、访问密码、配置损坏）来自磁盘上的配置，消失就是恢复。
 */
export class AlertTracker {
  /**
   * @param {object} [opts]
   * @param {string} [opts.statePath]              状态文件路径（测试注入）
   * @param {() => Promise<object>} [opts.gather]  输入收集（测试注入）
   * @param {() => number} [opts.now]
   * @param {boolean} [opts.log]                   是否在日志里打出变化
   */
  constructor(opts = {}) {
    this.statePath = opts.statePath || dataPath(STATE_FILE)
    this.gather = opts.gather || gatherAlertInputs
    this.now = opts.now || (() => Date.now())
    this.log = opts.log !== false
    this.listeners = new Set()
    this.evaluateListeners = new Set()
    this.current = []
    this.running = null
    this.timer = null
    this.#loadState()
  }

  #loadState() {
    this.hadState = existsSync(this.statePath)
    this.active = {}
    if (!this.hadState) return
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf-8'))
      if (parsed && typeof parsed.active === 'object' && parsed.active !== null) this.active = parsed.active
    } catch { /* 状态文件坏了就当没有，最多重报一次 */ }
  }

  #saveState() {
    try {
      writeJsonFileSync(this.statePath, { version: 1, active: this.active })
    } catch (error) {
      printYellow(`提醒状态写盘失败（下次评估重试）：${error.message}`)
    }
  }

  /** 订阅状态变化：listener({ raised, resolved, initial })。返回取消订阅函数。 */
  onChange(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * 每次评估完都通知（不论有没有变化）：listener({ alerts, activeIds, raised, resolved, initial })。
   * alerts 带 configKey 以外的全部字段；activeIds 是「已报过、还没确认恢复」的提醒 id。
   * 消息推送用它：推送有自己的门槛（抓取失败要连续两次），不能只靠状态变化那一刻。
   */
  onEvaluate(listener) {
    this.evaluateListeners.add(listener)
    return () => this.evaluateListeners.delete(listener)
  }

  /** 当前提醒（最近一次评估的结果，给后台用）。 */
  list() {
    return this.current.map(publicAlert)
  }

  /** 评估一次。并发调用合并成同一轮。 */
  evaluate() {
    if (!this.running) {
      this.running = this.#evaluateOnce().finally(() => { this.running = null })
    }
    return this.running
  }

  async #evaluateOnce() {
    const inputs = await this.gather()
    const alerts = collectAlerts(inputs)
    this.current = alerts
    const now = this.now()
    const byId = new Map(alerts.map(alert => [alert.id, alert]))
    const modules = new Map((inputs.extractors?.modules || []).map(m => [m.id, m]))

    const raised = []
    const resolved = []
    let changed = false

    for (const alert of alerts) {
      const prev = this.active[alert.id]
      if (!prev) {
        this.active[alert.id] = {
          level: alert.level, title: alert.title, text: alert.text, since: now,
          ...(alert.moduleId ? { moduleId: alert.moduleId, configKey: alert.configKey || '' } : {}),
        }
        raised.push(publicAlert(alert))
        changed = true
      } else if (prev.text !== alert.text || prev.title !== alert.title || prev.level !== alert.level) {
        // 同一条提醒换了措辞（比如沿用的频道数变了）：更新记录，不算新事件
        Object.assign(prev, { level: alert.level, title: alert.title, text: alert.text })
        changed = true
      }
    }

    for (const [id, prev] of Object.entries(this.active)) {
      if (byId.has(id)) continue
      if (prev.moduleId && !this.#moduleResolved(prev, modules.get(prev.moduleId))) continue
      delete this.active[id]
      resolved.push({ id, level: prev.level, title: prev.title, text: prev.text, since: prev.since })
      changed = true
    }

    if (changed || !this.hadState) {
      this.#saveState()
    }
    // 第一次运行（没有状态文件）时报出的都是升级前就存在的老问题，标出来让推送层自己决定要不要发
    const initial = !this.hadState
    this.hadState = true

    if (raised.length || resolved.length) {
      if (this.log) {
        for (const alert of raised) printYellow(`[提醒] 新提醒：${alert.title}`)
        for (const alert of resolved) printGreen(`[提醒] 已恢复：${alert.title}`)
      }
      for (const listener of this.listeners) {
        try { listener({ raised, resolved, initial }) } catch { /* 订阅方出错不影响评估 */ }
      }
    }
    const result = { alerts: this.list(), activeIds: Object.keys(this.active), raised, resolved, initial }
    // 不等推送：发消息要联网，后台拉 /api/alerts 不能被它拖慢；推送方自己串行
    for (const listener of this.evaluateListeners) {
      Promise.resolve().then(() => listener(result)).catch(() => { /* 推送出错不影响评估 */ })
    }
    return result
  }

  #moduleResolved(prev, module) {
    if (!module) return true                                   // 模块被下架
    if (!module.enabled) return true                           // 用户关掉了
    if ((module.configKey || '') !== (prev.configKey || '')) return true   // 配置（凭证）换过了
    const attemptAt = Number(module.health?.lastAttemptAt) || 0
    return attemptAt > (Number(prev.since) || 0)               // 提醒出现后又抓过一轮，结论是新的
  }

  /** 启动每分钟一次的评估。定时器 unref，不拖住进程退出。 */
  start(intervalMs = EVALUATE_INTERVAL_MS) {
    if (this.timer) return this
    this.timer = setInterval(() => { this.evaluate().catch(() => {}) }, intervalMs)
    this.timer.unref?.()
    return this
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

let singleton = null

export function getAlertTracker() {
  if (!singleton) singleton = new AlertTracker()
  return singleton
}

/**
 * GET /api/alerts：后台显示用。每次请求现算一遍（后台刚改完配置就来拉，要看到最新结果），
 * 顺带完成一次评估，状态变化照常记录。
 */
export async function getAlertsAPI() {
  try {
    const { alerts } = await getAlertTracker().evaluate()
    return { success: true, data: alerts }
  } catch (error) {
    return { success: false, message: error.message }
  }
}
