// 用户访问令牌系统（一人一源）——数据层
//
// 目标：每个家人/朋友一个独立的源地址 /u/<token>/m3u，可单独吊销、泄露可追溯，
//   且令牌只授权「内容」、进不了后台（后台仍只认站长密码 pass）。
//
// 设计：纯叠加 / opt-in。没有 data/users.json（或没有任何用户）时，本系统完全不激活，
//   行为与今天一致；站长在后台「新增用户」后才生成令牌，且旧的 pass/裸链接仍照常工作。

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { writeJsonFileSync } from './fileUtil.js'
import { dataPath } from './paths.js'
import { printRed } from './colorOut.js'
import { isPrivateAddress } from './logoCache.js'

const USERS_PATH = dataPath('users.json')

// 「最近访问来源」：每个用户按来源 IP 记最近 20 个，每个 IP 记最近 3 种播放器（UA）。
// 用来看令牌有没有被转给别人：同一时段冒出多个陌生 IP、或者不认识的播放器，就该重置令牌了。
const RECENT_CLIENTS_MAX = 20
const RECENT_UAS_MAX = 3
const UA_MAX_LENGTH = 160

/**
 * 记给站长看的来源 IP。直连时只认 TCP 对端：X-Forwarded-For 客户端自己就能写，拿来查泄露会被糊弄过去。
 * 对端是本机或内网地址（反代、内网穿透、Docker 网关）时，才取 X-Forwarded-For 的第一段。
 */
export function viewerIp(socketAddress, forwardedFor) {
  const socketIp = String(socketAddress || '').replace(/^::ffff:/, '')
  const forwarded = String(forwardedFor || '').split(',')[0].trim().replace(/^::ffff:/, '')
  if (forwarded && (!socketIp || isPrivateAddress(socketIp))) return forwarded.slice(0, 64)
  return socketIp || '未知'
}

// 令牌字符集需与 app.js 路由正则 [A-Za-z0-9_-]{8,64} 一致；base64url 正好只含这些字符
function genToken() {
  return randomBytes(18).toString('base64url') // 24 字符
}

function genId() {
  return 'u_' + randomBytes(5).toString('hex')
}

class UserManager {
  constructor() {
    this.config = { users: [] }
    this.index = new Map() // token -> user
    this._dirty = false
    this.load()
  }

  load() {
    if (!existsSync(USERS_PATH)) {
      // 不创建文件：保持「未启用」状态，零影响于老部署
      this.config = { users: [] }
      this.rebuildIndex()
      return
    }
    try {
      const parsed = JSON.parse(readFileSync(USERS_PATH, 'utf-8'))
      this.config = {
        users: Array.isArray(parsed?.users) ? parsed.users : []
      }
    } catch (e) {
      printRed(`加载用户配置失败，按未启用处理: ${e.message}`)
      this.config = { users: [] }
    }
    this.rebuildIndex()
  }

  rebuildIndex() {
    this.index = new Map()
    for (const u of this.config.users) {
      if (u && u.token) this.index.set(u.token, u)
    }
  }

  save() {
    try {
      writeJsonFileSync(USERS_PATH, this.config)
      this._dirty = false
      this.rebuildIndex()
      return { success: true }
    } catch (e) {
      printRed(`保存用户配置失败: ${e.message}`)
      return { success: false, message: e.message }
    }
  }

  // 是否已启用用户系统（有任意用户即视为启用；无则鉴权热路径完全不介入）
  hasUsers() {
    return this.config.users.length > 0
  }

  findByToken(token) {
    return this.index.get(token) || null
  }

  isExpired(u) {
    if (!u || !u.expiresAt) return false
    const t = Date.parse(u.expiresAt)
    return !Number.isNaN(t) && Date.now() > t
  }

  // 可用 = 启用 且 未过期
  isUsable(u) {
    return !!u && u.enabled !== false && !this.isExpired(u)
  }

  // 轻量记录用量：内存累加 + 标脏，由上层定时 flush，避免每个请求都落盘。
  // client = { ip, ua }：按 IP 归并进 recentClients，超出上限挤掉最久没来的那个。
  recordUsage(u, client = null) {
    if (!u) return
    const now = new Date().toISOString()
    u.reqCount = (u.reqCount || 0) + 1
    u.lastSeenAt = now
    const ip = String(client?.ip || '').trim().slice(0, 64)
    if (ip) {
      const ua = String(client.ua || '').replace(/[\r\n]/g, ' ').trim().slice(0, UA_MAX_LENGTH)
      if (!Array.isArray(u.recentClients)) u.recentClients = []
      const list = u.recentClients
      let entry = list.find(c => c && c.ip === ip)
      if (!entry) {
        entry = { ip, uas: [], count: 0, firstSeenAt: now, lastSeenAt: now }
        list.push(entry)
        if (list.length > RECENT_CLIENTS_MAX) {
          list.sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
          list.length = RECENT_CLIENTS_MAX
        }
      }
      entry.count = (entry.count || 0) + 1
      entry.lastSeenAt = now
      const uas = Array.isArray(entry.uas) ? entry.uas.filter(x => x !== ua) : []
      entry.uas = [ua, ...uas].slice(0, RECENT_UAS_MAX)
    }
    this._dirty = true
  }

  flushUsage() {
    if (this._dirty) this.save()
  }

  // ---- 管理操作（后台 API 调用，仅站长 pass 可达）----

  addUser({ name, profile = '', expiresAt = null, note = '' } = {}) {
    const nm = typeof name === 'string' ? name.trim() : ''
    if (!nm) return { success: false, message: '请填写用户名称' }
    let token = genToken()
    while (this.index.has(token)) token = genToken() // 极低概率重复，兜底
    const user = {
      id: genId(),
      name: nm,
      token,
      enabled: true,
      profile: typeof profile === 'string' ? profile : '',
      expiresAt: expiresAt || null,
      note: typeof note === 'string' ? note : '',
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
      reqCount: 0,
      recentClients: []
    }
    this.config.users.push(user)
    const r = this.save()
    return r.success ? { success: true, data: this.config, user } : r
  }

  updateUser(id, fields = {}) {
    const u = this.config.users.find(x => x.id === id)
    if (!u) return { success: false, message: '用户不存在' }
    if (fields.name !== undefined) {
      const nm = String(fields.name).trim()
      if (!nm) return { success: false, message: '名称不能为空' }
      u.name = nm
    }
    if (fields.enabled !== undefined) u.enabled = !!fields.enabled
    if (fields.profile !== undefined) u.profile = typeof fields.profile === 'string' ? fields.profile : ''
    if (fields.expiresAt !== undefined) u.expiresAt = fields.expiresAt || null
    if (fields.note !== undefined) u.note = String(fields.note)
    const r = this.save()
    return r.success ? { success: true, data: this.config } : r
  }

  removeUser(id) {
    const before = this.config.users.length
    this.config.users = this.config.users.filter(x => x.id !== id)
    if (this.config.users.length === before) return { success: false, message: '用户不存在' }
    const r = this.save()
    return r.success ? { success: true, data: this.config } : r
  }

  // 重置令牌：旧链接立即失效；访问来源一并清空，之后列出的只会是拿到新链接的设备
  regenToken(id) {
    const u = this.config.users.find(x => x.id === id)
    if (!u) return { success: false, message: '用户不存在' }
    let token = genToken()
    while (this.index.has(token)) token = genToken()
    u.token = token
    u.recentClients = []
    const r = this.save()
    return r.success ? { success: true, data: this.config, token } : r
  }

  getConfig() {
    return this.config
  }
}

const userManager = new UserManager()

export { userManager, UserManager }
