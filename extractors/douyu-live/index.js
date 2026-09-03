/** 斗鱼直播：按官网分类自动加入热门房间，也支持手动固定房间。 */
import {
  AREA_APIS,
  DEFAULT_MIN_HEAT,
  DOUYU_GROUP,
  DouyuOfflineError,
  clearResolveCache,
  fetchRoom,
  parseRoomList,
  resolveRoom,
  topRoomsOfArea,
} from './api.js'

const CONCURRENCY = 3

async function mapLimit(items, limit, worker) {
  const output = new Array(items.length)
  let cursor = 0
  async function run() {
    while (cursor < items.length) {
      const index = cursor++
      output[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return output
}

export function parseAreaNames(text) {
  return String(text || '').split('\n').map(value => value.trim()).filter(Boolean)
}

export function mergeRooms(manual, automatic) {
  const seen = new Set()
  const merged = []
  for (const room of [...(manual || []), ...(automatic || [])]) {
    const id = String(room?.roomId || '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    merged.push(room)
  }
  return merged
}

function toChannel(room) {
  return {
    name: room.name || `斗鱼 ${room.roomId}`,
    deferredRef: `douyu-${room.roomId}`,
    relayHls: true,
    logo: room.logo || '',
    groupTitle: DOUYU_GROUP,
  }
}

export default {
  id: 'douyu-live',
  name: '斗鱼直播',
  description: '按斗鱼官网分类加入热门直播间，也可手动指定房间；匿名播放时即时生成短效 HLS。',
  capabilities: { cache: 'disk', resolve: true, epg: false },
  defaultRefreshMinutes: 30,
  minRefreshMinutes: 15,
  maxRefreshMinutes: 120,

  configSchema: [
    {
      key: 'topAreas',
      section: '频道从哪来 —— 自动分类和手动房间可以同时使用，频道统一放入「斗鱼」组',
      group: '① 自动：按分类加入热门直播间',
      label: '选择分类（可多选）',
      type: 'multiselect',
      options: Object.keys(AREA_APIS).map(value => ({ value, label: value })),
      default: '网游竞技',
      hint: '默认只选「网游竞技」，首次启用最多加入 8 路。想只用手动房间，把下面数量设为 0。',
    },
    {
      key: 'topPerArea',
      section: '频道从哪来 —— 自动分类和手动房间可以同时使用，频道统一放入「斗鱼」组',
      group: '① 自动：按分类加入热门直播间',
      label: '每个分类取前几名',
      type: 'int',
      min: 0,
      max: 20,
      default: 8,
      hint: '按官网当前人气从高到低，受最低人气过滤；填 0 只关闭自动分类。',
    },
    {
      key: 'minHeat',
      section: '频道从哪来 —— 自动分类和手动房间可以同时使用，频道统一放入「斗鱼」组',
      group: '① 自动：按分类加入热门直播间',
      label: '最低人气',
      type: 'int',
      min: 0,
      max: 100000000,
      default: DEFAULT_MIN_HEAT,
      hint: '斗鱼人气不是实际在线人数。默认 10 万用于滤掉低热度推荐位；填 0 不设门槛。',
    },
    {
      key: 'rooms',
      section: '频道从哪来 —— 自动分类和手动房间可以同时使用，频道统一放入「斗鱼」组',
      group: '② 手动：指定直播间',
      label: '房间号 / 直播间地址（一行一个，可留空）',
      type: 'text',
      multiline: true,
      placeholder: '9999\nhttps://www.douyu.com/9999\n# 井号开头是注释',
      hint: '支持房间号、PC / 手机完整地址和分享地址。未开播房间自动跳过，手填房间排在自动分类之前。',
      default: '',
    },
    {
      key: 'quality',
      section: '播放偏好',
      label: '优先画质',
      type: 'select',
      options: [
        { value: 0, label: '原画 / 最高画质' },
        { value: 3, label: '超清 2M（推荐）' },
        { value: 2, label: '高清 900K' },
      ],
      default: 3,
      hint: '官网会按直播间实际档位自动回落。匿名实测可取原画；默认 2M 更适合电视端长时间播放。',
    },
  ],

  async fetch(config, ctx = {}) {
    const warnings = []
    let hardErrors = 0
    const manualRefs = parseRoomList(config.rooms)
    const manual = (await mapLimit(manualRefs, CONCURRENCY, async room => {
      try {
        return await fetchRoom(room, { timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
      } catch (error) {
        if (!(error instanceof DouyuOfflineError)) hardErrors++
        warnings.push(error.message)
        return null
      }
    })).filter(Boolean)

    const automatic = []
    if (Number(config.topPerArea) > 0) {
      for (const area of parseAreaNames(config.topAreas)) {
        try {
          automatic.push(...await topRoomsOfArea(area, config.topPerArea, {
            minHeat: config.minHeat,
            timeoutMs: ctx.timeoutMs,
            fetchImpl: ctx.fetchImpl,
          }))
        } catch (error) {
          hardErrors++
          warnings.push(`斗鱼分类「${area}」抓取失败：${error.message}`)
        }
      }
    }

    const rooms = mergeRooms(manual, automatic)
    if (!rooms.length && hardErrors > 0) throw new Error(warnings[0] || '斗鱼直播抓取失败')
    return {
      groups: rooms.length ? [{ name: DOUYU_GROUP, dataList: rooms.map(toChannel) }] : [],
      meta: { skipped: warnings, warnings },
    }
  },

  claimsRef: ref => /^douyu-\d{1,12}$/.test(String(ref || '')),
  resolve: resolveRoom,
  clearResolveCache,
}
