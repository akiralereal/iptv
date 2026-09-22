import { constants, createHash, publicEncrypt } from 'node:crypto'

// 官网包内也包含一个空 PEM 模板；要求正文每行都是 base64，避免误取模板。
const PUBLIC_KEY_RE = /-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/=]{1,80}\r?\n)+-----END PUBLIC KEY-----/
const ARRAY_FUNCTION_RE = /function\s+([A-Za-z_$][\w$]*)\(\)\{const\s+([A-Za-z_$][\w$]*)=(\[[\s\S]*?\]);return\s+\1=function\(\)\{return\s+\2\},\1\(\)/g

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function shanghaiDate(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(now))
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${byType.year}-${byType.month}-${byType.day}`
}

function decoderFor(bundle, arrayName) {
  const name = escapeRegExp(arrayName)
  const direct = new RegExp(`function\\s+([A-Za-z_$][\\w$]*)\\(([A-Za-z_$][\\w$]*)(?:,[^)]*)?\\)\\{return\\s+\\2=\\2-(\\d+),${name}\\(\\)\\[\\2\\]\\}`)
  const match = bundle.match(direct)
  if (!match) return null
  const decoderName = match[1]
  const alias = bundle.match(new RegExp(`const\\s+([A-Za-z_$][\\w$]*)=${escapeRegExp(decoderName)}(?:;|,)`))?.[1] || decoderName
  return { alias, offset: Number(match[3]) }
}

function parseAssignments(block, alias, values, offset) {
  const records = new Map()
  const decode = raw => values[Number(raw) - offset]
  const objectRe = /(?:const\s+)?([A-Za-z_$][\w$]*)\s*=\s*\{\}/g
  for (const hit of block.matchAll(objectRe)) records.set(hit[1], {})

  const call = `${escapeRegExp(alias)}\\(\\s*(\\d+)\\s*\\)`
  const assignmentRe = new RegExp(
    `([A-Za-z_$][\\w$]*)(?:\\.([A-Za-z_$][\\w$]*)|\\[\\s*(?:${call}|"([^\"]+)")\\s*\\])`
      + `\\s*=\\s*(?:${call}|"([^\"]*)"|(\\d+))`,
    'g',
  )
  for (const hit of block.matchAll(assignmentRe)) {
    const name = hit[1]
    if (!records.has(name)) continue
    const key = hit[2] || (hit[3] ? decode(hit[3]) : hit[4])
    const value = hit[5] ? decode(hit[5]) : (hit[6] !== undefined ? hit[6] : Number(hit[7]))
    if (typeof key === 'string') records.get(name)[key] = value
  }
  return [...records.values()]
}

/** 从官网当前 Nuxt 包中解析当天公开签名材料，不执行下载到的 JavaScript。 */
export function extractSigningMaterial(bundle, date = shanghaiDate()) {
  if (typeof bundle !== 'string' || bundle.length > 4 * 1024 * 1024) {
    throw new Error('新疆广电签名脚本无效或过大')
  }
  const publicKey = bundle.match(PUBLIC_KEY_RE)?.[0]
  if (!publicKey) throw new Error('新疆广电签名脚本缺少公钥')

  for (const match of bundle.matchAll(ARRAY_FUNCTION_RE)) {
    let values
    try { values = JSON.parse(match[3]) } catch { continue }
    if (!Array.isArray(values) || !values.includes('random_string')
      || !values.includes('random_number') || !values.includes('date')) continue
    const decoder = decoderFor(bundle, match[1])
    if (!decoder) continue
    const keyAt = bundle.indexOf('-----BEGIN PUBLIC KEY-----', match.index)
    const start = Math.max(0, match.index - 40_000)
    const end = keyAt > -1
      ? Math.min(bundle.length, keyAt + 100)
      : Math.min(bundle.length, match.index + 40_000)
    const block = bundle.slice(start, end)

    // 官网会在包加载时旋转字符串表；枚举所有旋转状态即可静态还原配置。
    for (let rotation = 0; rotation < values.length; rotation++) {
      const records = parseAssignments(block, decoder.alias, values, decoder.offset)
      const config = records.find(record => record.date === date
        && typeof record.random_string === 'string' && record.random_string.length >= 32
        && Number.isInteger(record.random_number) && record.random_number >= 0
        && record.random_number < record.random_string.length)
      if (config) return { ...config, publicKey }
      values.push(values.shift())
    }
  }
  throw new Error(`新疆广电签名脚本没有 ${date} 的配置`)
}

export function createSignedParams(endpoint, stamp, material, options = {}) {
  if (!/^\/api\/[A-Za-z0-9/]+$/.test(endpoint)) throw new Error('新疆广电签名接口路径无效')
  if (!/^\d{10,16}$/.test(String(stamp))) throw new Error('新疆广电时间戳无效')
  const { random_string: randomString, random_number: randomNumber, publicKey } = material
  if (typeof randomString !== 'string' || !Number.isInteger(randomNumber)
    || randomNumber < 0 || randomNumber >= randomString.length || !PUBLIC_KEY_RE.test(publicKey || '')) {
    throw new Error('新疆广电签名材料无效')
  }
  const now = Number(options.now ?? Date.now())
  const random = options.random ?? Math.random
  const guid = `${now.toString(36)}-${random().toString(36).slice(2, 9).padEnd(7, '0')}`
  const token = randomString.slice(0, randomNumber) + randomString.slice(randomNumber + 1)
  const message = `${token}${randomNumber >= 15 ? guid : ''}${stamp}${endpoint.slice(1)}`
  const digest = createHash('md5').update(message, 'ascii').digest('hex')
  const encrypted = publicEncrypt(
    { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(token, 'ascii'),
  ).toString('base64')
  return { stamp: String(stamp), guid, sign: digest + encrypted }
}

export function scriptUrls(html, pageUrl) {
  if (typeof html !== 'string' || html.length > 4 * 1024 * 1024) {
    throw new Error('新疆广电官网页面无效或过大')
  }
  const urls = []
  for (const match of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
    const url = new URL(match[1], pageUrl)
    if (url.protocol === 'https:' && !url.port && url.hostname === new URL(pageUrl).hostname
      && /^\/_nuxt\/[A-Za-z0-9_-]+\.js$/.test(url.pathname)) urls.push(url.href)
  }
  return [...new Set(urls)].slice(0, 32)
}
