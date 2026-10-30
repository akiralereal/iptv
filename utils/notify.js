/**
 * 消息推送：把提醒中心（utils/alerts.js）的「新出现 / 已恢复」发到企业微信（群机器人 / 应用消息）、
 * 飞书、钉钉、Telegram、Bark、任意 Webhook，或按用户自己填的请求模板发到 PushPlus、Server酱
 * 这类推送平台（自定义接口）。只做出站推送，不接收任何指令。
 *
 * 两份文件，刻意分开：
 *   notify-channels.json  渠道配置（含机器人地址 / Token，敏感）。小、少变、进配置备份。
 *   notify-state.json     推送记录（推过哪些提醒、各渠道最近一次结果）。运行状态，不进备份。
 *
 * 什么时候发（AlertTracker 每次评估后调 handleEvaluation）：
 *   - 升级后第一次运行时就已存在的提醒是老问题，记下但不发，它们恢复时也不发；
 *   - 抓取失败要连续失败两次才发，一闪而过的不打扰；其余提醒（凭证失效、EPG、访问密码、
 *     配置损坏）出现即发；
 *   - 推过的提醒恢复时发一条「已恢复」；没推过的恢复了不发；
 *   - 没有启用的渠道时什么都不记，配好渠道后当前未处理的提醒会补发一次。
 * 一轮里的多条合成一条消息。发送失败只记在渠道结果里，不重试——下次状态变化照常发。
 */
import { createHmac, randomBytes } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { writeJsonFileSync } from "./fileUtil.js"
import { dataPath } from "./paths.js"
import { proxyAwareFetch } from "./systemProxy.js"
import { printGreen, printRed, printYellow } from "./colorOut.js"

export const CHANNELS_FILE = 'notify-channels.json'
const STATE_FILE = 'notify-state.json'
const SEND_TIMEOUT_MS = 10 * 1000
const MAX_TEXT = 1800   // 企微 text 上限 2048 字节左右，留余量；各家都够用

/**
 * 渠道类型。fields 里 secret:true 的字段在后台接口里打码，保存时留空 = 不改。
 * 字段 key 同时是 notify-channels.json 里的键名。
 */
