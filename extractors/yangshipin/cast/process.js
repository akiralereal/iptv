import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dataPath } from '../../../utils/paths.js'

/** One lazy worker per server, shared by the three UHD channels. No startup probes. */
export class CastProcess {
  constructor({ spawnImpl = spawn, fetchImpl = (...args) => fetch(...args),
    python = process.env.YSP_CAST_PYTHON || 'python3', idleMs = 180000,
    startupMs = 45000, stateDir = dataPath('yangshipin/cast-device') } = {}) {
    Object.assign(this, { spawnImpl, fetchImpl, python, idleMs, startupMs, stateDir })
    this.child = null; this.base = ''; this.starting = null; this.retryAt = 0
    this.lastUsed = 0; this.timer = null; this.generation = 0
  }
  touch() {
    this.lastUsed = Date.now()
    if (!this.timer) {
      this.timer = setInterval(() => {
        if (!this.starting && Date.now() - this.lastUsed > this.idleMs) void this.close()
      }, Math.min(this.idleMs, 30000))
      this.timer.unref()
    }
  }
  async ensure() {
    this.touch()
    if (this.base) return this.base
    if (this.starting) return this.starting
    if (Date.now() < this.retryAt) throw new Error('投屏服务暂不可用，请稍后重试或切回原方案')
    const generation = this.generation
    const task = this.start(generation)
    this.starting = task
    try { return await task }
    catch {
      await this.close()
      this.retryAt = Date.now() + 30000
      throw new Error('投屏服务未就绪，请检查 Python 3 或切回原方案')
    } finally { if (this.starting === task) this.starting = null }
  }
  async start(generation) {
    const child = this.spawnImpl(this.python, [fileURLToPath(new URL('./worker.py', import.meta.url)), this.stateDir], {
      cwd: fileURLToPath(new URL('./', import.meta.url)),
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    // Raw Python errors/URLs/device state must never enter public responses or logs.
    child.stderr.resume()
    const lines = createInterface({ input: child.stdout })
    let rejectStart
    const exited = () => {
      if (this.child === child) { this.child = null; this.base = ''; this.retryAt = Date.now() + 30000 }
      lines.close(); rejectStart?.(new Error('worker exited'))
    }
    child.on('error', exited); child.once('exit', exited)
    const port = await new Promise((resolve, reject) => {
      rejectStart = reject
      const timeout = setTimeout(() => reject(new Error('worker startup timeout')), this.startupMs)
      const finish = fn => value => { clearTimeout(timeout); rejectStart = null; fn(value) }
      rejectStart = finish(reject)
      lines.on('line', line => {
        if (line.length > 256) return
        try {
          const value = JSON.parse(line)
          if (value.kind === 'listening' && Number.isInteger(value.port) && value.port > 0 && value.port < 65536) finish(resolve)(value.port)
        } catch {}
      })
    })
    const base = `http://127.0.0.1:${port}`
    const deadline = Date.now() + this.startupMs
    while (Date.now() < deadline && this.child === child && this.generation === generation) {
      try {
        const response = await this.fetchImpl(base + '/health', { signal: AbortSignal.timeout(1000) })
        if (response.ok && (await response.json()).ready === true) {
          if (this.child !== child || this.generation !== generation) break
          this.base = base
          return base
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error('device initialization timeout')
  }
  async close() {
    this.generation++
    clearInterval(this.timer); this.timer = null
    this.base = ''
    const child = this.child; this.child = null
    if (!child || child.exitCode != null || child.signalCode != null) return
    await new Promise(resolve => {
      const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 2000)
      child.once('exit', () => { clearTimeout(timeout); resolve() })
      child.stdin.end(); child.kill('SIGTERM')
    })
  }
}
