import { constants, createHash, publicEncrypt } from 'node:crypto'

// 官网包内也包含一个空 PEM 模板；要求正文每行都是 base64，避免误取模板。
const PUBLIC_KEY_RE = /-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/=]{1,80}\r?\n)+-----END PUBLIC KEY-----/
const IDENTIFIER = '[A-Za-z_$][\\w$]*'
// obfuscator.io 的字符串数组：function NAME(){const V=[...];return NAME=function(){return V},NAME()}
const ARRAY_FUNCTION_RE = new RegExp(
  `function\\s+(${IDENTIFIER})\\(\\)\\{const\\s+(${IDENTIFIER})=(\\[[\\s\\S]*?\\]);return\\s+\\1=function\\(\\)\\{return\\s+\\2\\},\\1\\(\\)\\}`,
  'g',
)
// 配套解码器，两种形态：
//   function DEC(a,b){return a=a-OFFSET,ARRAY()[a]}
//   function DEC(a,b){const x=ARRAY();return DEC=function(a,b){return a=a-OFFSET,x[a]},DEC(a,b)}
const decoderPattern = arrayName => new RegExp(
  `function\\s+(${IDENTIFIER})\\((${IDENTIFIER})(?:,[^)]*)?\\)\\{(?:return\\s+\\2=\\2-(\\d+),${escapeRegExp(arrayName)}\\(\\)\\[\\2\\]`
  + `|const\\s+(${IDENTIFIER})=${escapeRegExp(arrayName)}\\(\\);return\\s+\\1=function\\((${IDENTIFIER})(?:,[^)]*)?\\)\\{return\\s+\\5=\\5-(\\d+),\\4\\[\\5\\]\\},\\1\\([^)]*\\))`,
)
// 数组自检：官网在包加载时按固定表达式旋转数组，表达式算出的值等于目标值时才停。
// while 风格会多一层花括号：while(!![]){try{...}
const CHECK_PATTERN = new RegExp(
  `\\(function\\((${IDENTIFIER}),(${IDENTIFIER})\\)\\{const (${IDENTIFIER})=(${IDENTIFIER}),(${IDENTIFIER})=\\1\\(\\);` +
    '(?:for\\(;;\\)|while\\(!!\\[\\]\\))\\{?try\\{if\\(([\\s\\S]*?)\\)break;' +
    `(${IDENTIFIER})\\.push\\(\\7\\.shift\\(\\)\\)\\}catch\\(${IDENTIFIER}\\)\\{\\7\\.push\\(\\7\\.shift\\(\\)\\)\\}\\}\\)` +
    `\\((${IDENTIFIER}),(-?\\d+(?:\\.\\d+)?)\\)`,
  'g',
)
const ALIAS_PATTERN = new RegExp(`(?:const|let|var)\\s+(${IDENTIFIER})=(${IDENTIFIER})[,;]`, 'g')
// token 表只有这三个键
const CONFIG_KEYS = new Set(['date', 'random_string', 'random_number'])

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// JS 字符串字面量里的转义
const STRING_ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' }

/** 按 JS 规则还原字面量里的转义；遇到不完整的 \u / \x 就返回 null。 */
function unescapeLiteral(raw) {
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== '\\') { out += raw[i]; continue }
    const next = raw[++i]
    if (next === 'u' || next === 'x') {
      const width = next === 'u' ? 4 : 2
      const hex = raw.slice(i + 1, i + 1 + width)
      if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) return null
      out += String.fromCharCode(parseInt(hex, 16))
      i += width
      continue
    }
    if (next === '\n') continue                 // 行接续
    if (next === '\r') { if (raw[i + 1] === '\n') i += 1; continue }
    if (next === undefined) return null
    out += Object.hasOwn(STRING_ESCAPES, next) ? STRING_ESCAPES[next] : next
  }
  return out
}

const NUMBER_SOURCE = '-?(?:0[xX][0-9a-fA-F]+|\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)'
// 数组字面量的一个元素：三种引号的字符串、数字、true/false/null
const ARRAY_ITEM_RE = new RegExp(
  '\\s*(?:'
  + [
    '"((?:\\\\.|[^"\\\\])*)"',
    "'((?:\\\\.|[^'\\\\])*)'",
    '`((?:\\\\.|[^`\\\\])*)`',
    `(${NUMBER_SOURCE})`,
    '(true|false|null)',
  ].join('|')
  + ')',
  'y',
)