export const CHANNEL_TYPES = {
  feishu: {
    name: '飞书群机器人',
    fields: [
      { key: 'url', label: 'Webhook 地址', secret: true, required: true, placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/…' },
      { key: 'secret', label: '签名校验密钥（机器人开了「签名校验」才填）', secret: true },
    ],
  },
  wecom: {
    name: '企业微信群机器人',
    fields: [{ key: 'url', label: 'Webhook 地址', secret: true, required: true, placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…' }],
  },
  wecomApp: {
    name: '企业微信应用',
    fields: [
      { key: 'corpId', label: '企业 ID（我的企业 → 企业信息 → 企业ID）', required: true, placeholder: 'ww…' },
      { key: 'agentId', label: 'AgentId（应用管理 → 自建应用详情页）', required: true, placeholder: '1000002' },
      { key: 'secret', label: 'Secret（同一页，点「查看」后发到企业微信里）', secret: true, required: true },
      { key: 'toUser', label: '接收人（成员账号，多个用 | 隔开；留空发给应用可见范围内的所有人）', placeholder: '@all 或 ZhangSan|LiSi' },
      { key: 'apiBase', label: 'API 地址（服务器 IP 不固定、加不进「企业可信IP」时填反代地址，留空用官方）', placeholder: 'https://qyapi.weixin.qq.com' },
    ],
  },
  dingtalk: {
    name: '钉钉群机器人',
    fields: [
      { key: 'url', label: 'Webhook 地址', secret: true, required: true, placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=…' },
      { key: 'secret', label: '加签密钥（安全设置选了「加签」才填，SEC 开头）', secret: true },
    ],
  },
  telegram: {
    name: 'Telegram 机器人',
    fields: [
      { key: 'botToken', label: 'Bot Token', secret: true, required: true, placeholder: '123456:ABC-…' },
      { key: 'chatId', label: 'Chat ID', required: true, placeholder: '个人或群组的 chat id，如 123456789 / -100…' },
      { key: 'apiBase', label: 'API 地址（大陆部署连不上 api.telegram.org 时填反代地址，留空用官方）', placeholder: 'https://api.telegram.org' },
    ],
  },
  bark: {
    name: 'Bark（iPhone）',
    fields: [{ key: 'url', label: '推送地址', secret: true, required: true, placeholder: 'https://api.day.app/你的Key' }],
  },
  webhook: {
    name: '通用 Webhook',
    fields: [{ key: 'url', label: 'POST 地址（收到 JSON：title / text / raised / resolved）', secret: true, required: true, placeholder: 'https://example.com/hook' }],
  },
  // 用户照着对方平台的文档自己填请求；密钥单独放 token（打码），地址和模板不打码，方便回来改
  custom: {
    name: '自定义接口（PushPlus、Server酱 等）',
    help: '照着推送平台的接口文档填。请求地址、请求头、请求体里可以用占位符：{{title}} 标题，{{content}} 正文（纯文本，按下面选的样式排），{{markdown}} 正文的 Markdown 版，{{token}} 下面填的密钥。JSON 里的占位符写在引号里，换行和引号会自动转义。',
    fields: [
      { key: 'url', label: '请求地址', required: true, placeholder: 'https://www.pushplus.plus/send' },
      { key: 'token', label: '密钥 / Token（在地址、请求头、请求体里用 {{token}} 引用，保存后不再显示）', secret: true },
      { key: 'method', label: '请求方式', options: [{ value: 'POST', label: 'POST' }, { value: 'GET', label: 'GET（不带请求体，内容写进地址）' }] },
      { key: 'bodyType', label: '请求体格式', options: [{ value: 'json', label: 'JSON' }, { value: 'form', label: '表单（a=1&b=2）' }, { value: 'text', label: '纯文本' }] },
      { key: 'body', label: '请求体模板', multiline: true, placeholder: '{"token": "{{token}}", "title": "{{title}}", "content": "{{content}}"}' },
      { key: 'headers', label: '请求头（一行一个「名称: 值」）', multiline: true, placeholder: 'Authorization: Bearer {{token}}' },
      { key: 'success', label: '成功条件（返回的 JSON 里哪个字段等于什么算发送成功；留空只看 HTTP 状态码）', placeholder: 'code=200' },
    ],
    // 后台「按示例填」：只填地址和模板，密钥还要自己填
    presets: [
      customPreset('PushPlus', '密钥填 PushPlus 的用户 token。', {
        url: 'https://www.pushplus.plus/send',
        body: jsonTemplate({ token: '{{token}}', title: '{{title}}', content: '{{markdown}}', template: 'markdown' }),
        success: 'code=200',
      }),
      customPreset('Server酱', '密钥填 Server酱 Turbo 的 SendKey（SCT 开头）。', {
        url: 'https://sctapi.ftqq.com/{{token}}.send',
        bodyType: 'form',
        body: 'title={{title}}&desp={{markdown}}',
        success: 'code=0',
      }),
      customPreset('WxPusher', '密钥填应用的 appToken（AT_ 开头），再把请求体里的 UID 换成你自己的。', {
        url: 'https://wxpusher.zjiecode.com/api/send/message',
        body: jsonTemplate({ appToken: '{{token}}', content: '{{title}}\n{{content}}', contentType: 1, uids: ['UID_换成你的'] }),
        success: 'code=1000',
      }),
      customPreset('ntfy', '把请求体里的主题换成你订阅的主题；自建的换掉地址，开了访问控制的在请求头加一行 Authorization: Bearer {{token}}。', {
        url: 'https://ntfy.sh/',
        body: jsonTemplate({ topic: '换成你的主题', title: '{{title}}', message: '{{content}}' }),
      }),
      customPreset('Gotify', '把地址换成你自己的 Gotify，密钥填应用的 Token。', {
        url: 'https://gotify.example.com/message',
        body: jsonTemplate({ title: '{{title}}', message: '{{content}}', priority: 5 }),
        headers: 'X-Gotify-Key: {{token}}',
      }),
    ],
  },
}

function jsonTemplate(value) {
  return JSON.stringify(value, null, 2)
}

/** 示例把每个字段都给全，后台套用时不会留着上一个示例的请求头 / 成功条件。 */
function customPreset(name, tip, values) {
  return { name, tip, values: { method: 'POST', bodyType: 'json', body: '', headers: '', success: '', ...values } }
}

const MASK = '••••••'

/**
 * 消息样式，每个渠道单独选。卡片只给有富文本消息的四家：飞书发彩色标题的消息卡片，
 * 企业微信群机器人 / 钉钉发 Markdown，Telegram 发 HTML 加粗。别的类型选了卡片按详细发。
 * 企业微信应用不给卡片：应用的 Markdown 消息在微信里（企业微信插件）显示不了。
 */
export const TEMPLATES = {
  detailed: { name: '详细', description: '标题、每条提醒的说明、来自哪台服务器' },
  compact: { name: '简洁', description: '每条提醒一行，不带说明' },
  card: { name: '卡片', description: '加粗标题、分段排版；飞书是带颜色标题栏的卡片', types: ['feishu', 'wecom', 'dingtalk', 'telegram'] },
}

export function templateOf(channel) {
  const template = TEMPLATES[channel?.template] ? channel.template : 'detailed'
  const allowed = TEMPLATES[template].types
  return allowed && !allowed.includes(channel.type) ? 'detailed' : template
}

function isHttpUrl(value) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false }
}

function trimStr(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

/** 规整一个渠道：未知类型 / 缺必填字段返回 null。 */
function normalizeChannel(raw) {
  if (!raw || typeof raw !== 'object') return null
  const type = CHANNEL_TYPES[raw.type] ? raw.type : null
  if (!type) return null
  const channel = {
    // 先判类型：test(undefined) 会把 'undefined' 当字符串匹配上
    id: typeof raw.id === 'string' && /^[a-z0-9]{6,32}$/.test(raw.id) ? raw.id : randomBytes(6).toString('hex'),
    type,
    name: trimStr(raw.name).slice(0, 40) || CHANNEL_TYPES[type].name,
    enabled: raw.enabled !== false,
  }
  if (TEMPLATES[raw.template] && raw.template !== 'detailed') channel.template = raw.template
  for (const field of CHANNEL_TYPES[type].fields) {
    const value = trimStr(raw[field.key])
    if (!value || (field.options && !field.options.some(option => option.value === value))) continue
    channel[field.key] = value.slice(0, field.multiline ? 4000 : 1000)
  }
  return channel
}

/** 校验必填项与地址格式，返回错误信息或 ''。 */
function validateChannel(channel) {
  for (const field of CHANNEL_TYPES[channel.type].fields) {
    if (field.required && !channel[field.key]) return `请填写「${field.label}」`
  }
  for (const key of ['url', 'apiBase']) {
    if (channel[key] && !isHttpUrl(channel[key])) return '地址要以 http:// 或 https:// 开头'
  }
  if (channel.agentId && !/^\d+$/.test(channel.agentId)) return 'AgentId 是一串数字，如 1000002'
  if (channel.type === 'custom') return validateCustom(channel)
  return ''
}

// ---- 自定义接口：占位符、请求头、成功条件 ----

const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g
const PLACEHOLDERS = ['title', 'content', 'markdown', 'token']

const CUSTOM_CONTENT_TYPES = {
  json: 'application/json;charset=UTF-8',
  form: 'application/x-www-form-urlencoded;charset=UTF-8',
  text: 'text/plain;charset=UTF-8',
}

function fillPlaceholders(template, values, encode = value => value) {
  return template.replace(PLACEHOLDER, (all, name) => Object.hasOwn(values, name) ? encode(values[name]) : all)
}

/** 只替换 JSON 里的字符串值，再整体序列化：标题里的引号、换行不会弄坏 JSON。 */
function fillJson(node, values) {
  if (typeof node === 'string') return fillPlaceholders(node, values)
  if (Array.isArray(node)) return node.map(item => fillJson(item, values))
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, fillJson(value, values)]))
  return node
}

