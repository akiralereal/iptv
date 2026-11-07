import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { outboundFetch, outboundProxyUrl } from '../../utils/outboundProxy.js'

/**
 * YouTube 解析组件（yt-dlp）的版本与更新。
 *
 * YouTube 经常改播放器，yt-dlp 一般几天内发版跟进；镜像里的版本是发版时锁的，旧了就会集体解析失败。
 * 后台「检查更新」可以不等新镜像，就地把 yt-dlp 升到 PyPI 上的最新正式版。
 *
 * 只管我们自己建的虚拟环境（Docker 的 /opt/youtube、源码运行的 .runtime/youtube）：
 * 用户用 YTDLP_BIN 指过来的、或系统自带的 yt-dlp 只读版本，不替它升级。
 * Docker 里更新装在容器层，重建容器后回到镜像自带的版本（新镜像会带新版本），不往数据目录里写可执行代码。
 */

const run = promisify(execFile)
const localBinary = fileURLToPath(new URL('../../.runtime/youtube/bin/yt-dlp', import.meta.url))
const PYPI_URL = 'https://pypi.org/pypi/yt-dlp/json'

export function ytDlpBinary() {
  return process.env.YTDLP_BIN || (existsSync(localBinary) ? localBinary : 'yt-dlp')
}

function onPath(command) {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    const candidate = join(dir, command)
    if (dir && existsSync(candidate)) return candidate
  }
  return ''
}

/** yt-dlp 所在的虚拟环境（有 pyvenv.cfg 才算），找不到返回 ''。 */
export function managedVenv(binary = ytDlpBinary(), { env = process.env } = {}) {
  if (env.YTDLP_BIN) return ''
  try {
    const path = binary.includes('/') ? binary : onPath(binary)
    if (!path) return ''
    const venv = dirname(dirname(realpathSync(path)))
    return existsSync(join(venv, 'pyvenv.cfg')) && existsSync(join(venv, 'bin', 'python')) ? venv : ''
  } catch { return '' }
}

/**
 * 运行 yt-dlp 的命令。本项目自己的虚拟环境用其中的 python -m yt_dlp，不走 bin/yt-dlp 启动脚本：
 * pip 把安装时 Python 的绝对路径写死在脚本第一行，源码运行的项目目录挪动、改名或整份拷到别处后，
 * 脚本就报「找不到」，其实 Python 和 yt-dlp 都还在。YTDLP_BIN 指定的、系统里的照旧直接执行。
 */
export function ytDlpCommand(binary = ytDlpBinary(), { env = process.env } = {}) {
  const venv = managedVenv(binary, { env })
  return venv ? { file: join(venv, 'bin', 'python'), args: ['-m', 'yt_dlp'] } : { file: binary, args: [] }
}

/** yt-dlp 自己报 2026.08.19，PyPI 写 2026.8.19：按数字逐段比。 */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  }
  return 0
}

let installed = null   // { version } 缓存，更新后清掉
async function installedVersion() {
  if (installed) return installed.version
  const { file, args } = ytDlpCommand()
  try {
    const { stdout } = await run(file, [...args, '--version'], { timeout: 15000 })
    installed = { version: stdout.trim().split(/\s+/)[0] }
  } catch (err) {
    if (err.code === 'ENOENT') return ''
    throw Object.assign(new Error(err.killed ? '读取 yt-dlp 版本超时，稍后再试' : '读不到 yt-dlp 版本'), { timeout: Boolean(err.killed) })
  }
  return installed.version
}

/** 虚拟环境的 Python 版本（读 pyvenv.cfg，如 3.10.21），读不到返回 ''。 */
export function venvPython(venv) {
  try { return readFileSync(join(venv, 'pyvenv.cfg'), 'utf8').match(/^version(?:_info)?\s*=\s*(\d+\.\d+(?:\.\d+)?)/m)?.[1] || '' }
  catch { return '' }
}

