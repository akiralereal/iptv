#!/usr/bin/env node
/**
 * 仓库内置台标回归测试（utils/logoPack.js、scripts/build-logo-pack.mjs、logo-pack/）
 *
 * 不变量：
 * 1. 模块频道先按「模块/频道编号」精确对应，其次按台标名匹配（规则同台标库，含补分组前缀）；
 * 2. 通用名（新闻综合、少儿频道）在包里带地名存，外部 m3u 里裸的通用名不会贴上别家的图；
 * 3. 优先级：频道自带的托管图 > 内置 > 用户自配台标库；自带的坏了或还没下成功就用内置；
 * 4. /logo-pack/ 只认 index.json 登记过的文件；后台把内置台标标成「内置」，
 *    别人引用仓库 logos 目录的公网地址不会被误当成本地上传；
 * 5. 仓库里的 logo-pack/ 与 index.json 一一对应：文件都在、哈希对得上、都是 ≤256px 的 PNG、没有漏登记的文件。
 * 6. 模块官方图是透明底纯黑字 / 纯白字、内置包里做成卡片或铺过底色的（央视频的 CCTV 台标）：开着托管时这个模块的
 *    频道用内置那张、不要官网原图；别的模块、按名字碰上的咪咕 / 订阅频道、关了托管的都不换；
 * 7. 卡片有三套样式，按 cctvLogoStyle 给对应文件，默认那套文件名不变；样式文件也只认登记过的。
 * 8. 仓库远程台标 logo-remote/（不进镜像，经 jsDelivr 引用）同样一一对应、写清出处；不进镜像（.dockerignore）；
 *    订阅文件里指向它的台标地址都有对应的图。
 *
 * 运行： node scripts/test-logo-pack.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = mkdtempSync(join(tmpdir(), 'iptv-logo-pack-'))
const PACK_DIR = join(DATA_DIR, 'pack')
process.env.mdataDir = DATA_DIR
process.env.mblank = 'true'
process.env.mlogoPackDir = PACK_DIR

const png = tag => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(80, tag)])
mkdirSync(PACK_DIR, { recursive: true })
const logos = {}
for (const [name, tag] of [['内蒙古新闻综合', 'a'], ['凤凰中文', 'b'], ['湖南卫视', 'c'], ['CGTN Documentary', 'd']]) {
  writeFileSync(join(PACK_DIR, `${name}.png`), png(tag))
  logos[name] = { file: `${name}.png`, hash: `h${tag}`, origin: 'manual' }
}
// 央视频的 CCTV1综合：官方图做成了三套卡片；百视通的 CCTV1 按「一个名字一张图」也对到这张，但不是它自己的图
writeFileSync(join(PACK_DIR, 'CCTV1综合.png'), png('e'))
writeFileSync(join(PACK_DIR, 'CCTV1综合@light.png'), png('f'))
writeFileSync(join(PACK_DIR, 'CCTV1综合@blue.png'), png('g'))
logos['CCTV1综合'] = {
  file: 'CCTV1综合.png', hash: 'he', origin: 'yangshipin', card: true,
  styles: { light: { file: 'CCTV1综合@light.png', hash: 'hf' }, blue: { file: 'CCTV1综合@blue.png', hash: 'hg' } },
}
writeFileSync(join(PACK_DIR, 'index.json'), JSON.stringify({
  version: 1,
  logos,
  refs: { 'nmtv/nmtv-news': '内蒙古新闻综合', 'yangshipin/ysp-cctv1': 'CCTV1综合', 'bestv-fj/bestv-cctv1': 'CCTV1综合' },
}))

const { packBackedLogoUrl, packLogoFile, packLogoUrl, resetLogoPackForTest } = await import('../utils/logoPack.js')
const { logoCandidates } = await import('../utils/updateData.js')
const { hostedLogoUrl, prefetchLogos, resetLogoCacheForTest } = await import('../utils/logoCache.js')
const { classifyLogo } = await import('../utils/playlistConfig.js')
const { isGenericName, packNameFor } = await import('./build-logo-pack.mjs')

let passed = 0
const check = (n, fn) => { fn(); passed++; console.log('  ✅ ' + n) }
const checkAsync = async (n, fn) => { await fn(); passed++; console.log('  ✅ ' + n) }
const packUrl = name => `\${replace}/logo-pack/${encodeURIComponent(`${name}.png`)}?v=${logos[name].hash}`

console.log('内置台标回归测试')

check('模块频道按「模块/频道编号」对应；外部频道按台标名匹配，规则同台标库', () => {
  resetLogoPackForTest()
  assert.equal(packLogoUrl({ name: '新闻综合', sourceId: 'xt:nmtv', deferredRef: 'nmtv-news' }, '少儿'), packUrl('内蒙古新闻综合'))
  assert.equal(packLogoUrl({ name: '凤凰中文' }, '香港'), packUrl('凤凰中文'))
  assert.equal(packLogoUrl({ name: '湖南卫视4K' }, '卫视'), packUrl('湖南卫视'), '去掉清晰度后命中')
  assert.equal(packLogoUrl({ name: 'cgtn documentary' }, '文旅'), packUrl('CGTN Documentary'), '英文名大小写不敏感')
  assert.equal(packLogoUrl({ name: '没有这台' }, '其它'), '')
  assert.equal(packLogoUrl({ name: '' }, '其它'), '')
})

check('通用名不裸着匹配：别处的「新闻综合」拿不到内蒙古的图，内蒙古分组里的才补前缀命中', () => {
  assert.equal(packLogoUrl({ name: '新闻综合' }, '上海'), '')
  assert.equal(packLogoUrl({ name: '新闻综合' }, '内蒙古'), packUrl('内蒙古新闻综合'))
  assert.equal(isGenericName('新闻综合'), true)
  assert.equal(isGenericName('少儿频道'), true)
  assert.equal(isGenericName('经济生活'), true)
  assert.equal(isGenericName('文体娱乐'), true)
  for (const name of ['嘉佳卡通', '呼和浩特', '国学频道', '湖北教育', 'CCTV1综合', '睛彩中原']) assert.equal(isGenericName(name), false, name)
  assert.equal(packNameFor('新闻综合', '内蒙古'), '内蒙古新闻综合')
  assert.equal(packNameFor('湖北经视', '湖北'), '湖北经视')
  assert.equal(packNameFor('少儿频道', ''), '少儿频道')
})

await checkAsync('自带的托管好了用自带；自带确认坏了或还没下成功就用内置，排在台标库前面', async () => {
  const OWN = 'https://static.example.cn/logo/a.png'
  const LIB = 'https://lib.example.com/icon/a.png'
  const pack = packUrl('凤凰中文')
  const candidates = [{ url: OWN, from: 'source' }, { url: pack, from: 'pack' }, { url: LIB, from: 'auto' }]
  resetLogoCacheForTest()
  assert.equal(hostedLogoUrl(candidates), pack, '还没下过')
  await prefetchLogos([OWN], { fetchImpl: async () => new Response('gone', { status: 404 }) })
  assert.equal(hostedLogoUrl(candidates), pack, '确认坏了')
  rmSync(join(DATA_DIR, 'logo-cache'), { recursive: true, force: true })
  resetLogoCacheForTest()
  await prefetchLogos([OWN], { fetchImpl: async () => new Response(png('z')) })
  assert.match(hostedLogoUrl(candidates), /\/logo-cache\/[0-9a-f]{20}\.png\?v=\d+&from=source$/)
})

check('官方图做成卡片的模块频道用内置那张；别的模块、按名字碰上的、关了托管的不换', () => {
  const backed = packUrl('CCTV1综合')
  const ysp = { name: 'CCTV1综合', sourceId: 'xt:yangshipin', deferredRef: 'ysp-cctv1', logo: 'https://resources.yangshipin.cn/assets/oms/image/a.png' }
  assert.equal(packBackedLogoUrl(ysp), backed)
  assert.deepEqual(logoCandidates(ysp, '央视频', false, { hosting: true, style: 'dark' }), [{ url: backed, from: 'pack' }], '官网原图不再进候选，也就不再下载')
  assert.equal(hostedLogoUrl(logoCandidates(ysp, '央视频', false, { hosting: true, style: 'dark' })), backed)
  assert.deepEqual(logoCandidates(ysp, '央视频', false, { hosting: false, style: 'dark' }), [{ url: ysp.logo, from: 'source' }, { url: backed, from: 'pack' }], '关了托管要的是官方原地址')
  const bestv = { name: 'CCTV1', sourceId: 'xt:bestv-fj', deferredRef: 'bestv-cctv1', logo: 'https://tvappstatic.bestv.com.cn/a.png' }
  assert.equal(packBackedLogoUrl(bestv), '', '内置那张不是百视通自己的图')
  assert.deepEqual(logoCandidates(bestv, '百视通', false, { hosting: true, style: 'dark' }).map(c => c.from), ['source', 'pack'])
  const migu = { name: 'CCTV1综合', pics: { highResolutionH: 'http://wapx.cmvideo.cn:8080/a.webp' } }
  assert.equal(packBackedLogoUrl(migu), '', '咪咕的频道按名字碰上')
  assert.deepEqual(logoCandidates(migu, '央视', false, { hosting: true, style: 'dark' }), [{ url: migu.pics.highResolutionH, from: 'source' }, { url: backed, from: 'pack' }])
  assert.equal(packBackedLogoUrl({ name: '新闻综合', sourceId: 'xt:nmtv', deferredRef: 'nmtv-news' }), '', '没铺底色的照旧')
  assert.equal(packBackedLogoUrl({ name: '' }), '')
})

check('卡片按设置给对应样式的文件，样式文件也能取到', () => {
  const ysp = { name: 'CCTV1综合', sourceId: 'xt:yangshipin', deferredRef: 'ysp-cctv1', logo: 'https://resources.yangshipin.cn/a.png' }
  const style = (file, hash) => `\${replace}/logo-pack/${encodeURIComponent(file)}?v=${hash}`
  assert.equal(packBackedLogoUrl(ysp, 'light'), style('CCTV1综合@light.png', 'hf'))
  assert.equal(packBackedLogoUrl(ysp, 'blue'), style('CCTV1综合@blue.png', 'hg'))
  assert.equal(packBackedLogoUrl(ysp, 'dark'), packUrl('CCTV1综合'), '默认样式就是不带后缀的那张')
  assert.equal(packBackedLogoUrl(ysp, 'nope'), packUrl('CCTV1综合'), '不认识的样式按默认')
  assert.deepEqual(logoCandidates(ysp, '央视频', false, { hosting: true, style: 'blue' }), [{ url: style('CCTV1综合@blue.png', 'hg'), from: 'pack' }])
  assert.equal(packLogoUrl({ name: 'CCTV1综合' }, '央视', 'light'), style('CCTV1综合@light.png', 'hf'), '按名字兜底也用同一套样式')
  assert.equal(packLogoFile('CCTV1综合@blue.png').path, join(PACK_DIR, 'CCTV1综合@blue.png'))
  assert.equal(packLogoFile('CCTV1综合@red.png'), null)
})

check('/logo-pack/ 只认登记过的文件；后台标「内置」，公网 logos 地址不算本地上传', () => {
  assert.equal(packLogoFile('凤凰中文.png').path, join(PACK_DIR, '凤凰中文.png'))
  assert.equal(packLogoFile('凤凰中文.png').mime, 'image/png')
  for (const bad of ['index.json', '../凤凰中文.png', '凤凰中文', '', '不存在.png']) assert.equal(packLogoFile(bad), null, bad)
  assert.equal(classifyLogo(packUrl('凤凰中文')), 'pack')
  assert.equal(classifyLogo('${replace}/logos/%E5%87%A4.png?v=1'), 'local')
  assert.equal(classifyLogo('https://gcore.jsdelivr.net/gh/akiralereal/iptv@main/logo-pack/x.png'), 'source')
  assert.equal(classifyLogo('https://example.com/logos/x.png'), 'source')
})

// 台标目录与 index.json 一一对应：文件都在、哈希对得上、都是 ≤256px 的 PNG、手工图写清出处、没有漏登记的文件
function checkLogoDir(dir) {
  assert.ok(existsSync(join(dir, 'index.json')), `${dir}/index.json 不存在`)
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf-8'))
  // macOS 列目录返回的是分解写法（ñ = n + 波浪符），索引和 git 里是合成写法，看着一样但逐字符不相等；
  // 两边都先统一成合成写法再比，否则 France 24 Español / Français 在 Mac 上会被判成「没登记」
  const key = file => file.normalize('NFC').toLowerCase()
  const files = new Set()
  for (const [name, entry] of Object.entries(index.logos)) {
    assert.ok(entry.file && !files.has(key(entry.file)), `${name} 文件名重复`)
    files.add(key(entry.file))
    const buf = readFileSync(join(dir, entry.file))
    assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${name} 不是 PNG`)
    assert.equal(createHash('sha1').update(buf).digest('hex').slice(0, 10), entry.hash, `${name} 哈希对不上`)
    const [width, height] = [buf.readUInt32BE(16), buf.readUInt32BE(20)]
    assert.ok(width <= 256 && height <= 256 && width === entry.width && height === entry.height, `${name} 尺寸 ${width}x${height}`)
    assert.ok(entry.origin, `${name} 没记来源`)
    if (entry.origin === 'manual') assert.ok(entry.source && entry.kind, `${name} 手工图要写出处与类别`)
    if (entry.bg !== undefined) assert.match(entry.bg, /^#[0-9a-f]{3,8}$/i, `${name} 底色写法不对`)
    if (entry.card) {
      assert.deepEqual(Object.keys(entry.styles || {}).sort(), ['blue', 'light'], `${name} 卡片要有浅色、央视蓝两套`)
      for (const [style, variant] of Object.entries(entry.styles)) {
        assert.equal(variant.file, entry.file.replace(/\.png$/, `@${style}.png`), `${name} ${style} 文件名`)
        assert.ok(!files.has(key(variant.file)), `${variant.file} 重复`)
        files.add(key(variant.file))
        const vbuf = readFileSync(join(dir, variant.file))
        assert.equal(createHash('sha1').update(vbuf).digest('hex').slice(0, 10), variant.hash, `${variant.file} 哈希对不上`)
        assert.ok(vbuf.readUInt32BE(16) === variant.width && vbuf.readUInt32BE(20) === variant.height, `${variant.file} 尺寸`)
      }
    }
  }
  for (const file of readdirSync(dir)) {
    if (file === 'index.json') continue
    assert.ok(files.has(key(file)), `${file} 没登记在 index.json`)
  }
  for (const [ref, name] of Object.entries(index.refs)) assert.ok(/^[\w-]+\/.+/.test(ref) && typeof name === 'string', ref)
  return index
}

check('仓库 logo-pack/ 与 index.json 一一对应，全是 ≤256px 的 PNG', () => {
  const index = checkLogoDir(join(ROOT, 'logo-pack'))
  // 央视频的 CCTV 台标是透明底黑字，深色界面的播放器上只剩一个红 C：内置这张必须做成卡片
  // （build-logo-pack.mjs --card），央视频的频道才会换用它
  const yspCctv = Object.entries(index.refs).filter(([ref, name]) => ref.startsWith('yangshipin/') && /^CCTV/.test(name))
  assert.ok(yspCctv.length >= 34, `央视频的 CCTV 频道只对上 ${yspCctv.length} 个`)
  for (const [, name] of yspCctv) assert.ok(index.logos[name]?.card && index.logos[name].origin === 'yangshipin', `${name} 没做成卡片`)
})

check('仓库远程台标 logo-remote/：一一对应、不进镜像，订阅里引用的图都在', () => {
  const dir = join(ROOT, 'logo-remote')
  const index = checkLogoDir(dir)
  for (const [name, entry] of Object.entries(index.logos)) assert.equal(entry.origin, 'manual', `${name} 远程台标都是手工收的`)
  const ignore = readFileSync(join(ROOT, '.dockerignore'), 'utf-8').split('\n').map(line => line.trim())
  assert.ok(ignore.includes('logo-remote'), '.dockerignore 要排除 logo-remote，远程台标不进镜像')
  const base = 'https://gcore.jsdelivr.net/gh/akiralereal/iptv@main/logo-remote/'
  const files = new Set(Object.values(index.logos).map(entry => entry.file.normalize('NFC')))
  let referenced = 0
  for (const list of ['from-the-web/from-the-web.m3u', 'IPTV.m3u', 'IPTV-overseas.m3u']) {
    if (!existsSync(join(ROOT, list))) continue
    for (const [, url] of readFileSync(join(ROOT, list), 'utf-8').matchAll(/tvg-logo="([^"]*)"/g)) {
      if (!url.includes('/logo-remote/')) continue
      assert.ok(url.startsWith(base), `${list} 里的远程台标要用 jsDelivr gcore 地址：${url}`)
      const file = decodeURIComponent(url.slice(base.length)).normalize('NFC')
      assert.ok(files.has(file), `${list} 引用的 ${file} 不在 logo-remote/`)
      referenced++
    }
  }
  assert.ok(referenced > 0, '订阅里没有引用远程台标')
})

rmSync(DATA_DIR, { recursive: true, force: true })
console.log(`\n全部通过：${passed} ✅`)