/** 「名称: 值」一行一个，返回 [[名称, 值]]；写错的行抛错，说明是第几行。 */
function parseHeaders(text = '') {
  const headers = []
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return
    const at = line.indexOf(':')
    const name = at > 0 ? line.slice(0, at).trim() : ''
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new Error(`请求头第 ${index + 1} 行要写成「名称: 值」`)
    headers.push([name, line.slice(at + 1).trim()])
  })
  return headers
}

// 请求头里只能放 ASCII：中文标题、换行按 RFC 2047 编码（ntfy 等认这种写法），否则 fetch 直接报错
const headerValue = value => /[^\x20-\x7e\t]/.test(value) ? `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=` : value

/** 名称不分大小写：用户写的 content-type 要顶掉默认的 Content-Type，而不是并成两个值。 */
function setHeader(headers, name, value) {
  for (const key of Object.keys(headers)) if (key.toLowerCase() === name.toLowerCase()) delete headers[key]
  headers[name] = value
}

/** 「code=200」→ { path: 'code', expected: '200' }；写错或没填返回 null。 */
function parseSuccess(rule = '') {
  const match = /^([\w.-]+)\s*={1,2}\s*(.+)$/.exec(rule)
  return match ? { path: match[1], expected: match[2].trim().replace(/^(["'])(.*)\1$/, '$2') } : null
}

function validateCustom(channel) {
  let usesToken = false
  for (const key of ['url', 'body', 'headers']) {
    for (const [, name] of (channel[key] || '').matchAll(PLACEHOLDER)) {
      if (!PLACEHOLDERS.includes(name)) return `不认识的占位符 {{${name}}}，能用的有 ${PLACEHOLDERS.map(n => `{{${n}}}`).join(' ')}`
      if (name === 'token') usesToken = true
    }
  }
  // 套了示例忘填密钥最常见：不拦的话要等对方平台回一句含糊的「token 无效」
  if (usesToken && !channel.token) return '模板里用了 {{token}}，请填写「密钥 / Token」'
  if (channel.method === 'GET' && channel.body) return 'GET 请求不带请求体：把内容写进请求地址（如 ?title={{title}}），或改用 POST'
  if (channel.body && (channel.bodyType || 'json') === 'json') {
    try { JSON.parse(channel.body) } catch { return '请求体不是合法的 JSON：占位符要写在引号里，如 "title": "{{title}}"' }
  }
  try { parseHeaders(channel.headers) } catch (error) { return error.message }
  if (channel.success && !parseSuccess(channel.success)) return '成功条件要写成「字段=值」，如 code=200'
  return ''
}

// ---- 各家的消息格式 ----

function hmacBase64(key, data) {
  return createHmac('sha256', key).update(data).digest('base64')
}

function clip(text) {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text
}

/** 按 UTF-8 字节截断（不切开多字节字符），截了补「…」（3 字节）。 */
function clipBytes(text, max) {
  if (Buffer.byteLength(text) <= max) return text
  let bytes = 3
  let out = ''
  for (const char of text) {
    bytes += Buffer.byteLength(char)
    if (bytes > max) break
    out += char
  }
  return `${out}…`
}

const icon = alert => alert.level === 'error' ? '❗' : '⚠️'

/** 标题：一条就用它的标题，多条说条数。 */
export function messageTitle(message) {
  if (message.test) return '【iPTV】测试消息'
  const { raised = [], resolved = [] } = message
  if (raised.length) return `【iPTV】${raised.length === 1 ? raised[0].title : `${raised.length} 条新提醒`}`
  return `【iPTV】${resolved.length === 1 ? `已恢复：${resolved[0].title}` : `${resolved.length} 条提醒已恢复`}`
}

const testText = message => `收到这条说明「${message.channelName || '推送渠道'}」配置正确。以后登录凭证失效、模块连续抓取失败等需要处理的事会发到这里。`

/** 纯文本正文（详细 / 简洁）。 */
export function plainText(message, template = 'detailed') {
  const footer = message.host ? `\n\n来自 ${message.host}` : ''
  if (message.test) return clip(testText(message) + footer)
  const { raised = [], resolved = [] } = message
  const lines = template === 'compact'
    ? [...raised.map(a => `${icon(a)} ${a.title}`), ...resolved.map(a => `✅ 已恢复：${a.title}`)].join('\n')
    : [...raised.map(a => `${icon(a)} ${a.title}\n${a.text}`), ...resolved.map(a => `✅ 已恢复：${a.title}`)].join('\n\n')
  return clip(lines + footer)
}

/** 自定义接口 {{markdown}} 的正文：段与段之间空一行（Markdown 里单个换行会并成一行）。 */
function markdownText(message, template = 'detailed') {
  const footer = message.host ? `\n\n> 来自 ${message.host}` : ''
  if (message.test) return clip(testText(message) + footer)
  const { raised = [], resolved = [] } = message
  const blocks = [
    ...raised.map(a => `**${icon(a)} ${a.title}**${template !== 'compact' && a.text ? `\n\n${a.text}` : ''}`),
    ...resolved.map(a => `**✅ 已恢复：${a.title}**`),
  ]
  return clip(blocks.join('\n\n') + footer)
}

const escapeHtml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** 卡片样式各家的正文。flavor：feishu（卡片 markdown）/ wecom / dingtalk（Markdown）/ telegram（HTML）。 */
function richBody(message, flavor) {
  const bold = text => flavor === 'telegram' ? `<b>${escapeHtml(text)}</b>` : `**${text}**`
  const plain = text => flavor === 'telegram' ? escapeHtml(text) : text
  const blocks = message.test
    ? [plain(testText(message))]
    : [
        ...(message.raised || []).map(a => `${bold(`${icon(a)} ${a.title}`)}\n${plain(a.text)}`),
        ...(message.resolved || []).map(a => bold(`✅ 已恢复：${a.title}`)),
      ]
  return clip(blocks.join('\n\n'))
}

function footerLine(message, flavor) {
  if (!message.host) return ''
  if (flavor === 'telegram') return `\n\n<i>来自 ${escapeHtml(message.host)}</i>`
  if (flavor === 'wecom') return `\n\n<font color="comment">来自 ${message.host}</font>`
  return `\n\n> 来自 ${message.host}`
}

/** 飞书卡片标题栏颜色：有错误红、只有警告橙、只有恢复 / 测试绿。 */
function headerColor(message) {
  const raised = message.raised || []
  if (raised.some(a => a.level === 'error')) return 'red'
  if (raised.length) return 'orange'
  return 'green'
}

function feishuBody(message, template) {
  const title = messageTitle(message)
  if (template !== 'card') return { msg_type: 'text', content: { text: `${title}\n${plainText(message, template)}` } }
  const elements = [{ tag: 'markdown', content: richBody(message, 'feishu') }]
  if (message.host) elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `来自 ${message.host}` }] })
  return {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: { template: headerColor(message), title: { tag: 'plain_text', content: title } },
      elements,
    },
  }
}

