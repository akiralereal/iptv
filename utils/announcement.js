import { existsSync, readFileSync } from 'node:fs'

export const ANNOUNCEMENT = Object.freeze({
  group: '公告',
  name: '欢迎使用 iPTV',
  tvgId: 'iptv-announcement',
  videoPath: '/assets/announcement.mp4',
  logoPath: '/assets/announcement-logo.png',
})
export const ANNOUNCEMENT_CHANNEL_KEY = `${ANNOUNCEMENT.group}::${ANNOUNCEMENT.tvgId}`

const ASSETS = Object.freeze({
  [ANNOUNCEMENT.videoPath]: Object.freeze({
    file: new URL('../assets/announcement.mp4', import.meta.url),
    contentType: 'video/mp4',
  }),
  [ANNOUNCEMENT.logoPath]: Object.freeze({
    file: new URL('../assets/announcement-logo.png', import.meta.url),
    contentType: 'image/png',
  }),
})
const ASSET_CACHE = new Map()

export function announcementM3uEntry() {
  const a = ANNOUNCEMENT
  return `#EXTINF:-1 tvg-id="${a.tvgId}" tvg-name="${a.name}" tvg-logo="\${replace}${a.logoPath}" group-title="${a.group}",${a.name}\n\${replace}${a.videoPath}\n`
}

export function announcementTxtEntry() {
  const a = ANNOUNCEMENT
  return `${a.group},#genre#\n${a.name},\${replace}${a.videoPath}\n`
}

export function isAnnouncementChannel(channel) {
  return channel?.id === ANNOUNCEMENT.tvgId
    || channel?.tvgId === ANNOUNCEMENT.tvgId
    || channel?.url === `\${replace}${ANNOUNCEMENT.videoPath}`
}

/**
 * 公告是订阅的系统入口，不允许配置档把它隐藏、删除、移动或改序。
 * 返回副本，避免读取/校验过程中反向修改调用方持有的配置对象。
 */
export function protectAnnouncementConfig(input = {}) {
  const config = {
    ...input,
    hiddenChannels: [...(input.hiddenChannels || [])],
    deletedGroups: [...(input.deletedGroups || [])],
    groupOrder: [...(input.groupOrder || [])],
    channelGroupMap: { ...(input.channelGroupMap || {}) },
    channelRenameMap: { ...(input.channelRenameMap || {}) },
    channelOrder: { ...(input.channelOrder || {}) },
    groupRenameMap: { ...(input.groupRenameMap || {}) },
    groupSortMode: { ...(input.groupSortMode || {}) },
  }

  config.hiddenChannels = config.hiddenChannels.filter(key => key !== ANNOUNCEMENT_CHANNEL_KEY)
  // 精确删除项直接清掉；更宽的通配符仍需保留给其它分组，applyConfig 会单独豁免公告。
  config.deletedGroups = config.deletedGroups.filter(pattern => pattern !== ANNOUNCEMENT.group)
  delete config.channelGroupMap[ANNOUNCEMENT_CHANNEL_KEY]
  delete config.channelRenameMap[ANNOUNCEMENT_CHANNEL_KEY]
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
