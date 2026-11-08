import { readFileSync, existsSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { dataPath } from '../../utils/paths.js'
import { safeUrl } from './transport.js'
import { eligible } from './policy.js'

export const seed = JSON.parse(readFileSync(new URL('./seed.json', import.meta.url), 'utf8'))
export function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  const fd = openSync(temp, 'w', 0o600)
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd) }
  finally { closeSync(fd) }
  try { renameSync(temp, path) } finally { if (existsSync(temp)) unlinkSync(temp) }
}
function validate(value) {
  if (value?.schema !== 1 || !value.channels || !Object.keys(value.channels).length) throw new Error('Xumo 快照无效或为空')
  for (const [id, c] of Object.entries(value.channels)) {
    if (!/^\d{6,12}$/.test(id) || String(c.id) !== id || !c.name || !c.slug) throw new Error('Xumo 快照频道信息无效')
    safeUrl(c.entry)
    if (/\/manifest\/[^/]+\/[^/]+\/[0-9a-f-]{36}\//i.test(c.entry)) throw new Error('Xumo 临时会话地址不能持久保存')
  }
  return value
}
export class Store {
  constructor({ path = dataPath('xumo-state.json'), initial = seed } = {}) {
    this.path = path; this.initial = initial; this.warning = ''
  }
  load() {
    for (const file of [this.path, `${this.path}.previous`]) {
      if (!existsSync(file)) continue
      try { return structuredClone(validate(JSON.parse(readFileSync(file, 'utf8')))) }
      catch { this.warning = 'Xumo 快照损坏，已回退上一有效清单或随模块附带的已验证清单' }
    }
    return structuredClone(validate(this.initial))
  }
  runtime() {
    try { const r = JSON.parse(readFileSync(`${this.path}.runtime`, 'utf8')); if (r.schema === 1) return r } catch {}
    return { schema: 1, jobs: {}, excluded: {}, channelHealth: {} }
  }
  saveRuntime(value) { atomicJson(`${this.path}.runtime`, value) }
  publish(next) {
    validate(next)
    if (!Object.keys(eligible(next.channels)).length) throw new Error('没有可发布的非宗教频道')
    if (existsSync(this.path)) {
      try { const previous = validate(JSON.parse(readFileSync(this.path, 'utf8'))); atomicJson(`${this.path}.previous`, previous) }
      catch (error) { if (error.code) throw error }
    }
    atomicJson(this.path, next)
  }
}