// pip is present in every managed venv. Its bundled packaging parser handles
// version ranges and environment markers without adding another dependency.
const EJS_STATUS_SCRIPT = `import importlib, importlib.metadata as m, json
from pip._vendor.packaging.requirements import Requirement
requirements = [Requirement(r) for r in (m.requires('yt-dlp') or [])]
requirement = next((r for r in requirements if r.name == 'yt-dlp-ejs' and (not r.marker or r.marker.evaluate({'extra': 'default'}))), None)
version = ''
healthy = requirement is None
if requirement is not None:
    try:
        version = m.version('yt-dlp-ejs')
        importlib.import_module('yt_dlp_ejs')
        healthy = requirement.specifier.contains(version, prereleases=True)
    except (m.PackageNotFoundError, ImportError):
        healthy = False
print(json.dumps({'requirement': str(requirement).split(';')[0].strip() if requirement else '', 'version': version, 'healthy': healthy}))`

export async function ejsStatus(venv) {
  try {
    const { stdout } = await run(join(venv, 'bin', 'python'), ['-c', EJS_STATUS_SCRIPT], { timeout: 15000 })
    const data = JSON.parse(stdout)
    if (typeof data.healthy !== 'boolean' || typeof data.requirement !== 'string') throw new Error('invalid result')
    return data
  } catch {
    return { healthy: false, requirement: '', version: '' }
  }
}

/** requires_python（如 ">=3.11"、">=3.9,!=3.10.*"）是否接受这个 Python 版本。看不懂的条件不拦。 */
export function pythonSatisfies(spec, python) {
  if (!spec || !python) return true
  return spec.split(',').map(part => part.trim()).filter(Boolean).every(part => {
    const m = /^(>=|<=|==|!=|>|<|~=)\s*([\d.]+)(\.\*)?$/.exec(part)
    if (!m) return true
    const [, op, version, wildcard] = m
    if (wildcard) {
      const prefix = python.split('.').slice(0, version.split('.').length).join('.')
      const same = compareVersions(prefix, version) === 0
      return op === '!=' ? !same : op === '==' ? same : true
    }
    const c = compareVersions(python, version)
    return { '>=': c >= 0, '<=': c <= 0, '==': c === 0, '!=': c !== 0, '>': c > 0, '<': c < 0, '~=': c >= 0 }[op]
  })
}

/**
 * PyPI 上最新的正式版，以及给定 Python 能装的最新正式版（yt-dlp 会逐步抬高 Python 下限，
 * 2026.10.26 起要 3.11，3.10 的环境只能停在 2026.10.21）。dev 预发版、撤回的版本不算。
 */
