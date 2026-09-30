/** 抖音直播：所选分类轮选或公开网页顺序，手动房间优先。 */
import {
  CATEGORIES, DOUYIN_GROUP, QUALITIES, QUALITY_LABELS, RoomOfflineError, claimsRef, clearResolveCache,
  diversifiedOrder, fetchCategory, fetchRoom, parseRoomList, pickStream, resolveRoom,
} from './api.js'

const CATEGORY_IDS = new Map(Object.entries(CATEGORIES).map(([id, name]) => [name, id]))
export const DEFAULT_CATEGORIES = ['聊天', '生活']

export function parseCategoryNames(text) {
  return String(text || '').split('\n').map(value => value.trim()).filter(name => CATEGORY_IDS.has(name))
}

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

function cleanText(value) {
  return String(value || '').replace(/[\x00-\x1f"\r\n]/g, ' ').replace(/,/g, '，').trim()
}

function toChannel(row, format, quality) {
  // 只确认房间有能播的地址。抖音会间歇地漏发个别房间的 FLV 地址、下次请求又有，所以地址形态
  // 只看配置：FLV 模式一律写无后缀地址，播放时拿不到 FLV 再由 resolve 在同一地址上直出 HLS 清单
  pickStream(row.streams, quality, format)
  return {
    name: cleanText(row.title ? `${row.name} · ${row.title}` : row.name) || `抖音 ${row.id}`,
    deferredRef: `douyin-${row.id}`,
    relayHls: format === 'hls',
    logo: row.logo || '',
    groupTitle: DOUYIN_GROUP,
    catchup: 'none',
  }
}

export default {
  id: 'douyin-live',
  name: '抖音直播',
  description: '公开网页直播：按所选分类轮选或保留“全部”页顺序；支持手填房间号，默认 FLV，也可选 HLS。',
  category: 'live',
  capabilities: { cache: 'disk', resolve: true, epg: false, catchup: false },
  streamType: 'flv',
  defaultRefreshMinutes: 30,
  minRefreshMinutes: 15,
  maxRefreshMinutes: 120,
  configSchema: [
    {
      key: 'order', section: '频道从哪来', label: '自动频道顺序', type: 'select',
      options: [
        { value: 'balanced', label: '在所选分类里轮选' },
        { value: 'native', label: '抖音网页“全部”页原始顺序（首批约 15 个）' },
      ],
      default: 'balanced',
      hint: '分类轮选让所选的每个分类都有频道；网页顺序保留未登录公开网页返回的先后，不看下面的分类，也不能复现 App 的个性化推荐。',
    },
    {
      key: 'categories', section: '频道从哪来', label: '选择分类（可多选）', type: 'multiselect',
      options: Object.values(CATEGORIES).map(value => ({ value, label: value })),
      default: DEFAULT_CATEGORIES.join('\n'),
      hint: '仅用于分类轮选，默认「聊天」「生活」。抖音网页版只有这 8 个直播分类。',
    },
    {
      key: 'count', section: '频道从哪来', label: '自动加入房间数', type: 'int',
      min: 0, max: 100, default: 20,
      hint: '填 0 只使用手动房间。每个分类页首批约 15 个房间，网页顺序模式通常最多约 15 个。',
    },
    {
      key: 'minViewers', section: '频道从哪来', label: '分类轮选最低显示在线人数', type: 'int',
      min: 0, max: 100000000, default: 0,
      hint: '仅用于分类轮选，默认 0。抖音分类页显示人数有时只有个位数，高门槛可能使列表集中在少数分类。',
    },
    {
      key: 'rooms', section: '频道从哪来', label: '手动房间号 / 直播间地址（一行一个）',
      type: 'text', multiline: true,
      placeholder: '541862161030\nhttps://live.douyin.com/325163481565\n# 井号开头是注释',
      default: '',
      hint: '手填房间排在自动频道之前，未开播时跳过；填直播间地址 live.douyin.com/ 后面的房间号，或整条地址。',
    },
    {
      key: 'format', section: '播放偏好', label: '播放格式', type: 'select',
      options: [
        { value: 'flv', label: 'FLV（默认，起播较快）' },
        { value: 'hls', label: 'HLS（兼容更多播放器）' },
      ],
      default: 'flv',
      hint: 'FLV 由本机流式转发、不转码；HLS 由本机刷新清单，视频分片仍由播放器直连官方 CDN。播放时拿不到 FLV 地址会自动改用 HLS。',
    },
    {
      key: 'quality', section: '播放偏好', label: '优先画质', type: 'select',
      options: QUALITIES.map(value => ({ value, label: value === 'HD1' ? '超清（推荐）' : QUALITY_LABELS[value] })),
      default: 'HD1',
      hint: '多数直播间是竖屏，超清一般 720×1280、蓝光 1080×1920。房间没有所选档位时自动换可用档位。',
    },
  ],

  async fetch(config, ctx = {}) {
    const warnings = []
    let hardErrors = 0
    const format = config.format === 'hls' ? 'hls' : 'flv'
    const quality = QUALITIES.includes(config.quality) ? config.quality : 'HD1'
    const count = Math.max(0, Math.min(100, Number(config.count) || 0))
    const manualIds = parseRoomList(config.rooms)
    const manual = (await mapLimit(manualIds, 3, async id => {
      try { return await fetchRoom(id, ctx) }
      catch (error) {
        if (!(error instanceof RoomOfflineError)) hardErrors++
        warnings.push(`手动房间 ${id}：${error.message}`)
        return null
      }
    })).filter(Boolean)

    let automatic = []
    if (count > 0 && config.order === 'native') {
      try { automatic = await fetchCategory('0', ctx) }
      catch (error) { hardErrors++; warnings.push(`抖音“全部”页：${error.message}`) }
    } else if (count > 0) {
      const categories = parseCategoryNames(config.categories).map(name => CATEGORY_IDS.get(name))
      const batches = await mapLimit(categories, 4, async category => {
        try { return await fetchCategory(category, ctx) }
        catch (error) { hardErrors++; warnings.push(`抖音分类“${CATEGORIES[category]}”：${error.message}`); return [] }
      })
      const byId = new Map()
      for (const row of batches.flat()) {
        if (!byId.has(row.roomKey) || byId.get(row.roomKey).viewers < row.viewers) byId.set(row.roomKey, row)
      }
      automatic = diversifiedOrder([...byId.values()], Number(config.minViewers) || 0)
    }

    const channels = []
    const seen = new Set()
    function add(row) {
      if (seen.has(row.roomKey)) return false
      try {
        const channel = toChannel(row, format, quality)
        channels.push(channel)
        seen.add(row.roomKey)
        return true
      } catch (error) {
        warnings.push(`房间 ${row.id}：${error.message}`)
        return false
      }
    }
    for (const row of manual) add(row)
    let added = 0
    for (const row of automatic) {
      if (added >= count) break
      if (add(row)) added++
    }
    if (!channels.length && hardErrors > 0) throw new Error(warnings[0] || '抖音直播抓取失败')
    return {
      groups: channels.length ? [{ name: DOUYIN_GROUP, dataList: channels }] : [],
      meta: { skipped: warnings, warnings },
    }
  },

  claimsRef,
  resolve: resolveRoom,
  clearResolveCache,
}
