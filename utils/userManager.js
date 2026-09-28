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

const USERS_PATH = dataPath('users.json')

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

  // 轻量记录用量：内存累加 + 标脏，由上层定时 flush，避免每个请求都落盘
  recordUsage(u) {
    if (!u) return
    u.reqCount = (u.reqCount || 0) + 1
    u.lastSeenAt = new Date().toISOString()
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
      reqCount: 0
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

  // 重置令牌：旧链接立即失效
  regenToken(id) {
    const u = this.config.users.find(x => x.id === id)
    if (!u) return { success: false, message: '用户不存在' }
    let token = genToken()
    while (this.index.has(token)) token = genToken()
    u.token = token
    const r = this.save()
    return r.success ? { success: true, data: this.config, token } : r
  }

  getConfig() {
    return this.config
  }
}

const userManager = new UserManager()

export { userManager, UserManager }
