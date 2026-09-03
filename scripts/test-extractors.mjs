#!/usr/bin/env node
/**
 * 抓取模块注册表 + 哔哩哔哩直播模块 测试。
 *
 * 覆盖的不变量：
 *  - 注册表：id 白名单、sourceId 命名空间（它会写进 EXTINF 属性，是注入面）；
 *  - 配置校验：类型/边界/默认值；secret 字段空串=保持原值（否则后台每次保存
 *    都会把用户看不见的凭据抹掉），显式 null 才是清空；
 *  - secret 不回传明文（默认部署下后台是无鉴权的）；
 *  - 环境变量兜底（docker 用户没有别的路子注入凭据）；
 *  - 选流偏好：HLS 优先、AVC 优先，以及地址必须是裸字符串拼接——一旦过
 *    new URL() 就会丢掉 extra 里那段 expires token，地址直接失效；
 *  - 抓取失败时沿用上一轮频道，不让频道静默从播放列表消失；
 *  - 模块默认开启，明确关闭后必须挡住抓取与输出。
 *
 * 运行： node scripts/test-extractors.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { constants, createCipheriv, createDecipheriv, createHash, createHmac, generateKeyPairSync, privateEncrypt } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listModules, getModule, sourceIdOf, resolverFor, validateModule, MODULE_ID_RE } from '../extractors/registry.js'
import { clearUrlCache } from '../utils/appUtils.js'
import { selectFromPlayurl, parseRoomList, normalizeRoom, mapLimit, selectTopRooms, RoomError, BILIBILI_GROUP, DEFAULT_MIN_ONLINE } from '../extractors/bilibili-live/api.js'
import { shouldFailRound, parseAreaNames, mergeRoomRefs, groupBilibiliResults } from '../extractors/bilibili-live/index.js'
import {
  DEFAULT_MIN_HEAT,
  HUYA_GROUP,
  clearResolveCache as clearHuyaResolveCache,
  normalizeRoom as normalizeHuyaRoom,
  parseCategoryRooms as parseHuyaCategoryRooms,
  parseEventRooms as parseHuyaEventRooms,
  parseRoomList as parseHuyaRoomList,
  parseRoomPage as parseHuyaRoomPage,
  resolveRoom as resolveHuyaRoom,
  selectBitrate as selectHuyaBitrate,
  signHlsUrl as signHuyaHlsUrl,
} from '../extractors/huya-live/api.js'
import { mergeRooms as mergeHuyaRooms, parseAreaNames as parseHuyaAreaNames } from '../extractors/huya-live/index.js'
import {
  ANONYMOUS_DID,
  DEFAULT_MIN_HEAT as DEFAULT_DOUYU_MIN_HEAT,
  DOUYU_GROUP,
  clearResolveCache as clearDouyuResolveCache,
  createMobileSign as createDouyuMobileSign,
  isOfficialStreamUrl as isOfficialDouyuStreamUrl,
  normalizeCategoryPayload as normalizeDouyuCategoryPayload,
  normalizeRoom as normalizeDouyuRoom,
  parseMobileRoomPage as parseDouyuMobileRoomPage,
  parseRoomList as parseDouyuRoomList,
  resolveRoom as resolveDouyuRoom,
} from '../extractors/douyu-live/api.js'
import { mergeRooms as mergeDouyuRooms, parseAreaNames as parseDouyuAreaNames } from '../extractors/douyu-live/index.js'
import {
  buildChannelGroups as buildGxtvGroups,
  clearStreamCache as clearGxtvStreamCache,
  resolveChannel as resolveGxtvChannel,
  streamUrlOf,
} from '../extractors/gxtv/api.js'
import {
  buildChannelGroups as buildFjtvGroups,
  clearXiamenCache,
  fetchFuzhouChannels,
  fetchXiamenChannels,
  FUZHOU_CHANNELS,
  hlsOf as fjtvHlsOf,
  resolveXiamenChannel,
  XIAMEN_CHANNELS,
} from '../extractors/fjtv/api.js'
import { mergeFuzhouChannels, mergeXiamenChannels } from '../extractors/fjtv/index.js'
import {
  buildChannels as buildCztvChannels,
  clearPlayInfoCache as clearCztvPlayInfoCache,
  resolveChannel as resolveCztvChannel,
  selectStream as selectCztvStream,
  signStreamUrl as signCztvStreamUrl,
} from '../extractors/cztv/api.js'
import {
  buildAuthRequest as buildJstvAuthRequest,
  buildChannels as buildJstvChannels,
  clearCache as clearJstvCache,
  resolveChannel as resolveJstvChannel,
  signStreamUrl as signJstvStreamUrl,
} from '../extractors/jstv/api.js'
import {
  buildExchangeRequest as buildIqiluExchangeRequest,
  clearCache as clearIqiluCache,
  decryptExchangeResponse as decryptIqiluExchangeResponse,
  parseChannelPage as parseIqiluChannelPage,
  resolveChannel as resolveIqiluChannel,
} from '../extractors/iqilu/api.js'
import {
  buildChannels as buildHnntvChannels,
  clearCache as clearHnntvCache,
  resolveChannel as resolveHnntvChannel,
} from '../extractors/hnntv/api.js'
import {
  buildChannels as buildHntvChannels,
  buildSignedHeaders as buildHntvSignedHeaders,
  clearCache as clearHntvCache,
  resolveChannel as resolveHntvChannel,
} from '../extractors/hntv/api.js'
import {
  buildChannels as buildHebtvChannels,
  clearCache as clearHebtvCache,
  normalizeRows as normalizeHebtvRows,
  normalizeScenicArticles as normalizeHebtvScenicArticles,
  normalizeScenicDetail as normalizeHebtvScenicDetail,
  resolveChannel as resolveHebtvChannel,
  signStreamUrl as signHebtvStreamUrl,
} from '../extractors/hebtv/api.js'
import {
  buildChannels as buildKankanewsChannels,
  buildScenicChannels as buildKankanewsScenicChannels,
  buildSignedHeaders as buildKankanewsSignedHeaders,
  clearCache as clearKankanewsCache,
  decryptLiveAddress as decryptKankanewsLiveAddress,
  resolveChannel as resolveKankanewsChannel,
} from '../extractors/kankanews/api.js'
import {
  buildChannels as buildMgtvChannels,
  buildSourceRequest as buildMgtvSourceRequest,
  clearCache as clearMgtvCache,
  resolveChannel as resolveMgtvChannel,
  selectHighestSource as selectMgtvSource,
} from '../extractors/mgtv/api.js'
import {
  buildCatalogAuth as buildSztvCatalogAuth,
  buildChannels as buildSztvChannels,
  buildLiveKeyRequest as buildSztvLiveKeyRequest,
  clearCache as clearSztvCache,
  decodeLiveKey as decodeSztvLiveKey,
  resolveChannel as resolveSztvChannel,
  signStreamUrl as signSztvStreamUrl,
} from '../extractors/sztv/api.js'
import { shouldFailRound as miguShouldFailRound } from '../extractors/migu/index.js'
import {
  ExtractorManager, validateConfig, redactConfig, resolveConfig, normalizeGroups, emptyHealth,
} from '../utils/extractorManager.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }

const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('抓取模块注册表测试')

const bili = getModule('bilibili-live')
const huya = getModule('huya-live')
const douyu = getModule('douyu-live')

// ---- 注册表 ----

check('注册表枚举出模块，且每个 id 都过白名单', () => {
  const modules = listModules()
  assert.ok(modules.length >= 1)
  for (const module of modules) {
    assert.ok(MODULE_ID_RE.test(module.id), `${module.id} 不合法`)
    assert.equal(typeof module.fetch, 'function')
  }
})

check('sourceId 用 xt: 命名空间，与外部源 ext: / 内置源 bi: 不撞', () => {
  assert.equal(sourceIdOf('bilibili-live'), 'xt:bilibili-live')
  // app.js 的 sourceId 白名单正则要求这个形状
  assert.ok(/^xt:[\w.-]{1,64}$/.test(sourceIdOf('bilibili-live')))
})

check('虎牙模块已注册，且只认自己的单段播放引用', () => {
  assert.equal(huya?.id, 'huya-live')
  assert.equal(resolverFor('huya-660101')?.id, 'huya-live')
  assert.equal(resolverFor('huya-lpl')?.id, 'huya-live')
  assert.equal(resolverFor('huya-660101/extra'), null)
})

check('斗鱼模块已注册，且只认自己的数字播放引用', () => {
  assert.equal(douyu?.id, 'douyu-live')
  assert.equal(resolverFor('douyu-9999')?.id, 'douyu-live')
  assert.equal(resolverFor('douyu-room')?.id, undefined)
  assert.equal(resolverFor('douyu-9999/extra'), null)
})

check('id 白名单挡住会破坏 EXTINF 属性的字符', () => {
  for (const bad of ['A-Upper', '带中文', 'has space', 'quote"inside', '-leading', '']) {
    assert.equal(MODULE_ID_RE.test(bad), false, `${bad} 不该通过`)
  }
})

// ---- 配置校验 ----

check('int 字段：边界外拒绝并回退，不落坏值', () => {
  const bad = validateConfig(bili, { cachingMs: 999999 }, { cachingMs: 3000 })
  assert.equal(bad.ok, false)
  assert.equal(bad.config.cachingMs, 3000, '越界时保持原值')
  assert.match(bad.errors[0].message, /不能大于/)

  const good = validateConfig(bili, { cachingMs: '5000' }, {})
  assert.equal(good.ok, true)
  assert.equal(good.config.cachingMs, 5000, '字符串数字要被转成数字')
})

check('职责分离：validateConfig 只产出要落盘的，默认值由 resolveConfig 补', () => {
  // 未提交的字段：已存的保留，没存过的不写（稀疏）
  assert.equal(validateConfig(bili, {}, { cachingMs: 1234 }).config.cachingMs, 1234)
  assert.deepEqual(validateConfig(bili, {}, {}).config, {}, '空提交 + 空存储 = 什么都不落盘')

  // 默认值在取值层，不在存储层
  const effective = resolveConfig(bili, {})
  assert.equal(effective.cachingMs, 3000)
  assert.equal(effective.preferHls, true)
  assert.equal(resolveConfig(bili, { cachingMs: 1234 }).cachingMs, 1234, '已存值压过默认')
})

check('secret 字段：空串 = 保持原值（后台看不见它，不能因保存而抹掉）', () => {
  const { config } = validateConfig(bili, { sessdata: '' }, { sessdata: 'SECRET' })
  assert.equal(config.sessdata, 'SECRET')
})

check('secret 字段：显式 null 才是清空，且清空后回落到 env', () => {
  // 稀疏存储下「清空」= 键不存在，而不是存一个空串。语义相同，但表达方式让
  // resolveConfig 能正确回落到 env / 默认——存空串是做不到的。
  const { config } = validateConfig(bili, { sessdata: null }, { sessdata: 'SECRET' })
  assert.equal('sessdata' in config, false)

  const saved = process.env.mbiliSessdata
  try {
    process.env.mbiliSessdata = 'FROM_ENV'
    assert.equal(resolveConfig(bili, config).sessdata, 'FROM_ENV', '清空后该由 env 接手')
  } finally {
    if (saved === undefined) delete process.env.mbiliSessdata
    else process.env.mbiliSessdata = saved
  }
})

check('未知字段被丢弃，不会混进配置', () => {
  const { config } = validateConfig(bili, { 一个不存在的字段: 'x', rooms: '13' }, {})
  assert.equal('一个不存在的字段' in config, false)
  assert.equal(config.rooms, '13')
})

check('redactConfig 不回传 secret 明文，只回传有没有值', () => {
  const { config, secretsSet } = redactConfig(bili, { sessdata: 'SECRET', rooms: '13' })
  assert.equal(config.sessdata, '', '绝不能把凭据回传给前端')
  assert.equal(secretsSet.sessdata, true)
  assert.equal(config.rooms, '13', '非 secret 字段照常回传')

  const empty = redactConfig(bili, { sessdata: '' })
  assert.equal(empty.secretsSet.sessdata, false)
})

check('取值分层：已存 → 环境变量 → schema 默认', () => {
  const key = 'mbiliSessdata'
  const saved = process.env[key]
  try {
    process.env[key] = 'FROM_ENV'
    assert.equal(resolveConfig(bili, {}).sessdata, 'FROM_ENV', '没配过 → 用 env')
    assert.equal(resolveConfig(bili, { sessdata: 'FROM_UI' }).sessdata, 'FROM_UI', '配过 → 已存值优先')
    delete process.env[key]
    assert.equal(resolveConfig(bili, {}).sessdata, '', '都没有 → schema 默认')
  } finally {
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
  }
})

check('稀疏存储：显式设成 false 的布尔字段能压过 env（原先做不到）', () => {
  // 原实现存的是补齐默认值后的全量 key，default:true 的布尔恒为真值 → 直接跳过 env，
  // env 永远读不到；而 default:false 的会被赋成字符串 "false"（真值），
  // 「显式关掉」反而变成「强制打开」。稀疏存储让「没配过」成为明确状态才解开这一条。
  const schema = [{ key: 'flag', type: 'boolean', env: 'mTestFlag', default: true, label: '开关' }]
  const mod = { id: 'probe', configSchema: schema }
  const saved = process.env.mTestFlag
  try {
    process.env.mTestFlag = 'false'
    assert.equal(resolveConfig(mod, {}).flag, false, '没配过 → env 说关就关')
    assert.equal(resolveConfig(mod, { flag: true }).flag, true, '配过 true → 压过 env')
    process.env.mTestFlag = 'true'
    assert.equal(resolveConfig(mod, { flag: false }).flag, false, '配过 false → 同样压过 env')
  } finally {
    if (saved === undefined) delete process.env.mTestFlag
    else process.env.mTestFlag = saved
  }
})

check('稀疏存储：只落盘用户显式设过的字段', () => {
  const { config } = validateConfig(bili, { rooms: '13' }, {})
  assert.deepEqual(Object.keys(config), ['rooms'], '没提交的字段不该被补进存储')
  const again = validateConfig(bili, { preferHls: false }, config)
  assert.deepEqual(Object.keys(again.config).sort(), ['preferHls', 'rooms'], '已存的保留，新提交的加入')
  assert.equal(again.config.preferHls, false, 'false 也算「配过」')
})

check('清空 = 回到「没配过」，而不是存一个空值', () => {
  const stored = { rooms: '13', sessdata: 'SECRET' }
  const cleared = validateConfig(bili, { rooms: '' }, stored)
  assert.equal('rooms' in cleared.config, false, '文本清空后不该留在存储里')
  assert.equal(cleared.config.sessdata, 'SECRET', '没提交的 secret 保持不变')
  const wiped = validateConfig(bili, { sessdata: null }, stored)
  assert.equal('sessdata' in wiped.config, false, 'secret 显式 null 才清空')
})

check('保存别的字段不会顺手把 secret 写成空串（稀疏存储的直接收益）', () => {
  // 原先 validateConfig 对每个 key 都建自有属性，存过一次配置后磁盘上全是自有属性，
  // 于是「用户配过没有」无从判断，env 兜底也就没法按 key 存在与否来做。
  const { config } = validateConfig(bili, { rooms: '13' }, {})
  assert.equal('sessdata' in config, false, '没提交的 secret 不该被补成空串落盘')
})

check('select 字段：只接受 options 里的值，且保留声明的原始类型', () => {
  const mod = { id: 'probe', configSchema: [{
    key: 'rate', type: 'select', label: '画质',
    options: [{ value: 3, label: '高清' }, { value: 9, label: '4K' }], default: 3,
  }] }
  assert.equal(validateConfig(mod, { rate: '9' }, {}).config.rate, 9, '下拉提交的字符串要还原成数字')
  const bad = validateConfig(mod, { rate: '5' }, {})
  assert.equal(bad.ok, false)
  assert.match(bad.errors[0].message, /不是可选值/)
})

check('multiselect 字段：兼容换行字符串，只接受 options 且至少选一项', () => {
  const mod = { id: 'probe', configSchema: [{
    key: 'areas', type: 'multiselect', label: '分区',
    options: [{ value: '赛事' }, { value: '知识' }, { value: '生活' }],
  }] }
  assert.equal(validateConfig(mod, { areas: '赛事\n知识\n赛事' }, {}).config.areas, '赛事\n知识', '应去重并保持提交顺序')
  assert.equal(validateConfig(mod, { areas: ['生活', '赛事'] }, {}).config.areas, '生活\n赛事', '也兼容数组输入')
  assert.equal(validateConfig(mod, { areas: '' }, {}).ok, false, '不能保存空选择')
  assert.equal(validateConfig(mod, { areas: '赛事\n不存在' }, {}).ok, false, '不能保存无效选项')
  const bad = validateConfig(mod, { areas: '' }, { areas: '知识' })
  assert.equal(bad.config.areas, '知识', '校验失败时保留原配置')
})

check('select / multiselect 没有 options 会在启动期被拒绝', () => {
  const withField = (field) => ({ id: 'probe', name: 'probe', fetch: async () => ({}), configSchema: [field] })
  assert.throws(() => validateModule(withField({ key: 'x', type: 'select', label: 'x' })), /没有 options/)
  assert.throws(() => validateModule(withField({ key: 'x', type: 'multiselect', label: 'x' })), /没有 options/)
  validateModule(withField({ key: 'x', type: 'select', label: 'x', options: [{ value: 1, label: 'a' }] }))
  validateModule(withField({ key: 'x', type: 'multiselect', label: 'x', options: [{ value: 1, label: 'a' }] }))
})

check('normalizeGroups 挡住畸形返回，不让一个坏模块搞崩整轮合并', () => {
  assert.deepEqual(normalizeGroups(null), [])
  assert.deepEqual(normalizeGroups('nope'), [])
  assert.deepEqual(normalizeGroups([{ name: '', dataList: [] }]), [])
  assert.deepEqual(normalizeGroups([{ name: 'A', dataList: 'nope' }]), [])
  assert.deepEqual(
    normalizeGroups([{ name: 'A', dataList: [{ name: 'x' }, null, 'bad'] }]),
    [{ name: 'A', dataList: [{ name: 'x' }] }],
  )
})

// ---- 选流 ----

const playurl = (streams) => ({ playurl_info: { playurl: { stream: streams } } })
const codecOf = (name, base, host, extra) => ({
  codec_name: name, base_url: base, current_qn: 10000,
  url_info: [{ host, extra }],
})

check('选流：HLS 优先于 FLV，即便 FLV 排在前面', () => {
  const data = playurl([
    { protocol_name: 'http_stream', format: [{ codec: [codecOf('avc', '/flv', 'https://f', '?t=1')] }] },
    { protocol_name: 'http_hls', format: [{ codec: [codecOf('avc', '/hls', 'https://h', '?t=2')] }] },
  ])
  assert.equal(selectFromPlayurl(data, { preferHls: true }).url, 'https://h/hls?t=2')
  assert.equal(selectFromPlayurl(data, { preferHls: false }).url, 'https://f/flv?t=1')
})

check('选流：AVC 优先于 HEVC（老盒子解不了 HEVC），可反转', () => {
  const data = playurl([
    { protocol_name: 'http_hls', format: [{ codec: [
      codecOf('hevc', '/h265', 'https://a', ''),
      codecOf('avc', '/h264', 'https://a', ''),
    ] }] },
  ])
  assert.equal(selectFromPlayurl(data, {}).url, 'https://a/h264')
  assert.equal(selectFromPlayurl(data, { preferAvc: false }).url, 'https://a/h265')
})

check('选流：地址是裸字符串拼接，expires token 原样保留', () => {
  const extra = '?expires=1787000000&len=0&oi=123&pt=web&sign=abc&trid=xyz'
  const data = playurl([
    { protocol_name: 'http_hls', format: [{ codec: [
      codecOf('avc', '/live-bvc/1/live_1_2.m3u8', 'https://cn-gotcha104.bilivideo.com', extra),
    ] }] },
  ])
  const { url, qn } = selectFromPlayurl(data, {})
  assert.equal(url, `https://cn-gotcha104.bilivideo.com/live-bvc/1/live_1_2.m3u8${extra}`)
  assert.ok(url.includes('sign=abc'), '签名不能在拼接中丢失')
  assert.equal(qn, 10000)
})

check('选流：没有 stream 时报「未开播或地区限制」而不是崩', () => {
  assert.throws(() => selectFromPlayurl(playurl([]), {}), RoomError)
  assert.throws(() => selectFromPlayurl({}, {}), RoomError)
})

check('选流：有 stream 但没有可用 host/base 时报明确错误', () => {
  const data = playurl([{ protocol_name: 'http_hls', format: [{ codec: [
    { codec_name: 'avc', base_url: '', url_info: [{ host: '', extra: '' }] },
  ] }] }])
  assert.throws(() => selectFromPlayurl(data, {}), /没有可用的 host/)
})

// ---- 房间清单解析 ----

check('房间清单：注释行、行尾注释、空行都被正确处理', () => {
  assert.deepEqual(parseRoomList([
    '# 整行注释',
    '',
    '13   # 这是备注',
    '  1022  ',
  ].join('\n')), ['13', '1022'])
})

check('房间清单：URL 的 fragment 不被当成注释截断', () => {
  // Python 版无条件按 # 切，会把带 fragment 的地址截坏
  assert.deepEqual(
    parseRoomList('https://live.bilibili.com/13?spm=1#anchor'),
    ['https://live.bilibili.com/13?spm=1#anchor'],
  )
})

check('房间清单：URL 后跟注释按空白切，地址完整保留', () => {
  assert.deepEqual(
    parseRoomList('https://live.bilibili.com/13?a=1   # TI 主舞台'),
    ['https://live.bilibili.com/13?a=1'],
  )
})

await checkAsync('房间号归一：纯数字 / 路径数字 / h5 路径，都不联网', async () => {
  assert.equal(await normalizeRoom('13'), '13')
  assert.equal(await normalizeRoom('https://live.bilibili.com/1022?live_from=86001'), '1022')
  assert.equal(await normalizeRoom('https://live.bilibili.com/h5/1022'), '1022')
})

await checkAsync('房间号归一：全角数字被归一，不再变成一个必然失败的请求', async () => {
  assert.equal(await normalizeRoom('１３'), '13')
})

await checkAsync('房间号归一：认不出的输入报错而不是静默丢弃', async () => {
  await assert.rejects(() => normalizeRoom('随便写点什么'), RoomError)
  await assert.rejects(() => normalizeRoom(''), RoomError)
})

await checkAsync('mapLimit：保持顺序，且并发不超过上限', async () => {
  let running = 0
  let peak = 0
  const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
    running++
    peak = Math.max(peak, running)
    await new Promise(r => setTimeout(r, 5))
    running--
    return n * 2
  })
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12], '结果必须按输入顺序')
  assert.ok(peak <= 2, `并发峰值 ${peak} 超过上限`)
})

check('全网失败判失败、全体没开播判成功——决定要不要清空用户的频道', () => {
  // 两者都产出 0 个频道。断网时若被记成「成功抓到 0 个」，上一轮缓存会被空结果
  // 覆盖，用户的频道消失且不退避重试。
  assert.equal(shouldFailRound(0, 3), true, '一条没成功且有真错误 → 判失败，保留上一轮缓存')
  assert.equal(shouldFailRound(0, 0), false, '全部没开播 → 正常的 0 条，如实写出')
  assert.equal(shouldFailRound(2, 5), false, '有成功的就不算整轮失败，失败的那几间进 skipped')
})

check('播放路由：裸数字归咪咕，认不出的 ref 无人认领', () => {
  // ⚠️ 「裸数字 → 咪咕」这条兜底不能去掉：体育赛事在 updateData 里直接写
  // ${replace}/<pID> 追加进播放列表，完全绕开 extractorManager；老订阅里缓存的
  // 历史地址同理。改成「只认 fetch() 产出过的 ref」会让这些地址全部 404。
  assert.equal(resolverFor('608807420')?.id, 'migu')
  assert.equal(resolverFor('abc'), null)
})

check('浙江延迟引用使用命名空间，不与咪咕裸数字路由冲突', () => {
  assert.equal(resolverFor('cztv-108')?.id, 'cztv')
  assert.equal(resolverFor('108')?.id, 'migu')
  assert.equal(resolverFor('cztv-108/extra'), null, 'ref 必须保持单个路径段')
})

check('claimsRef 保持 isNaN 语义，不许收紧成 /^\\d+$/', () => {
  // 现网 isNaN("") / isNaN("1e3") / isNaN("0x10") 都是 false，都会被放行走到
  // 咪咕接口。收紧会改掉「地址格式错误」的边界——那是可观察行为变更。
  const migu = getModule('migu')
  for (const pass of ['608807420', '', '1e3', '0x10', 'Infinity', ' 12 ']) {
    assert.equal(migu.claimsRef(pass), true, `${JSON.stringify(pass)} 应当被放行（与收编前一致）`)
  }
  for (const reject of ['abc', '12a', '中文']) {
    assert.equal(migu.claimsRef(reject), false, `${JSON.stringify(reject)} 应当被拒`)
  }
})

check('声明了 resolve 能力的模块必须实现 resolve 与 claimsRef', () => {
  for (const module of listModules()) {
    if (!module.capabilities?.resolve) continue
    assert.equal(typeof module.resolve, 'function', `${module.id} 缺 resolve`)
    assert.equal(typeof module.claimsRef, 'function', `${module.id} 缺 claimsRef`)
  }
})

check('clearUrlCache 会委托到各模块的 clearResolveCache', () => {
  // 画质/编码改动后不清缓存，三小时内会继续下发旧编码的流（issue #60）。
  // 调用点在 systemConfigAPI 与 configBackupAPI，改名要同步两处。
  let called = 0
  const migu = getModule('migu')
  const original = migu.clearResolveCache
  migu.clearResolveCache = () => { called++ }
  try { clearUrlCache() } finally { migu.clearResolveCache = original }
  assert.equal(called, 1)
})

check('咪咕已收编成模块，且三条 wire format 保持不变', () => {
  const migu = getModule('migu')
  assert.ok(migu, '咪咕应当在注册表里')
  assert.equal(migu.sourceId, 'migu', 'source-ids 必须保持字面量，老用户「按档禁用源」存的就是它')
  assert.equal(typeof migu.enabledGetter, 'function', '开关要代理到 config.js 的 enableMigu')
  assert.equal(migu.capabilities.cache, 'memory', '175 个频道带全部原始字段，不该落盘')
})

check('第一阶段两个官方直播模块已注册，缓存/解析能力声明正确', () => {
  const gxtv = getModule('gxtv')
  const cztv = getModule('cztv')
  assert.ok(gxtv)
  assert.ok(cztv)
  assert.equal(gxtv.capabilities.cache, 'disk')
  assert.equal(gxtv.capabilities.resolve, true)
  assert.equal(gxtv.defaultRefreshMinutes, 30, '广西密钥要短周期主动刷新，不能沿用频道列表的长缓存')
  assert.equal(gxtv.refreshConfigurable, false, '广西刷新策略由模块管理，不该让用户误改')
  assert.deepEqual(gxtv.configSchema, [], '广西频道范围使用固定策略，不向用户暴露选择项')
  assert.equal(cztv.capabilities.cache, 'disk')
  assert.equal(cztv.capabilities.resolve, true)
  assert.equal(cztv.refreshConfigurable, false, '浙江的签名和 CDN 探测不是外层刷新输入框能控制的')
  assert.deepEqual(cztv.configSchema, [], '浙江不向用户暴露播放缓冲等技术参数')
})

check('福建模块仍是原 id，固定六小时刷新且厦门短效地址可延迟解析', () => {
  const fjtv = getModule('fjtv')
  assert.ok(fjtv)
  assert.equal(fjtv.capabilities.cache, 'disk')
  assert.equal(fjtv.capabilities.resolve, true)
  assert.equal(fjtv.defaultRefreshMinutes, 360)
  assert.equal(fjtv.refreshConfigurable, false)
  assert.deepEqual(fjtv.configSchema, [])
})

check('江苏网络台模块已注册，使用固定频道周期和播放时解析', () => {
  const jstv = getModule('jstv')
  assert.ok(jstv)
  assert.equal(jstv.capabilities.cache, 'disk')
  assert.equal(jstv.capabilities.resolve, true)
  assert.equal(jstv.defaultRefreshMinutes, 240)
  assert.equal(jstv.refreshConfigurable, false)
  assert.deepEqual(jstv.configSchema, [], '江苏不向用户暴露播放缓冲等技术参数')
  assert.equal(resolverFor('jstv-670')?.id, 'jstv')
})

check('山东齐鲁网模块已注册，使用固定频道周期且不需要全代理', () => {
  const iqilu = getModule('iqilu')
  assert.ok(iqilu)
  assert.equal(iqilu.capabilities.cache, 'disk')
  assert.equal(iqilu.capabilities.resolve, true)
  assert.equal(iqilu.defaultRefreshMinutes, 240)
  assert.equal(iqilu.refreshConfigurable, false)
  assert.deepEqual(iqilu.configSchema, [])
  assert.equal(resolverFor('iqilu-sdtv')?.id, 'iqilu')
})

check('河南大象新闻模块已注册，使用固定两小时刷新且排除购物频道', () => {
  const hntv = getModule('hntv')
  assert.ok(hntv)
  assert.equal(hntv.capabilities.cache, 'disk')
  assert.equal(hntv.capabilities.resolve, true)
  assert.equal(hntv.defaultRefreshMinutes, 120)
  assert.equal(hntv.refreshConfigurable, false)
  assert.deepEqual(hntv.configSchema, [])
  assert.equal(resolverFor('hntv-145')?.id, 'hntv')
})

check('海南网台模块已注册，频道定时同步且播放时解析签名地址', () => {
  const hnntv = getModule('hnntv')
  assert.ok(hnntv)
  assert.equal(hnntv.capabilities.cache, 'disk')
  assert.equal(hnntv.capabilities.resolve, true)
  assert.equal(hnntv.defaultRefreshMinutes, 240)
  assert.equal(hnntv.refreshConfigurable, false)
  assert.deepEqual(hnntv.configSchema, [])
  assert.equal(resolverFor('hnntv-13')?.id, 'hnntv')
  assert.equal(resolverFor('hnntv-13/extra'), null)
})

check('河北冀时模块已注册，完整频道表定时同步且播放时续签', () => {
  const hebtv = getModule('hebtv')
  assert.ok(hebtv)
  assert.equal(hebtv.capabilities.cache, 'disk')
  assert.equal(hebtv.capabilities.resolve, true)
  assert.equal(hebtv.defaultRefreshMinutes, 240)
  assert.equal(hebtv.refreshConfigurable, false)
  assert.deepEqual(hebtv.configSchema, [])
  assert.equal(resolverFor('hebtv-10524916')?.id, 'hebtv')
  assert.equal(resolverFor('hebtv-10524916/extra'), null)
})

check('深圳广电模块已注册，固定周期刷新且逐路径签名流必须全代理', () => {
  const sztv = getModule('sztv')
  assert.ok(sztv)
  assert.equal(sztv.capabilities.cache, 'disk')
  assert.equal(sztv.capabilities.resolve, true)
  assert.equal(sztv.defaultRefreshMinutes, 240)
  assert.equal(sztv.refreshConfigurable, false)
  assert.deepEqual(sztv.configSchema, [])
  assert.equal(resolverFor('sztv-24725')?.id, 'sztv')
  assert.equal(resolverFor('sztv-R77mK1v'), null)
})

check('省市广电模块卡片只显示地区名，不带平台品牌', () => {
  const expectedNames = {
    beidou: '辽宁', cztv: '浙江', dalian: '大连', fjtv: '福建', gdtv: '广东', gxtv: '广西',
    gztv: '广州', hbtv: '湖北', hebtv: '河北', hnntv: '海南', hntv: '河南',
    iqilu: '山东', jstv: '江苏', kankanews: '上海', mgtv: '湖南', njtv: '南京',
    qtv: '青岛', sztv: '深圳',
  }
  const groupOverrides = { dalian: '辽宁', gztv: '广东', sztv: '广东' }
  for (const [id, name] of Object.entries(expectedNames)) {
    assert.equal(getModule(id)?.name, name, `${id} 卡片标题应只保留地区名`)
    assert.equal(
      getModule(id)?.outputGroupName,
      groupOverrides[id] || name,
      `${id} 播放列表分组应按地区归类`,
    )
  }
})

check('芒果 TV 模块已注册，固定刷新策略且不暴露技术设置', () => {
  const mgtv = getModule('mgtv')
  assert.ok(mgtv)
  assert.equal(mgtv.capabilities.cache, 'disk')
  assert.equal(mgtv.capabilities.resolve, true)
  assert.equal(mgtv.defaultRefreshMinutes, 240)
  assert.equal(mgtv.refreshConfigurable, false)
  assert.deepEqual(mgtv.configSchema, [])
  assert.equal(resolverFor('mgtv-287')?.id, 'mgtv')
})


// ---- 管理器 ----

const tmp = mkdtempSync(join(tmpdir(), 'iptv-extractors-test-'))
// 每个用例一份独立的配置/缓存文件：共用一份的话，前一个用例存下的开关状态
// 会污染后一个（比如前一个用例关掉的模块开关会被后一个读到）
let caseSeq = 0
const newManager = (legacy, extractorConfig) => {
  const seq = ++caseSeq
  const manager = new ExtractorManager()
  manager.configPath = join(tmp, `extractors-${seq}.json`)
  manager.cachePath = join(tmp, `extractor-cache-${seq}.json`)
  // 指向测试自己的旧配置，避免读到仓库根目录里用户的真实 system-config.json
  manager.legacyConfigPath = join(tmp, `system-config-${seq}.json`)
  if (extractorConfig !== undefined) writeFileSync(manager.configPath, JSON.stringify(extractorConfig))
  if (legacy !== undefined) writeFileSync(manager.legacyConfigPath, JSON.stringify(legacy))
  return manager.load()
}
const seed = (manager, groups, health = {}) => {
  manager.cache.modules['bilibili-live'] = {
    groups,
    health: { status: 'ok', lastSuccessAt: Date.now(), consecutiveFailures: 0, ...health },
  }
}
const oneGroup = [{
  name: '赛事', dataList: [{ name: '[原画] 主播', url: 'https://cdn/a.m3u8', opts: ['http-referrer=https://live.bilibili.com/'] }],
}]

try {
  check('迁移：把系统配置里真有的画质搬进模块，幂等，且不覆盖已配过的', () => {
    const manager = newManager({ rateType: 9, enableHDR: false, enableH265: false, port: '1905' })
    const cfg = manager.effectiveConfig(getModule('migu'))
    assert.equal(cfg.rateType, 9)
    assert.equal(cfg.enableHDR, false)
    assert.equal(cfg.enableH265, false)
    assert.equal(manager.config.migrated?.migu, true, '要打迁移标记')
    // 只搬 legacySystemConfigKeys 声明的键，port 是全局配置不该被卷进来
    assert.equal('port' in manager.config.modules.migu.config, false)

    // 幂等：把值改掉并落盘，再 load 一次，迁移不该把它冲回 9
    // （注意要先落盘——load() 会重新读磁盘，只改内存的话是被重读覆盖，测不到迁移）
    manager.updateModuleConfig('migu', { rateType: 4 })
    manager.load()
    assert.equal(manager.effectiveConfig(getModule('migu')).rateType, 4, '标记在就不该再搬')
  })

  check('迁移：凭据不写进日志（docker 日志常被贴进 issue）', () => {
    const lines = []
    const orig = console.log
    console.log = (...a) => lines.push(a.join(' '))
    try {
      newManager({ userId: '12345678', token: 'SECRET_TOKEN_VALUE', rateType: 4 })
    } finally { console.log = orig }
    const all = lines.join('\n')
    assert.ok(all.includes('迁入模块'), '应当有迁移日志')
    assert.equal(all.includes('SECRET_TOKEN_VALUE'), false, 'token 明文不该出现在日志里')
    assert.ok(all.includes('token=<已迁移>'), '应当只报「已迁移」')
    assert.ok(all.includes('12345678'), 'userId 不是 secret，照常打出来便于排查')
  })

  check('迁移：系统配置里没有的键一个都不写，env 继续 live 生效', () => {
    // 这是关键——搬过来等于把 mrateType=4 固化成文件值，用户改 compose 就再也不生效。
    const manager = newManager({ port: '1905' })   // 完全没有画质字段
    assert.deepEqual(manager.config.modules.migu?.config ?? {}, {}, '不该凭空写入')
    const saved = process.env.mrateType
    try {
      process.env.mrateType = '4'
      assert.equal(manager.effectiveConfig(getModule('migu')).rateType, 4, 'env 仍然生效')
    } finally {
      if (saved === undefined) delete process.env.mrateType
      else process.env.mrateType = saved
    }
  })

  check('迁移：旧配置文件损坏时不打标记，下次启动重试', () => {
    const manager = new ExtractorManager()
    const seq = ++caseSeq
    manager.configPath = join(tmp, `extractors-bad-${seq}.json`)
    manager.cachePath = join(tmp, `extractor-cache-bad-${seq}.json`)
    manager.legacyConfigPath = join(tmp, `system-config-bad-${seq}.json`)
    writeFileSync(manager.legacyConfigPath, '{ 这不是合法 JSON')
    manager.load()
    assert.equal(manager.config.migrated?.migu, undefined, '读失败绝不能当成「迁过了」')
  })

  check('★ 迁移：旧文件里没有咪咕键时不打标记——之后导入 v3 备份还能迁到（搬家场景）', () => {
    // 回归：首启对空 legacy 也打标记的话，全新部署 v4 再在后台导入 v3 备份
    // （system-config.json 里带着账号）时，reload() 会因标记直接跳过迁移，
    // 导入的 VIP 账号成死数据、画质静默降档到游客档。
    const manager = newManager({ port: '1905' })   // 全新安装：没有任何咪咕键
    assert.equal(manager.config.migrated?.migu, undefined, '空 legacy 不该焊死标记')
    writeFileSync(manager.legacyConfigPath, JSON.stringify({ userId: 'u1', token: 't1', rateType: 4 }))
    manager.reload()   // configBackupAPI 导入配置后走的就是这条
    assert.equal(manager.effectiveConfig(getModule('migu')).rateType, 4, '导入的配置要被搬进模块')
    assert.equal(manager.config.migrated?.migu, true, '这回真搬了，标记照打')
  })

  check('★ 只有声明了 loginFlow 的模块支持扫码登录', () => {
    // API 层是通用的、不认识任何平台：靠模块声明 loginFlow 决定支不支持。
    // 咪咕的 SESSDATA 等价物是 cookie 里读得到的，不需要扫码；将来要加，
    // 声明同样的 start/poll/configKey 即可，不用动 extractorsAPI。
    const bili = getModule('bilibili-live')
    assert.equal(typeof bili.loginFlow?.start, 'function')
    assert.equal(typeof bili.loginFlow?.poll, 'function')
    assert.equal(bili.loginFlow?.configKey, 'sessdata', '登录成功后凭据写进哪个字段')
    assert.equal(getModule('migu').loginFlow, undefined, '没声明就是不支持，API 层据此拒绝')
  })

  check('模块声明的 helper / helperSection 要透传给后台，否则辅助 UI 渲染不出来', () => {
    const manager = newManager()
    const modules = manager.getState().modules
    const migu = modules.find(m => m.id === 'migu')
    const bili = modules.find(m => m.id === 'bilibili-live')
    assert.equal(migu.helper, 'migu-bookmarklet')
    assert.equal(migu.helperSection, '', '没声明 helperSection 的渲染在表单最上面（咪咕就是）')
    assert.equal(bili.helper, 'bilibili-login', 'B 站的扫码登录助手')
    assert.equal(bili.helperSection, '登录态（选填）', '助手要挂在它自己那一段，不是表单最上面')
  })

  check('★ 所有非代理抓取模块首次出现默认开启，显式关闭后保持关闭', () => {
    // 跳过旧总开关迁移，只验证当前版本的模块默认值；代理模块继续听自己的 getter。
    const manager = newManager(undefined, { modules: {}, masterSwitchRetired: true })
    const regular = listModules().filter(module => typeof module.enabledGetter !== 'function')
    assert.ok(regular.length > 0)
    assert.deepEqual(
      regular.filter(module => !manager.isModuleEnabled(module)).map(module => module.id),
      [],
      '新注册模块和从未保存开关的模块都应开箱启用',
    )

    manager.setModuleEnabled('kankanews', false)
    manager.load()
    assert.equal(manager.isModuleEnabled(getModule('kankanews')), false,
      '用户明确保存的关闭态不能被默认值覆盖')
  })

  check('代理开关的模块不受抓取子系统总开关约束', () => {
    // config.js 明写「可 mblank=true + menableMigu=true 单独留咪咕」。咪咕若被
    // enableExtractors 一起管掉，这个既有组合就废了。总开关是 config.js 的 live
    // binding、单测里改不了，所以这里验的是「代理开关的模块走的是另一条判定路径」
    // ——只要它读的是自己的 getter 而不是子系统开关，上面那条语义就成立。
    const manager = newManager()
    assert.equal(typeof getModule('migu').enabledGetter, 'function', '咪咕必须用代理开关')
    assert.equal(manager.isModuleEnabled(getModule('migu')), getModule('migu').enabledGetter(),
      '代理模块的启用状态必须等于它自己的 getter')
    manager.setModuleEnabled('bilibili-live', false)
    assert.equal(manager.isModuleEnabled(getModule('bilibili-live')), false, '普通模块读 entry.enabled')
  })

  check('代理开关的模块读写都走自己的 getter/setter，不碰 extractors.json', () => {
    // 咪咕的开关是 config.js 的 enableMigu（被六处直接 import，带 env 与 mblank 语义），
    // 模块只是把读写入口挪到自己名下。这里不实际调 setter——它写的是
    // dataPath('system-config.json')，在测试里就是仓库根目录。
    const migu = getModule('migu')
    assert.equal(typeof migu.enabledGetter, 'function')
    assert.equal(typeof migu.enabledSetter, 'function', '开关要可写，否则卡片里是个死复选框')
    const manager = newManager()
    manager.setModuleEnabled('bilibili-live', true)
    manager.effectiveConfig(migu)   // 触发 entry 初始化
    assert.equal('enabled' in (manager.config.modules.migu || {}), false,
      '代理模块不该在 extractors.json 里留 enabled——存了也不读，只会误导看文件的人')
    assert.equal(manager.config.modules['bilibili-live'].enabled, true, '普通模块照常存')
  })

  check('输出：频道被盖上 source=extractor 与 xt: 命名空间的 sourceId', () => {
    const manager = newManager()
    manager.setModuleEnabled('bilibili-live', true)
    seed(manager, oneGroup)
    const [group] = manager.getValidChannels()
    assert.equal(group.name, '赛事')
    const [channel] = group.dataList
    assert.equal(channel.source, 'extractor', '不能靠「有没有 url」被推断成外部源')
    assert.equal(channel.sourceId, 'xt:bilibili-live')
    assert.equal(channel.groupTitle, '赛事')
    assert.deepEqual(channel.opts, ['http-referrer=https://live.bilibili.com/'])
  })

  check('输出：opts 过消毒，白名单外的键进不了播放列表', () => {
    const manager = newManager()
    manager.setModuleEnabled('bilibili-live', true)
    seed(manager, [{ name: 'G', dataList: [{ name: 'A', url: 'u', opts: ['program=/bin/sh', 'http-referrer=https://x/'] }] }])
    const [channel] = manager.getValidChannels()[0].dataList
    assert.deepEqual(channel.opts, ['http-referrer=https://x/'])
  })

  check('输出：平台级 HLS 模式覆盖旧频道缓存', () => {
    const manager = newManager()
    manager.cache.modules.livechina = {
      groups: [{
        name: '央视景观',
        dataList: [{
          name: '西藏｜测试景观',
          deferredRef: 'livechina-test',
          relayHls: true,
        }],
      }],
      health: { status: 'ok' },
    }
    const group = manager.getValidChannels().find(item => item.name === '央视景观')
    const [channel] = group.dataList
    assert.equal(channel.proxyHls, true, '央视景观升级后应立即改为清单与分片全代理')
    assert.equal(channel.relayHls, false, '旧缓存中的只中转清单标记必须被覆盖')
  })

  check('输出：省市分组与管理卡片同名，旧缓存也立即生效', () => {
    const manager = newManager()
    manager.cache.modules.beidou = {
      groups: [{ name: '辽宁频道', dataList: [{ name: '辽宁卫视', deferredRef: 'beidou-liaoning-1' }] }],
      health: { status: 'ok' },
    }
    manager.cache.modules.gztv = {
      groups: [{ name: '广州电视台', dataList: [{ name: '广州综合', deferredRef: 'gztv-3001' }] }],
      health: { status: 'ok' },
    }
    manager.cache.modules.sztv = {
      groups: [{ name: '深圳电视台', dataList: [{ name: '深圳卫视', deferredRef: 'sztv-7867' }] }],
      health: { status: 'ok' },
    }
    manager.cache.modules.kankanews = {
      groups: [
        { name: '上海电视台', dataList: [{ name: '上海新闻', deferredRef: 'kankanews-tv-1' }] },
        { name: '上海景观', dataList: [{ name: '外滩', deferredRef: 'kankanews-scenic-1' }] },
      ],
      health: { status: 'ok' },
    }
    const groups = manager.getValidChannels()
    assert.deepEqual(groups.map(group => group.name), ['辽宁', '广东', '上海', '上海景观'])
    assert.equal(groups.find(group => group.name === '广东').dataList.length, 2)
  })

  check('抓取失败时沿用上一轮频道——频道不能静默从播放列表消失', () => {
    const manager = newManager()
    manager.setModuleEnabled('bilibili-live', true)
    seed(manager, oneGroup, { status: 'failed', consecutiveFailures: 3, lastError: '风控' })
    const groups = manager.getValidChannels()
    assert.equal(groups.length, 1)
    assert.equal(groups[0].dataList.length, 1, '全局的 0 频道守卫只看总数，护不住单个模块')
    const moduleState = manager.getState().modules.find(module => module.id === 'bilibili-live')
    assert.equal(moduleState.health.usingCachedChannels, true,
      '面板必须说明失败时的频道数来自上一轮缓存')
  })

  check('首次抓取失败且无缓存时，面板不得误报沿用缓存', () => {
    const manager = newManager()
    seed(manager, [], { status: 'failed', consecutiveFailures: 1, lastError: 'HTTP 403', channelCount: 0 })
    const moduleState = manager.getState().modules.find(module => module.id === 'bilibili-live')
    assert.equal(moduleState.health.usingCachedChannels, false)
  })

  // 「抓取模块总开关」已退休：旧关闭态只负责升级迁移，运行时不能再覆盖卡片选择。
  // 这条钉住「模块开关就是唯一真相」，防将来有人
  // 看到 config.js 里还留着 enableExtractors 就顺手把那道闸加回 isModuleEnabled。
  check('★ 模块开关是唯一真相：打开后必须出频道，不受任何外层开关否决', () => {
    const manager = newManager()
    manager.setModuleEnabled('bilibili-live', true)
    seed(manager, oneGroup)
    assert.equal(manager.getValidChannels().length, 1,
      '模块开关打开却没出频道 —— 是不是又加了一道外层总开关？')
    // getState 不该再回传总开关字段：前端据此画过一个顶在卡片上方、却管不到咪咕的开关
    assert.equal('enabled' in manager.getState(), false,
      'getState 不该再有 enabled（总开关）字段')
  })

  check('模块级开关关掉后不出频道', () => {
    const manager = newManager()
    manager.setModuleEnabled('bilibili-live', true)
    seed(manager, oneGroup)
    assert.equal(manager.getValidChannels().length, 1)

    manager.setModuleEnabled('bilibili-live', false)
    assert.deepEqual(manager.getValidChannels(), [], '模块级开关关掉后不该出频道')
  })

  // 以下用例一律带 onlyId：注册表里还有咪咕，不限定的话 updateAll 会去抓真实的
  // 咪咕接口——测试不该联网，也不该受它成败影响。
  await checkAsync('禁用的模块不参与抓取', async () => {
    const manager = newManager()
    manager.setModuleEnabled('bilibili-live', false)
    const result = await manager.updateAll({ forceAll: true, onlyId: 'bilibili-live' })
    assert.deepEqual(result.results, [])
  })

  await checkAsync('房间清单空 + 自动抓取关闭：成功但 0 频道，且不联网', async () => {
    // 多选分区至少保留一个；关闭自动抓取由 topPerArea=0 明确表达。默认分区仍在，
    // 但数量为 0 时不会发起热门榜请求。
    const manager = newManager()
    manager.setModuleEnabled('bilibili-live', true)
    manager.updateModuleConfig('bilibili-live', { rooms: '', topPerArea: 0 })
    const result = await manager.updateAll({ forceAll: true, onlyId: 'bilibili-live' })
    assert.equal(result.results[0].success, true)
    const state = manager.getState()
    const module = state.modules.find(m => m.id === 'bilibili-live')
    assert.equal(module.health.status, 'empty', '0 频道是「没人播」不是「失败」')
    assert.ok(module.health.warnings.some(w => w.includes('房间号')))
  })

  check('配置损坏时拒绝写盘，不把用户配置覆盖成空', () => {
    const badDir = mkdtempSync(join(tmpdir(), 'iptv-extractors-corrupt-'))
    const badPath = join(badDir, 'extractors.json')
    writeFileSync(badPath, '{ 这不是合法 JSON')
    const manager = new ExtractorManager()
    manager.configPath = badPath
    manager.cachePath = join(badDir, 'extractor-cache.json')
    manager.load()

    assert.ok(manager.corrupt, '应当置位损坏标记')
    assert.ok(existsSync(`${badPath}.corrupt`), '应当另存一份原文件')
    assert.throws(() => manager.setModuleEnabled('bilibili-live', false), /损坏/)
    assert.ok(readFileSync(badPath, 'utf-8').includes('这不是合法 JSON'), '原文件必须原样保留')
    rmSync(badDir, { recursive: true, force: true })
  })

  check('改配置后立刻到期重抓，而不是等到原定刷新点', () => {
    const manager = newManager()
    manager.setModuleEnabled('bilibili-live', true)
    seed(manager, oneGroup)
    manager.updateModuleConfig('bilibili-live', { rooms: '13' })
    const module = manager.getState().modules.find(m => m.id === 'bilibili-live')
    assert.equal(module.health.lastSuccessAt, null, '配置变了，上一轮结果不再代表当前配置')
  })

  check('向后兼容：老版本写的「全量 key」配置里，空串不该挡住 env 兜底', () => {
    // 改稀疏存储之前，磁盘上存的是 sessdata:"" 这种「配过但是空」的条目。
    // 老代码 env 兜底用真值判断（空串回落 env），新代码用「键存不存在」——
    // 不归一的话，设了 mbiliSessdata 又存过一次配置的用户 env 会突然失效。
    const manager = newManager()
    manager.config.modules['bilibili-live'] = {
      enabled: true,
      config: { rooms: '13', sessdata: '', preferHls: true, preferAvc: true, cachingMs: 3000 },
    }
    const saved = process.env.mbiliSessdata
    try {
      process.env.mbiliSessdata = 'FROM_ENV'
      const cfg = manager.effectiveConfig(getModule('bilibili-live'))
      assert.equal(cfg.sessdata, 'FROM_ENV', '老配置里的空串要被归一掉，让 env 接手')
      assert.equal(cfg.rooms, '13', '有值的字段保持不变')
      assert.equal(cfg.cachingMs, 3000, 'int 不做归一，保留成「配过」')
    } finally {
      if (saved === undefined) delete process.env.mbiliSessdata
      else process.env.mbiliSessdata = saved
    }
  })

  check('deferredRef 原样透传，供写盘落成 ${replace}/<ref>', () => {
    // 延迟解析模块（咪咕将来就是这个形态）产出 ref 而不是 url。
    // ref 必须保持单个路径段：buildChannelId 用 /^\$\{replace\}\/([^/?#]+)/ 取
    // 频道主键，多段会失配、让老用户的「我的频道」配置一次性作废。
    const manager = newManager()
    manager.setModuleEnabled('bilibili-live', true)
    seed(manager, [{ name: 'G', dataList: [{ name: 'CCTV1', deferredRef: 608807420 }] }])
    const [channel] = manager.getValidChannels()[0].dataList
    assert.equal(channel.deferredRef, '608807420', '数字要归一成字符串')
    assert.ok(!channel.deferredRef.includes('/'), 'ref 不能含斜杠')
  })

  check('cache:disk 的模块：结果与健康状态都落盘', () => {
    // cache:'memory' 的分支目前没有模块声明（咪咕收编时才会用到），故此处未覆盖。
    const manager = newManager()
    manager.setModuleEnabled('bilibili-live', true)
    seed(manager, oneGroup)
    manager.updateModuleConfig('bilibili-live', { rooms: '13' })   // 这条会写缓存
    const onDisk = JSON.parse(readFileSync(manager.cachePath, 'utf-8'))
    // bilibili-live 声明的是 cache:'disk'，所以这里应当落盘
    assert.ok(onDisk.modules['bilibili-live'].groups.length > 0, 'disk 模块的结果要落盘')
    assert.ok(onDisk.modules['bilibili-live'].health, '健康状态要落盘')
  })

  await checkAsync('冷缓存兜底看「本进程抓过没」，不看「历史上成功过没」', async () => {
    // 回归：曾用 !health.lastSuccessAt 做判据。而 cache:'memory' 的模块 groups 不落盘、
    // health 落盘，重启后就是「groups 空 + lastSuccessAt 有值」，那个判据会把真正需要
    // 兜底的场景整个挡掉——实测设了 updateOnStartup=false 的用户重启后一次重生成，
    // 175 条咪咕频道整批从播放列表消失。
    const manager = newManager()
    manager.setModuleEnabled('bilibili-live', true)
    manager.updateModuleConfig('bilibili-live', { rooms: '', topPerArea: 0 }) // 空清单 = 不联网
    // 默认开启后其余模块也是冷缓存；本用例只测 B 站，标成已尝试以隔离真实网络。
    for (const module of listModules()) {
      if (module.id !== 'bilibili-live') manager.attempted.add(module.id)
    }
    // 模拟「上次成功过、但本进程 groups 是空的」
    manager.cache.modules['bilibili-live'] = {
      groups: [], health: { ...emptyHealth(), status: 'ok', lastSuccessAt: Date.now() },
    }
    const first = await manager.ensureWarm()
    assert.ok(first.results.some(r => r.id === 'bilibili-live'), '有过成功记录也要兜底抓一次')

    // 抓过之后即便结果是 0 条（房间全没开播是合法的空），不该反复重抓
    const second = await manager.ensureWarm()
    assert.deepEqual(second.results, [], '本进程已抓过就不再重复兜底')
  })

  check('critical 模块一条频道都没有时会被报出来，供写盘守卫拦截', () => {
    // 回归：收编前咪咕现抓失败会让 getAllChannels 返回空 → 全局 0 频道守卫触发 →
    // 一个字节都不写。收编后失败被吞在模块内，而外部源几十条就能把总数撑起来，
    // 守卫失效 → 播放列表被重写成没有咪咕的版本（实测 484 条 → 0 条）。
    // 那份保护本来是靠「咪咕失败 = 全局 0 条」的巧合得来的，现在改成显式声明。
    const manager = newManager()
    assert.deepEqual(manager.criticalShortfall(), ['咪咕视频'], '缓存为空时必须报出来')

    // 有频道了就不该再报
    manager.cache.modules['migu'] = {
      groups: [{ name: '央视', dataList: [{ name: 'CCTV1', deferredRef: '1' }] }],
      health: { ...emptyHealth(), status: 'ok', lastSuccessAt: Date.now() },
    }
    assert.deepEqual(manager.criticalShortfall(), [])
  })

  check('非 critical 模块拿不到频道不触发守卫（房间全没开播是合法的空）', () => {
    const manager = newManager()
    manager.setModuleEnabled('bilibili-live', true)
    manager.cache.modules['migu'] = {
      groups: [{ name: '央视', dataList: [{ name: 'CCTV1', deferredRef: '1' }] }],
      health: { ...emptyHealth(), status: 'ok', lastSuccessAt: Date.now() },
    }
    // bilibili-live 没有 critical，0 条频道不该让整份播放列表停止生成
    assert.deepEqual(manager.criticalShortfall(), [])
  })

  check('刷新间隔默认取模块声明值，且远小于 B 站地址的 2 小时有效期', () => {
    const manager = newManager()
    const module = manager.getState().modules.find(m => m.id === 'bilibili-live')
    assert.equal(module.refreshMinutes, 45)
    assert.equal(module.minRefreshMinutes, 45)
    assert.equal(module.maxRefreshMinutes, 90)
    assert.ok(module.refreshMinutes * 60 * 1000 < 2 * 60 * 60 * 1000)
  })

  check('B 站刷新间隔只允许 45~90 分钟，历史越界值回落默认', () => {
    const manager = newManager()
    assert.throws(() => manager.updateModuleConfig('bilibili-live', {}, { refreshMinutes: 44 }), /45~90/)
    assert.throws(() => manager.updateModuleConfig('bilibili-live', {}, { refreshMinutes: 91 }), /45~90/)
    manager.updateModuleConfig('bilibili-live', {}, { refreshMinutes: 90 })
    assert.equal(manager.getState().modules.find(m => m.id === 'bilibili-live').refreshMinutes, 90)
    manager.config.modules['bilibili-live'].refreshMinutes = 10
    assert.equal(manager.getState().modules.find(m => m.id === 'bilibili-live').refreshMinutes, 45)
  })

  check('自动刷新模块忽略历史覆盖值，且拒绝继续手动修改', () => {
    const manager = newManager()
    manager.getState() // 先让管理器按注册表建立各模块的稀疏配置项
    manager.config.modules.gxtv.refreshMinutes = 999
    manager.config.modules.cztv.refreshMinutes = 999
    const modules = manager.getState().modules
    const gxtv = modules.find(m => m.id === 'gxtv')
    const cztv = modules.find(m => m.id === 'cztv')
    assert.equal(gxtv.refreshMinutes, 30)
    assert.equal(cztv.refreshMinutes, 240)
    assert.equal(gxtv.refreshConfigurable, false)
    assert.match(cztv.refreshDescription, /播放签名约 5 分钟/)
    assert.throws(
      () => manager.updateModuleConfig('gxtv', {}, { refreshMinutes: 60 }),
      /自动管理/,
    )
  })

  check('未知模块 id 被拒绝', () => {
    const manager = newManager()
    assert.throws(() => manager.setModuleEnabled('不存在', true), /未知的抓取模块/)
    assert.throws(() => manager.updateModuleConfig('不存在', {}), /未知的抓取模块/)
  })

  await checkAsync('★ 同一模块的并发抓取合并为一份在飞（tick / 立即刷新 / 启动抓取互撞）', async () => {
    // 回归：三条触发路径互不知情，后台「立即刷新」还是 fire-and-forget、可连点。
    // 撞在一起就是对同一平台瞬时并发翻倍——B 站为防 -352 风控特意把模块内并发
    // 压到 3 路，两轮并行等于 6 路；且两轮的成败会互相覆盖健康状态。
    const manager = newManager()
    manager.setModuleEnabled('bilibili-live', true)
    const module = getModule('bilibili-live')
    const origFetch = module.fetch
    let calls = 0
    module.fetch = async () => { calls++; await new Promise(r => setTimeout(r, 30)); return { groups: oneGroup } }
    try {
      await Promise.all([
        manager.updateAll({ onlyId: 'bilibili-live' }),
        manager.updateAll({ onlyId: 'bilibili-live' }),
      ])
    } finally { module.fetch = origFetch }
    assert.equal(calls, 1, '在飞的必须复用同一份，不能对平台翻倍并发')
  })

  await checkAsync('★ 在飞轮跑的是旧配置时，「立即刷新」串行补跑一轮新配置，不复用旧轮', async () => {
    // 回归（对抗审查抓到的）：无脑复用在飞轮的话，「保存配置 → 点立即刷新」拿到的
    // 是旧配置那轮的结果，且旧轮完成时的记账会把 updateModuleConfig 置下的
    // 「立刻重抓」信号抹掉——刚扫码写入的 SESSDATA 要等满 45 分钟才生效。
    const manager = newManager()
    manager.setModuleEnabled('bilibili-live', true)
    const module = getModule('bilibili-live')
    const origFetch = module.fetch
    const seenRooms = []
    let release
    const gate = new Promise(r => { release = r })
    module.fetch = async (config) => { seenRooms.push(config.rooms); await gate; return { groups: oneGroup } }
    try {
      const first = manager.updateAll({ onlyId: 'bilibili-live' })    // 旧配置在飞
      await new Promise(r => setTimeout(r, 10))
      manager.updateModuleConfig('bilibili-live', { rooms: '999' })   // 保存新配置
      const second = manager.updateAll({ onlyId: 'bilibili-live' })   // 立即刷新
      release()
      await Promise.all([first, second])
    } finally { module.fetch = origFetch }
    assert.equal(seenRooms.length, 2, '配置变了必须补跑一轮，不能吞掉强制刷新')
    assert.equal(seenRooms[1], '999', '补跑那轮用的必须是新配置')
  })

  await checkAsync('★ 在飞轮跑到一半配置变了：记账不得抹掉「立刻重抓」信号', async () => {
    // 同一回归的 tick 路径：没有人点「立即刷新」，只是保存了配置。在飞旧轮完成时
    // recordSuccess 整份重建 health，若把 lastSuccessAt 写回非 null，下一轮 5 分钟
    // tick 就不会重抓，新配置要等满整个刷新周期。
    const manager = newManager()
    manager.setModuleEnabled('bilibili-live', true)
    const module = getModule('bilibili-live')
    const origFetch = module.fetch
    let release
    const gate = new Promise(r => { release = r })
    module.fetch = async () => { await gate; return { groups: oneGroup } }
    try {
      const round = manager.updateAll({ onlyId: 'bilibili-live' })
      await new Promise(r => setTimeout(r, 10))
      manager.updateModuleConfig('bilibili-live', { rooms: '999' })
      release()
      await round
    } finally { module.fetch = origFetch }
    const health = manager.cache.modules['bilibili-live'].health
    assert.equal(health.lastSuccessAt, null, '旧轮的记账不能冻结「配置已变更、立刻重抓」')
  })

  check('listSourceIds 不按模块开关过滤——「配置档 ↔ 源」的绑定行要留在矩阵里', () => {
    // 回归：按 isModuleEnabled 过滤的话，关掉模块后它的绑定行从矩阵消失，开回来
    // 得重设一遍（app.js /api/source-profiles 的注释明确要求「绑定关系要留着」）。
    const manager = newManager()
    manager.setModuleEnabled('bilibili-live', false)
    const ids = manager.listSourceIds().map(s => s.id)
    assert.ok(ids.includes('xt:bilibili-live'), '关着的模块也要列出')
    assert.ok(ids.includes('migu'), '代理开关模块以字面量 id 列出，且只此一份（app.js 不再单列）')
  })
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

// ---- 热门直播间自动加入（省去用户自己找房间号）----
// 存在的理由：不这么做的话，想用 B 站直播就得先去网页上一个个找房间号，那是这个
// 模块最劝退的一步。默认「赛事 + 知识」兼顾官方比赛与新闻 / 教育 / 科普，适合
// 电视端长时间观看；所有结果仍统一进一个 B站 组。

check('分区名解析：一行一个、去空白、忽略空行与 # 注释', () => {
  assert.deepEqual(parseAreaNames('赛事\n  网游  \n\n# 这行是注释\n手游'), ['赛事', '网游', '手游'])
  assert.deepEqual(parseAreaNames(''), [])
  assert.deepEqual(parseAreaNames(null), [])
  assert.deepEqual(parseAreaNames('# 全是注释\n\n'), [])
})

check('★ 手填清单排在热门榜之前', () => {
  // 顺序不只是好看：它决定同名频道在播放器「源1 / 源2」里的先后，
  // 用户明确指定的那个应该是源1
  assert.deepEqual(mergeRoomRefs([111, 222], [333, 444]), [111, 222, 333, 444])
})

check('★ 手填的房间正好在热门榜里时只出现一次', () => {
  // 不去重的话同一个直播间会在播放列表里出现两次：同名、同地址，纯噪音
  assert.deepEqual(mergeRoomRefs([111, 222], [222, 333]), [111, 222, 333])
})

check('去重按字符串形式，数字 222 与字符串 "222" 视为同一个房间', () => {
  // parseRoomList 产出的可能是字符串（用户粘的地址），热门榜产出的是数字
  assert.deepEqual(mergeRoomRefs(['222'], [222, 333]), ['222', 333])
})

check('空输入不炸', () => {
  assert.deepEqual(mergeRoomRefs([], []), [])
  assert.deepEqual(mergeRoomRefs(null, undefined), [])
})

check('★ B 站不同分区统一归入「B站」组，且真实房间号仍去重', () => {
  const warnings = []
  const groups = groupBilibiliResults([
    { roomId: '1', group: '赛事', channel: { name: '赛事 A', groupTitle: '赛事' } },
    { roomId: '2', group: '娱乐', channel: { name: '娱乐 B', groupTitle: '娱乐' }, warning: '装饰信息缺失' },
    { roomId: '1', group: '网游', channel: { name: '重复房间', groupTitle: '网游' } },
  ], warnings)
  assert.equal(BILIBILI_GROUP, 'B站')
  assert.deepEqual(groups, [{
    name: 'B站',
    dataList: [
      { name: '赛事 A', groupTitle: 'B站' },
      { name: '娱乐 B', groupTitle: 'B站' },
    ],
  }])
  assert.deepEqual(warnings, ['装饰信息缺失'])
})

check('★ 热门榜滤掉人气过低的房间（否则同一场比赛的多机位小号会灌进播放列表）', () => {
  // 实测赛事区 13 名往后全是「王者荣耀赛事第一视角7/9/3…」这种同场比赛的不同机位，
  // 人气普遍在 1000 上下。删掉过滤那行不会有任何报错，只是播放列表悄悄变脏。
  const raw = [
    { roomid: 1, online: 3_000_000 },   // 真赛事
    { roomid: 2, online: 150_000 },     // 真赛事
    { roomid: 3, online: 11_000 },      // 小众但真实（羽毛球世锦赛量级）
    { roomid: 4, online: 1_836 },       // 「第一视角7」这类
    { roomid: 5, online: 163 },
  ]
  assert.deepEqual(selectTopRooms(raw, 10), [1, 2, 3], '默认门槛以下的必须滤掉')
})

check('热门榜最低人气可配置，0 表示不过滤', () => {
  const raw = [
    { roomid: 1, online: 11_000 },
    { roomid: 2, online: 3_000 },
    { roomid: 3, online: 1_500 },
  ]
  assert.deepEqual(selectTopRooms(raw, 10, 10_000), [1], '可收紧到旧门槛')
  assert.deepEqual(selectTopRooms(raw, 10, 1_000), [1, 2, 3], '可放宽门槛')
  assert.deepEqual(selectTopRooms(raw, 10, 0), [1, 2, 3], '0 应关闭人气过滤')
})

check('数量是上限不是保证：够格的不足就给不足', () => {
  const raw = [{ roomid: 1, online: 3_000_000 }, { roomid: 2, online: 500 }]
  assert.deepEqual(selectTopRooms(raw, 8), [1], '只有 1 个够格就只给 1 个，不凑数')
})

check('截断按数量生效，且保持人气从高到低的原序', () => {
  const raw = [1, 2, 3, 4].map((id, i) => ({ roomid: id, online: 1_000_000 - i * 1000 }))
  assert.deepEqual(selectTopRooms(raw, 2), [1, 2])
})

check('脏数据不炸：非数组 / 缺字段 / 房间号非法', () => {
  assert.deepEqual(selectTopRooms(null, 5), [])
  assert.deepEqual(selectTopRooms(undefined, 5), [])
  assert.deepEqual(selectTopRooms([{}, { online: 999999 }, { roomid: 0, online: 999999 }], 5), [])
  assert.deepEqual(selectTopRooms([{ roomid: 7, online: 999999 }], 0), [], 'count=0 等于关掉')
})

check('热门榜配置已进 configSchema 且默认值符合「开箱即用」', () => {
  const schema = bili.configSchema
  const areas = schema.find(f => f.key === 'topAreas')
  const per = schema.find(f => f.key === 'topPerArea')
  const minOnline = schema.find(f => f.key === 'minOnline')
  assert.ok(areas, 'topAreas 字段丢了')
  assert.ok(per, 'topPerArea 字段丢了')
  assert.ok(minOnline, 'minOnline 字段丢了')
  assert.equal(areas.type, 'multiselect', '分区应直接勾选，不再依赖用户读说明后手填')
  assert.deepEqual(areas.options.map(option => option.value), [
    '赛事', '知识', '生活', '网游', '手游', '单机游戏',
    '娱乐', '电台', '虚拟主播', '聊天室', '互动玩法', '购物',
  ])
  assert.equal(areas.default, '赛事\n知识', '默认分区应兼顾赛事与适合电视端的知识内容')
  assert.deepEqual(parseAreaNames(areas.default), ['赛事', '知识'])
  assert.equal(per.default, 8, "实测赛事区人气在第 6~7 名有 82% 断崖，5 会漏掉 300 万人在看的比赛")
  assert.equal(per.min, 0, '填 0 必须能关掉这个功能')
  assert.equal(minOnline.default, DEFAULT_MIN_ONLINE)
  assert.equal(minOnline.default, 3000, '默认应兼顾正常赛事与低热度重复机位')
  assert.equal(minOnline.min, 0, '填 0 必须能关闭人气过滤')
})

check('★ 咪咕：分类全失败判失败保缓存，部分失败/真没频道不误伤', () => {
  // 与 B 站 shouldFailRound 同一套约定。全失败当成功返回的话：空结果覆盖上一轮
  // 内存缓存、无退避、criticalShortfall 把所有播放列表重生成挡到下个刷新周期。
  assert.equal(miguShouldFailRound(0, 11), true, '一个频道都没有且确有分类失败 → 判失败')
  assert.equal(miguShouldFailRound(0, 0), false, '接口正常但真没频道 → 如实返回（不太可能但不该误判）')
  assert.equal(miguShouldFailRound(500, 2), false, '部分分类失败不算整轮失败，记 meta.warnings')
})

await checkAsync('★ B 站：热门榜获取失败且无手填 → 整轮判失败（保上一轮缓存），不再是「成功 0 频道」', async () => {
  // 回归：默认配置正是纯热门榜（topAreas=赛事、rooms 留空）。分区清单/热门榜的
  // 网络层失败此前被吞成 warning、fetch() 返回空 groups——被记成「成功 0 频道」，
  // 上一轮频道被覆盖成空且不退避。timeoutMs=1 模拟断网：现在必须抛。
  const config = resolveConfig(bili, {})
  await assert.rejects(() => bili.fetch(config, { timeoutMs: 1 }), /失败/)
})

// ---- 虎牙直播 ----

const huyaEventHtml = `
<ul><li class="game-live-item match-live-item" data-gid="1">
  <a href="https://www.huya.com/660101" class="video-info clickstat">
    <img class="pic" data-original="//img.example/live.jpg?a=1&amp;b=2" alt="主播的直播">
  </a>
  <a href="https://www.huya.com/660101" class="title" title="决赛 &amp; 颁奖">决赛</a>
  <i class="nick" title="赛事官方">赛事官方</i>
  <i class="js-num">1.2万</i>
</li></ul>`

const huyaAntiCode = new URLSearchParams({
  wsSecret: 'old',
  wsTime: '6553f100',
  fm: 'c2FsdF8kMF8kMV8kMl8kMw==',
  ctype: 'huya_live',
  fs: 'bgct',
}).toString()

const huyaPlayerHtml = `
<script>var hyPlayerConfig = {
  stream: ${JSON.stringify({
    data: [{
      gameLiveInfo: {
        uid: 123456,
        profileRoom: 660101,
        introduction: '虎牙测试直播',
        nick: '测试主播',
        screenshot: 'http://img.example/room.jpg',
        totalCount: 12000,
      },
      gameStreamInfoList: [{
        sStreamName: 'abc',
        sHlsUrl: 'http://al.hls.huya.com/src',
        sHlsUrlSuffix: 'm3u8',
        sHlsAntiCode: huyaAntiCode,
      }],
    }],
    vMultiStreamInfo: [{ iBitRate: 0 }, { iBitRate: 4000 }, { iBitRate: 2000 }, { iBitRate: 500 }],
  })},
  other: { nested: true }
};</script>`

check('虎牙：房间号/地址归一并去重，拒绝外站地址', () => {
  assert.equal(normalizeHuyaRoom('６６０１０１'), '660101')
  assert.equal(normalizeHuyaRoom('https://www.huya.com/lpl?from=web'), 'lpl')
  assert.deepEqual(parseHuyaRoomList('660101\nhttps://www.huya.com/660101\n# 注释\nlpl'), ['660101', 'lpl'])
  assert.throws(() => normalizeHuyaRoom('https://example.com/660101'), /不是虎牙/)
})

check('虎牙：赛事卡片解析标题、图片和“万”人气', () => {
  const rows = parseHuyaEventRooms(huyaEventHtml)
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0], {
    roomId: '660101',
    name: '决赛 & 颁奖',
    nick: '赛事官方',
    logo: 'https://img.example/live.jpg?a=1&b=2',
    heat: 12000,
  })
})

check('虎牙：普通分类的 ALL_LIST_DATA JSON 可解析并归一频道', () => {
  const html = `var ALL_LIST_DATA = ${JSON.stringify([{
    lProfileRoom: 102411,
    sNick: '神超',
    sIntroduction: '标题里也可以有 ] 和 }',
    sScreenshot: 'http://img.example/a.jpg',
    lTotalCount: 1838540,
    sGameFullName: '英雄联盟',
  }])}; var after = true;`
  const rows = parseHuyaCategoryRooms(html)
  assert.equal(rows[0].roomId, '102411')
  assert.equal(rows[0].name, '标题里也可以有 ] 和 }')
  assert.equal(rows[0].heat, 1838540)
  assert.equal(rows[0].logo, 'https://img.example/a.jpg')
})

check('虎牙：播放器配置与画质回落可从房间页稳定提取', () => {
  const room = parseHuyaRoomPage(huyaPlayerHtml, '660101')
  assert.equal(room.roomId, '660101')
  assert.equal(room.presenterUid, '123456')
  assert.equal(room.logo, 'https://img.example/room.jpg')
  assert.equal(selectHuyaBitrate(room.bitrates, 2000), 2000)
  assert.equal(selectHuyaBitrate(room.bitrates, 1000), 500, '缺 1M 时回落到不高于目标的最近档')
  assert.equal(selectHuyaBitrate(room.bitrates, 0), 0, '0 表示原画')
})

check('虎牙：官网 H5 签名算法固定样本一致', () => {
  const room = parseHuyaRoomPage(huyaPlayerHtml, '660101')
  const signed = new URL(signHuyaHlsUrl(room.streams[0], room.presenterUid, 2000, 1700000000000))
  assert.equal(signed.protocol, 'https:')
  assert.equal(signed.pathname, '/src/abc.m3u8')
  assert.equal(signed.searchParams.get('wsSecret'), '40f4876dcefaa5d837caaf0e35f06997')
  assert.equal(signed.searchParams.get('seqid'), '1700000000000')
  assert.equal(signed.searchParams.get('ratio'), '2000')
  assert.equal(signed.searchParams.get('u'), '123456')
  assert.equal(signed.searchParams.get('t'), '100')
  assert.equal(signed.searchParams.get('fm'), null, 'fm 模板不能泄漏到最终播放地址')
  assert.throws(() => signHuyaHlsUrl({
    ...room.streams[0],
    sHlsUrl: 'https://example.com/src',
  }, room.presenterUid, 2000, 1700000000000), /官方域名/)
})

check('虎牙：默认配置控制数量与人气，所有频道固定放入虎牙组', () => {
  const areas = huya.configSchema.find(field => field.key === 'topAreas')
  assert.equal(areas.type, 'multiselect')
  assert.deepEqual(areas.options.map(option => option.value), ['赛事', '网游', '手游', '单机', '娱乐'])
  assert.deepEqual(parseHuyaAreaNames(areas.default), ['赛事'])
  assert.equal(huya.configSchema.find(field => field.key === 'topPerArea').default, 8)
  assert.equal(huya.configSchema.find(field => field.key === 'minHeat').default, DEFAULT_MIN_HEAT)
  assert.equal(huya.configSchema.find(field => field.key === 'quality').default, 2000)
  assert.deepEqual(mergeHuyaRooms(
    [{ roomId: '1', name: '手填' }],
    [{ roomId: '1', name: '重复' }, { roomId: '2', name: '自动' }],
  ).map(room => room.name), ['手填', '自动'])
  assert.equal(HUYA_GROUP, '虎牙')
})

await checkAsync('虎牙：模块抓取赛事卡片，播放时才刷新签名并要求清单中继', async () => {
  clearHuyaResolveCache()
  const response = text => ({ ok: true, status: 200, text: async () => text })
  const config = resolveConfig(huya, {})
  const fetched = await huya.fetch(config, { fetchImpl: async url => {
    assert.equal(String(url), 'https://www.huya.com/m')
    return response(huyaEventHtml)
  } })
  assert.equal(fetched.groups[0].name, '虎牙')
  assert.equal(fetched.groups[0].dataList[0].deferredRef, 'huya-660101')
  assert.equal(fetched.groups[0].dataList[0].relayHls, true)
  assert.equal(fetched.groups[0].dataList[0].opts, undefined, 'LunaTV 导入时 EXTINF 后必须紧跟地址')

  const resolved = await resolveHuyaRoom('huya-660101', {
    now: 1700000000000,
    config,
    fetchImpl: async url => {
      assert.equal(String(url), 'https://www.huya.com/660101')
      return response(huyaPlayerHtml)
    },
  })
  assert.match(resolved.url, /^https:\/\/al\.hls\.huya\.com\/src\/abc\.m3u8\?/)
  assert.equal(resolved.relayHls, true)
  assert.equal(resolved.upstreamHeaders.Referer, 'https://www.huya.com/')
})

// ---- 斗鱼直播 ----

const douyuSignerCode = `
var signerPadding = '${'x'.repeat(120)}';
function ub98484234(rid, did, tt) {
  return 'v=250120260830&did=' + did + '&tt=' + tt
    + '&sign=' + CryptoJS.MD5(String(rid) + did + String(tt)).toString();
}`

const douyuMobileHtml = `<html><body>
<script id="vike_pageContext" type="application/json">${JSON.stringify({
  pageProps: { room: { roomInfo: { roomInfo: {
    rid: 9999,
    roomName: '陪伴每一天',
    nickname: '测试主播',
    avatar: 'https://img.example/avatar.jpg',
    roomSrcSixteen: 'https://img.example/cover.jpg',
    hn: '123.4万',
    isLive: 1,
  } } } },
  crptext: douyuSignerCode,
})}</script></body></html>`

const douyuCategoryPayload = {
  code: 0,
  msg: 'success',
  data: { rl: [
    { rid: 9999, rn: '第一名', nn: '主播甲', ol: 2300000, rs16: '//img.example/1.jpg', c2name: 'DOTA2' },
    { rid: 1234, rn: '第二名', nn: '主播乙', ol: 90000, rs16: 'https://img.example/2.jpg', c2name: '英雄联盟' },
    { rid: 0, rn: '无效推荐位', ol: 9999999 },
  ] },
}

check('斗鱼：房间号、PC/手机/分享地址归一并去重，拒绝外站地址', () => {
  assert.equal(normalizeDouyuRoom('９９９９'), '9999')
  assert.equal(normalizeDouyuRoom('https://www.douyu.com/9999?dyshid=1'), '9999')
  assert.equal(normalizeDouyuRoom('https://m.douyu.com/9999'), '9999')
  assert.equal(normalizeDouyuRoom('https://www.douyu.com/room/share/171717'), '171717')
  assert.deepEqual(parseDouyuRoomList('9999\nhttps://www.douyu.com/9999\n# 注释\n1234'), ['9999', '1234'])
  assert.throws(() => normalizeDouyuRoom('https://example.com/9999'), /不是斗鱼/)
})

check('斗鱼：官方分类接口字段归一，跳过占位卡片并保留官网人气', () => {
  const rows = normalizeDouyuCategoryPayload(douyuCategoryPayload)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], {
    roomId: '9999',
    name: '第一名',
    nick: '主播甲',
    logo: 'https://img.example/1.jpg',
    heat: 2300000,
    category: 'DOTA2',
  })
})

check('斗鱼：移动官网房间数据和动态匿名签名可在受限上下文解析', () => {
  const room = parseDouyuMobileRoomPage(douyuMobileHtml, '9999')
  assert.equal(room.roomId, '9999')
  assert.equal(room.name, '陪伴每一天')
  assert.equal(room.heat, 1234000)
  const signed = createDouyuMobileSign(douyuSignerCode, room.roomId, ANONYMOUS_DID, 1700000000)
  assert.equal(signed.get('v'), '250120260830')
  assert.equal(signed.get('did'), ANONYMOUS_DID)
  assert.equal(signed.get('tt'), '1700000000')
  assert.equal(signed.get('sign'), createHash('md5').update(`9999${ANONYMOUS_DID}1700000000`).digest('hex'))
  assert.throws(() => createDouyuMobileSign('function ub98484234(){}', '9999'), /不完整/)
})

check('斗鱼：只接受官方 CDN 的 HLS 地址', () => {
  assert.equal(isOfficialDouyuStreamUrl('http://openhls-hw.douyucdn2.cn/live/a.m3u8?token=x'), true)
  assert.equal(isOfficialDouyuStreamUrl('https://stream.example.com/live/a.m3u8'), false)
  assert.equal(isOfficialDouyuStreamUrl('https://openhls-hw.douyucdn2.cn/live/a.flv'), false)
})

check('斗鱼：默认配置控制分类、数量、人气与画质，所有频道固定放入斗鱼组', () => {
  const areas = douyu.configSchema.find(field => field.key === 'topAreas')
  assert.equal(areas.type, 'multiselect')
  assert.deepEqual(areas.options.map(option => option.value), ['全部', '网游竞技', '单机热游', '手游休闲', '娱乐'])
  assert.deepEqual(parseDouyuAreaNames(areas.default), ['网游竞技'])
  assert.equal(douyu.configSchema.find(field => field.key === 'topPerArea').default, 8)
  assert.equal(douyu.configSchema.find(field => field.key === 'minHeat').default, DEFAULT_DOUYU_MIN_HEAT)
  assert.equal(douyu.configSchema.find(field => field.key === 'quality').default, 3)
  assert.deepEqual(mergeDouyuRooms(
    [{ roomId: '1', name: '手填' }],
    [{ roomId: '1', name: '重复' }, { roomId: '2', name: '自动' }],
  ).map(room => room.name), ['手填', '自动'])
  assert.equal(DOUYU_GROUP, '斗鱼')
})

await checkAsync('斗鱼：模块抓取分类热门房间，播放时匿名刷新短效 HLS 并要求清单中继', async () => {
  clearDouyuResolveCache()
  const config = resolveConfig(douyu, {})
  const fetched = await douyu.fetch(config, { fetchImpl: async url => {
    assert.equal(String(url), 'https://www.douyu.com/gapi/rkc/directory/mixListV1/1_1/1')
    return { ok: true, status: 200, json: async () => douyuCategoryPayload }
  } })
  assert.equal(fetched.groups[0].name, '斗鱼')
  assert.equal(fetched.groups[0].dataList.length, 1, '默认 10 万人气应过滤第二条')
  assert.equal(fetched.groups[0].dataList[0].deferredRef, 'douyu-9999')
  assert.equal(fetched.groups[0].dataList[0].relayHls, true)
  assert.equal(fetched.groups[0].dataList[0].opts, undefined, 'LunaTV 导入时 EXTINF 后必须紧跟地址')

  let calls = 0
  const resolved = await resolveDouyuRoom('douyu-9999', {
    now: 1700000000000,
    config,
    fetchImpl: async (url, options = {}) => {
      calls++
      if (calls === 1) {
        assert.equal(String(url), 'https://m.douyu.com/9999')
        return { ok: true, status: 200, text: async () => douyuMobileHtml }
      }
      assert.equal(String(url), 'https://m.douyu.com/hgapi/livenc/room/getStreamUrl')
      assert.equal(options.method, 'POST')
      const body = new URLSearchParams(String(options.body))
      assert.equal(body.get('rid'), '9999')
      assert.equal(body.get('rate'), '3')
      assert.equal(body.get('did'), ANONYMOUS_DID)
      return { ok: true, status: 200, json: async () => ({
        error: 0,
        data: {
          settings: [{ name: '超清', rate: 3 }],
          rate: 3,
          pass: 0,
          url: 'http://openhls-hw.douyucdn2.cn/live/test_2000.m3u8?txSecret=abc',
        },
      }) }
    },
  })
  assert.equal(resolved.url, 'https://openhls-hw.douyucdn2.cn/live/test_2000.m3u8?txSecret=abc')
  assert.match(resolved.desc, /超清地址获取成功/)
  assert.equal(resolved.relayHls, true)
  assert.equal(resolved.upstreamHeaders.Referer, 'https://m.douyu.com/')
})

// ---- 广西网络台 / 浙江新蓝网 ----

const fakeResponse = payload => ({
  ok: true,
  status: 200,
  json: async () => payload,
  text: async () => typeof payload === 'string' ? payload : JSON.stringify(payload),
})

check('广西：只取官网正式频道、规范命名并排除内部/专题流', () => {
  const rows = [
    { name: '新闻在线网络直播专用', state: 1, showChannel: 1, decodeM3u8: 'https://x/internal.m3u8' },
    { name: '广西卫视', state: 1, showChannel: 1, encodeM3u8: 'https://x/gxws.m3u8', logo: 'https://x/gx.png' },
    { name: '新闻频道', state: 1, showChannel: 1, encodeM3u8: 'https://x/news.m3u8' },
    { name: '移动数字电视频道', state: 1, showChannel: 1, encodeM3u8: 'https://x/mobile.m3u8' },
    { name: '乐思购频道', state: 1, showChannel: 1, encodeM3u8: 'https://x/shop.m3u8' },
    { name: '中国教育电视台CETV-1频道', state: 1, showChannel: 1, encodeM3u8: 'https://x/cetv1.m3u8' },
    { name: '《广西新闻》矩阵号', state: 1, showChannel: 1, encodeM3u8: 'https://x/matrix.m3u8' },
  ]
  const groups = buildGxtvGroups(rows, { includeSpecialty: true, includeCetv: true })
  assert.deepEqual(groups.map(g => g.name), ['广西电视台'])
  assert.deepEqual(groups[0].dataList.map(ch => ch.name), ['广西卫视', '广西新闻', '广西移动'])
})

check('广西：HLS 字段按优先级回落，非 HLS/坏 URL 不进入播放列表', () => {
  assert.equal(streamUrlOf({ encodeM3u8: '', decodeM3u8: 'https://x/live.m3u8' }), 'https://x/live.m3u8')
  assert.equal(streamUrlOf({ encodeM3u8: 'https://x/live.flv' }), '')
  assert.equal(streamUrlOf({ encodeM3u8: '[B@31aae2e6' }), '')
})

await checkAsync('广西：模块按官网 POST 形状取数并产出全代理引用', async () => {
  const module = getModule('gxtv')
  let request
  const fetchImpl = async (url, options) => {
    request = { url, options }
    return fakeResponse({ code: 0, data: { rows: [
      { name: '广西卫视', state: 1, showChannel: 1, encodeM3u8: 'https://x/gxws.m3u8' },
    ] } })
  }
  const result = await module.fetch({ includeSpecialty: true, includeCetv: false }, { fetchImpl })
  assert.equal(request.options.method, 'POST')
  assert.match(request.options.body, /pageSize=1000/)
  assert.equal(result.groups[0].dataList[0].deferredRef, 'gxtv-gxws')
  assert.equal(result.groups[0].dataList[0].proxyHls, true)
  assert.equal('url' in result.groups[0].dataList[0], false)
})

await checkAsync('广西：resolve 使用已抓到的正式 HLS，格式错误/断网均不抛', async () => {
  clearGxtvStreamCache()
  let calls = 0
  const fetchImpl = async () => {
    calls++
    return fakeResponse({ code: 0, data: { rows: [
      {
        name: '广西卫视', state: 1, showChannel: 1,
        encodeM3u8: 'https://x/gxws.m3u8', encodingId: 'id', encodingKey: 'key',
      },
    ] } })
  }
  const first = await resolveGxtvChannel('gxtv-gxws', { fetchImpl, now: 1720000000000 })
  const second = await resolveGxtvChannel('gxtv-gxws', { fetchImpl, now: 1720000000001 })
  assert.equal(first.url, 'https://x/gxws.m3u8')
  assert.equal(typeof first.segmentTransform, 'function')
  assert.equal(second.url, first.url)
  assert.equal(calls, 1, '代理周期性拉清单时不能每次都重打频道 API')
  assert.equal((await resolveGxtvChannel('gxtv-unknown')).url, '')

  clearGxtvStreamCache()
  const failed = await resolveGxtvChannel('gxtv-gxws', {
    fetchImpl: async () => { throw new Error('断网') }, now: 1720000000002,
  })
  assert.equal(failed.url, '')
  assert.match(failed.desc, /请求失败/)
})

await checkAsync('广西：30 分钟到期刷新失败沿用旧密钥，一分钟后再试并恢复新值', async () => {
  clearGxtvStreamCache()
  const startedAt = 1720000000000
  const row = (url, key) => ({
    name: '广西卫视', state: 1, showChannel: 1, encodeM3u8: url,
    encodingId: 'customer', encodingKey: key,
  })
  let calls = 0
  const first = await resolveGxtvChannel('gxtv-gxws', {
    now: startedAt,
    fetchImpl: async () => {
      calls++
      return fakeResponse({ code: 0, data: { rows: [row('https://x/old.m3u8', 'old-key')] } })
    },
  })
  assert.equal(first.url, 'https://x/old.m3u8')

  const stale = await resolveGxtvChannel('gxtv-gxws', {
    now: startedAt + 30 * 60 * 1000 + 1,
    fetchImpl: async () => { calls++; throw new Error('官网瞬时故障') },
  })
  assert.equal(stale.url, first.url)
  assert.match(stale.desc, /沿用上一份/)

  const retrySuppressed = await resolveGxtvChannel('gxtv-gxws', {
    now: startedAt + 30 * 60 * 1000 + 30 * 1000,
    fetchImpl: async () => { calls++; throw new Error('一分钟内不应重试') },
  })
  assert.equal(retrySuppressed.url, first.url)
  assert.equal(calls, 2, '清单每几秒轮询时不能持续轰炸故障中的官网接口')

  const recovered = await resolveGxtvChannel('gxtv-gxws', {
    now: startedAt + 31 * 60 * 1000 + 2,
    fetchImpl: async () => {
      calls++
      return fakeResponse({ code: 0, data: { rows: [row('https://x/new.m3u8', 'new-key')] } })
    },
  })
  assert.equal(recovered.url, 'https://x/new.m3u8')
  assert.equal(calls, 3)
})

check('浙江：频道名规范化、deferredRef 带平台前缀并固定排除购物频道', () => {
  const rows = [
    { name: '浙江卫视', station_code: '101', logo: 'http://oss/a.png' },
    { name: '新闻', station_code: '107', logo: 'https://oss/n.png' },
    { name: '好易购', station_code: '111', logo: 'https://oss/s.png' },
    { name: '未知内部频道', station_code: '999' },
  ]
  const channels = buildCztvChannels(rows)
  assert.deepEqual(channels.map(ch => [ch.name, ch.deferredRef]), [
    ['浙江卫视', 'cztv-101'],
    ['浙江新闻', 'cztv-107'],
  ])
  assert.equal(channels[0].logo, 'https://oss/a.png', '台标升级为 HTTPS')
  assert.equal(channels[0].relayHls, true, '浙江清单需经本机中继，播放中才能持续换签和切 CDN')
})

await checkAsync('浙江：播放缓冲固定 3000ms，旧配置不再影响输出', async () => {
  const module = getModule('cztv')
  const result = await module.fetch({ cachingMs: 0 }, {
    fetchImpl: async () => fakeResponse({
      state: 0,
      content: { list: [{ name: '浙江卫视', station_code: '101' }] },
    }),
  })
  assert.deepEqual(result.groups[0].dataList[0].opts, ['network-caching=3000'])
})

check('浙江：优先目标画质、缺档自动回落，绝不误选 AUDIO', () => {
  const playInfo = { multiBitrateStreamList: [
    { bitrateCode: 'AUDIO', urlList: ['https://x/audio.m3u8'] },
    { bitrateCode: '720P', urlList: ['https://x/720.m3u8'] },
    { bitrateCode: '1080P', urlList: ['https://x/1080.m3u8'] },
  ] }
  assert.equal(selectCztvStream(playInfo, '1080P').url, 'https://x/1080.m3u8')
  assert.equal(selectCztvStream(playInfo, '720P').url, 'https://x/720.m3u8')
  assert.equal(selectCztvStream({ multiBitrateStreamList: [playInfo.multiBitrateStreamList[0]] }, '1080P'), null)
})

check('浙江：auth_key 与官网当前毫秒签名算法逐字节一致', () => {
  const signed = new URL(signCztvStreamUrl('https://zwebl04.cztv.com/live/channel011080Pnew.m3u8', 1720000000000))
  assert.equal(
    signed.searchParams.get('auth_key'),
    '1720000000000-0-0-0c9ec6316a9ac89cc6f1c05c406d0833',
  )
})

await checkAsync('浙江：resolve 获取播放信息、选码率、现签地址，失败不抛异常', async () => {
  clearCztvPlayInfoCache()
  let calls = 0
  const fetchImpl = async () => {
    calls++
    return fakeResponse({ success: true, code: 200, data: { multiBitrateStreamList: [
      { bitrateCode: '720P', urlList: ['https://zwebl04.cztv.com/live/channel08720Pnew.m3u8'] },
      { bitrateCode: '1080P', urlList: ['https://zwebl04.cztv.com/live/channel081080Pnew.m3u8'] },
    ] } })
  }
  const result = await resolveCztvChannel('cztv-108', {
    config: { quality: '720P' }, fetchImpl, now: 1720000000000,
  })
  assert.equal(calls, 1)
  assert.match(result.url, /channel081080Pnew\.m3u8\?auth_key=1720000000000-0-0-/,
    '旧配置即使残留 quality=720P 也必须固定选择最高档')
  assert.equal(result.relayHls, true, '旧的无后缀入口也必须持续直出清单，不能一次 302 后锁死 CDN')

  const bad = await resolveCztvChannel('cztv-999', {
    fetchImpl: async () => { throw new Error('断网') }, now: 1720000000001,
  })
  assert.equal(bad.url, '')
  assert.match(bad.desc, /请求失败/)
})

await checkAsync('浙江：首个 CDN 节点故障时自动选择后续可用节点，并短期复用健康结果', async () => {
  clearCztvPlayInfoCache()
  let apiCalls = 0
  let probeCalls = 0
  const fetchImpl = async () => {
    apiCalls++
    return fakeResponse({ success: true, code: 200, data: { multiBitrateStreamList: [
      { bitrateCode: '1080P', urlList: [
        'https://zwebl03.cztv.com/live/channel011080Pnew.m3u8',
        'https://zwebl06.cztv.com/live/channel011080Pnew.m3u8',
      ] },
    ] } })
  }
  const probeFetchImpl = async url => {
    probeCalls++
    const ok = url.includes('zwebl06.cztv.com')
    return { ok, status: ok ? 200 : 403, text: async () => ok ? '#EXTM3U\n' : '' }
  }

  const first = await resolveCztvChannel('cztv-101', {
    now: 1720000000000, fetchImpl, probeFetchImpl, config: { quality: '1080P' },
  })
  assert.match(first.url, /zwebl06\.cztv\.com/)
  assert.equal(apiCalls, 1)
  assert.equal(probeCalls, 2)

  const cached = await resolveCztvChannel('cztv-101', {
    now: 1720000001000, fetchImpl, probeFetchImpl, config: { quality: '1080P' },
  })
  assert.match(cached.url, /zwebl06\.cztv\.com/)
  assert.equal(apiCalls, 1, '播放信息五分钟内复用')
  assert.equal(probeCalls, 2, '健康节点十五秒内复用，避免每次清单轮询都重复探测')
})

await checkAsync('浙江：5 分钟到期刷新失败沿用旧播放信息，一分钟后自动恢复', async () => {
  clearCztvPlayInfoCache()
  const startedAt = 1720000000000
  const payload = path => fakeResponse({ success: true, code: 200, data: { multiBitrateStreamList: [
    { bitrateCode: '1080P', urlList: [`https://zwebl04.cztv.com/live/${path}.m3u8`] },
  ] } })
  let calls = 0
  const first = await resolveCztvChannel('cztv-101', {
    now: startedAt,
    fetchImpl: async () => { calls++; return payload('old') },
  })
  assert.match(first.url, /\/old\.m3u8/)

  const stale = await resolveCztvChannel('cztv-101', {
    now: startedAt + 5 * 60 * 1000 + 1,
    fetchImpl: async () => { calls++; throw new Error('官网瞬时故障') },
  })
  assert.match(stale.url, /\/old\.m3u8/)

  const retrySuppressed = await resolveCztvChannel('cztv-101', {
    now: startedAt + 5 * 60 * 1000 + 30 * 1000,
    fetchImpl: async () => { calls++; throw new Error('一分钟内不应重试') },
  })
  assert.match(retrySuppressed.url, /\/old\.m3u8/)
  assert.equal(calls, 2)

  const recovered = await resolveCztvChannel('cztv-101', {
    now: startedAt + 6 * 60 * 1000 + 2,
    fetchImpl: async () => { calls++; return payload('new') },
  })
  assert.match(recovered.url, /\/new\.m3u8/)
  assert.equal(calls, 3)
})

// ---- 看看新闻（上海电视台） ----

check('看看新闻：可播放的 v1 请求验签与官网双 MD5 算法固定样本一致', () => {
  const headers = buildKankanewsSignedHeaders({ channel_id: '2' }, {
    now: 1720000000000,
    nonce: 'abcd1234',
    uuid: '0123456789ABCDEFGHIJK',
  })
  assert.equal(headers.timestamp, 1720000000)
  assert.equal(headers['Api-Version'], 'v1')
  assert.equal(headers.version, '2.42.15')
  assert.equal(headers['m-uuid'], '0123456789ABCDEFGHIJK')
  assert.equal(headers.sign, '91365fae251585050ea90559bea0f3ea')
})

check('看看新闻：只收录官网 8 个正式上海频道，规范命名并固定全代理', () => {
  const rows = [
    { id: 2, name: '新闻综合', cover: 'http://p.statickksmg.com/news.png' },
    { id: 1, name: '东方卫视', cover: 'https://p.statickksmg.com/dfws.png' },
    { id: 11, name: '魔都眼' },
    { id: 5, name: '第一财经' },
    { id: 12, name: '新纪实' },
    { id: 10, name: '五星体育' },
    { id: 4, name: '都市频道' },
    { id: 9, name: '哈哈炫动' },
    { id: 99, name: '临时测试频道' },
  ]
  const channels = buildKankanewsChannels(rows)
  assert.deepEqual(channels.map(channel => channel.name), [
    '东方卫视', '上海新闻综合', '魔都眼', '第一财经',
    '新纪实', '五星体育', '上海都市', '哈哈炫动',
  ])
  assert.equal(channels[0].deferredRef, 'kankanews-1')
  assert.equal(channels[1].logo, 'https://p.statickksmg.com/news.png')
  assert.ok(channels.every(channel => channel.proxyHls === true))
})

check('看看新闻：收录上海这一刻 5 路景观直播，并区分同名电视台频道', () => {
  const channels = buildKankanewsScenicChannels([
    { id: 15989, title: '陆家嘴', play_url: 'encrypted', cover: 'http://p.statickksmg.com/ljz.jpg' },
    { id: 13755, title: '外滩观光平台', play_url: 'encrypted' },
    { id: 12835, title: '魔都眼', play_url: 'encrypted' },
    { id: 13973, title: '北外滩', play_url: 'encrypted' },
    { id: 13974, title: '外白渡桥', play_url: 'encrypted' },
    { id: 99999, title: '临时机位', play_url: 'encrypted' },
  ])
  assert.deepEqual(channels.map(channel => channel.name), [
    '陆家嘴', '外滩观光平台', '魔都眼景观', '北外滩', '外白渡桥',
  ])
  assert.equal(channels[0].deferredRef, 'kankanews-scenic-15989')
  assert.equal(channels[0].logo, 'https://p.statickksmg.com/ljz.jpg')
  assert.ok(channels.every(channel => channel.proxyHls === true))
})

check('看看新闻：分块 RSA 公钥还原能跨块拼回完整 HLS 地址，并拒绝坏密文', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 })
  const plain = 'https://volc-stream.kksmg.com/live/xwzh/index.m3u8?token=' + 'x'.repeat(180)
  const encrypted = []
  for (let offset = 0; offset < Buffer.byteLength(plain); offset += 117) {
    encrypted.push(privateEncrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(plain).subarray(offset, offset + 117)))
  }
  assert.equal(decryptKankanewsLiveAddress(Buffer.concat(encrypted).toString('base64'), publicKey), plain)
  assert.throws(() => decryptKankanewsLiveAddress('not-base64!', publicKey), /密文格式/)
})

await checkAsync('看看新闻：模块抓频道表，播放时还原短效地址并复用 150 秒缓存', async () => {
  clearKankanewsCache()
  const module = getModule('kankanews')
  const list = await module.fetch({}, { fetchImpl: async (url, options) => {
    assert.match(options.headers.sign, /^[a-f0-9]{32}$/)
    if (String(url) === 'https://kapi.kankanews.com/content/pc/tv/channels') {
      return fakeResponse({ code: '1000', result: { list: [{ id: 1, name: '东方卫视' }] } })
    }
    assert.equal(String(url), 'https://kapi.kankanews.com/content/pc/news/detail?content_id=8029037XEw6')
    return fakeResponse({ code: '1000', result: {
      play_info: [{ id: 15989, title: '陆家嘴', play_url: 'encrypted' }],
    } })
  } })
  assert.equal(list.groups[0].name, '上海电视台')
  assert.deepEqual(list.groups[0].dataList[0].opts, ['network-caching=3000'])
  assert.equal(list.groups[1].name, '上海景观')
  assert.equal(list.groups[1].dataList[0].deferredRef, 'kankanews-scenic-15989')
  assert.equal(module.claimsRef('kankanews-scenic-15989'), true)

  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 })
  const startedAt = 1720000000000
  const tokenPayload = Buffer.from(JSON.stringify({ exp: Math.floor(startedAt / 1000) + 3600 })).toString('base64url')
  const url = `https://volc-stream.kksmg.com/live/dfws4k/index.m3u8?token=x.${tokenPayload}.x&volcTime=abc`
  const scenicUrl = `https://live-ws.kksmg.com/live/sdi5/playlist.m3u8?token=x.${tokenPayload}.x&volcTime=def`
  const encryptUrl = plain => {
    const encrypted = []
    for (let offset = 0; offset < Buffer.byteLength(plain); offset += 117) {
      encrypted.push(privateEncrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(plain).subarray(offset, offset + 117)))
    }
    return Buffer.concat(encrypted).toString('base64')
  }
  let channelCalls = 0
  let scenicCalls = 0
  const fetchImpl = async requestUrl => {
    if (/channel\/detail\?channel_id=1$/.test(String(requestUrl))) {
      channelCalls++
      return fakeResponse({ code: '1000', result: {
        id: 1, name: '东方卫视', limit_time: 180,
        live_address: encryptUrl(url),
      } })
    }
    scenicCalls++
    assert.match(String(requestUrl), /news\/detail\?content_id=8029037XEw6$/)
    return fakeResponse({ code: '1000', result: {
      limit_time: 180,
      play_info: [{ id: 15989, title: '陆家嘴', play_url: encryptUrl(scenicUrl) }],
    } })
  }
  const first = await resolveKankanewsChannel('kankanews-1', {
    now: startedAt, publicKey, fetchImpl, nonce: 'abcd1234',
  })
  const cached = await resolveKankanewsChannel('kankanews-1', {
    now: startedAt + 1000, publicKey, fetchImpl, nonce: 'abcd1234',
  })
  assert.equal(first.url, url)
  assert.equal(cached.url, url)
  assert.equal(channelCalls, 1, '播放器轮询清单时不能每次都重打频道详情接口')
  assert.equal(first.upstreamHeaders.Origin, 'https://live.kankanews.com')
  assert.equal(first.upstreamHeaders.Referer, 'https://live.kankanews.com/huikan')

  const scenicFirst = await resolveKankanewsChannel('kankanews-scenic-15989', {
    now: startedAt, publicKey, fetchImpl, nonce: 'abcd1234',
  })
  const scenicCached = await resolveKankanewsChannel('kankanews-scenic-15989', {
    now: startedAt + 1000, publicKey, fetchImpl, nonce: 'abcd1234',
  })
  assert.equal(scenicFirst.url, scenicUrl)
  assert.equal(scenicCached.url, scenicUrl)
  assert.equal(scenicCalls, 1, '景观线路共用详情接口，播放器轮询时必须复用缓存')
})

// ---- 福建海博TV ----

const fjtvRow = (id, title, sortId, path, extra = {}) => ({
  id,
  title,
  sort_id: sortId,
  indexpic: `https://fyfile.fjtv.net/file/${id}.png`,
  topic_camera: [{
    // 这个字段在真实「福建综合」行里曾指向无关频道，测试确保实现不会读取它。
    extra: { play_stream_url: 'https://stream3.fjtv.net/cctv1hd/hd/live.m3u8' },
    streams: [{ hls: `https://live4-fuyun.fjtv.net/${path}/live.m3u8` }],
  }],
  ...extra,
})

const fjtvProvinceSort = '665226484478443521'
const fjtvCitySort = '665226484646215680'
const fjtvProvinceRows = () => [
  fjtvRow('665248990102917120', '综合频道', fjtvProvinceSort, 'zhpd/hd'),
  fjtvRow('665248966136664064', '东南卫视', fjtvProvinceSort, 'dnpd/hd'),
  fjtvRow('665248914378952704', '新闻频道', fjtvProvinceSort, 'xwpd/hd'),
  fjtvRow('665248752898248704', '文旅·体育频道', fjtvProvinceSort, 'dspd/hd'),
  fjtvRow('665248553475870720', '少儿频道', fjtvProvinceSort, 'child/hd'),
  fjtvRow('665248523855695872', '海峡卫视', fjtvProvinceSort, 'haixiapd/hd'),
]
const fjtvCityRows = () => [
  fjtvRow('727571808803282944', '厦门卫视', fjtvCitySort, 'hb_xmtv/sd'),
  fjtvRow('731087090473676800', '福州新闻综合频道', fjtvCitySort, 'hb_fztv/sd'),
  fjtvRow('727214415649083392', '漳州新闻综合频道', fjtvCitySort, 'hb_zztv/sd'),
  fjtvRow('727216678547394560', '三明综合频道', fjtvCitySort, 'hb_smtv/sd'),
  fjtvRow('727572738755977216', '泉州新闻综合频道', fjtvCitySort, 'hb_qztv/sd'),
  fjtvRow('727216450918322176', '南平综合频道', fjtvCitySort, 'hb_nptv/sd'),
  fjtvRow('727212352215093248', '龙岩综合频道', fjtvCitySort, 'hb_lytv/sd'),
  fjtvRow('727213694589505536', '莆田新闻综合频道', fjtvCitySort, 'hb_puttv/sd'),
  fjtvRow('727574414028103680', '平潭综合频道', fjtvCitySort, 'hb_pttv/sd'),
  fjtvRow('727213159174017024', '宁德新闻综合频道', fjtvCitySort, 'hb_ndtv/sd'),
]

const xiamenRow = definition => ({
  id: Number(definition.id),
  name: definition.rawNames[0],
  m3u8: `https://${definition.id === '18' ? 'live4' : 'live1'}.kxm.xmtv.cn/${definition.path}/playlist.m3u8?_upt=deadbeef1999999999`,
  logo: {
    square_1: {
      host: 'https://img1.kxm.xmtv.cn/',
      filename: `${definition.id}.png`,
    },
  },
  channel_stream: [{
    is_main: 1,
    m3u8: `https://${definition.id === '18' ? 'live4' : 'live1'}.kxm.xmtv.cn/${definition.path}/main/live.m3u8?_upt=deadbeef1999999999`,
  }],
})

const fakeXiamenFetch = async (requestUrl, options, { failManifestId = '' } = {}) => {
  const url = new URL(String(requestUrl))
  assert.equal(options.headers.Referer, 'https://www.xmtv.cn/')
  if (url.hostname === 'mapi1.kxm.xmtv.cn') {
    const definition = XIAMEN_CHANNELS.find(channel => channel.id === url.searchParams.get('channel_id'))
    return fakeResponse(definition ? [xiamenRow(definition)] : [])
  }
  const definition = XIAMEN_CHANNELS.find(channel => url.pathname.startsWith(`/${channel.path}/`))
  if (definition?.id === failManifestId) return { ok: false, status: 503 }
  return fakeResponse('#EXTM3U\n#EXT-X-TARGETDURATION:6\nsegment.ts\n')
}

check('福建：只读取官方 streams[].hls，不使用错误备用字段或外站地址', () => {
  assert.equal(
    fjtvHlsOf(fjtvProvinceRows()[0]),
    'https://live4-fuyun.fjtv.net/zhpd/hd/live.m3u8',
  )
  assert.equal(fjtvHlsOf({
    topic_camera: [{
      extra: { play_stream_url: 'https://stream3.fjtv.net/wrong/live.m3u8' },
      streams: [{ hls: 'https://example.com/fake/live.m3u8' }],
    }],
  }), '')
  assert.equal(fjtvHlsOf({
    topic_camera: [{ streams: [{ hls: 'http://live1-fuyun.fjtv.net/xwpd/hd/live.m3u8' }] }],
  }), '')
})

check('福建：固定输出6个省级与9个地市频道，排除重复低清厦门卫视与活动直播', () => {
  const groups = buildFjtvGroups([
    {
      sortId: fjtvProvinceSort,
      rows: [
        ...fjtvProvinceRows(),
        fjtvRow('999', '临时活动直播', fjtvProvinceSort, 'event/hd'),
        fjtvRow('665248990102917120', '错误频道名', fjtvProvinceSort, 'wrong/hd'),
      ],
    },
    { sortId: fjtvCitySort, rows: fjtvCityRows() },
  ])
  assert.deepEqual(groups.map(group => group.name), ['福建电视台', '福建地市台'])
  assert.deepEqual(
    groups[0].dataList.map(channel => channel.name),
    ['福建综合', '东南卫视', '福建新闻', '福建文旅体育', '福建少儿', '海峡卫视'],
  )
  assert.deepEqual(
    groups[1].dataList.map(channel => channel.name),
    ['福州新闻综合', '漳州新闻综合', '三明综合', '泉州新闻综合', '南平综合', '龙岩综合', '莆田新闻综合', '平潭综合', '宁德新闻综合'],
  )
  assert.ok(groups.flatMap(group => group.dataList).every(channel =>
    !channel.proxyHls && !channel.relayHls && !channel.deferredRef))
})

check('福建：福州三路替换原单路并留在既有福建地市台分组', () => {
  const groups = mergeFuzhouChannels(buildFjtvGroups([
    { sortId: fjtvProvinceSort, rows: fjtvProvinceRows() },
    { sortId: fjtvCitySort, rows: fjtvCityRows() },
  ]), FUZHOU_CHANNELS)
  assert.deepEqual(groups.map(group => group.name), ['福建电视台', '福建地市台'])
  assert.deepEqual(
    groups[1].dataList.slice(0, 5).map(channel => channel.name),
    ['福州综合', '福州生活', '福州少儿', '漳州新闻综合', '三明综合'],
  )
  assert.equal(groups[1].dataList.length, 11)
  assert.ok(!groups[1].dataList.some(channel => channel.name === '福州新闻综合'))

  const fallbackOnly = mergeFuzhouChannels([], FUZHOU_CHANNELS)
  assert.deepEqual(fallbackOnly.map(group => group.name), ['福建地市台'])
  assert.deepEqual(fallbackOnly[0].dataList.map(channel => channel.name), ['福州综合', '福州生活', '福州少儿'])
})

check('福建：排除厦门卫视，只把厦门三个地面频道并入原地市分组', () => {
  const xiamen = XIAMEN_CHANNELS.map(channel => ({
    name: channel.name,
    deferredRef: `fjtv-xiamen-${channel.id}`,
    proxyHls: true,
  }))
  const withXiamen = mergeXiamenChannels(buildFjtvGroups([
    { sortId: fjtvProvinceSort, rows: fjtvProvinceRows() },
    { sortId: fjtvCitySort, rows: fjtvCityRows() },
  ]), xiamen)
  assert.deepEqual(
    withXiamen[1].dataList.slice(0, 4).map(channel => channel.name),
    ['厦视一套', '厦视二套', '厦视三套', '福州新闻综合'],
  )
  assert.equal(withXiamen[1].dataList.length, 12)

  const merged = mergeFuzhouChannels(withXiamen, FUZHOU_CHANNELS)
  assert.deepEqual(
    merged[1].dataList.slice(0, 7).map(channel => channel.name),
    ['厦视一套', '厦视二套', '厦视三套', '福州综合', '福州生活', '福州少儿', '漳州新闻综合'],
  )
  assert.equal(merged[1].dataList.length, 14)

  const fallbackOnly = mergeFuzhouChannels(mergeXiamenChannels([], xiamen), FUZHOU_CHANNELS)
  assert.deepEqual(fallbackOnly[0].dataList.map(channel => channel.name), [
    '厦视一套', '厦视二套', '厦视三套', '福州综合', '福州生活', '福州少儿',
  ])
})

await checkAsync('福建：福州固定官方 HLS 逐路探测，单路失败不会拖掉其余频道', async () => {
  const calls = []
  const result = await fetchFuzhouChannels({ fetchImpl: async (requestUrl, options) => {
    const url = new URL(String(requestUrl))
    calls.push(url.href)
    assert.equal(url.hostname, 'live.zohi.tv')
    assert.equal(options.headers.Referer, 'https://www.zohi.tv/')
    if (url.pathname.includes('fztv-3')) return { ok: false, status: 503 }
    return fakeResponse('#EXTM3U\n#EXT-X-TARGETDURATION:6\n')
  } })
  assert.deepEqual(calls, FUZHOU_CHANNELS.map(channel => channel.url))
  assert.deepEqual(result.channels.map(channel => channel.name), ['福州综合', '福州少儿'])
  assert.match(result.warnings[0], /福州生活探测失败：HTTP 503/)

  await assert.rejects(
    () => fetchFuzhouChannels({ fetchImpl: async () => fakeResponse('<html>not hls</html>') }),
    /三路直播全部不可用.*不是 HLS 清单/,
  )
})

await checkAsync('福建：厦门官方接口严格选三路，探测失败只跳过单路', async () => {
  clearXiamenCache()
  const result = await fetchXiamenChannels({
    fetchImpl: (url, options) => fakeXiamenFetch(url, options, { failManifestId: '17' }),
  })
  assert.deepEqual(result.channels.map(channel => channel.name), ['厦视一套', '厦视三套'])
  assert.ok(result.channels.every(channel => channel.proxyHls === true && /^fjtv-xiamen-/.test(channel.deferredRef)))
  assert.match(result.warnings[0], /厦视二套探测失败：HTTP 503/)
})

await checkAsync('福建：厦门播放时刷新短效地址，并全代理官网 Referer', async () => {
  clearXiamenCache()
  let apiCalls = 0
  const fetchImpl = async (url, options) => {
    apiCalls++
    return fakeXiamenFetch(url, options)
  }
  const first = await resolveXiamenChannel('fjtv-xiamen-16', { fetchImpl, now: 1900000000000 })
  const second = await resolveXiamenChannel('fjtv-xiamen-16', { fetchImpl, now: 1900000001000 })
  assert.equal(apiCalls, 1, '未过期的短效地址应复用，避免每个播放器请求都打官方接口')
  assert.equal(first.url, second.url)
  assert.equal(first.proxyHls, true)
  assert.equal(first.upstreamHeaders.Referer, 'https://www.xmtv.cn/')
  assert.match(first.url, /^https:\/\/live1\.kxm\.xmtv\.cn\/xmtjs1\/main\/live\.m3u8\?_upt=/)
})

await checkAsync('福建：仍用一个模块和原有两组；海博失败时回落到厦门、福州六路', async () => {
  const module = getModule('fjtv')
  const calls = []
  const fetchImpl = async (requestUrl, options) => {
    const url = new URL(String(requestUrl))
    if (url.hostname === 'mapi1.kxm.xmtv.cn' || /^live\d+\.kxm\.xmtv\.cn$/.test(url.hostname)) {
      return fakeXiamenFetch(requestUrl, options)
    }
    if (url.hostname === 'live.zohi.tv') {
      assert.equal(options.headers.Referer, 'https://www.zohi.tv/')
      return fakeResponse('#EXTM3U\n#EXT-X-TARGETDURATION:6\n')
    }
    calls.push(url.searchParams.get('sort_id'))
    assert.equal(url.origin + url.pathname, 'https://mapi-plus.fjtv.net/api/open/haibo8/tv_channel_list.php')
    assert.equal(options.headers.Referer, 'https://www.fjtv.net/')
    return fakeResponse(url.searchParams.get('sort_id') === fjtvProvinceSort
      ? fjtvProvinceRows()
      : fjtvCityRows())
  }
  const result = await module.fetch({}, { fetchImpl })
  assert.deepEqual(calls, [fjtvProvinceSort, fjtvCitySort])
  assert.equal(result.groups[0].dataList.length, 6)
  assert.equal(result.groups[1].dataList.length, 14)
  assert.deepEqual(result.meta.warnings, [])

  const fallback = await module.fetch({}, { fetchImpl: async (requestUrl, options) => {
    const url = new URL(String(requestUrl))
    if (url.hostname === 'mapi1.kxm.xmtv.cn' || /^live\d+\.kxm\.xmtv\.cn$/.test(url.hostname)) {
      return fakeXiamenFetch(requestUrl, options)
    }
    if (url.hostname === 'live.zohi.tv') return fakeResponse('#EXTM3U\n#EXT-X-TARGETDURATION:6\n')
    const sortId = url.searchParams.get('sort_id')
    return fakeResponse(sortId === fjtvProvinceSort ? fjtvProvinceRows().slice(1) : fjtvCityRows())
  } })
  assert.deepEqual(fallback.groups.map(group => group.name), ['福建地市台'])
  assert.deepEqual(fallback.groups[0].dataList.map(channel => channel.name), [
    '厦视一套', '厦视二套', '厦视三套', '福州综合', '福州生活', '福州少儿',
  ])
  assert.match(fallback.meta.warnings[0], /只找到 5\/6 个正式频道/)

  await assert.rejects(
    () => module.fetch({}, { fetchImpl: async () => ({ ok: false, status: 403 }) }),
    /全部抓取失败.*HTTP 403/,
  )
})

// ---- 海南网络广播电视台 ----

const hnntvRows = () => [
  { id: 13, name: '海南卫视', code: 'STHaiNan_channel_lywsgq', type: 1, liveUrl: 'https://live2.hnntv.cn/srs/tv/lywsgq.m3u8' },
  { id: 5, name: '三沙卫视', code: 'STHaiNan_channel_ssws', type: 1, liveUrl: 'https://livessws.hnntv.cn/live/ssws_260111hnntv.m3u8' },
  { id: 1, name: '海南自贸', code: 'jjpd', type: 1, liveUrl: 'https://live2.hnntv.cn/srs/tv/jjpd.m3u8' },
  { id: 3, name: '海南新闻', code: 'STHaiNan_channel_xwpd', type: 1, liveUrl: 'https://live2.hnntv.cn/srs/tv/xwpd.m3u8' },
  { id: 4, name: '海南社会与法', code: 'ggpd', type: 1, liveUrl: 'https://live2.hnntv.cn/srs/tv/ggpd.m3u8' },
  { id: 6, name: '海南文旅', code: 'wlpd', type: 1, liveUrl: 'https://live2.hnntv.cn/srs/tv/wlpd.m3u8' },
  { id: 7, name: '海南少儿', code: 'sepd', type: 1, liveUrl: 'https://live2.hnntv.cn/srs/tv/sepd.m3u8' },
]

check('海南：只输出固定七套电视，保持官网顺序并拒绝身份错配', () => {
  const rows = hnntvRows()
  rows.reverse()
  rows.push(
    { id: 8, name: '海南交通广播', code: 'jtgb', type: 2, liveUrl: 'https://live2.hnntv.cn/srs/radio/jtgb.m3u8' },
    { id: 13, name: '伪造卫视', code: 'STHaiNan_channel_lywsgq', type: 1, liveUrl: 'https://live2.hnntv.cn/srs/tv/lywsgq.m3u8' },
    { id: 5, name: '三沙卫视', code: 'wrong', type: 1, liveUrl: 'https://example.com/ssws.m3u8' },
  )
  const channels = buildHnntvChannels(rows)
  assert.deepEqual(channels.map(channel => channel.name), [
    '海南卫视', '三沙卫视', '海南自贸', '海南新闻', '海南社会与法', '海南文旅', '海南少儿',
  ])
  assert.deepEqual(channels.map(channel => channel.deferredRef), [
    'hnntv-13', 'hnntv-5', 'hnntv-1', 'hnntv-3', 'hnntv-4', 'hnntv-6', 'hnntv-7',
  ])
  assert.ok(channels.every(channel => !channel.proxyHls && !channel.relayHls))
})

await checkAsync('海南：抓取七套频道，播放时签名并在有效期内复用地址', async () => {
  clearHnntvCache()
  const startedAt = 1720000000000
  const signedUrl = 'https://live2.hnntv.cn/srs/tv/lywsgq.m3u8?_upt=deadbeef1720007200'
  let listCalls = 0
  let playCalls = 0
  const fetchImpl = async (requestUrl, options = {}) => {
    const url = new URL(String(requestUrl))
    assert.equal(options.headers.Origin, 'https://www.hnntv.cn')
    if (url.hostname === 'www.hnntv.cn') {
      listCalls++
      assert.equal(url.searchParams.get('type'), '1')
      return fakeResponse({ businessCode: '00000', resultSet: hnntvRows() })
    }
    playCalls++
    assert.equal(url.hostname, 'ps.hnntv.cn')
    assert.equal(url.searchParams.get('channelCode'), 'STHaiNan_channel_lywsgq')
    assert.equal(url.searchParams.get('appCode'), '')
    assert.equal(url.searchParams.get('token'), '')
    return fakeResponse({ businessCode: 200, resultSet: [{ url: signedUrl }] })
  }

  const module = getModule('hnntv')
  const result = await module.fetch({}, { fetchImpl, now: startedAt })
  assert.equal(result.groups[0].name, '海南电视台')
  assert.equal(result.groups[0].dataList.length, 7)

  const first = await resolveHnntvChannel('hnntv-13', { fetchImpl, now: startedAt + 1000 })
  const cached = await resolveHnntvChannel('hnntv-13', { fetchImpl, now: startedAt + 2000 })
  assert.equal(first.url, signedUrl)
  assert.equal(cached.url, signedUrl)
  assert.equal(first.upstreamHeaders, undefined)
  assert.equal(listCalls, 1)
  assert.equal(playCalls, 1)
})

// ---- 河南大象新闻 ----

check('河南：官网请求实际使用 SHA-256（不是 MD5）且时间戳为秒', () => {
  const now = 1720000000123
  const headers = buildHntvSignedHeaders(now)
  assert.equal(headers.timestamp, '1720000000')
  assert.equal(
    headers.sign,
    createHash('sha256').update('6ca114a836ac7d731720000000').digest('hex'),
  )
  assert.equal(headers.sign.length, 64)
})

check('河南：只输出固定正式频道、规范名称并排除购物与 ID/名称错配', () => {
  const expiry = Math.floor(Date.now() / 1000) + 14400
  const stream = id => `http://tvcdn.stream3.hndt.com/tv/${id}/playlist.m3u8?wsSecret=x&wsTime=${expiry}`
  const channels = buildHntvChannels([
    { cid: 145, name: '河南卫视', image: '/a.png', video_streams: [stream('ws')] },
    { cid: 149, name: '新闻频道', image: '/b.png', video_streams: [stream('news')] },
    { cid: 150, name: '欢腾购物', video_streams: [stream('shopping')] },
    { cid: 141, name: '伪造频道', video_streams: [stream('wrong')] },
  ])
  assert.deepEqual(channels.map(channel => channel.name), ['河南卫视', '河南新闻'])
  assert.deepEqual(channels.map(channel => channel.deferredRef), ['hntv-145', 'hntv-149'])
  assert.ok(channels.every(channel => !channel.proxyHls && !channel.relayHls))
  assert.equal(channels[0].logo, 'https://static.hntv.tv/a.png')
})

await checkAsync('河南：模块用签名频道接口取流，缓存后播放不重复联网', async () => {
  clearHntvCache()
  const startedAt = 1720000000000
  const expiry = Math.floor(startedAt / 1000) + 14400
  const rows = [
    {
      cid: 145, name: '河南卫视', image: '/anonymous/ws.png',
      video_streams: [`http://tvcdn.stream3.hndt.com/tv/ws/playlist.m3u8?wsSecret=x&wsTime=${expiry}`],
    },
    {
      cid: 149, name: '新闻频道', image: '/anonymous/news.png',
      video_streams: [`http://tvcdn.stream3.hndt.com/tv/news/playlist.m3u8?wsSecret=y&wsTime=${expiry}`],
    },
    {
      cid: 150, name: '欢腾购物', image: '/anonymous/shop.png',
      video_streams: [`http://tvcdn.stream3.hndt.com/tv/shop/playlist.m3u8?wsSecret=z&wsTime=${expiry}`],
    },
  ]
  let calls = 0
  const fetchImpl = async (_url, options) => {
    calls++
    assert.equal(options.headers.timestamp, '1720000000')
    assert.equal(options.headers.sign.length, 64)
    assert.equal(options.headers.Origin, 'https://static.hntv.tv')
    return fakeResponse(rows)
  }
  const module = getModule('hntv')
  const result = await module.fetch({}, { fetchImpl, now: startedAt })
  assert.deepEqual(result.groups[0].dataList.map(channel => channel.name), ['河南卫视', '河南新闻'])

  const resolved = await resolveHntvChannel('hntv-145', {
    now: startedAt + 1000,
    fetchImpl: async () => { throw new Error('有效缓存内不应联网') },
  })
  assert.match(resolved.url, /^https:\/\/tvcdn\.stream3\.hndt\.com\//)
  assert.equal(resolved.upstreamHeaders, undefined)
  assert.equal(calls, 1)
})

// ---- 山东齐鲁网 ----

const iqiluPage = (id, name) => `
  <script>var _pdCid = "${id}"; var _pdName = "${name}";</script>
  <script>
    var dF = 'https://feiying.litenews.cn/api/';
    var aF = 'v1/auth/exchange';
    var mxpx = 'QZMVKTRHPLXADJNE';
    var aly = 'BWRFYSNCOGIXUTPA';
  </script>`

check('山东：从官方频道页提取频道 ID 与鉴权参数，并拒绝伪造接口', () => {
  const definition = { slug: 'qlpd', name: '齐鲁频道', pageName: '齐鲁频道', logo: '' }
  const row = parseIqiluChannelPage(iqiluPage('24584', '齐鲁频道'), definition)
  assert.equal(row.id, '24584')
  assert.equal(row.auth.endpoint, 'https://feiying.litenews.cn/api/v1/auth/exchange')
  assert.throws(
    () => parseIqiluChannelPage(iqiluPage('24584', '错误频道'), definition),
    /频道名不符合预期/,
  )
  assert.throws(
    () => parseIqiluChannelPage(iqiluPage('24584', '齐鲁频道').replace('feiying.litenews.cn', 'example.com'), definition),
    /鉴权参数不符合预期/,
  )
})

check('山东：exchange 请求与官网 MD5 + AES-128-CBC 算法一致', () => {
  const row = parseIqiluChannelPage(
    iqiluPage('24584', '齐鲁频道'),
    { slug: 'qlpd', name: '齐鲁频道', pageName: '齐鲁频道', logo: '' },
  )
  const now = 1720000000123
  const request = buildIqiluExchangeRequest(row, now)
  const url = new URL(request.url)
  assert.equal(url.searchParams.get('t'), String(now))
  assert.equal(
    url.searchParams.get('s'),
    createHash('md5').update(`24584${now}QZMVKTRHPLXADJNE`).digest('hex'),
  )

  const key = Buffer.from('BWRFYSNCOGIXUTPA')
  const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x30))
  const plain = Buffer.concat([decipher.update(request.body, 'base64'), decipher.final()]).toString('utf8')
  assert.equal(plain, JSON.stringify({ channelMark: '24584' }))
})

await checkAsync('山东：九个官方频道全部加入，播放鉴权结果按频道复用且不声明全代理', async () => {
  clearIqiluCache()
  const pages = {
    sdtv: ['24581', '山东卫视'], qlpd: ['24584', '齐鲁频道'], ggpd: ['24602', '新闻频道'],
    typd: ['24587', '体育休闲频道'], shpd: ['24596', '生活频道'], zypd: ['24593', '综艺频道'],
    nkpd: ['24599', '农科频道'], yspd: ['24590', '文旅频道'], sepd: ['24605', '少儿频道'],
  }
  let exchangeCalls = 0
  const streamUrl = 'https://tstreamlive302.iqilu.com/21/test/playlist.m3u8?k=x&t=1'
  const encryptedResponse = () => {
    const cipher = createCipheriv(
      'aes-128-cbc',
      Buffer.from('BWRFYSNCOGIXUTPA'),
      Buffer.alloc(16, 0x30),
    )
    return Buffer.concat([
      cipher.update(JSON.stringify({ code: 1, data: streamUrl })),
      cipher.final(),
    ]).toString('base64')
  }
  const fetchImpl = async (requestUrl, options = {}) => {
    const url = new URL(String(requestUrl))
    if (url.hostname === 'v.iqilu.com') {
      const slug = url.pathname.split('/').filter(Boolean).pop()
      const row = pages[slug]
      assert.ok(row, `未预期频道页 ${slug}`)
      return { ok: true, status: 200, text: async () => iqiluPage(row[0], row[1]) }
    }
    exchangeCalls++
    assert.equal(options.method, 'POST')
    assert.equal(options.headers['Content-Type'], 'text/plain')
    assert.equal(options.headers.Origin, 'https://v.iqilu.com')
    return { ok: true, status: 200, text: async () => encryptedResponse() }
  }

  const module = getModule('iqilu')
  const result = await module.fetch({}, { fetchImpl })
  assert.deepEqual(
    result.groups[0].dataList.map(channel => channel.name),
    ['山东卫视', '齐鲁频道', '山东新闻', '山东体育休闲', '山东生活', '山东综艺', '山东农科', '山东文旅', '山东少儿'],
  )
  assert.ok(result.groups[0].dataList.every(channel => !channel.proxyHls && !channel.relayHls))

  const first = await resolveIqiluChannel('iqilu-qlpd', { fetchImpl, now: 1720000000123 })
  const cached = await resolveIqiluChannel('iqilu-qlpd', { fetchImpl, now: 1720000001123 })
  assert.equal(first.url, streamUrl)
  assert.equal(cached.url, streamUrl)
  assert.equal(exchangeCalls, 1)
  assert.equal(first.upstreamHeaders, undefined)
  assert.deepEqual(decryptIqiluExchangeResponse(encryptedResponse(), 'BWRFYSNCOGIXUTPA'), { code: 1, data: streamUrl })
})

// ---- 江苏网络台 ----

check('江苏：Web 鉴权签名与官网算法固定样本一致', () => {
  const request = buildJstvAuthRequest(1720000000000, '0123456789abcdef0123456789abcdef')
  assert.equal(request.body.platform, 41)
  assert.equal(request.body.appId, '3b93c452b851431c8b3a076789ab1e14')
  assert.match(request.url, /TT=-235964777/)
  assert.match(request.url, /Sign=d66d6d8c6ab4cec57f79653449c88013/)
})

check('江苏：短效 HLS 签名切换到网页播放域名并保留路径', () => {
  const signed = signJstvStreamUrl(
    'https://litchi-play-encrypted.jstv.com/applive/jswspro.m3u8',
    1720000000000,
  )
  assert.equal(
    signed,
    'https://litchi-play-encrypted-site.jstv.com/applive/jswspro.m3u8?txSecret=7f4e425e5f26c7a18c8679e376d746c5&txTime=66851eb4',
  )
})

check('江苏：4K 与普通频道默认全部加入且走全代理', () => {
  const rows = [
    { id: '670', name: '江苏卫视', url: 'https://x.jstv.com/applive/jswspro.m3u8', logo: 'a.png' },
    { id: '676', name: '江苏卫视4K', url: 'https://x.jstv.com/4klive/jsws4kpro.m3u8', logo: 'b.png' },
  ]
  const channels = buildJstvChannels(rows)
  assert.deepEqual(channels.map(x => x.name), ['江苏卫视', '江苏卫视4K'])
  assert.equal(channels[0].deferredRef, 'jstv-670')
  assert.ok(channels.every(x => x.proxyHls === true))
})

await checkAsync('江苏：模块取 Bearer 频道表，缓存后播放时签名并声明防盗链请求头', async () => {
  clearJstvCache()
  const futureExp = Math.floor(Date.now() / 1000) + 600
  const token = `x.${Buffer.from(JSON.stringify({ exp: futureExp })).toString('base64url')}.x`
  const articles = [
    {
      title: '江苏卫视', extraId: '670', thumbnailsJson: ['https://images.jstv.com/jsws.png'],
      extraJson: { url: 'https://litchi-play-encrypted.jstv.com/applive/jswspro.m3u8' },
    },
    {
      title: '江苏卫视4K超高清', extraId: '676', thumbnailsJson: ['https://images.jstv.com/jsws4k.png'],
      extraJson: { url: 'https://litchi-play-encrypted.jstv.com/4klive/jsws4kpro.m3u8' },
    },
  ]
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options })
    if (String(url).includes('/JwtAuth/GetWebToken')) {
      return fakeResponse({ code: 200, data: { accessToken: token } })
    }
    return fakeResponse({ code: 200, data: { articles } })
  }
  const module = getModule('jstv')
  const result = await module.fetch({ cachingMs: 0 }, { fetchImpl })
  assert.deepEqual(result.groups[0].dataList.map(x => x.name), ['江苏卫视', '江苏卫视4K'])
  assert.ok(result.groups[0].dataList.every(x => x.opts?.[0] === 'network-caching=3000'), '旧配置不影响固定缓冲')
  assert.equal(calls.length, 2)
  assert.match(calls[1].options.headers.Authorization, /^Bearer /)

  const resolved = await resolveJstvChannel('jstv-670', {
    now: 1720000000000,
    fetchImpl: async () => { throw new Error('已有频道缓存时不该联网') },
  })
  assert.match(resolved.url, /txSecret=/)
  assert.equal(resolved.upstreamHeaders.Origin, 'https://live.jstv.com')
  assert.equal(resolved.upstreamHeaders.Referer, 'https://live.jstv.com/')
})

// ---- 河北广播电视台「冀时」 ----

const hebtvArticle = ({ id, title, path, key = 'k5m9p2x8r4b3' }) => ({
  id,
  title,
  logo: 'http://pic.cmc.hebrts.cn/logo.png',
  appCustomParams: { movie: { liveUri: path, liveKey: key } },
  liveVideo: [{ type: 'PC', formats: [{ url: `https://tv.pull.hebtv.com${path}` }] }],
})

const hebtvScenicArticle = ({ id, title, active = true }) => ({
  id,
  title,
  type: '15',
  appCustomParams: JSON.stringify({
    movie: { liveStatus: active ? 1 : 0 },
    customStyle: { imgPath: ['http://pic.cmc.hebrts.cn/scenic.jpg'] },
  }),
})

check('河北：官网直播稿件规范成六套频道，固定排除三佳购物与未知稿件', () => {
  const rows = normalizeHebtvRows([
    hebtvArticle({ id: 10524916, title: '河北卫视', path: '/jishi/weishipindao.m3u8' }),
    hebtvArticle({ id: 10516507, title: '经济生活', path: '/jishi/jingjishenghuo.m3u8' }),
    hebtvArticle({ id: 10516509, title: '河北都市', path: '/jishi/dushipindao.m3u8' }),
    hebtvArticle({ id: 10516510, title: '文旅体育', path: '/zhibo/yingshijupindao.m3u8' }),
    hebtvArticle({ id: 10516511, title: '少儿科教', path: '/jishi/shaoerkejiao.m3u8' }),
    hebtvArticle({ id: 10516508, title: '三农频道', path: '/jishi/nongminpindao.m3u8' }),
    hebtvArticle({ id: 10516513, title: '三佳购物', path: '/zhibo/sanjiagouwu.m3u8' }),
    hebtvArticle({ id: 1, title: '内部测试', path: '/jishi/test.m3u8' }),
  ])
  assert.deepEqual(rows.map(row => row.name), [
    '河北卫视', '河北经济生活', '河北都市', '河北文旅体育', '河北少儿科教', '河北三农',
  ])
  const channels = buildHebtvChannels(rows)
  assert.equal(channels.length, 6)
  assert.equal(channels[0].deferredRef, 'hebtv-10524916')
  assert.ok(channels.every(channel => channel.relayHls === true))
  assert.equal(channels[0].logo, 'https://pic.cmc.hebrts.cn/logo.png')
})

check('河北：美丽河北只收城市慢直播稿件，详情严格校验官方 CDN 与签名字段', () => {
  const articles = normalizeHebtvScenicArticles([
    hebtvScenicArticle({ id: 11605050, title: '慢直播丨石家庄' }),
    hebtvScenicArticle({ id: 11605048, title: '慢直播｜雄安新区' }),
    hebtvScenicArticle({ id: 11417638, title: '慢直播丨秘境精灵' }),
    hebtvScenicArticle({ id: 1, title: '慢直播丨承德', active: false }),
  ])
  assert.deepEqual(articles.map(row => row.name), ['石家庄', '雄安新区'])
  assert.equal(articles[0].logo, 'https://pic.cmc.hebrts.cn/scenic.jpg')

  const detail = normalizeHebtvScenicDetail({ data: {
    articleId: 11605050,
    title: '慢直播丨石家庄',
    status: '1',
    livePath: 'https://live.pull.hebtv.com/live/mzb173.m3u8',
    cdnUri: '/live/mzb173.m3u8',
    cdnKey: 'k5m9p2x8r4b3',
  } }, articles[0])
  assert.equal(detail.name, '石家庄')
  assert.equal(detail.scenic, true)
  assert.equal(normalizeHebtvScenicDetail({ data: {
    articleId: 11605050,
    title: '慢直播丨石家庄',
    status: '1',
    livePath: 'https://evil.example/live/mzb173.m3u8',
    cdnUri: '/live/mzb173.m3u8',
    cdnKey: 'k5m9p2x8r4b3',
  } }, articles[0]), null)
})

check('河北：两小时 t/k 签名与官网播放器固定样本逐字节一致', () => {
  const signed = new URL(signHebtvStreamUrl(
    'https://tv.pull.hebtv.com/jishi/weishipindao.m3u8',
    '/jishi/weishipindao.m3u8',
    'k5m9p2x8r4b3',
    1720000000000,
  ))
  assert.equal(signed.searchParams.get('t'), '1720007200')
  assert.equal(signed.searchParams.get('k'), '00496e7b70332f38d30084b44155b50d')
  const scenic = new URL(signHebtvStreamUrl(
    'https://live.pull.hebtv.com/live/mzb173.m3u8',
    '/live/mzb173.m3u8',
    'k5m9p2x8r4b3',
    1720000000000,
  ))
  assert.equal(scenic.searchParams.get('t'), '1720007200')
  assert.equal(scenic.searchParams.get('k'), '6f67777fbd80dba9e24ed067cfe74275')
  assert.throws(() => signHebtvStreamUrl(
    'https://example.com/jishi/weishipindao.m3u8',
    '/jishi/weishipindao.m3u8',
    'k5m9p2x8r4b3',
    1720000000000,
  ), /不是河北广电/)
})

await checkAsync('河北：模块同步电视与景观两组，按真实流去重并在播放时复用缓存现签', async () => {
  clearHebtvCache()
  let calls = 0
  const articles = [
    hebtvArticle({ id: 10524916, title: '河北卫视', path: '/jishi/weishipindao.m3u8' }),
    hebtvArticle({ id: 10516513, title: '三佳购物', path: '/zhibo/sanjiagouwu.m3u8' }),
  ]
  const scenicArticles = [
    hebtvScenicArticle({ id: 11605050, title: '慢直播丨石家庄' }),
    hebtvScenicArticle({ id: 12348364, title: '慢直播丨平山' }),
  ]
  const fetchImpl = async (rawUrl, options) => {
    calls++
    const url = String(rawUrl)
    if (url.includes('getArticleList')) {
      assert.equal(options.method, 'POST')
      return fakeResponse({ returnCode: '0000', returnDesc: '成功', returnData: { news: articles } })
    }
    assert.equal(options.method, 'GET')
    if (url.includes('findPage')) {
      return fakeResponse({ data: { pageRecords: scenicArticles } })
    }
    const id = new URL(url).searchParams.get('articleId')
    const article = scenicArticles.find(row => String(row.id) === id)
    return fakeResponse({ state: 200, data: {
      articleId: article.id,
      title: article.title,
      status: '1',
      livePath: 'https://live.pull.hebtv.com/live/mzb173.m3u8',
      cdnUri: '/live/mzb173.m3u8',
      cdnKey: 'k5m9p2x8r4b3',
    } })
  }
  const module = getModule('hebtv')
  const result = await module.fetch({}, { fetchImpl, now: 1720000000000 })
  assert.equal(result.groups[0].name, '河北电视台')
  assert.deepEqual(result.groups[0].dataList.map(channel => channel.name), ['河北卫视'])
  assert.ok(result.groups[0].dataList.every(channel => channel.opts?.[0] === 'network-caching=3000'))
  assert.equal(result.groups[1].name, '河北景观')
  assert.deepEqual(result.groups[1].dataList.map(channel => channel.name), ['石家庄'])
  assert.match(result.meta.warnings[0], /平山.*共用直播流/)

  const resolved = await resolveHebtvChannel('hebtv-10524916', {
    now: 1720000001000,
    fetchImpl: async () => { throw new Error('已有频道缓存时不该联网') },
  })
  assert.equal(calls, 4)
  assert.match(resolved.url, /^https:\/\/tv\.pull\.hebtv\.com\/jishi\/weishipindao\.m3u8\?t=1720007201&k=/)
  assert.equal(resolved.relayHls, true)
  assert.equal(resolved.upstreamHeaders.Origin, 'https://www.hebrts.cn')

  const scenicResolved = await resolveHebtvChannel('hebtv-11605050', {
    now: 1720000001000,
    fetchImpl: async () => { throw new Error('景观也必须复用同一份缓存') },
  })
  assert.match(scenicResolved.url, /^https:\/\/live\.pull\.hebtv\.com\/live\/mzb173\.m3u8\?t=1720007201&k=/)

  const bad = await resolveHebtvChannel('hebtv-999', { now: 1720000001000 })
  assert.equal(bad.url, '')
  assert.match(bad.desc, /不在官网列表/)
})

// ---- 深圳广电「第一现场」 ----

const sztvRows = () => [
  {
    id: 24725, name: '深圳卫视4K超高清', logo: 'https://www.sztv.com.cn/4k.jpg',
    extend: { liveId: 'R77mK1v', liveRate: [500], backGroundImageV1: '' },
  },
  {
    id: 7867, name: '深圳卫视', logo: 'https://www.sztv.com.cn/ws.jpg',
    extend: { liveId: 'AxeFRth', liveRate: [500], backGroundImageV1: '' },
  },
  {
    id: 7868, name: '都市频道', logo: '',
    extend: { liveId: 'ZwxzUXr', liveRate: [500], backGroundImageV1: 'https://www.sztv.com.cn/ds.jpg' },
  },
  { id: 7880, name: '电视剧频道', extend: { liveId: '4azbkoY', liveRate: [500] } },
  { id: 7881, name: '少儿频道', extend: { liveId: '1SIQj6s', liveRate: [500] } },
  { id: 7869, name: '移动电视', extend: { liveId: 'wDF6KJ3', liveRate: [500] } },
  { id: 7878, name: '宜和购物频道', extend: { liveId: 'BJ5u5k2', liveRate: [500] } },
  { id: 7944, name: '国际频道', extend: { liveId: 'sztvgjpd', liveRate: [500] } },
]

check('深圳：匿名 Web HMAC 固定样本与官网 yszsdk 一致', () => {
  const now = 1720000000000
  const nonce = '01234567-89ab-4cde-8123-456789abcdef'
  const auth = buildSztvCatalogAuth(undefined, now, nonce)
  const date = new Date(now).toUTCString()
  const canonical = `x-date: ${date}\n@request-target: get /api/com/catalog/getCatalogList\nhost: apix.scms.sztv.com.cn\nnonce: ${nonce}`
  const secret = Buffer.from('eFVKN0dsczQ1U3QwQ1RuYXRud1p3c0g0VXlZajBycFg=', 'base64').toString('utf8')
  const expected = createHmac('sha512', secret).update(canonical).digest('base64')
  assert.equal(auth['X-Date'], date)
  assert.equal(auth.Nonce, nonce)
  assert.match(auth.Authorization, /^hmac username="onesz"/)
  assert.ok(auth.Authorization.endsWith(`signature="${expected}"`))
})

check('深圳：直播 Key 请求、混淆解码及 CDN 逐路径签名与固定样本一致', () => {
  const now = 1720000000000
  const keyRequest = new URL(buildSztvLiveKeyRequest('R77mK1v', now))
  assert.equal(keyRequest.searchParams.get('t'), '1720000000')
  assert.equal(
    keyRequest.searchParams.get('token'),
    createHash('md5').update('1720000000R77mK1vcutvLiveStream|Dream2017').digest('hex'),
  )
  assert.equal(decodeSztvLiveKey('"nUzgzN==AM3M"'), '783Rs70')
  const signed = new URL(signSztvStreamUrl(
    'https://sztv-live.sztv.com.cn/R77mK1v/500/783Rs70.m3u8',
    now,
  ))
  assert.equal(signed.searchParams.get('t'), '66853a20')
  assert.equal(
    signed.searchParams.get('sign'),
    createHash('md5').update(`ejow6p6p6hmrm9g96beh2knecdq5kyw9bp0zxyg7${signed.pathname}66853a20`).digest('hex'),
  )
  assert.throws(() => signSztvStreamUrl('https://example.com/steal.ts', now), /不是深圳广电/)
})

check('深圳：固定排除购物，七套频道规范命名并全部走全代理', () => {
  const rows = sztvRows().filter(row => row.name !== '宜和购物频道').map(row => ({
    id: String(row.id),
    name: ({
      深圳卫视4K超高清: '深圳卫视4K', 深圳卫视: '深圳卫视', 都市频道: '深圳都市',
      电视剧频道: '深圳电视剧', 少儿频道: '深圳少儿', 移动电视: '深圳移动电视', 国际频道: '深圳国际',
    })[row.name],
    liveId: row.extend.liveId,
    rate: row.extend.liveRate[0],
    logo: row.logo || row.extend.backGroundImageV1 || '',
  }))
  const channels = buildSztvChannels(rows)
  assert.deepEqual(channels.map(channel => channel.name), [
    '深圳卫视4K', '深圳卫视', '深圳都市', '深圳电视剧', '深圳少儿', '深圳移动电视', '深圳国际',
  ])
  assert.deepEqual(channels.map(channel => channel.deferredRef), [
    'sztv-24725', 'sztv-7867', 'sztv-7868', 'sztv-7880', 'sztv-7881', 'sztv-7869', 'sztv-7944',
  ])
  assert.ok(channels.every(channel => channel.proxyHls === true))
})

await checkAsync('深圳：模块取七套官网频道，播放时换 Key 并提供分片动态签名器', async () => {
  clearSztvCache()
  let catalogCalls = 0
  let keyCalls = 0
  const fetchImpl = async (requestUrl, options = {}) => {
    const url = new URL(String(requestUrl))
    if (url.hostname === 'apix.scms.sztv.com.cn') {
      catalogCalls++
      assert.match(options.headers.Authorization, /^hmac username="onesz"/)
      assert.match(options.headers.Nonce, /^[0-9a-f-]{36}$/)
      return fakeResponse({ returnCode: '0000', returnDesc: '成功', returnData: sztvRows() })
    }
    keyCalls++
    assert.equal(url.hostname, 'hls-api.sztv.com.cn')
    assert.equal(url.searchParams.get('id'), 'R77mK1v')
    assert.equal(options.headers.Origin, 'https://www.sztv.com.cn')
    return fakeResponse('"nUzgzN==AM3M"')
  }

  const module = getModule('sztv')
  const result = await module.fetch({}, { fetchImpl })
  assert.equal(result.groups[0].name, '广东')
  assert.deepEqual(result.groups[0].dataList.map(channel => channel.name), [
    '深圳卫视4K', '深圳卫视', '深圳都市', '深圳电视剧', '深圳少儿', '深圳移动电视', '深圳国际',
  ])

  const first = await resolveSztvChannel('sztv-24725', { fetchImpl, now: 1720000000000 })
  const cached = await resolveSztvChannel('sztv-24725', { fetchImpl, now: 1720000001000 })
  assert.match(first.url, /^https:\/\/sztv-live\.sztv\.com\.cn\/R77mK1v\/500\/783Rs70\.m3u8\?sign=/)
  assert.equal(first.upstreamHeaders.Origin, 'https://www.sztv.com.cn')
  assert.equal(typeof first.upstreamUrlTransform, 'function')
  assert.match(
    first.upstreamUrlTransform('https://sztv-live.sztv.com.cn/R77mK1v/500/123/456.ts'),
    /\/456\.ts\?sign=[0-9a-f]{32}&t=[0-9a-f]+$/,
  )
  assert.match(cached.url, /783Rs70\.m3u8/)
  assert.equal(catalogCalls, 1)
  assert.equal(keyCalls, 1)
})

// ---- 芒果 TV ----

check('芒果：固定排除快乐购，官网分类重复频道只输出一次且全部走全代理', () => {
  const rows = [
    { id: '287', name: '金鹰卡通', channel_image: 'http://0img.hitv.com/jykt.jpg' },
    { id: '267', name: '快乐购', channel_image: '' },
    { id: '280', name: '湖南经视', channel_image: 'https://2img.hitv.com/hnjs.jpg' },
    { id: '287', name: '金鹰卡通', channel_image: 'https://2img.hitv.com/duplicate.jpg' },
    { id: '999', name: '临时活动直播', channel_image: '' },
  ]
  const channels = buildMgtvChannels(rows)
  assert.deepEqual(channels.map(channel => channel.name), ['金鹰卡通', '湖南经视'])
  assert.equal(channels[0].deferredRef, 'mgtv-287')
  assert.equal(channels[0].logo, 'https://0img.hitv.com/jykt.jpg')
  assert.ok(channels.every(channel => channel.proxyHls === true))
})

check('芒果：播放签名与官网固定样本一致，且最高 definition 同档优先 H.264', () => {
  const request = new URL(buildMgtvSourceRequest('287', {
    now: 1787985107731,
    deviceId: '494daf13-3a4d-4e45-a020-3d24c425b9d4',
  }))
  assert.equal(request.searchParams.get('sign'), 'AD8915099571D2CDE4CFCF5F6CA95715')
  assert.equal(request.searchParams.get('_support'), '10000000')

  const selected = selectMgtvSource({ sources: [
    { definition: 1, name: '480P', format: '.m3u8', videoFormat: 'h264', url: 'https://padal.qing.mgtv.com/live/480.m3u8' },
    { definition: 3, name: '1080P', format: '.m3u8', videoFormat: 'h265', url: 'https://padhw.qing.mgtv.com/live/1080-hevc.m3u8' },
    { definition: 3, name: '1080P', format: '.m3u8', videoFormat: 'h264', url: 'https://padqq.qing.mgtv.com/live/1080-avc.m3u8' },
  ] })
  assert.match(selected.url, /1080-avc\.m3u8$/)
})

await checkAsync('芒果：模块取官方频道表，播放时签名并声明防盗链请求头', async () => {
  clearMgtvCache()
  const module = getModule('mgtv')
  const listResult = await module.fetch({}, { fetchImpl: async url => {
    assert.match(String(url), /media_asset_id=TVStationAll/)
    return fakeResponse({ errno: '0', data: { category: [
      { channels: [
        { id: '287', name: '金鹰卡通', channel_image: 'http://0img.hitv.com/jykt.jpg' },
        { id: '267', name: '快乐购', channel_image: '' },
      ] },
    ] } })
  } })
  assert.deepEqual(listResult.groups[0].dataList.map(channel => channel.name), ['金鹰卡通'])

  let calls = 0
  const resolved = await resolveMgtvChannel('mgtv-287', {
    now: 1720000000000,
    deviceId: '00000000-0000-4000-8000-000000000001',
    fetchImpl: async url => {
      calls++
      assert.match(String(url), /cameraId=287/)
      return fakeResponse({ code: 0, data: { activityName: '金鹰卡通', sources: [
        { definition: 1, name: '480P', format: '.m3u8', videoFormat: 'h264', urlExpireDuration: 28800,
          url: 'https://padal.qing.mgtv.com/live/480.m3u8' },
        { definition: 3, name: '1080P', format: '.m3u8', videoFormat: 'h264', urlExpireDuration: 28800,
          url: 'https://padqq.qing.mgtv.com/live/1080.m3u8' },
      ] } })
    },
  })
  assert.equal(calls, 1)
  assert.match(resolved.url, /1080\.m3u8$/)
  assert.equal(resolved.upstreamHeaders.Origin, 'https://www.mgtv.com')
  assert.equal(resolved.upstreamHeaders.Referer, 'https://www.mgtv.com/')
})

await checkAsync('芒果：每小时提前换新，失败沿用未过期地址并一分钟后恢复', async () => {
  clearMgtvCache()
  const startedAt = 1720000000000
  let calls = 0
  const payload = suffix => fakeResponse({ code: 0, data: { activityName: '金鹰卡通', sources: [
    { definition: 1, name: '480P', format: '.m3u8', videoFormat: 'h264', urlExpireDuration: 28800,
      url: `https://padal.qing.mgtv.com/live/${suffix}.m3u8` },
  ] } })
  const first = await resolveMgtvChannel('mgtv-287', {
    now: startedAt,
    fetchImpl: async () => { calls++; return payload('old') },
  })
  assert.match(first.url, /old\.m3u8$/)

  const stale = await resolveMgtvChannel('mgtv-287', {
    now: startedAt + 60 * 60 * 1000 + 1,
    fetchImpl: async () => { calls++; throw new Error('官网瞬时故障') },
  })
  assert.match(stale.url, /old\.m3u8$/)

  const retrySuppressed = await resolveMgtvChannel('mgtv-287', {
    now: startedAt + 60 * 60 * 1000 + 30 * 1000,
    fetchImpl: async () => { calls++; throw new Error('一分钟内不应重试') },
  })
  assert.match(retrySuppressed.url, /old\.m3u8$/)
  assert.equal(calls, 2)

  const recovered = await resolveMgtvChannel('mgtv-287', {
    now: startedAt + 61 * 60 * 1000 + 2,
    fetchImpl: async () => { calls++; return payload('new') },
  })
  assert.match(recovered.url, /new\.m3u8$/)
  assert.equal(calls, 3)
})

console.log(`\n全部通过：${passed} ✅`)