export async function latestRelease({ python = '', fetchImpl = outboundFetch } = {}) {
  let res
  try { res = await fetchImpl(PYPI_URL, { signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json' } }) }
  catch { throw new Error('连不上 PyPI，查不到最新版本') }
  if (!res.ok) { await res.body?.cancel(); throw new Error('PyPI 返回 HTTP ' + res.status) }
  const data = await res.json()
  const newest = data?.info?.version
  if (typeof newest !== 'string' || !/^\d+\.\d+\.\d+$/.test(newest)) throw new Error('PyPI 返回的版本号看不懂')
  const meta = version => data.releases?.[version]?.[0] || {}
  let version = ''
  for (const [candidate, files] of Object.entries(data.releases || {})) {
    if (!/^\d+\.\d+\.\d+$/.test(candidate) || !files?.length || files[0].yanked) continue
    if (!pythonSatisfies(files[0].requires_python, python)) continue
    if (!version || compareVersions(candidate, version) > 0) version = candidate
  }
  if (!version) throw new Error(`PyPI 上没有 Python ${python} 能装的 yt-dlp 版本`)
  return {
    version,
    date: (meta(version).upload_time || '').slice(0, 10),
    newest,
    newestRequiresPython: meta(newest).requires_python || '',
  }
}

/**
 * 当前状态。checkLatest 时顺带查 PyPI（只在用户点「检查更新」时查，打开源管理页不打外网）。
 */
export async function runtimeStatus({ checkLatest = false } = {}) {
  const venv = managedVenv()
  // 本项目的虚拟环境里跑不起来（yt-dlp 没装上或装坏了）不直接报错：标成待修复，后台给「修复」按钮。
  // 超时不算装坏（机器慢、正忙），照旧报错
  const version = venv
    ? await installedVersion().catch(err => { if (err.timeout) throw err; return '' })
    : await installedVersion()
  const out = {
    version,
    managed: Boolean(venv),
    reason: venv ? '' : process.env.YTDLP_BIN ? '用的是 YTDLP_BIN 指定的 yt-dlp，请自行升级' : version ? '这个 yt-dlp 不是本项目安装的，请自行升级' : '没装 yt-dlp：Docker 镜像已自带；源码运行请执行 npm run setup:youtube',
    updating: Boolean(updating),
    repairNeeded: Boolean(venv && !updating && (!version || !(await ejsStatus(venv)).healthy)),
  }
  if (checkLatest) {
    const python = venv ? venvPython(venv) : ''
    const latest = await latestRelease({ python })
    Object.assign(out, { latest: latest.version, latestDate: latest.date, outdated: Boolean(version) && compareVersions(latest.version, version) > 0 })
    if (latest.newest !== latest.version) {
      out.pythonNote = `最新的 ${latest.newest} 要求 Python ${latest.newestRequiresPython || '更高版本'}，当前 Python ${python} 最高只能用 ${latest.version}`
    }
  }
  return out
}

// pip 只认 http(s) 代理（SOCKS 要额外装 PySocks），SOCKS 时直连 PyPI —— PyPI 在大陆本来就能访问
function pipProxyArgs() {
  const proxy = outboundProxyUrl()
  return /^https?:/i.test(proxy) ? ['--proxy', proxy] : []
}

let updating = null
/**
 * 升到 PyPI 最新正式版，并按新版本自己声明的版本装配套的 yt-dlp-ejs（它们要成对）。
 * 同一时间只跑一个；onUpdated 用来让模块丢掉旧解析缓存。
 */
export function updateRuntime({ onUpdated } = {}) {
  updating ||= (async () => {
    const venv = managedVenv()
    if (!venv) throw new Error((await runtimeStatus()).reason || '这个 yt-dlp 不能在后台升级')
    const before = await installedVersion().catch(() => '')
    const beforeHealth = await ejsStatus(venv)
    const { version: target } = await latestRelease({ python: venvPython(venv) })
    const upgrade = !before || compareVersions(target, before) > 0
    if (!upgrade && beforeHealth.healthy) return { updated: false, repaired: false, version: before }
    const python = join(venv, 'bin', 'python')
    const pip = ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--root-user-action=ignore', ...pipProxyArgs()]
    try {
      // 读不到版本（没装上或装坏了）时强制重装：版本号相同的话，pip 会当成已经装好、什么都不做
      if (upgrade) await run(python, [...pip, before ? '--upgrade' : '--force-reinstall', `yt-dlp==${target}`], { timeout: 180000, maxBuffer: 4 * 1024 * 1024 })
      const health = await ejsStatus(venv)
      const ejs = health.requirement
      if (!health.healthy) {
        if (!/^yt-dlp-ejs[=<>!~\d.,*a-zA-Z+-]*$/.test(ejs)) throw new Error('无法读取配套 EJS 依赖要求')
        await run(python, [...pip, '--force-reinstall', ejs], { timeout: 180000, maxBuffer: 4 * 1024 * 1024 })
      }
    } catch (err) {
      const text = String(err.stderr || err.message || '')
      if (err.killed) throw new Error('下载超时，稍后再试')
      if (/Could not find a version|No matching distribution|ConnectionError|Failed to establish|timed out|ProxyError/i.test(text)) throw new Error('连不上 PyPI，更新没完成')
      if (/Permission denied|Errno 13|read-only/i.test(text)) throw new Error('没有权限写入 yt-dlp 所在目录')
      throw new Error('pip 安装失败：' + text.split('\n').filter(Boolean).at(-1)?.slice(0, 200))
    } finally {
      installed = null
    }
    const after = await installedVersion().catch(() => '')
    if (!after || (upgrade && compareVersions(after, target) < 0) || !(await ejsStatus(venv)).healthy) {
      throw new Error('解析组件或配套 EJS 依赖校验失败，请重试修复')
    }
    onUpdated?.()
    return { updated: Boolean(before) && compareVersions(after, before) !== 0, repaired: !before || !beforeHealth.healthy, from: before, version: after }
  })().finally(() => { updating = null })
  return updating
}
