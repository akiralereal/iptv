import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { Agent, fetch } from 'undici'

export const MEDIA_HOST = 'idclive.hljtv.com'
export const MEDIA_ORIGIN = `https://${MEDIA_HOST}:4430`
const DNS_URL = `https://dns.alidns.com/resolve?name=${MEDIA_HOST}&type=A`
const blocked = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
]) blocked.addSubnet(address, prefix, 'ipv4')

const publicIPv4 = address => isIP(address) === 4 && !blocked.check(address, 'ipv4')

async function timedLookup(lookupImpl) {
  let timer
  try {
    return await Promise.race([
      lookupImpl(MEDIA_HOST, { family: 4, all: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS 超时')), 2000) }),
    ])
  } finally { clearTimeout(timer) }
}

/** 仅此官方域名：正常 DNS 优先；fake-IP、私网或解析失败时才查询公共 DNS。 */
export function createAddressResolver({ lookupImpl = lookup, dnsFetch = fetch, now = Date.now } = {}) {
  let cached, pending
  async function discover() {
    try {
      const rows = await timedLookup(lookupImpl)
      const row = rows.find(item => publicIPv4(item.address))
      if (row) return { address: row.address, expires: now() + 60_000 }
    } catch { /* 本地解析不可用，改查 DNS over HTTPS */ }
    const response = await dnsFetch(DNS_URL, { signal: AbortSignal.timeout(5000), redirect: 'error' })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`黑龙江域名解析 HTTP ${response.status}`) }
    const data = await response.json()
    const row = data.Status === 0 && data.Answer?.find(item => item.type === 1
      && String(item.name).replace(/\.$/, '').toLowerCase() === MEDIA_HOST && publicIPv4(item.data))
    if (!row) throw new Error('黑龙江官方域名没有可用的公网 IPv4 地址')
    const ttl = Number.isFinite(row.TTL) ? Math.max(0, Math.min(row.TTL, 600)) : 60
    return { address: row.data, expires: now() + ttl * 1000 }
  }
  return {
    async address() {
      if (cached && cached.expires > now()) return cached.address
      if (!pending) pending = discover().then(value => { cached = value; return value.address }).finally(() => { pending = null })
      return pending
    },
    clear() { cached = undefined },
  }
}

/** 只替换连接时的 DNS 结果；URL、Host、TLS SNI 和证书校验始终使用官方域名。 */
export function createOfficialTransport(validateUrl, options = {}) {
  const addresses = createAddressResolver(options)
  const dispatcher = new Agent({
    connect: {
      family: 4, autoSelectFamily: false, timeout: 8000,
      lookup(hostname, lookupOptions, callback) {
        if (hostname !== MEDIA_HOST) { callback(new Error('非黑龙江官方媒体主机')); return }
        addresses.address().then(address => {
          if (lookupOptions.all) callback(null, [{ address, family: 4 }])
          else callback(null, address, 4)
        }, callback)
      },
    },
  })
  return {
    async fetch(raw, init = {}) {
      const url = validateUrl(raw)
      try {
        // 省台媒体直连，不交给系统 HTTP 代理；每一跳由调用方重新校验。
        return await fetch(url, { ...init, dispatcher, redirect: 'manual' })
      } catch (error) {
        if (!init.signal?.aborted) addresses.clear()
        throw error
      }
    },
    clear: () => addresses.clear(),
    close: () => dispatcher.close(),
  }
}
