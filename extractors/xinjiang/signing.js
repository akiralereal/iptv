import { constants, createHash, publicEncrypt } from 'node:crypto'

// 官网包内也包含一个空 PEM 模板；要求正文每行都是 base64，避免误取模板。
const PUBLIC_KEY_RE = /-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/=]{1,80}\r?\n)+-----END PUBLIC KEY-----/
const IDENTIFIER = '[A-Za-z_$][\\w$]*'
// obfuscator.io 的字符串数组：function NAME(){const V=[...];return NAME=function(){return V},NAME()}
const ARRAY_FUNCTION_RE = new RegExp(
  `function\\s+(${IDENTIFIER})\\(\\)\\{const\\s+(${IDENTIFIER})=(\\[[\\s\\S]*?\\]);return\\s+\\1=function\\(\\)\\{return\\s+\\2\\},\\1\\(\\)\\}`,
  'g',
)
// 配套解码器：function DEC(a,b){return a=a-OFFSET,ARRAY()[a]}
const decoderPattern = arrayName => new RegExp(
  `function\\s+(${IDENTIFIER})\\((${IDENTIFIER})(?:,[^)]*)?\\)\\{return\\s+\\2=\\2-(\\d+),${escapeRegExp(arrayName)}\\(\\)\\[\\2\\]\\}`,
)
// 数组自检：官网在包加载时按固定表达式旋转数组，表达式算出的值等于目标值时才停。
const CHECK_PATTERN = new RegExp(
  `\\(function\\((${IDENTIFIER}),(${IDENTIFIER})\\)\\{const (${IDENTIFIER})=(${IDENTIFIER}),(${IDENTIFIER})=\\1\\(\\);` +
    'for\\(;;\\)try\\{if\\(([\\s\\S]*?)\\)break;' +
    `(${IDENTIFIER})\\.push\\(\\7\\.shift\\(\\)\\)\\}catch\\(${IDENTIFIER}\\)\\{\\7\\.push\\(\\7\\.shift\\(\\)\\)\\}\\}\\)` +
    `\\((${IDENTIFIER}),(-?\\d+(?:\\.\\d+)?)\\)`,
  'g',
)
const ALIAS_PATTERN = new RegExp(`(?:const|let|var)\\s+(${IDENTIFIER})=(${IDENTIFIER})[,;]`, 'g')

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

/**
 * 自检表达式只含 parseInt(dec(n))/常数 的四则运算，这里用递归下降求值：
 * 不 eval、不 new Function，也不执行官网下载下来的任何代码。
 * 表达式尾部的 ===目标 去掉——目标值本来就由自检函数的实参给出。
 */
function foldChecksum(expression, decode) {
  const body = expression.replace(/[=!]==?\s*[A-Za-z_$][\w$]*\s*$/, '')
  return body.replace(
    new RegExp(`parseInt\\(\\s*${IDENTIFIER}\\s*\\(\\s*(\\d+)\\s*\\)\\s*\\)`, 'g'),
    (all, index) => String(parseInt(decode(Number(index)), 10)),
  )
}

function tokenizeArithmetic(source) {
  const tokens = []
  const pattern = /\s*([()+\-*/]|NaN|\d+)/y
  let at = 0
  while (at < source.length) {
    pattern.lastIndex = at
    const hit = pattern.exec(source)
    if (!hit) throw new Error('无法解析: ' + JSON.stringify(source.slice(at, at + 24)))
    tokens.push(hit[1])
    at = pattern.lastIndex
  }
  return tokens
}

function evaluateArithmetic(tokens) {
  let at = 0
  const peek = () => tokens[at]
  const eat = () => tokens[at++]
  const factor = () => {
    if (peek() === '(') {
      eat()
      const value = sum()
      if (eat() !== ')') throw new Error('自检表达式括号不匹配')
      return value
    }
    const token = eat()
    if (token === 'NaN') return NaN
    if (!/^\d+$/.test(token)) throw new Error('自检表达式含非数字记号')
    return Number(token)
  }
  const unary = () => {
    if (peek() === '-') { eat(); return -unary() }
    if (peek() === '+') { eat(); return unary() }
    return factor()
  }
  const product = () => {
    let value = unary()
    while (peek() === '*' || peek() === '/') {
      const operator = eat()
      const operand = unary()
      value = operator === '*' ? value * operand : value / operand
    }
    return value
  }
  function sum() {
    let value = product()
    while (peek() === '+' || peek() === '-') {
      const operator = eat()
      const operand = product()
      value = operator === '+' ? value + operand : value - operand
    }
    return value
  }
  const value = sum()
  if (at !== tokens.length) throw new Error('自检表达式尾部残留')
  return value
}

