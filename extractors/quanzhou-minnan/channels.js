/**
 * 泉州广播电视台两路电视频道的固定表，取流与节目单共用。
 *
 * 官网播放页挂在三个域名下：wxqz2.qztv.cn、www.qztv.cn、control-center.qztv.cn。三个是同一源站
 * （2026-09-29 查 DNS 都落到 47.101.236.119），各自 CNAME 到阿里云 WAF（yundunwaf5 / 4 / 2）。
 * 频道由 media_id 区分，stream_name 就是 CDN 上的流名前缀（news、mny）。
 *
 * 台标取官网首页「电视直播」区块的频道卡（QZTV-1 新闻综合、QZTV-2 闽南语），路径不带哈希；
 * 官网没有单独的方形频道标。
 */
export const MEDIA_HOST = 'live.qztv.cn'
export const SITE_ORIGINS = Object.freeze([
  'https://wxqz2.qztv.cn',
  'https://www.qztv.cn',
  'https://control-center.qztv.cn',
])

export const CHANNELS = Object.freeze([
  Object.freeze({
    key: 'news',
    ref: 'quanzhou-news-tv',
    name: '泉州新闻综合',
    mediaId: 'wq95wqbDnMKyd8KiwqzChnt0w5nChcKowoHCoQ',
    logo: 'https://www.qztv.cn/index/images/home/crad-01.jpg',
  }),
  Object.freeze({
    key: 'mny',
    ref: 'quanzhou-minnan-tv',
    name: '泉州闽南语',
    mediaId: 'wq95wqbDnMKyd8KiwqzChnt0w5nChcKofcKh',
    logo: 'https://www.qztv.cn/index/images/home/crad-02.jpg',
  }),
])

export const CHANNEL_BY_REF = new Map(CHANNELS.map(channel => [channel.ref, channel]))
export const CHANNEL_BY_KEY = new Map(CHANNELS.map(channel => [channel.key, channel]))

/** 某个频道在某个域名下的官网播放页。 */
export function playerPage(channel, origin = SITE_ORIGINS[0]) {
  return `${origin}/index/Medias/index/media_id/${channel.mediaId}/stream_name/${channel.key}.html`
}
