// 内置台标：仓库 logo-pack/ 目录里自己维护的一套台标（index.json + <台标名>.png），随镜像发布。
//
// 为什么：去掉第三方台标库后，频道自带的官方图是唯一来源；图床挂了（河南那 13 张）、海外服务器
// 连不上大陆图床、精选频道这类 m3u 本来就没写台标，都会变成没图。内置一份由维护者打包的图，
// 服务端本地直接提供，不联网、不依赖别人的库。
//
// 优先级：本地上传 > 频道自带（模块官方 / 咪咕 / m3u，实时下发、能跟上改版）> 内置 > 用户自配的台标库。
// 查找：模块频道先按「模块/频道编号」精确对应（index.json 的 refs），再按台标名匹配——规则与台标库
// 相同（utils/logoLibrary.js：原名、台标匹配名、补分组前缀……），所以「新闻综合」这类通用名在包里
// 一律带地名存（内蒙古新闻综合），外部 m3u 里裸的「新闻综合」不会被随手贴上别家的图。
//
// 打包与维护：scripts/build-logo-pack.mjs，规则见 LOGO.md。

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLogoNameMatcher } from './logoLibrary.js'
import { printYellow } from './colorOut.js'

const DEFAULT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'logo-pack')

let pack = null

function packDir() {
  return process.env.mlogoPackDir || DEFAULT_DIR
}

function loadPack() {
  if (pack) return pack
  const empty = { logos: {}, refs: {}, files: new Map(), match: () => '' }
  const indexPath = path.join(packDir(), 'index.json')
  if (!existsSync(indexPath)) return (pack = empty)
  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf-8'))
    const logos = parsed && typeof parsed.logos === 'object' && parsed.logos ? parsed.logos : {}
    const refs = parsed && typeof parsed.refs === 'object' && parsed.refs ? parsed.refs : {}
    const files = new Map()
    for (const entry of Object.values(logos)) if (entry?.file) files.set(entry.file, entry)
    pack = { logos, refs, files, match: createLogoNameMatcher(Object.keys(logos)) }
  } catch (e) {
    printYellow(`内置台标索引读取失败，本轮不用内置台标: ${e.message}`)
    pack = empty
  }
  return pack
}

function urlFor(entry) {
  return `\${replace}/logo-pack/${encodeURIComponent(entry.file)}?v=${entry.hash || ''}`
}

/**
 * 这个频道的内置台标地址，没有返回 ''。
 * @param {{name: string, sourceId?: string, deferredRef?: string}} channelItem
 * @param {string} groupName 播放列表里的分组名，用于「新闻综合」→「内蒙古新闻综合」这类补前缀匹配
 */
export function packLogoUrl(channelItem, groupName) {
  const { logos, refs, match } = loadPack()
  const name = channelItem?.name
  if (!name) return ''
  const moduleId = /^xt:(.+)$/.exec(channelItem.sourceId || '')?.[1]
  if (moduleId) {
    const byRef = refs[`${moduleId}/${channelItem.deferredRef ?? `#${name}`}`]
    if (byRef && logos[byRef]) return urlFor(logos[byRef])
  }
  const hit = match(name, groupName)
  return hit ? urlFor(logos[hit]) : ''
}

/** /logo-pack/ 路由用：只认 index.json 里登记过的文件名，否则 null。 */
export function packLogoFile(fileName) {
  const entry = loadPack().files.get(String(fileName || ''))
  return entry ? { path: path.join(packDir(), entry.file), mime: 'image/png' } : null
}

/** 测试用：丢掉已加载的包，下次按当前 mlogoPackDir 重读。 */
export function resetLogoPackForTest() {
  pack = null
}
