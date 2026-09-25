import { buildGroups, claimsRef, clearCache, fetchCatalog, resolveChannel } from './api.js'
import epg from './epg.js'

export default {
  id: 'beijing',
  name: '北京广播电视台',
  description: '北京时间官网 9 个电视频道与当前公开活动/慢直播；公开直播免登录，配置本人官网 Cookie 后自动加入电视台。',
  category: 'account',
  capabilities: { cache: 'disk', resolve: true, epg: true, catchup: false },
  channelHlsMode: 'proxy',
  defaultRefreshMinutes: 60,
  minRefreshMinutes: 30,
  maxRefreshMinutes: 360,
  helper: 'beijing-cookie',
  helperSection: '电视台登录（选填）',
  configSchema: [{
    key: 'cookie',
    section: '电视台登录（选填）',
    label: '北京时间 Cookie',
    type: 'text',
    secret: true,
    env: 'mBtimeCookie',
    default: '',
    hint: '仅 9 个电视频道需要；免登录活动直播无需填写。支持直接粘贴完整 Cookie、以 Cookie: 开头的请求头，或浏览器导出的 cookies JSON。保存后凭据只留在服务端，不写入播放列表，也不发送给媒体 CDN。',
  }],
  async fetch(config, ctx = {}) {
    const catalog = await fetchCatalog({ cookie: config?.cookie || '', timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
    return {
      groups: buildGroups(catalog),
      meta: { skipped: [], warnings: catalog.warnings },
    }
  },
  // 北京台自己没有节目单，电视频道的取自央视网（见 epg.js）；与取流链路互不依赖
  epg,
  claimsRef,
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
