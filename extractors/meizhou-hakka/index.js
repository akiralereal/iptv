/** 梅州市广播电视台「客家生活」公开直播。 */
export const STREAM_URL = 'https://livepull.hellohakka.cn/live/ch_kejiashenghuo.m3u8'

export default {
  id: 'meizhou-hakka',
  name: '梅州',
  description: '梅州市广播电视台客家生活频道的公开 HLS 直播。',
  capabilities: { cache: 'disk', resolve: false, epg: false, catchup: false },
  catalogVersion: 1,
  outputGroupName: '广东',
  defaultRefreshMinutes: 1440,
  refreshConfigurable: false,
  refreshDescription: '固定频道表；HLS 地址无时效参数，由播放器访问上游 CDN。',
  configSchema: [],

  async fetch() {
    return {
      groups: [{ name: '广东', dataList: [{
        name: '梅州客家生活',
        url: STREAM_URL,
        // 台标留空：hellohakka.cn 是通用融媒 App 壳（kan0512），首页与打包脚本里都没有台标或频道图，
        // 官方直播接口只给流地址。内置台标库（logo-pack）按名收了一张公开库的客家生活台标兜底

        opts: ['network-caching=3000'],
        catchup: 'none',
      }] }],
      meta: { skipped: [], warnings: [] },
    }
  },
}