const wecomBase = channel => (channel.apiBase || 'https://qyapi.weixin.qq.com').replace(/\/+$/, '')
// 「ZhangSan | LiSi」里的空格会被当成账号的一部分，那几个人就收不到
const wecomToUser = channel => (channel.toUser || '').split('|').map(s => s.trim()).filter(Boolean).join('|') || '@all'
// 应用消息 text.content 最长 2048 字节（UTF-8，一个汉字 3 字节）；clip 按字符数截，多条提醒合在一起会超
const WECOM_APP_MAX_BYTES = 2048

/** 组一个请求：{ url, body }。纯函数，测试直接看它。企业微信应用要先换好 accessToken 传进来。 */
export function buildRequest(channel, message, now = Date.now(), accessToken = '') {
  const template = templateOf(channel)
  const title = messageTitle(message)
  const full = `${title}\n${plainText(message, template)}`
  switch (channel.type) {
    case 'wecom':
      return template === 'card'
        ? { url: channel.url, body: { msgtype: 'markdown', markdown: { content: `**${title}**\n\n${richBody(message, 'wecom')}${footerLine(message, 'wecom')}` } } }
        : { url: channel.url, body: { msgtype: 'text', text: { content: full } } }
    case 'wecomApp':
      return {
        url: `${wecomBase(channel)}/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`,
        body: { touser: wecomToUser(channel), msgtype: 'text', agentid: Number(channel.agentId), text: { content: clipBytes(full, WECOM_APP_MAX_BYTES) } },
      }
    case 'feishu': {
      const body = feishuBody(message, template)
      if (channel.secret) {
        // 飞书：以「时间戳\n密钥」为 HMAC key、对空串签名
        const timestamp = String(Math.floor(now / 1000))
        Object.assign(body, { timestamp, sign: hmacBase64(`${timestamp}\n${channel.secret}`, '') })
      }
      return { url: channel.url, body }
    }
    case 'dingtalk': {
      let url = channel.url
      if (channel.secret) {
        // 钉钉：以密钥为 HMAC key、对「时间戳(毫秒)\n密钥」签名，签名放查询参数
        const timestamp = String(now)
        const sign = encodeURIComponent(hmacBase64(channel.secret, `${timestamp}\n${channel.secret}`))
        url += `${url.includes('?') ? '&' : '?'}timestamp=${timestamp}&sign=${sign}`
      }
      return template === 'card'
        ? { url, body: { msgtype: 'markdown', markdown: { title, text: `### ${title}\n\n${richBody(message, 'dingtalk')}${footerLine(message, 'dingtalk')}` } } }
        : { url, body: { msgtype: 'text', text: { content: full } } }
    }
    case 'telegram': {
      const base = (channel.apiBase || 'https://api.telegram.org').replace(/\/+$/, '')
      const body = template === 'card'
        ? { chat_id: channel.chatId, parse_mode: 'HTML', text: `<b>${escapeHtml(title)}</b>\n\n${richBody(message, 'telegram')}${footerLine(message, 'telegram')}` }
        : { chat_id: channel.chatId, text: full }
      return { url: `${base}/bot${channel.botToken}/sendMessage`, body: { ...body, disable_web_page_preview: true } }
    }
    case 'bark':
      return { url: channel.url, body: { title, body: plainText(message, template), group: 'iPTV' } }
    case 'custom': {
      // 返回的 body 是排好的字符串（JSON / 表单 / 纯文本），sendToChannel 原样发出
      const values = { title, content: plainText(message, template), markdown: markdownText(message, template), token: channel.token || '' }
      const method = channel.method === 'GET' ? 'GET' : 'POST'
      const headers = {}
      let body
      if (method === 'POST' && channel.body) {
        const bodyType = CUSTOM_CONTENT_TYPES[channel.bodyType] ? channel.bodyType : 'json'
        headers['Content-Type'] = CUSTOM_CONTENT_TYPES[bodyType]
        if (bodyType === 'json') body = JSON.stringify(fillJson(JSON.parse(channel.body), values))
        else if (bodyType === 'form') body = new URLSearchParams([...new URLSearchParams(channel.body)].map(([key, value]) => [key, fillPlaceholders(value, values)])).toString()
        else body = fillPlaceholders(channel.body, values)
      }
      for (const [name, value] of parseHeaders(channel.headers)) setHeader(headers, name, headerValue(fillPlaceholders(value, values)))
      return { url: fillPlaceholders(channel.url, values, encodeURIComponent), method, headers, body }
    }
    case 'webhook':
    default:
      return {
        url: channel.url,
        body: {
          title, text: plainText(message, template),
          raised: (message.raised || []).map(({ id, level, title: t, text }) => ({ id, level, title: t, text })),
          resolved: (message.resolved || []).map(({ id, title: t }) => ({ id, title: t })),
          test: !!message.test,
          sentAt: new Date(now).toISOString(),
        },
      }
  }
}

