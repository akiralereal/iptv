import { existsSync, readFileSync } from 'node:fs'

/**
 * 系统频道：项目自带、随订阅分发的短片，统一放在「公告」分组、固定在订阅首位。
 * 第一条是使用公告（含版权提示），第二条是央视频会员频道的登录教程——复制 Cookie 导入
 * 那套操作光靠文字说不清，电视上放一遍比 README 管用（issue #119 后续）；第三条是
 * 「来源于网络」列表的添加教程——被清出精选列表的第三方源放在仓库 from-the-web/，
 * 教用户自己粘直链订阅（issue #121 后续）。
 * 都可以按档隐藏，但不能删除、移动、改名、改序；短片由 assets/*-source.html 经
 * scripts/generate-announcement-video.mjs 生成。
 */
export const ANNOUNCEMENT = Object.freeze({
  group: '公告',
  name: '欢迎使用 iPTV for iFansClub.com',
  tvgId: 'iptv-announcement',
  videoPath: '/assets/announcement.mp4',
  logoPath: '/assets/announcement-logo.png',
  description: '项目自带的使用说明与版权提示短片',
})
export const YSP_LOGIN_GUIDE = Object.freeze({
  group: '公告',
  name: '央视频会员频道登录教程',
  tvgId: 'iptv-ysp-login-guide',
  videoPath: '/assets/ysp-login-guide.mp4',
  logoPath: '/assets/ysp-login-guide-logo.png',
  description: '演示如何从浏览器复制 Cookie 把央视频登录态导入 iPTV 的教程短片',
})
export const FROM_THE_WEB_GUIDE = Object.freeze({
  group: '公告',
  name: '「来源于网络」频道添加教程',
  tvgId: 'iptv-from-the-web-guide',
  videoPath: '/assets/from-the-web-guide.mp4',
  logoPath: '/assets/from-the-web-guide-logo.png',
  description: '演示如何把仓库 from-the-web.m3u 里的网络第三方源作为订阅添加到 iPTV 的教程短片',
})
export const SYSTEM_CHANNELS = Object.freeze([ANNOUNCEMENT, YSP_LOGIN_GUIDE, FROM_THE_WEB_GUIDE])
export const systemChannelKey = channel => `${channel.group}::${channel.tvgId}`
export const ANNOUNCEMENT_CHANNEL_KEY = systemChannelKey(ANNOUNCEMENT)
export const SYSTEM_CHANNEL_KEYS = Object.freeze(SYSTEM_CHANNELS.map(systemChannelKey))
export const SYSTEM_CHANNEL_IDS = Object.freeze(SYSTEM_CHANNELS.map(channel => channel.tvgId))

const ASSETS = Object.freeze(Object.fromEntries(SYSTEM_CHANNELS.flatMap(channel => [
  [channel.videoPath, Object.freeze({ file: new URL(`..${channel.videoPath}`, import.meta.url), contentType: 'video/mp4' })],
  [channel.logoPath, Object.freeze({ file: new URL(`..${channel.logoPath}`, import.meta.url), contentType: 'image/png' })],
])))
export const SYSTEM_ASSET_PATHS = Object.freeze(Object.keys(ASSETS))
const ASSET_CACHE = new Map()

export function announcementM3uEntry() {
  return SYSTEM_CHANNELS.map(a =>
    `#EXTINF:-1 tvg-id="${a.tvgId}" tvg-name="${a.name}" tvg-logo="\${replace}${a.logoPath}" group-title="${a.group}",${a.name}\n\${replace}${a.videoPath}\n`,
  ).join('')
}

export function announcementTxtEntry() {
  return `${ANNOUNCEMENT.group},#genre#\n` + SYSTEM_CHANNELS.map(a => `${a.name},\${replace}${a.videoPath}\n`).join('')
}

/** 按播放地址反查系统频道（interface.txt 解析时给它们稳定的频道 ID 用）。 */
export function systemChannelByUrl(url) {
  return SYSTEM_CHANNELS.find(channel => url === `\${replace}${channel.videoPath}`) || null
}

export function isAnnouncementChannel(channel) {
  return SYSTEM_CHANNELS.some(system => channel?.id === system.tvgId
    || channel?.tvgId === system.tvgId
    || channel?.url === `\${replace}${system.videoPath}`)
}

/**
 * 系统频道是订阅的固定入口：不允许配置档把它们删除、移动、重命名或改序，
 * 但允许逐条隐藏——要不要在电视上放这些短片由站长自己决定（issue #119），
 * 隐藏走普通的 hiddenChannels，随时可在「已隐藏」里恢复。
 * 返回副本，避免读取/校验过程中反向修改调用方持有的配置对象。
 */
// 手改过的配置文件里，本该是数组的字段可能是字符串（"hiddenRules": "购物"）。
// 直接展开会把字符串拆成**字符数组**——'购物' → ['购','物']，而按名字屏蔽是子串匹配，
// 单个字会命中一大片，整份播放列表当场少掉几百个频道。非数组一律当空处理。
const asArray = value => (Array.isArray(value) ? [...value] : [])

export function protectAnnouncementConfig(input = {}) {
  const config = {
    ...input,
    hiddenChannels: asArray(input.hiddenChannels),
    hiddenRules: asArray(input.hiddenRules),
    deletedGroups: asArray(input.deletedGroups),
    groupOrder: asArray(input.groupOrder),
    channelGroupMap: { ...(input.channelGroupMap || {}) },
    channelRenameMap: { ...(input.channelRenameMap || {}) },
    channelOrder: { ...(input.channelOrder || {}) },
    groupRenameMap: { ...(input.groupRenameMap || {}) },
    groupSortMode: { ...(input.groupSortMode || {}) },
  }

  // hiddenChannels 原样保留：系统频道可逐条隐藏。
  // 精确删除项直接清掉；更宽的通配符仍需保留给其它分组，applyConfig 会单独豁免公告。
  config.deletedGroups = config.deletedGroups.filter(pattern => pattern !== ANNOUNCEMENT.group)
  for (const key of SYSTEM_CHANNEL_KEYS) {
    delete config.channelGroupMap[key]
    delete config.channelRenameMap[key]
  }
  // 组内顺序固定为 SYSTEM_CHANNELS 的声明顺序
  delete config.channelOrder[ANNOUNCEMENT.group]
  delete config.groupRenameMap[ANNOUNCEMENT.group]
  delete config.groupSortMode[ANNOUNCEMENT.group]
  if (config.groupOrder.length) {
    config.groupOrder = [ANNOUNCEMENT.group, ...config.groupOrder.filter(name => name !== ANNOUNCEMENT.group)]
  }
  return config
}

export function readAnnouncementAsset(pathname) {
  const asset = ASSETS[pathname]
  if (!asset || !existsSync(asset.file)) return null
  if (!ASSET_CACHE.has(pathname)) ASSET_CACHE.set(pathname, readFileSync(asset.file))
  return { content: ASSET_CACHE.get(pathname), contentType: asset.contentType }
}
