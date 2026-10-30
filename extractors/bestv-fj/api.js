import { directFamilyFetch, proxyAwareFetch } from '../../utils/systemProxy.js'
import { createApiClient, requestText } from './auth.js'
import { CHANNELS, DEFAULT_CHANNEL_IDS, GROUP, channelForRef, refOf } from './channels.js'

export function networkMode(config = {}) {
  const mode = config.networkMode ?? 'auto'
  if (!['auto', 'ipv6'].includes(mode)) throw new Error('百视通网络模式无效')
  return mode
}
export function networkFetch(config = {}) {
  return networkMode(config) === 'ipv6'
    ? (url, options) => directFamilyFetch(url, options, 6)
    : proxyAwareFetch
}

export function selectedIds(config = {}) {
  if (config.channels === undefined) return [...DEFAULT_CHANNEL_IDS]
  const ids = Array.isArray(config.channels) ? config.channels : String(config.channels).split(/\r?\n/)
  const unique = [...new Set(ids.map(id => String(id).trim()).filter(Boolean))]
  if (!unique.length || unique.some(id => !CHANNELS.some(c => c.id === id))) throw new Error('频道选择无效')
  return unique
}
export function officialLogo(raw) {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && url.hostname === 'tvappstatic.bestv.com.cn'
      && !url.username && !url.password && !url.port && /^\/images\/[\w/.-]+\.(png|jpe?g)$/i.test(url.pathname) ? url.href : ''
  } catch { return '' }
}
export function buildChannels(payload, ids, absent = []) {
  if (!Array.isArray(payload) || payload.some(g => !Array.isArray(g?.items))) throw new Error('官方频道目录结构已变化')
  const rows = payload.flatMap(group => group.items)
  const output = []
  for (const id of ids) {
    // 官方把东南卫视同时列在「福建」「卫视」；相同元数据合并，互相矛盾的目录仍失败。
    const matches = [...new Map(rows.filter(row => String(row.id) === id)
      .map(row => [JSON.stringify([row.id, row.name, row.icon, row.enabled, row.mode, row.audio]), row])).values()]
    // 目录按访问地区下发：上海移动等出口拿到的版本没有多彩文体4K 等台，用那份 clientID 也取不到地址。
    // 只跳过这几路，别让其余频道跟着失败。
    if (!matches.length) { absent.push(id); continue }
    if (matches.length !== 1) throw new Error(`官方目录未唯一列出频道 ${id}`)
    const row = matches[0]
    if (row.enabled !== 1 || row.mode !== 'live' || row.audio !== 0) continue
    if (row.name !== CHANNELS.find(c => c.id === id).name) throw new Error(`频道 ${id} 的官方名称已变化，需要复核`)
    const logo = officialLogo(row.icon)
    if (!logo) throw new Error(`频道 ${id} 没有可识别的官方台标`)
    output.push({ name: row.name, deferredRef: refOf(id), logo,
      groupTitle: GROUP, relayHls: true, catchup: 'none' })
  }
  return output
}
export async function fetchChannels(config, ctx = {}) {
  const api = createApiClient({ fetchImpl: ctx.fetchImpl || networkFetch(config), timeoutMs: ctx.timeoutMs || 12000 })
  const ids = selectedIds(config)
  const absent = []
  const channels = buildChannels(await api.request('/tvs'), ids, absent)
  if (!channels.length) {
    throw new Error(absent.length === ids.length ? '这台服务器拿到的官方目录里没有已选择的频道（百视通按地区下发频道）' : '已选择的频道在官方目录中均已停用')
  }
  const missing = ids.filter(id => !channels.some(c => c.deferredRef === refOf(id)))
  const stopped = missing.filter(id => !absent.includes(id))
  const names = absent.map(id => CHANNELS.find(c => c.id === id).name)
  const warnings = []
  if (absent.length) {
    warnings.push(`这台服务器拿到的官方目录里没有${names.slice(0, 6).join('、')}${names.length > 6 ? ` 等 ${names.length} 个频道` : ''}（百视通按地区下发频道），已跳过`)
  }
  if (stopped.length) warnings.push(`官方目录已停用 ${stopped.length} 个选中频道`)
  return { groups: [{ name: GROUP, dataList: channels }], meta: { skipped: missing, warnings } }
}

