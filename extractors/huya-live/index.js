/** 虎牙直播：按分类自动加入热门房间，也支持手动固定房间。 */
import {
  AREA_PAGES,
  DEFAULT_MIN_HEAT,
  HUYA_GROUP,
  HuyaOfflineError,
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
    name: room.name || `虎牙 ${room.roomId}`,
    deferredRef: `huya-${room.roomId}`,
    // 防盗链请求头由本机清单中继发送；不下发给播放器，TXT/TVBox 订阅也能保留。
    relayHls: true,
    logo: room.logo || '',
    groupTitle: HUYA_GROUP,
  }
}

export default {
  id: 'huya-live',
  name: '虎牙直播',
  description: '按分类加入虎牙热门直播间，也可手动指定房间；播放时即时生成短期有效地址。',
  capabilities: { cache: 'disk', resolve: true, epg: false },
  defaultRefreshMinutes: 30,
  minRefreshMinutes: 15,
  maxRefreshMinutes: 120,

  configSchema: [
    {
      key: 'topAreas',
      section: '频道从哪来 —— 自动分类和手动房间可以同时使用，频道统一放入「虎牙」组',
      group: '① 自动：按分类加入热门直播间',
      label: '选择分类（可多选）',
      type: 'multiselect',
      options: Object.keys(AREA_PAGES).map(value => ({ value, label: value })),
      default: '赛事',
      hint: '默认只选「赛事」，避免首次启用就加入大量普通游戏主播。想只用手动房间，把下面数量设为 0。',
    },
    {
      key: 'topPerArea',
      section: '频道从哪来 —— 自动分类和手动房间可以同时使用，频道统一放入「虎牙」组',
      group: '① 自动：按分类加入热门直播间',
      label: '每个分类取前几名',
      type: 'int',
      min: 0,
      max: 20,
      default: 8,
      hint: '按当前人气从高到低，受最低人气过滤；填 0 只关闭自动分类。',
    },
    {
      key: 'minHeat',
      section: '频道从哪来 —— 自动分类和手动房间可以同时使用，频道统一放入「虎牙」组',
      group: '① 自动：按分类加入热门直播间',
      label: '最低人气',
      type: 'int',
      min: 0,
      max: 100000000,
      default: DEFAULT_MIN_HEAT,
      hint: '虎牙人气不是实际在线人数。默认 3000，兼顾小型赛事并过滤低热度房间；填 0 不设门槛。',
    },
    {
      key: 'rooms',
      section: '频道从哪来 —— 自动分类和手动房间可以同时使用，频道统一放入「虎牙」组',
      group: '② 手动：指定直播间',
      label: '房间号 / 直播间地址（一行一个，可留空）',
      type: 'text',
      multiline: true,
      placeholder: '660101\nhttps://www.huya.com/660101\n# 井号开头是注释',
      hint: '数字房间号和英文房间短名都支持。未开播房间会自动跳过，手填房间排在自动分类之前。',
      default: '',
    },
    {
      key: 'quality',
      section: '播放偏好',
      label: '优先画质',
      type: 'select',
      options: [
        { value: 0, label: '原画 / 最高画质' },
        { value: 4000, label: '蓝光 4M' },
        { value: 2000, label: '超清 2M（推荐）' },
        { value: 500, label: '流畅 500K' },
      ],
      default: 2000,
      hint: '房间没有目标档时自动选择不高于目标的最接近档位。电视端默认 2M，在清晰度和稳定性之间更均衡。',
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
        if (!(error instanceof HuyaOfflineError)) hardErrors++
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
          warnings.push(`虎牙分类「${area}」抓取失败：${error.message}`)
        }
      }
    }

    const rooms = mergeRooms(manual, automatic)
    if (!rooms.length && hardErrors > 0) throw new Error(warnings[0] || '虎牙直播抓取失败')
    return {
      groups: rooms.length ? [{ name: HUYA_GROUP, dataList: rooms.map(toChannel) }] : [],
      meta: { skipped: warnings, warnings },
    }
  },

  claimsRef: ref => /^huya-[a-z0-9_-]{1,64}$/i.test(String(ref || '')),
  resolve: resolveRoom,
  clearResolveCache,
}