/**
 * 解析 JS 数组字面量，同样不 eval、不 new Function。
 * 官网的字符串表里现在混着模板字符串（RSA 公钥），JSON.parse 会直接报错、整张表被跳过，
 * 所以这里手写词法：只认字符串字面量（单/双引号与反引号）、数字、true/false/null，
 * 其余语法一律判为「不是常量表」，宁可漏掉也不猜——保持本模块不执行官网代码的约定。
 */
function parseArrayLiteral(text) {
  let at = 0
  const skipSpace = () => { while (at < text.length && /\s/.test(text[at])) at += 1 }
  // 收尾：必须正好吃完整段，剩下的尾巴一律不认
  const finish = () => (at === text.length ? values : null)
  const values = []
  skipSpace()
  if (text[at] !== '[') return null
  at += 1
  skipSpace()
  if (text[at] === ']') { at += 1; skipSpace(); return finish() }
  for (;;) {
    ARRAY_ITEM_RE.lastIndex = at
    const hit = ARRAY_ITEM_RE.exec(text)
    if (!hit || hit.index !== at) return null
    at = ARRAY_ITEM_RE.lastIndex
    const literal = hit[1] ?? hit[2] ?? hit[3]
    if (literal !== undefined) {
      // 模板字符串带 ${...} 插值就不是常量了，算不出来也不能猜
      if (hit[3] !== undefined && literal.includes('${')) return null
      const value = unescapeLiteral(literal)
      if (value === null) return null
      values.push(value)
    } else if (hit[4] !== undefined) {
      values.push(Number(hit[4]))
    } else if (hit[5] === 'null') {
      values.push(null)
    } else {
      values.push(hit[5] === 'true')
    }
    skipSpace()
    if (text[at] === ',') {
      at += 1
      skipSpace()
      if (text[at] === ']') { at += 1; skipSpace(); return finish() }
      continue
    }
    if (text[at] === ']') { at += 1; skipSpace(); return finish() }
    return null
  }
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
  // 自替换形态的偏移量在另一组捕获里
  const offset = Number(decoder[3] ?? decoder[6])

  const names = new Set([decoderName])
  for (const hit of bundle.matchAll(ALIAS_PATTERN)) if (hit[2] === decoderName) names.add(hit[1])

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
      if (passed) return { decode, names }
      rotated.push(rotated.shift())
    }
  }
  return null
}

/**
 * 把赋值位置上的 dec(idx) 换成明文字面量：obj.KEY= / obj[dec(idx)]=。
 * 压缩代码里 dec 的局部别名（const t=dec）和同名普通变量混在一起，
 * 全局替换 dec(idx) 会把无关代码改坏，所以只在赋值处解码。
 */
function decodeAssignments(block, decode, names) {
  const call = [...names].map(escapeRegExp).join('|')
  const assignmentPattern = new RegExp(
    `(${IDENTIFIER})(?:\\.(${IDENTIFIER})|\\[(${call})\\((\\d+)\\)\\])=`
    + `(?:"((?:\\\\.|[^"\\\\])*)"|(${call})\\((\\d+)\\)|(-?\\d+))`,
    'g',
  )
  return block.replace(assignmentPattern, (all, name, dotKey, keyDecoder, keyIndex, quoted, valueDecoder, valueIndex, plain) => {
    const key = keyDecoder ? decode(Number(keyIndex)) : dotKey
    if (!CONFIG_KEYS.has(key)) return all
    if (quoted !== undefined) return `${name}.${key}=${JSON.stringify(quoted)}`
    if (valueDecoder) {
      const value = decode(Number(valueIndex))
      return typeof value === 'string' ? `${name}.${key}=${JSON.stringify(value)}` : all
    }
    return `${name}.${key}=${plain}`
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
    const values = parseArrayLiteral(match[3])
    if (!values) continue
    // 官网约四成日子把日期直接写成字面量，不能按表里有没有日期预筛；但键名必须在表里。
    if (!values.includes('date') || !values.includes('random_string')
      || !values.includes('random_number')) continue

    const solved = solveStringArray(bundle, match[1], values)
    if (!solved) continue

    // 配置块贴着这个数组函数前后。
    // 以前拿公钥常量当右边界，现在公钥模板被搬进了字符串表内部（数组函数开头就是它），
    // 那个锚点会落在数组自己身上、右边界只剩一百来个字符，只能改按数组函数本身取窗口。
    const start = Math.max(0, match.index - 40_000)
    const end = Math.min(bundle.length, match.index + match[0].length + 40_000)
    const configs = collectConfigs(decodeAssignments(
      bundle.slice(start, end), solved.decode, solved.names,
    ))
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