/**
 * 亚洲直播实验台收敛出的公开直播频道。
 *
 * rules 是服务端允许访问的精确媒体边界；动态接口只能返回这些主机上的地址，
 * HLS 根清单里出现的子清单、音轨、密钥和分片也必须全部落在同一边界内。
 */
export const SOURCES = [
  { id: 'tvb-news', name: 'TVB新闻', group: '香港', page: 'https://news.tvb.com/tc/live/C', kind: 'tvb',
    rules: [/^(?:[a-z0-9-]+\.)*akamai\.tvb\.com$/, /^(?:[a-z0-9-]+\.)*edgeware\.tvb\.com$/, 'ads.cdn.tvb.com'] },
  { id: 'ytn', name: 'YTN News', group: '韩国', page: 'https://m.ytn.co.kr/live_view_cdn.php', kind: 'ytn',
    rules: ['ytnlive.ytn.co.kr'] },
  { id: 'arirang', name: 'Arirang', group: '韩国', page: 'https://www.arirang.com/live',
    streamUrl: 'https://amdlive-ch01-g-ctnd-com.akamaized.net/arirang_1gch/smil:arirang_1gch.smil/playlist.m3u8',
    rules: ['amdlive-ch01-g-ctnd-com.akamaized.net'] },
  { id: 'nhk-world', name: 'NHK World', group: '日本', page: 'https://www3.nhk.or.jp/nhkworld/en/live_tv/', kind: 'nhk',
    rules: ['masterpl.hls.nhkworld.jp', /^media-[a-z0-9-]+\.hls\.nhkworld\.jp$/] },
  { id: 'dw-en', name: 'DW English', group: '国际', page: 'https://www.dw.com/en/live-tv/channel-english',
    streamUrl: 'https://dwamdstream102.akamaized.net/hls/live/2015525/dwstream102/master.m3u8', rules: ['dwamdstream102.akamaized.net'] },
  { id: 'dw-ar', name: 'DW Arabia', group: '国际', page: 'https://www.dw.com/ar/live-tv/channel-arabic',
    streamUrl: 'https://dwamdstream103.akamaized.net/hls/live/2015526/dwstream103/master.m3u8', rules: ['dwamdstream103.akamaized.net'] },
  { id: 'al-jazeera-english', name: 'Al Jazeera English', group: '国际', page: 'https://www.aljazeera.com/live',
    streamUrl: 'https://live-hls-apps-aje-fa.getaj.net/AJE/index.m3u8', rules: ['live-hls-apps-aje-fa.getaj.net'] },
  { id: 'abc-news-australia', name: 'ABC News Australia', group: '国际', page: 'https://www.abc.net.au/news/newschannel',
    streamUrl: 'https://abc-news-dmd-streams-1.akamaized.net/out/v1/701126012d044971b3fa89406a440133/index.m3u8', rules: ['abc-news-dmd-streams-1.akamaized.net'] },
  { id: 'al-arabiya', name: 'Al Arabiya', group: '国际', page: 'https://www.alarabiya.net/',
    streamUrl: 'https://live.alarabiya.net/alarabiapublish/alarabiya.smil/playlist.m3u8', rules: ['live.alarabiya.net'] },
  { id: 'bloomberg-asia', name: 'Bloomberg Asia', group: '国际', page: 'https://www.bloomberg.com/live/asia', referer: 'https://www.bloomberg.com/',
    streamUrl: 'https://bloomberg.com/media-manifest/streams/asia.m3u8',
    rules: ['bloomberg.com', 'www.bloomberg.com', 'liveprodapnortheast.global.ssl.fastly.net', 'liveprodapnortheast.akamaized.net'] },
  { id: 'bloomberg-us', name: 'Bloomberg US', group: '国际', page: 'https://www.bloomberg.com/live/us/', referer: 'https://www.bloomberg.com/',
    streamUrl: 'https://bloomberg.com/media-manifest/streams/us.m3u8', rules: ['bloomberg.com', 'www.bloomberg.com', 'liveproduseast.global.ssl.fastly.net'] },
  { id: 'bloomberg-europe', name: 'Bloomberg Europe', group: '国际', page: 'https://www.bloomberg.com/live/europe', referer: 'https://www.bloomberg.com/',
    streamUrl: 'https://bloomberg.com/media-manifest/streams/eu.m3u8', rules: ['bloomberg.com', 'www.bloomberg.com', 'liveprodeuwest.akamaized.net'] },
  { id: 'bright-smart-finance', name: '耀才财经', group: '香港', page: 'https://www.bsgroup.com.hk/brightsmart/investor/investor_background.aspx',
    streamUrl: 'https://v3.mediacast.hk/webcast/bshdlive-pc/playlist.m3u8', rules: ['v3.mediacast.hk'] },
  { id: 'pet-club-tv', name: 'Pet Club TV', group: '宠物', page: 'https://www.samsung.com/au/tvs/smart-tv/samsung-tv-plus/all-channels/',
    referer: 'https://petclub-samsungaus.amagi.tv/', streamUrl: 'https://petclub-samsungaus.amagi.tv/playlist.m3u8', rules: ['petclub-samsungaus.amagi.tv'] },
  { id: 'wildearth', name: 'WildEarth', group: '文旅', page: 'https://watch.plex.tv/live-tv/channel/wildearth',
    streamUrl: 'https://wildearth-plex.amagi.tv/masterR1080p.m3u8', rules: ['wildearth-plex.amagi.tv'] },
  { id: 'national-geographic', name: 'National Geographic', group: '文旅', page: 'http://23.237.104.106:8080/USA_NAT_GEO/',
    logo: 'http://schedulesdirect-api20141201-logos.s3.dualstack.us-east-1.amazonaws.com/stationLogos/s49438_dark_360w_270h.png',
    streamUrl: 'http://23.237.104.106:8080/USA_NAT_GEO/index.m3u8', rules: [{ hostname: '23.237.104.106', protocol: 'http:', port: '8080' }] },
  { id: 'love-nature-4k', name: 'Love Nature 4K', group: '文旅', page: 'https://lovenature.com/',
    logo: 'https://images.sr.roku.com/idType/roku-trc/context/trc/id/479fe0d11f3f5132a3f36b617547da3b/https%3A%2F%2Fimage.roku.com%2Fbh-uploads%2Fproduction%2FinfoHUDLogo%2F1738776545554_LoveNature_logos_HUB_Centered.png',
    streamUrl: 'https://pb-ehs1glsha1juy.akamaized.net/v1/manifest/3722c60a815c199d9c0ef36c5b73da68a62b09d1/pb-ehs1glsha1juy/f2141f37-1f48-475b-ba54-b9efb62346db/0.m3u8',
    rules: ['pb-ehs1glsha1juy.akamaized.net'] },
  { id: 'fashiontv-paris', name: "FashionTV Paris L'Original", group: '娱乐时尚', page: 'https://fashiontv.com/live',
    streamUrl: 'https://ftv1.b-cdn.net/bfdbb576-83f7-11f0-9f89-0200170e3e04_1000028043_HLS/manifest.m3u8', rules: ['ftv1.b-cdn.net'] },
  { id: 'global-fashion-channel', name: 'Global Fashion Channel', group: '娱乐时尚', page: 'https://globalfashionchannel.com/live-broadcast/',
    streamUrl: 'https://pubgfc.teleosmedia.com/linear/globalfashionchannel/globalfashionchannel/playlist.m3u8', rules: ['pubgfc.teleosmedia.com'] },
  { id: 'qello-concerts', name: 'Qello Concerts', group: '娱乐时尚', page: 'https://www.stingray.com/consumer/platforms/samsung-tv-plus-free-channels-apps/',
    streamUrl: 'https://lotus.stingray.com/manifest/qello-qello001-montreal/samsungtvplus/master.m3u8', rules: ['lotus.stingray.com'] },
  { id: 'totalmusic-concerts', name: 'Totalmusic Concerts', group: '娱乐时尚', page: 'https://www.40mediagroup.com/canales/totalmusic-concerts/',
    streamUrl: 'https://cdn.40mediagroup.com/live/c7eds/Totalmusic_Concerts/SA_LIVE_hls_enc/master.m3u8', rules: ['cdn.40mediagroup.com'] },
  { id: 'bread-tv', name: '面包台', group: '娱乐时尚', page: 'https://www.bread-tv.com/',
    streamUrl: 'https://video.bread-tv.com:8091/hls-live24/online/index.m3u8', rules: [{ hostname: 'video.bread-tv.com', port: '8091' }] },
  { id: 'cna', name: 'CNA', group: '国际', page: 'https://www.channelnewsasia.com/watch',
    streamUrl: 'https://d2e1asnsl7br7b.cloudfront.net/7782e205e72f43aeb4a48ec97f66ebbe/index.m3u8', rules: ['d2e1asnsl7br7b.cloudfront.net'] },
  { id: 'reuters', name: 'Reuters', group: '国际', page: 'https://www.reuters.com/video/',
    logo: 'https://provider-static.plex.tv/epg/cms/production/8cf9c131-2d92-4d91-86b1-22ef458d703f/reuters_reutersnow_1RDX.png',
    streamUrl: 'https://dbrb49pjoymg4.cloudfront.net/manifest/3fec3e5cac39a52b2132f9c66c83dae043dc17d4/prod_default_xumo-ams-aws/e7493ea5-5c1c-4d7a-a3f7-e95516048ad8/3.m3u8',
    rules: ['dbrb49pjoymg4.cloudfront.net', 'amg00453-reuters-amg00453c1-xumo-us-2073.playouts.now.amagi.tv'] },
  { id: 'nasa-plus', name: 'NASA+ Live', group: '国际', page: 'https://plus.nasa.gov/scheduled-events/', kind: 'nasa',
    rules: [/^ntv\d+\.akamaized\.net$/] },
  { id: 'news1', name: 'NEWS1', group: '国际', page: 'https://news1live.com/',
    streamUrl: 'https://server1.streamssl.com/stream/news1.m3u8', rules: ['server1.streamssl.com'] },
  { id: 'france24-fr', name: 'France 24 Français', group: '国际', page: 'https://www.france24.com/fr/',
    streamUrl: 'https://live.france24.com/hls/live/2037179-b/F24_FR_HI_HLS/master_5000.m3u8', rules: ['live.france24.com'] },
  { id: 'france24-en', name: 'France 24 English', group: '国际', page: 'https://www.france24.com/en/',
    streamUrl: 'https://live.france24.com/hls/live/2037218-b/F24_EN_HI_HLS/master_5000.m3u8', rules: ['live.france24.com'] },
  { id: 'france24-es', name: 'France 24 Español', group: '国际', page: 'https://www.france24.com/es/',
    streamUrl: 'https://live.france24.com/hls/live/2037220-b/F24_ES_HI_HLS/master_5000.m3u8', rules: ['live.france24.com'] },
  { id: 'france24-ar', name: 'France 24 Arabic', group: '国际', page: 'https://www.france24.com/ar/',
    streamUrl: 'https://live.france24.com/hls/live/2037222-b/F24_AR_HI_HLS/master_5000.m3u8', rules: ['live.france24.com'] },
  { id: 'rthk-tv31', name: '港台电视31', group: '香港', page: 'https://www.rthk.hk/tv/dtt31',
    streamUrl: 'https://rthktv31-live.akamaized.net/hls/live/2036818/RTHKTV31/master.m3u8', rules: ['rthktv31-live.akamaized.net'] },
  { id: 'red-bull-tv', name: 'Red Bull TV', group: '体育', page: 'https://www.redbull.com/int-en/tv',
    streamUrl: 'https://rbmn-live.akamaized.net/hls/live/590964/BoRB-AT/master.m3u8', rules: ['rbmn-live.akamaized.net'] },
  { id: 'trace-sport-stars', name: 'Trace Sport Stars', group: '体育', page: 'https://www.samsung.com/au/tvs/smart-tv/samsung-tv-plus/all-channels/',
    streamUrl: 'https://lightning-tracesport-samsungau.amagi.tv/playlist.m3u8', rules: ['lightning-tracesport-samsungau.amagi.tv'] },
  { id: 'bein-sports-xtra', name: 'beIN Sports Xtra', group: '体育', page: 'https://www.beinsports.com/en-au/bein-xtra?app=true',
    logo: 'https://image.xumo.com/v1/channels/channel/99991387/168x168.png?type=color_onBlack',
    streamUrl: 'https://bein-xtra-bein.amagi.tv/playlist.m3u8', rules: ['bein-xtra-bein.amagi.tv'] },
  { id: 'fifa-plus', name: 'FIFA+', group: '体育', page: 'https://www.plus.fifa.com/',
    streamUrl: 'https://d2w9q46ikgrcwx.cloudfront.net/v1/master/3722c60a815c199d9c0ef36c5b73da68a62b09d1/cc-of5cbk3sav3w5/v1/sysdata_s_p_a_fifa_7/samsungheadend_us/latest/main/hls/playlist.m3u8',
    rules: ['d2w9q46ikgrcwx.cloudfront.net'] },
  { id: 'nbc-sports-now', name: 'NBC Sports NOW', group: '体育', page: 'https://www.nbcsports.com/now',
    logo: 'https://image.xumo.com/v1/channels/channel/99951253/168x168.png?type=color_onBlack',
    streamUrl: 'https://d4whmvwm0rdvi.cloudfront.net/manifest/3fec3e5cac39a52b2132f9c66c83dae043dc17d4/prod_default_xumo-nbcu-linear/9ed59304-2f35-4c88-9b99-34153edef42b/4.m3u8',
    rules: ['d4whmvwm0rdvi.cloudfront.net', /^xumo-xumoent-vc-\d+-[a-z0-9]+\.fast\.nbcuni\.com$/] },
  { id: 'nhl-fast', name: 'NHL FAST', group: '体育', page: 'https://www.nhl.com/news/nhl-fast-channel-on-roku-338231668',
    streamUrl: 'https://nhl-firetv.amagi.tv/playlist1080p.m3u8', rules: ['nhl-firetv.amagi.tv'] },
  { id: 'tennis-channel-international', name: 'Tennis Channel International', group: '体育', page: 'https://www.tennis.com/international',
    logo: 'https://i.ibb.co/pBBqvWSK/tennis-channel.png',
    streamUrl: 'https://cdn-uw2-prod.tsv2.amagi.tv/linear/amg01444-tennischannelth-tennischnlintl-lggb/playlist.m3u8',
    rules: ['cdn-uw2-prod.tsv2.amagi.tv', /^amg01444-tennischannelth-tennischnlintl-lggb-[a-z0-9]+\.amagi\.tv$/] },
  { id: 'ufc-24-7', name: 'UFC 24/7', group: '体育', page: 'https://play.xumo.com/networks/ufc/99951134',
    logo: 'https://d1biytugnv36sr.cloudfront.net/resize?width=400&height=200&url=https://static.frequency.com/studio/ufc/channels/ufc-domestic400x200.png',
    streamUrl: 'https://dbrb49pjoymg4.cloudfront.net/manifest/3fec3e5cac39a52b2132f9c66c83dae043dc17d4/prod_default_xumo-ams-aws/194a140c-0cf5-443e-b747-08bf621d75a8/0.m3u8',
    rules: ['dbrb49pjoymg4.cloudfront.net', /^linear-\d+\.frequency\.stream$/] },
  { id: 'stadium', name: 'Stadium', group: '体育', page: 'https://watchstadium.com/',
    streamUrl: 'https://wurl120sports.global.transmit.live/hls/679a907dce42a042c23ace37/v1/stadium_gracenote/samsung_us/latest/main/hls/playlist.m3u8',
    rules: ['wurl120sports.global.transmit.live', /^[a-z0-9]+\.wurl\.com$/] },
  { id: 'mtrspt1', name: 'MTRSPT1', group: '体育', page: 'https://www.mtrspt1.com/',
    streamUrl: 'https://amg02873-kravemedia-mtrspt1-samsungau-2anp4.amagi.tv/playlist/amg02873-kravemedia-mtrspt1-samsungau/playlist.m3u8',
    rules: ['amg02873-kravemedia-mtrspt1-samsungau-2anp4.amagi.tv'] },
  { id: 'china-travel', name: 'China Travel', group: '文旅', page: 'https://www.cctvplus.com/',
    streamUrl: 'https://fastlive.cctvplus.com/out/v1/ca6f9297b7314a63959435028af287fc/index.m3u8', rules: ['fastlive.cctvplus.com'] },
  { id: 'dali-tv', name: '大立电视台', group: '台湾', page: 'http://www.dalitv.com.tw/',
    streamUrl: 'http://www.dalitv.com.tw:4568/live/dali/index.m3u8', rules: [{ hostname: 'www.dalitv.com.tw', protocol: 'http:', port: '4568' }] },
]

const BY_ID = new Map(SOURCES.map(source => [source.id, source]))

export function sourceFromRef(ref) {
  const match = /^asian-live-([a-z0-9][a-z0-9-]{0,47})$/.exec(String(ref || ''))
  return match ? BY_ID.get(match[1]) : undefined
}

export function claimsRef(ref) {
  return !!sourceFromRef(ref)
}

export function buildGroups() {
  const groups = new Map()
  for (const source of SOURCES) {
    if (!groups.has(source.group)) groups.set(source.group, { name: source.group, dataList: [] })
    groups.get(source.group).dataList.push({
      name: source.name,
      deferredRef: `asian-live-${source.id}`,
      logo: source.logo || '',
      opts: ['network-caching=3000'],
      catchup: 'none',
    })
  }
  return [...groups.values()]
}
