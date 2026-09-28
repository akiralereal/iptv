/**
 * 海南网台七套电视的固定频道表：取流（api.js）与节目单（epg.js）共用。
 * 纯数据，不 import 任何东西——epg.js 连同本文件拿出去就能单独产出节目单。
 */

// 台标：官网频道接口（www.hnntv.cn/api/channel）不带图，取「视听海南」App 直播频道列表
// （service-app.hnntv.cn/EPGService/v3/Content/GetLiveChannelnfo）每路下发的 img——192×192 的频道圆标，
// 七套各不相同。img 是相对路径，按 App 配置里的图片基址 img-app.hnntv.cn/resource/ 拼完整（https 可用）。
const LOGO_BASE = 'https://img-app.hnntv.cn/resource/upload/image/media/'

// 固定七套电视的身份与顺序。ID、名称、频道代码必须同时吻合，避免接口将来混入
// 广播、临时直播，或复用 ID 后把已有频道静默换成别的内容。
export const CHANNELS = [
  { id: '13', rawName: '海南卫视', name: '海南卫视', code: 'STHaiNan_channel_lywsgq',
    logo: `${LOGO_BASE}2023-09-03/94fb34ba-3474-4b48-aa32-0a4a61721af3.png` },
  { id: '5', rawName: '三沙卫视', name: '三沙卫视', code: 'STHaiNan_channel_ssws',
    logo: `${LOGO_BASE}2023-09-03/b15bb5dd-f724-419f-b629-71d9752eb26d.png` },
  { id: '1', rawName: '海南自贸', name: '海南自贸', code: 'jjpd',
    logo: `${LOGO_BASE}2023-09-03/bb673c2e-8719-4622-9b5e-4f4a6b2388e1.png` },
  { id: '3', rawName: '海南新闻', name: '海南新闻', code: 'STHaiNan_channel_xwpd',
    logo: `${LOGO_BASE}2023-09-03/caf876fd-4c73-4301-a230-337d9fd10fca.png` },
  { id: '4', rawName: '海南社会与法', name: '海南社会与法', code: 'ggpd',
    logo: `${LOGO_BASE}2026-01-16/c82bee22-e400-433c-a85f-9cf6370ca5a7.png` },
  { id: '6', rawName: '海南文旅', name: '海南文旅', code: 'wlpd',
    logo: `${LOGO_BASE}2023-09-03/7c693c8b-dd1d-4223-af95-0fd53cd90ad5.png` },
  { id: '7', rawName: '海南少儿', name: '海南少儿', code: 'sepd',
    logo: `${LOGO_BASE}2023-09-03/56a568e6-620b-4cca-9a02-b41caf0f861c.png` },
]