// 企业微信应用最常见的几个配置错误：原样的 errmsg 是英文，还看不出该改哪一项
const WECOM_APP_HINTS = {
  40001: 'Secret 不对，要填这个应用自己的 Secret',
  40013: '企业 ID 不对',
  40056: 'AgentId 不对',
  60020: '服务器 IP 不在这个应用的「企业可信IP」里',
  81013: '接收人都不在这个应用的可见范围里，要填成员账号而不是名字',
}

function wecomAppError({ errcode, errmsg = '' }) {
  const hint = WECOM_APP_HINTS[errcode]
  if (!hint) return `${errcode} ${errmsg}`.trim()
  const ip = errcode === 60020 && /from ip: ?([\da-f.:]+)/i.exec(errmsg)?.[1]
  return `${errcode} ${hint}${ip ? `（本机出口 IP ${ip}）` : ''}`
}

/** 各家「HTTP 200 但其实失败」的判断，返回错误信息或 ''。 */
function responseError(type, status, payload) {
  if (status < 200 || status >= 300) {
    const detail = payload?.description || payload?.errmsg || payload?.msg || payload?.message || ''
    return `HTTP ${status}${detail ? `：${detail}` : ''}`
  }
  if (!payload || typeof payload !== 'object') return ''
  if (type === 'wecomApp') return payload.errcode ? wecomAppError(payload) : ''
  if (type === 'wecom' || type === 'dingtalk') return payload.errcode ? `${payload.errcode} ${payload.errmsg || ''}`.trim() : ''
  if (type === 'feishu') {
    const code = payload.code ?? payload.StatusCode
    return code ? `${code} ${payload.msg || payload.StatusMessage || ''}`.trim() : ''
  }
  if (type === 'telegram') return payload.ok === false ? (payload.description || '发送失败') : ''
  if (type === 'bark') return payload.code && payload.code !== 200 ? (payload.message || `code ${payload.code}`) : ''
  return ''
}

