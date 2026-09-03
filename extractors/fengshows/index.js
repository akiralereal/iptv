import { buildGroups, claimsRef, parseToken, resolveChannel } from './api.js'

export default {
  id: 'fengshows',
  name: '凤凰卫视',
  description: '凤凰资讯、凤凰中文、凤凰香港三路官方直播，统一归入香港。游客 480p；登录普通凤凰秀账号可获取 720p，无需付费会员。',
  capabilities: { cache: 'disk', resolve: true, epg: false, catchup: false },
  streamType: 'flv',
  outputGroupName: '香港',
  defaultRefreshMinutes: 360,
  refreshConfigurable: false,
  refreshDescription: '频道固定为三个电视直播；播放时实时向官方取址，自动跟随地区调度，无需定时刷新播放签名。',
  helper: 'fengshows-bookmarklet',
  configSchema: [{
    key: 'token', section: '凤凰秀账号（选填）', label: '凤凰秀 Token / Cookie',
    type: 'text', secret: true, env: 'mFengshowsToken', default: '',
    hint: '官网普通账号登录后复制 App.user.token，支持粘贴该值或完整 Cookie。游客 480p，已实测普通账号三台均为 720p / 25 帧，无需付费会员。保存后持久保留，过期时重新获取。直播采用 HTTP-FLV。',
  }],
  async fetch(config) {
    parseToken(config?.token || '')
    return { groups: buildGroups(), meta: { skipped: [], warnings: [] } }
  },
  claimsRef,
  resolve: resolveChannel,
}
