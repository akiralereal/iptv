/**
 * 宁夏广播电视台官方节目单（黄河云）。
 *
 * GET api.ningxiahuangheyun.com/?mod=get_appdata&appid=nxtv-tv，不用登录、不带签名、不挑 UA。实测（2026-09-25）：
 * - 一次给三套频道：data.menu[] 里 types 为 tvpro 的三项，ename 是 nxws / nxgg / nxwl，playbill 是节目列表。
 * - 每档有 stimestamp / otimestamp（Unix 秒）与节目名，已按时间排好、首尾相接没有空档。
 * - 只给今天；date / day / time 这类参数都不认，明天的要等零点后官方换数据。
 * - 响应约 500KB（整个 App 页面配置都在里面），Content-Type 写的是 text/html，实际是 JSON。
 *   三套频道共用一份，模块内缓存 10 分钟，一轮更新只请求一次。
 * - 每档还带官方回看地址（hls.nxhhy.cn/record/…），本模块只做直播，没用。
 *
 * 和取流链路没有共享状态：只用频道表 api.js 和调用方注入的 fetch，不 import 项目内其它模块。
 */
import { CHANNELS } from './api.js'

export const EPG_API = 'https://api.ningxiahuangheyun.com/?mod=get_appdata&appid=nxtv-tv'
const MAX_BYTES = 4 * 1024 * 1024
const CACHE_MS = 10 * 60 * 1000
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const KEYS = new Set(CHANNELS.map(channel => channel.key))
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** 上海日期 YYYYMMDD → { 当天零点, 次日零点 }（毫秒）；与运行机器的时区无关。 */
export function dayInfo(day) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(day ?? ''))
  if (!match) throw new Error('宁夏节目单参数非法')
  const [year, month, date] = match.slice(1).map(Number)
  const start = Date.UTC(year, month - 1, date) - SHANGHAI_OFFSET_MS
  const check = new Date(start + SHANGHAI_OFFSET_MS)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) {
    throw new Error('宁夏节目单参数非法')
  }
  return { start, end: start + DAY_MS }
}

/** 接口 JSON → Map<频道代号, [{ title, start, stop }]>（全部日期，按开始时间升序、同一时刻只留一条）。 */
export function parsePayload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('宁夏节目单数据格式异常')
  if (String(payload.errcode) !== '200') {
    throw new Error(`宁夏节目单接口报错：${String(payload.errmsg || payload.errcode).slice(0, 80)}`)
  }
  const menus = payload.data?.menu
  if (!Array.isArray(menus)) throw new Error('宁夏节目单数据格式异常')
  const result = new Map()
  for (const menu of menus) {
    if (menu?.types !== 'tvpro' || !KEYS.has(menu?.ename) || !Array.isArray(menu.playbill)) continue
    const items = []
    for (const row of menu.playbill) {
      const start = Number(row?.stimestamp) * 1000
      const stop = Number(row?.otimestamp) * 1000
      const title = String(row?.name ?? '').replace(/\s+/g, ' ').trim()
      if (!Number.isFinite(start) || !Number.isFinite(stop) || start <= 0 || stop <= start || !title) continue
      items.push({ title, start, stop })
    }
    // 有数据却一条都读不出，多半是接口改了字段，报错而不是当成「当天没发」
    if (menu.playbill.length && !items.length) throw new Error('宁夏节目单数据格式异常')
    items.sort((a, b) => a.start - b.start)
    const unique = items.filter((item, index) => index === 0 || item.start !== items[index - 1].start)
    // 结束晚于下一档开始的截到下一档，不让节目互相重叠
    result.set(menu.ename, unique.map((item, index) => {
      const next = unique[index + 1]?.start
      return next != null && item.stop > next ? { ...item, stop: next } : item
    }))
  }
  // 三套一个都没有，按接口改版处理
  if (!result.size) throw new Error('宁夏节目单数据格式异常')
  return result
}

async function readCapped(response) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (declared > MAX_BYTES) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error('宁夏节目单响应过大')
  }
  const buf = Buffer.from(await response.arrayBuffer())
  if (buf.length > MAX_BYTES) throw new Error('宁夏节目单响应过大')
  return buf.toString('utf8')
}

async function requestPayload({ fetchImpl, timeoutMs }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(EPG_API, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      redirect: 'manual',
      signal: controller.signal,
    })
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {})
      throw new Error(`宁夏节目单 HTTP ${response.status}`)
    }
    let payload
    try {
      payload = JSON.parse(await readCapped(response))
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('宁夏节目单不是 JSON')
      throw error
    }
    return parsePayload(payload)
  } finally {
    clearTimeout(timer)
  }
}

/** 三套频道共用一份响应：同一 fetchImpl 在 10 分钟内只请求一次，并发请求合并。失败不缓存。 */
export function createProvider({ now = () => Date.now() } = {}) {
  let cached = null // { fetchImpl, at, promise }

  function load(options) {
    const time = now()
    if (cached && cached.fetchImpl === options.fetchImpl && time - cached.at < CACHE_MS) return cached.promise
    const entry = { fetchImpl: options.fetchImpl, at: time, promise: null }
    entry.promise = requestPayload(options).catch(error => {
      if (cached === entry) cached = null
      throw error
    })
    cached = entry
    return entry.promise
  }

  return {
    id: 'ningxia',
    // 官方只给今天
    days: 1,

    channels() {
      return CHANNELS.map(channel => ({ ref: channel.ref, name: channel.name, key: channel.key }))
    },

    /** 取某一天（上海日期 YYYYMMDD）的节目；接口给的不是这一天（零点前后官方还没换数据）返回空数组。 */
    async programmes(key, day, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
      if (!KEYS.has(key)) throw new Error('宁夏节目单参数非法')
      const { start, end } = dayInfo(day)
      const all = await load({ fetchImpl, timeoutMs })
      return (all.get(key) || []).filter(item => item.start >= start && item.start < end)
    },

    clearCache() { cached = null },
  }
}

export default createProvider()