/** 自定义接口：先看 HTTP 状态码；填了成功条件再看返回 JSON 里的那个字段。 */
function customError(channel, status, payload, text) {
  const httpError = responseError('custom', status, payload)
  const rule = parseSuccess(channel.success)
  if (httpError || !rule) return httpError
  if (!payload || typeof payload !== 'object') {
    const snippet = trimStr(text).slice(0, 80)
    return `返回的不是 JSON，判断不了「${channel.success}」${snippet ? `：${snippet}` : ''}`
  }
  const actual = rule.path.split('.').reduce((node, key) => node && typeof node === 'object' ? node[key] : undefined, payload)
  if (String(actual) === rule.expected) return ''
  const detail = [payload.msg, payload.message, payload.errmsg, payload.description, payload.error].find(value => typeof value === 'string' && value)
  const got = actual === undefined ? `返回里没有 ${rule.path}` : `返回 ${rule.path}=${typeof actual === 'object' ? JSON.stringify(actual) : actual}`
  return `${got}，不是 ${rule.expected}${detail ? `：${detail}` : ''}`
}

/** 错误信息里别带出机器人地址 / Token（日志和后台都会显示它）。 */
function scrub(message, channel) {
  let out = String(message || '')
  for (const field of CHANNEL_TYPES[channel.type]?.fields || []) {
    if (field.secret && channel[field.key]) out = out.split(channel[field.key]).join(MASK)
  }
  // 企业微信应用换来的 access_token 不在配置里，按参数名打码
  out = out.replace(/(access_token|corpsecret)=[^&\s]+/g, `$1=${MASK}`)
  return out.slice(0, 200)
}

/**
 * 企业微信应用：先用企业 ID + Secret 换 access_token，再带着它发应用消息。token 有效 2 小时，
 * 企业微信要求缓存、频繁换会被限频，所以按「API 地址 + 企业 ID + Secret」记在内存里，提前 5 分钟换新。
 */
const wecomTokens = new Map()
const WECOM_TOKEN_INVALID = new Set([40014, 42001])   // token 不合法 / 已过期（重置了 Secret 等）

async function wecomAccessToken(channel, call, now, fresh) {
  const base = wecomBase(channel)
  const key = `${base}\n${channel.corpId}\n${channel.secret}`
  const cached = wecomTokens.get(key)
  if (!fresh && cached && cached.expiresAt > now) return { token: cached.token }
  wecomTokens.delete(key)
  const { status, payload } = await call(`${base}/cgi-bin/gettoken?corpid=${encodeURIComponent(channel.corpId)}&corpsecret=${encodeURIComponent(channel.secret)}`)
  const error = responseError('wecomApp', status, payload) || (payload?.access_token ? '' : '没换到 access_token')
  if (error) return { error }
  wecomTokens.set(key, { token: payload.access_token, expiresAt: now + ((Number(payload.expires_in) || 7200) - 300) * 1000 })
  return { token: payload.access_token }
}

/** 发出去，返回错误信息或 ''。call(url, body) 发一个请求，没有 body 时是 GET。 */
async function deliver(channel, message, call, now) {
  if (channel.type === 'custom') {
    const { url, method, headers, body } = buildRequest(channel, message, now)
    const { status, payload, text } = await call(url, body, { method, headers })
    return customError(channel, status, payload, text)
  }
  if (channel.type !== 'wecomApp') {
    const { url, body } = buildRequest(channel, message, now)
    const { status, payload } = await call(url, body)
    return responseError(channel.type, status, payload)
  }
  // 缓存的 token 被提前作废时换一次新的重发
  for (const fresh of [false, true]) {
    const { token, error } = await wecomAccessToken(channel, call, now, fresh)
    if (error) return error
    const { url, body } = buildRequest(channel, message, now, token)
    const { status, payload } = await call(url, body)
    if (!fresh && WECOM_TOKEN_INVALID.has(payload?.errcode)) continue
    return responseError(channel.type, status, payload)
  }
}

