/**
 * 海南网台七套电视的固定频道表：取流（api.js）与节目单（epg.js）共用。
 * 纯数据，不 import 任何东西——epg.js 连同本文件拿出去就能单独产出节目单。
 */

// 固定七套电视的身份与顺序。ID、名称、频道代码必须同时吻合，避免接口将来混入
// 广播、临时直播，或复用 ID 后把已有频道静默换成别的内容。
export const CHANNELS = [
  { id: '13', rawName: '海南卫视', name: '海南卫视', code: 'STHaiNan_channel_lywsgq' },
  { id: '5', rawName: '三沙卫视', name: '三沙卫视', code: 'STHaiNan_channel_ssws' },
  { id: '1', rawName: '海南自贸', name: '海南自贸', code: 'jjpd' },
  { id: '3', rawName: '海南新闻', name: '海南新闻', code: 'STHaiNan_channel_xwpd' },
  { id: '4', rawName: '海南社会与法', name: '海南社会与法', code: 'ggpd' },
  { id: '6', rawName: '海南文旅', name: '海南文旅', code: 'wlpd' },
  { id: '7', rawName: '海南少儿', name: '海南少儿', code: 'sepd' },
]
