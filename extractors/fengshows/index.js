import { buildGroups, checkToken, claimsRef, credentialRejected, parseToken, resolveChannel } from './api.js'
import epg from './epg.js'

export default {
  id: 'fengshows',
  name: '凤凰卫视',
  description: '凤凰资讯、凤凰中文、凤凰香港三路官方直播，统一归入香港。游客 480p；登录普通凤凰秀账号可获取 720p，无需付费会员。',
  category: 'account',
  capabilities: { cache: 'disk', resolve: true, epg: true, catchup: false },
  streamType: 'flv',
  outputGroupName: '香港',
  defaultRefreshMinutes: 360,
  refreshConfigurable: false,
  refreshDescription: '频道固定为三个电视直播；每 6 小时检查一次凤凰秀 Token 是否仍被官网认可。播放时实时向官方取址，自动跟随地区调度，无需定时刷新播放签名。',
  helper: 'fengshows-bookmarklet',
  credentialCheck: { refresh: true, playback: true, degrade: 'Token 被拒时三台自动改用游客 480p 继续播' },
  configSchema: [{
    key: 'token', section: '凤凰秀账号（选填）', label: '凤凰秀 Token / Cookie',
    type: 'text', secret: true, env: 'mFengshowsToken', default: '',
    hint: '官网普通账号登录后复制 App.user.token，支持粘贴该值或完整 Cookie。游客 480p，已实测普通账号三台均为 720p / 25 帧，无需付费会员。保存后持久保留；过期后三台自动改用游客 480p 继续播放，后台会提示重新获取。直播采用 HTTP-FLV。',
  }],
  // 官网直播页的节目表，按官方直播 id 取；与取流链路互不依赖（见 epg.js）
  epg,
  async fetch(config, ctx = {}) {
    parseToken(config?.token || '')
    // 校验结果只做提示，频道照常输出（Token 被拒时播放自动退回游客 480p）；
    // 没查成不下结论，后台沿用上一轮（registry.js）
    const { rejected, warning } = await checkToken(config, ctx)
    return {
      groups: buildGroups(),
      meta: { skipped: [], warnings: warning ? [warning] : [], credentialRejected: warning ? undefined : (rejected || '') },
    }
  },
  claimsRef,
  credentialRejected,
  resolve: resolveChannel,
}