export async function sendToChannel(channel, message, { fetchImpl = proxyAwareFetch, now = Date.now() } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS)
  // body 是对象时按 JSON 发；字符串（自定义接口排好的）原样发，Content-Type 由 headers 给
  const call = async (url, body, { method, headers: extra = {} } = {}) => {
    const headers = { 'User-Agent': 'iptv-notify' }
    if (body !== undefined && typeof body !== 'string') headers['Content-Type'] = 'application/json;charset=UTF-8'
    for (const [name, value] of Object.entries(extra)) setHeader(headers, name, value)
    const init = { method: method || (body === undefined ? 'GET' : 'POST'), headers, signal: controller.signal }
    if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)
    const res = await fetchImpl(url, init)
    const text = await res.text()
    let payload = null
    try { payload = JSON.parse(text) } catch { /* 有的服务回纯文本 */ }
    return { status: res.status, payload, text }
  }
  try {
    const error = await deliver(channel, message, call, now)
    return error ? { ok: false, message: scrub(error, channel) } : { ok: true, message: '' }
  } catch (error) {
    // undici 只给一句「fetch failed」，真正原因（域名解析失败、连接被拒、超时）在 cause 里
    const cause = error?.cause
    const detail = [cause?.code, cause?.message].filter(Boolean).join(' ')
    const reason = error?.name === 'AbortError'
      ? `${SEND_TIMEOUT_MS / 1000} 秒没有响应`
      : (detail ? `连不上推送服务（${detail}）` : (error?.message || '发送失败'))
    return { ok: false, message: scrub(reason, channel) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 一轮要发的内容（还没排版）：新提醒、已恢复、来自哪台服务器。排版按各渠道的样式在 buildRequest 里做。
 * host 只用来标明是哪台服务器，不带访问密码。title / text 是详细样式的纯文本，方便日志和测试。
 */
export function formatMessage({ raised = [], resolved = [] }, host = '') {
  const message = { raised, resolved, host }
  return { ...message, title: messageTitle(message), text: plainText(message, 'detailed') }
}

/** 后台表单里的样式预览用的示例：一条错误提醒 + 一条已恢复。 */
export function samplePreviews(host = '') {
  const message = {
    host: host || 'http://192.168.1.10:1905',
    raised: [{ level: 'error', title: '央视频登录凭证已失效', text: '央视频登录态已失效（官网没认出关联过的账号），10 个会员频道暂时播不了；请在后台重新登录或导入登录态' }],
    resolved: [{ title: '咪咕登录凭证已失效' }],
  }
  const previews = {}
  for (const template of ['detailed', 'compact']) previews[template] = `${messageTitle(message)}\n${plainText(message, template)}`
  return { message: { ...message, title: messageTitle(message) }, previews }
}

export class Notifier {
  /**
   * @param {object} [opts]
   * @param {string} [opts.channelsPath]
   * @param {string} [opts.statePath]
   * @param {Function} [opts.fetchImpl]
   * @param {() => string} [opts.host]   订阅里的自定义访问地址（config.js 的 host）
   * @param {boolean} [opts.log]
   */
  constructor(opts = {}) {
    this.channelsPath = opts.channelsPath || dataPath(CHANNELS_FILE)
    this.statePath = opts.statePath || dataPath(STATE_FILE)
    this.fetchImpl = opts.fetchImpl || proxyAwareFetch
    this.host = opts.host || (() => '')
    this.log = opts.log !== false
    this.queue = Promise.resolve()
  }

  // ---- 渠道配置 ----

  loadChannels() {
    const raw = readJson(this.channelsPath, { channels: [] })
    return (Array.isArray(raw.channels) ? raw.channels : []).map(normalizeChannel).filter(Boolean)
  }

  #saveChannels(channels) {
    writeJsonFileSync(this.channelsPath, { channels })
  }

  #loadState() {
    const raw = readJson(this.statePath, {})
    return {
      pushed: raw.pushed && typeof raw.pushed === 'object' ? raw.pushed : {},
      results: raw.results && typeof raw.results === 'object' ? raw.results : {},
    }
  }

  #saveState(state) {
    try { writeJsonFileSync(this.statePath, state) } catch (error) { printYellow(`推送记录写盘失败：${error.message}`) }
  }

  /** 给后台的渠道列表：敏感字段打码，带上最近一次发送结果。 */
  publicChannels() {
    const { results } = this.#loadState()
    return this.loadChannels().map(channel => {
      const out = { ...channel, secretsSet: {}, lastResult: results[channel.id] || null }
      for (const field of CHANNEL_TYPES[channel.type].fields) {
        if (!field.secret) continue
        out.secretsSet[field.key] = !!channel[field.key]
        delete out[field.key]
      }
      return out
    })
  }

  addChannel(payload) {
    const channel = normalizeChannel({ ...payload, id: undefined })
    if (!channel) throw new Error('不支持的推送类型')
    const error = validateChannel(channel)
    if (error) throw new Error(error)
    const channels = this.loadChannels()
    channels.push(channel)
    this.#saveChannels(channels)
    return channel.id
  }

  /** 更新：敏感字段留空 = 保持原值。 */
  updateChannel(id, fields = {}) {
    const channels = this.loadChannels()
    const index = channels.findIndex(channel => channel.id === id)
    if (index === -1) throw new Error('推送渠道不存在')
    const current = channels[index]
    const merged = { ...current }
    if (fields.name !== undefined) merged.name = fields.name
    if (fields.enabled !== undefined) merged.enabled = fields.enabled !== false
    if (fields.template !== undefined) merged.template = fields.template
    for (const field of CHANNEL_TYPES[current.type].fields) {
      if (fields[field.key] === undefined) continue
      const value = trimStr(fields[field.key])
      if (field.secret && !value) continue
      merged[field.key] = value
    }
    const channel = normalizeChannel(merged)
    const error = validateChannel(channel)
    if (error) throw new Error(error)
    channels[index] = channel
    this.#saveChannels(channels)
  }

  removeChannel(id) {
    const channels = this.loadChannels()
    const next = channels.filter(channel => channel.id !== id)
    if (next.length === channels.length) throw new Error('推送渠道不存在')
    this.#saveChannels(next)
    const state = this.#loadState()
    delete state.results[id]
    this.#saveState(state)
  }

  async testChannel(id) {
    const channel = this.loadChannels().find(item => item.id === id)
    if (!channel) throw new Error('推送渠道不存在')
    const result = await sendToChannel(channel, { test: true, channelName: channel.name, host: this.host() }, { fetchImpl: this.fetchImpl })
    this.#recordResults({ [channel.id]: result })
    return result
  }

  #recordResults(byChannel) {
    const state = this.#loadState()
    const at = Date.now()
    for (const [id, result] of Object.entries(byChannel)) state.results[id] = { ...result, at }
    this.#saveState(state)
  }

  // ---- 推送 ----

  /** AlertTracker#onEvaluate 的回调。串行执行，避免两轮评估同时发同一条。 */
  handleEvaluation(evaluation) {
    this.queue = this.queue.then(() => this.#handle(evaluation)).catch(error => {
      printRed(`消息推送出错：${error?.message || error}`)
    })
    return this.queue
  }

  async #handle({ alerts = [], activeIds = [], initial = false }) {
    const state = this.#loadState()
    const pushed = state.pushed
    let changed = false

    if (initial) {
      // 升级后第一次运行：已存在的都是老问题，记下不发；它们恢复时也不发
      for (const alert of alerts) {
        if (!pushed[alert.id]) { pushed[alert.id] = { title: alert.title, silent: true }; changed = true }
      }
      if (changed) this.#saveState(state)
      return { sent: false }
    }

    const active = new Set(activeIds)
    const resolved = []
    for (const [id, record] of Object.entries(pushed)) {
      if (active.has(id)) continue
      if (!record.silent) resolved.push({ id, title: record.title })
      delete pushed[id]
      changed = true
    }

    const channels = this.loadChannels().filter(channel => channel.enabled)
    const raised = []
    for (const alert of alerts) {
      if (pushed[alert.id]) continue
      // 在后台点过「知道了」：用户已经知道，不再推；恢复时也不推
      if (alert.dismissed) { pushed[alert.id] = { title: alert.title, silent: true }; changed = true; continue }
      // 模块抓取失败 / 风控 / 官方故障：用户自己处理不了（只能等更新或关模块），只在后台显示，不推
      if (alert.id.startsWith('module-failed:')) continue
      raised.push(alert)
    }

    if (!channels.length || (!raised.length && !resolved.length)) {
      // 没配渠道时不记新提醒（配好后补发），恢复的照常从记录里删掉
      if (changed) this.#saveState(state)
      return { sent: false }
    }

    for (const alert of raised) pushed[alert.id] = { title: alert.title }
    this.#saveState(state)

    const message = formatMessage({ raised, resolved }, this.host())
    const results = {}
    await Promise.all(channels.map(async channel => {
      results[channel.id] = await sendToChannel(channel, message, { fetchImpl: this.fetchImpl })
      if (!this.log) return
      if (results[channel.id].ok) printGreen(`[推送] 已发到「${channel.name}」：${message.title}`)
      else printRed(`[推送] 发到「${channel.name}」失败：${results[channel.id].message}`)
    }))
    this.#recordResults(results)
    return { sent: true, message, results }
  }
}

