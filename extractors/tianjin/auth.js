/**
 * 津云 WiseTV 接口的应用参数与请求头：取流（api.js）与节目单（epg.js）共用。
 *
 * 只放常量与纯计算，不发请求、不 import 项目内部模块——节目单拆出去单独维护时连同
 * channels.js 整份带走即可。
 *
 * 签发直播地址和节目单都走 jyapi2.wisetv.com.cn:8684/v3，每个请求都要带 ak / sk 与一组
 * 固定的设备头；不带回 code 4001「缺少授权认证信息」。设备标识实测随机值即可，
 * 每个进程随机一个 16 位十六进制，不落盘、不和任何人关联。
 */
import { randomBytes } from 'node:crypto'

export const API_ROOT = 'https://jyapi2.wisetv.com.cn:8684/v3'
// 接口实测不看 UA；带上 App 网络库的标识，不用 Node 默认的 undici 标识
export const API_UA = 'okhttp/4.9.3'

// 津云 App 内置的 WiseTV 应用参数（AK / SK 与签发直播地址用的 24 字节 3DES 密钥）。
// 与安徽视讯内置的租户种子同一性质：属于应用、不是用户凭据，所以作为默认值写在这里；
// 平台换参数时可用环境变量覆盖，不必等发版。
const DEFAULT_AK = 'HyQuy347BBv9En+0VZ8ToA=='
const DEFAULT_SK = 'CQNRW8hsdrKKwHr1ofFgdw=='
const DEFAULT_3DES_KEY = '298826ae269c0ba92bc6b7fb'

export const DEVICE_ID = randomBytes(8).toString('hex')

/** 生效的应用参数：环境变量 TIANJIN_WISE_AK / TIANJIN_WISE_SK / TIANJIN_WISE_3DES_KEY 优先。 */
export function wiseConfig(env = process.env) {
  return {
    ak: String(env?.TIANJIN_WISE_AK || DEFAULT_AK),
    sk: String(env?.TIANJIN_WISE_SK || DEFAULT_SK),
    cipherKey: String(env?.TIANJIN_WISE_3DES_KEY || DEFAULT_3DES_KEY),
  }
}

/** App 发给 WiseTV 接口的请求头，字段照 App 抓包原样，空值也要带。 */
export function wiseHeaders(config = wiseConfig(), deviceId = DEVICE_ID) {
  if (!config?.ak || !config?.sk) throw new Error('津云接口缺少 AK / SK')
  return {
    ak: config.ak,
    sk: config.sk,
    authorization: '',
    imei: deviceId,
    'x-appcode': '1',
    'x-appversion': '1.0',
    'x-bindarea': '',
    'x-bindcp': '',
    'x-bindid': '',
    'x-deviceid': deviceId,
    'x-phoneno': '',
    'x-phonever': 'sdk_gphone_arm64',
    'x-platform': 'Android',
    'x-sysver': '11',
    'x-userid': '',
    'User-Agent': API_UA,
  }
}
