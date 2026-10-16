// Accept only the owner's official iQiyi cookies; never persist the import text.
const error = message => new Error(message)
export function parseCookies(payload) {
  if (typeof payload !== 'string' || !payload.trim() || payload.length > 65536) throw error('请提供不超过 64 KB 的 Cookie 请求头或 Cookie JSON。')
  let cookies
  const text = payload.trim()
  if (/^[\[{]/.test(text)) {
    let data
    try { data = JSON.parse(text) } catch { throw error('Cookie JSON 格式不正确。') }
    cookies = Array.isArray(data) ? data : data.cookies
  } else {
    const header = text.replace(/^cookie:\s*/i, '')
    if (/[\r\n]/.test(header)) throw error('请只粘贴一行 Cookie 请求头。')
    cookies = header.split(';').map(part => {
      const index = part.indexOf('=')
      if (index < 1) throw error('Cookie 请求头格式不正确。')
      return { name: part.slice(0, index).trim(), value: part.slice(index + 1).trim(), domain: '.iqiyi.com', path: '/', secure: true }
    })
  }
  if (!Array.isArray(cookies) || !cookies.length || cookies.length > 120) throw error('Cookie 数量无效。')
  const normalized = cookies.map(c => {
    const domain = String(c.domain || '.iqiyi.com').toLowerCase()
    if (!/^(?:\.?iqiyi\.com|\.?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.iqiyi\.com)$/.test(domain)) throw error('只接受爱奇艺 iqiyi.com 域名的 Cookie。')
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(c.name || '') || typeof c.value !== 'string' || /[\r\n\x00]/.test(c.value)) throw error('Cookie 字段无效。')
    const out = { name: c.name, value: c.value, domain, path: typeof c.path === 'string' && c.path.startsWith('/') ? c.path : '/',
      secure: c.secure !== false, httpOnly: c.httpOnly === true }
    if (['Strict', 'Lax', 'None'].includes(c.sameSite)) out.sameSite = c.sameSite
    const expires = Number(c.expires ?? c.expirationDate)
    // A Cookie request header omits expiry. Keep it locally for at most 48 hours;
    // the official server still decides whether its token is valid on every check.
    out.expires = Number.isFinite(expires) && expires > 0 ? expires : Math.floor(Date.now() / 1000) + 48 * 3600
    return out
  })
  if (!normalized.some(c => c.name === 'P00001' && c.value)) throw error('未找到 P00001 登录凭证，请从已登录的官方请求复制完整 Cookie。')
  return normalized
}