/**
 * 找出这个数组在官网里被用到的解码器与别名，并按自检表达式定出唯一的正确旋转。
 * 自检通过前一直是 NaN（parseInt 取不到前缀数字），旋转到某一档才会等于目标值——
 * 这就是官网运行时的行为，这里只做静态复现，所以拿到的一定是对的那一档。
 */
function solveStringArray(bundle, arrayName, values) {
  const decoder = bundle.match(decoderPattern(arrayName))
  if (!decoder) return null
  const decoderName = decoder[1]
  const offset = Number(decoder[3])

  const names = new Set([decoderName])
  for (const hit of bundle.matchAll(ALIAS_PATTERN)) if (hit[2] === decoderName) names.add(hit[1])
  const callPattern = new RegExp(`(?<![\\w$])(?:${[...names].map(escapeRegExp).join('|')})\\(\\s*(\\d+)\\s*\\)`, 'g')

  for (const hit of bundle.matchAll(CHECK_PATTERN)) {
    if (hit[4] !== decoderName || hit[8] !== arrayName) continue
    const expression = hit[6]
    const target = Number(hit[9])
    const rotated = values.slice()
    const decode = index => rotated[index - offset]
    for (let rotation = 0; rotation <= rotated.length; rotation += 1) {
      let passed = false
      try {
        passed = evaluateArithmetic(tokenizeArithmetic(foldChecksum(expression, decode))) === target
      } catch {
        // 自检表达式结构不认得就换下一档，别当成本档失败
      }
      if (passed) return { decode, callPattern }
      rotated.push(rotated.shift())
    }
  }
  return null
}

/** 把 dec(idx) 调用换成 JSON 字符串字面量，dec 出来的值再当键名或键值都能直接用。 */
function inlineDecodeCalls(block, decode, callPattern) {
  return block.replace(callPattern, (all, index) => {
    const value = decode(Number(index))
    return typeof value === 'string' ? JSON.stringify(value) : 'null'
  })
}

/**
 * 取配置对象里的 date / random_string / random_number。
 * 官网同一个变量名会在不同作用域复用，碰到新的 date 就结算上一组，避免串味。
 */
function collectConfigs(block) {
  const merged = []
  const records = new Map()
  // 官网三种写法混用：点号、字面量计算键、解码后计算键，内联后统一成这两种
  const entryPattern = new RegExp(
    `(${IDENTIFIER})(?:\\.(date|random_string|random_number)|\\["(date|random_string|random_number)"\\])`
      + `=(?:"((?:\\\\.|[^"\\\\])*)"|(\\d+))`,
    'g',
  )
  const flush = record => {
    if (!record) return
    const { date, token, number } = record
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return
    if (!token || !/^[A-Za-z0-9]+$/.test(token) || token === date) return
    if (!Number.isInteger(number) || number < 0) return
    merged.push({ date, random_string: token, random_number: number })
  }
  for (const hit of block.matchAll(entryPattern)) {
    const [, name, dotKey, bracketKey, quoted, plain] = hit
    const key = dotKey || bracketKey
    if (key === 'date') {
      flush(records.get(name))
      records.set(name, { date: quoted })
      continue
    }
    const record = records.get(name) || {}
    if (key === 'random_string') record.token = quoted
    else record.number = Number(plain)
    records.set(name, record)
  }
  for (const record of records.values()) flush(record)
  return merged
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
    if (!Array.isArray(values)) continue
    // 官网约四成日子把日期直接写成字面量，不能按表里有没有日期预筛；但键名必须在表里。
    if (!values.includes('date') || !values.includes('random_string')
      || !values.includes('random_number')) continue

    const solved = solveStringArray(bundle, match[1], values)
    if (!solved) continue

    // 配置块贴着公钥常量前后；数组函数到公钥之间就是全部日期配置。
    const keyAt = bundle.indexOf('-----BEGIN PUBLIC KEY-----', match.index)
    const start = Math.max(0, match.index - 40_000)
    const end = keyAt > -1 ? Math.min(bundle.length, keyAt + 100)
      : Math.min(bundle.length, match.index + 40_000)
    const configs = collectConfigs(inlineDecodeCalls(bundle.slice(start, end), solved.decode, solved.callPattern))
    const config = configs.find(item => item.date === date
      && item.random_string.length >= 32 && item.random_number < item.random_string.length)
    if (config) return { ...config, publicKey }
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