let singleton = null

export async function getNotifier() {
  if (!singleton) {
    const config = await import("../config.js")
    singleton = new Notifier({ host: () => config.host || '' })
  }
  return singleton
}

// ---- 后台接口 ----

export async function getNotifyAPI() {
  try {
    const notifier = await getNotifier()
    const types = Object.entries(CHANNEL_TYPES).map(([id, type]) => ({
      id, name: type.name, fields: type.fields, help: type.help, presets: type.presets,
      templates: Object.entries(TEMPLATES).filter(([, t]) => !t.types || t.types.includes(id)).map(([key]) => key),
    }))
    const templates = Object.entries(TEMPLATES).map(([id, t]) => ({ id, name: t.name, description: t.description }))
    return { success: true, data: { channels: notifier.publicChannels(), types, templates, sample: samplePreviews(notifier.host()) } }
  } catch (error) {
    return { success: false, message: error.message }
  }
}

export async function postNotifyAPI(data = {}) {
  try {
    const notifier = await getNotifier()
    switch (data.action) {
      case 'add': notifier.addChannel(data.channel || {}); break
      case 'update': notifier.updateChannel(data.id, data.fields || {}); break
      case 'remove': notifier.removeChannel(data.id); break
      case 'test': {
        const result = await notifier.testChannel(data.id)
        const listed = await getNotifyAPI()
        return { success: result.ok, message: result.ok ? '测试消息已发出' : `发送失败：${result.message}`, data: listed.data }
      }
      default: return { success: false, message: '未知操作' }
    }
    return getNotifyAPI()
  } catch (error) {
    return { success: false, message: error.message }
  }
}