/** CDN 必须处于当前频道的签名目录内；绝不把 API 凭据发给媒体主机。 */
export function mediaUrl(raw, base) {
  let url
  try { url = new URL(String(raw)) } catch { throw new Error('媒体地址无效') }
  // 上海版目录的 clientID 拿到的是 dongfang5g-pc-v52-live 节点，路径和清单格式与福建节点相同（2026-10-29 实测）
  if (!['http:', 'https:'].includes(url.protocol) || !/^(?:fjnetv\d+\.live|dongfang5g-pc-v\d+-live)\.bestvcdn\.com\.cn$/.test(url.hostname)
      || url.username || url.password || url.port || url.hash
      || !/^\/[A-Za-z0-9=_-]{32,2048}\/live\/program\/live\/[a-zA-Z0-9_-]+\/\d+\/(?:mnf\.m3u8|\d{10}\/\d+\.ts)$/.test(url.pathname)) {
    throw new Error('媒体地址不在百视通官方直播目录')
  }
  if (base) {
    const origin = new URL(base)
    if (url.origin !== origin.origin || !url.pathname.startsWith(new URL('.', origin).pathname)) throw new Error('媒体地址不属于当前频道')
  }
  return url.href
}
export function validateManifest(text, base) {
  if (!text.startsWith('#EXTM3U') || /#EXT-X-(KEY|MAP|STREAM-INF|ENDLIST)/.test(text)
      || !/#EXT-X-MEDIA-SEQUENCE:\d+/.test(text)) throw new Error('上游不是已验证格式的未加密直播清单')
  let count = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const url = mediaUrl(new URL(line, base).href, base)
    if (!new URL(url).pathname.endsWith('.ts')) throw new Error('清单没有 TS 分片')
    count++
  }
  if (!count || !text.includes('#EXTINF:')) throw new Error('直播清单没有媒体分片')
  return text
}

export function createResolver({ fetchImpl = proxyAwareFetch, now = () => Date.now(), timeoutMs = 12000, family } = {}) {
  const api = createApiClient({ fetchImpl, now, timeoutMs })
  const cache = new Map(), pending = new Map()
  let generation = 0
  async function play(channel, force = false) {
    if (!force && cache.get(channel.id)?.expiresAt > now()) return cache.get(channel.id).url
    if (force) cache.delete(channel.id)
    if (!pending.has(channel.id)) {
      const gen = generation, started = now()
      const promise = api.request(`/tv/now/${channel.id}`).then(data => {
        // 上海目录的公开频道同时返回 paid=true、contentIsFree=true；paid 不能单独当作收费拦截标志。
        // 只增加官方明确标为免费的情况，paid=true 且没有免费标记仍然拒绝。
        const playable = data?.paid === false || data?.contentIsFree === true
        if (String(data?.tvid) !== channel.id || data.tv_name !== channel.name || data.state !== 'live' || !playable || !data.playUrl) throw new Error('频道不可播、需要付费或身份不匹配')
        const url = mediaUrl(data.playUrl)
        const valid = Number(data.validSeconds)
        if (!Number.isFinite(valid) || valid <= 30) throw new Error('播放地址缺少足够有效期')
        if (gen === generation) cache.set(channel.id, { url, expiresAt: started + Math.min(120, valid - 30) * 1000 })
        return url
      }).finally(() => { if (pending.get(channel.id) === promise) pending.delete(channel.id) })
      pending.set(channel.id, promise)
    }
    return pending.get(channel.id)
  }
  async function resolve(ref) {
    const channel = channelForRef(ref)
    if (!channel) return { url: '', desc: '百视通频道不存在' }
    try {
      let url = await play(channel), text
      try { text = validateManifest(await requestText(url, { fetchImpl, timeoutMs }), url) }
      catch {
        // 缓存尚未到期但 CDN 已拒绝时，立即重新取票；仍失败就结束，不回退旧地址。
        url = await play(channel, true)
        text = validateManifest(await requestText(url, { fetchImpl, timeoutMs }), url)
      }
      return { url, desc: '福建百视通直播', relayHls: true, manifestText: text, manifestUrl: url,
        ...(family === 6 ? { proxyHls: true, upstreamFamily: 6 } : {}),
        upstreamUrlTransform: raw => mediaUrl(raw, url) }
    } catch (error) {
      cache.delete(channel.id)
      return { url: '', desc: `百视通取流失败：${error?.message || '上游不可用'}` }
    }
  }
  function clear() { generation++; cache.clear(); pending.clear(); api.clear() }
  return { resolve, clear }
}
const resolvers = {
  auto: createResolver(),
  ipv6: createResolver({ fetchImpl: networkFetch({ networkMode: 'ipv6' }), family: 6 }),
}
export async function resolveChannel(ref, ctx = {}) {
  try {
    const mode = networkMode(ctx.config)
    const result = await resolvers[mode].resolve(ref)
    if (!result.url && mode === 'ipv6') result.desc += '（IPv6直连需要容器具备原生IPv6、DNS返回AAAA记录；不会自动回退IPv4或代理）'
    return result
  } catch (error) { return { url: '', desc: error.message || '百视通网络模式无效' } }
}
export function clearResolveCache() { for (const resolver of Object.values(resolvers)) resolver.clear() }
