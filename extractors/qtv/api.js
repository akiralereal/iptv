/** 青岛网络广播电视台五路城市直播页面解析。 */
import fetch from 'node-fetch'

export const QTV_CHANNELS = [
  {
    id: '014282221',
    name: '五四广场',
    pageUrl: 'https://www.qtv.com.cn/live/system/2017/04/28/014282221.shtml',
    fallbackUrl: 'https://video10.qtv.com.cn/aqdwsgc2022/manifest.m3u8',
  },
  {
    id: '014282223',
    name: '奥帆中心',
    pageUrl: 'https://www.qtv.com.cn/live/system/2017/04/28/014282223.shtml',
    fallbackUrl: 'https://video10.qtv.com.cn/aqdafzx2022/manifest.m3u8',
  },
  {
    id: '014283886',
    name: '快速路大润发方向',
    pageUrl: 'https://www.qtv.com.cn/live/system/2017/04/29/014283886.shtml',
    fallbackUrl: 'https://video10.qtv.com.cn/sxt1/manifest.m3u8',
  },
  {
    id: '014283895',
    name: '胶宁高架福州路口',
    pageUrl: 'https://www.qtv.com.cn/live/system/2017/04/29/014283895.shtml',
    fallbackUrl: 'https://video10.qtv.com.cn/sxt3/manifest.m3u8',
  },
  {
    id: '014283894',
    name: '胶宁高架银川西路口',
    pageUrl: 'https://www.qtv.com.cn/live/system/2017/04/29/014283894.shtml',
    fallbackUrl: 'https://video10.qtv.com.cn/sxt2/manifest.m3u8',
  },
]

const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'

export function normalizeStreamUrl(raw) {
  try {
    const url = new URL(String(raw || '').trim().replace(/^http:/i, 'https:'))
    return url.protocol === 'https:'
      && url.hostname === 'video10.qtv.com.cn'
      && /^\/[A-Za-z0-9_-]+\/manifest\.m3u8$/i.test(url.pathname)
      ? url.href
      : ''
  } catch {
    return ''
  }
}

export function parseStreamPage(html) {
  const match = /\bvideoUrl\s*:\s*["']([^"']+)["']/i.exec(String(html || ''))
  const url = normalizeStreamUrl(match?.[1])
  if (!url) throw new Error('页面没有找到青岛广电官方 HLS 地址')
  return url
}

async function fetchOne(definition, { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(definition.pageUrl, {
      headers: { Accept: 'text/html,*/*', Referer: 'https://www.qtv.com.cn/live/citylive/', 'User-Agent': UA },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return { name: definition.name, url: parseStreamPage(await response.text()), logo: '' }
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error?.message || String(error))
    return {
      name: definition.name,
      url: normalizeStreamUrl(definition.fallbackUrl),
      logo: '',
      warning: `${definition.name}页面本轮不可用，沿用已核验地址：${reason}`,
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchChannels(options = {}) {
  const rows = await Promise.all(QTV_CHANNELS.map(channel => fetchOne(channel, options)))
  return {
    channels: rows.map(row => ({
      name: row.name,
      url: row.url,
      catchup: 'none',
      logo: row.logo,
      opts: ['network-caching=3000'],
    })),
    warnings: rows.flatMap(row => row.warning ? [row.warning] : []),
  }
}
