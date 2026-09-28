/** 四川广播电视台：本人官网登录后动态换签并全代理官方 HLS。 */
import {
  buildChannels,
  buildLiveChannels,
  claimsRef,
  clearCache,
  fetchChannelList,
  fetchLiveEvents,
  parseCredential,
  resolveChannel,
} from './api.js'

export default {
  id: 'sichuan',
  name: '四川',
  description: '四川广电官网 9 个电视频道与当前公开活动直播；活动有则显示、无则隐藏，电视台需关联本人官网登录 Token。',
  category: 'account',
  capabilities: { cache: 'disk', resolve: true, epg: false, catchup: false },
  outputGroupName: '四川',
  channelHlsMode: 'proxy',
  defaultRefreshMinutes: 5,
  refreshConfigurable: false,
  refreshDescription: '自动管理：每 5 分钟发现公开活动；电视台播放签名按官网给的有效期提前换新，清单、密钥和分片全代理并逐跳加签。',
  helper: 'sichuan-token',
  helperSection: '四川官网登录',

  configSchema: [{
    key: 'accessToken',
    section: '四川官网登录',
    label: '四川广电 access_token',
    type: 'text',
    secret: true,
    env: 'mSichuanAccessToken',
    default: '',
    hint: '支持粘贴裸 access_token、Bearer 值或完整 scgc_userAccountInfo JSON。凭据只保存在服务端配置中，不写入播放列表，也不会发送给媒体 CDN。',
  }],

  async fetch(config, ctx = {}) {
    const accessToken = parseCredential(config?.accessToken)
    const warnings = []
    let rows = []
    let liveRows = []
    if (!accessToken) warnings.push('尚未配置四川官网登录 Token，9 个电视频道暂不加入；公开活动直播不受影响')
    else {
      try {
        rows = await fetchChannelList({
          timeoutMs: ctx.timeoutMs,
          fetchImpl: ctx.fetchImpl,
          now: ctx.now,
        })
      } catch (error) {
        warnings.push(error?.message || String(error))
      }
    }
    try {
      liveRows = await fetchLiveEvents({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
    } catch (error) {
      warnings.push(`四川活动直播发现失败：${error?.message || String(error)}`)
    }
    const dataList = [...buildChannels(rows), ...buildLiveChannels(liveRows)]
    return {
      groups: dataList.length ? [{ name: '四川', dataList }] : [],
      meta: { skipped: [], warnings },
    }
  },

  claimsRef,
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
