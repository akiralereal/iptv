import { readFileSync, existsSync } from "node:fs"
import path from "node:path"

const SYSTEM_CONFIG_PATH = path.join(process.cwd(), 'system-config.json')

// 加载系统配置文件
function loadSystemConfig() {
  if (existsSync(SYSTEM_CONFIG_PATH)) {
    try {
      const content = readFileSync(SYSTEM_CONFIG_PATH, 'utf-8')
      return JSON.parse(content)
    } catch (error) {
      console.error('加载系统配置失败:', error.message)
      return {}
    }
  }
  return {}
}

const systemConfig = loadSystemConfig()

// 用户id
const userId = systemConfig.userId || process.env.muserId || ""
// 用户token 可以使用网页登录获取
const token = systemConfig.token || process.env.mtoken || ""
// 本地运行端口号
const port = systemConfig.port || process.env.mport || 1905
// 公网/自定义访问地址
const host = systemConfig.host || process.env.mhost || ""
// 画质
// 4蓝光(1080p，需要登录且账号有VIP)
// 3高清(720p)
// 2标清(480p)
const rateType = systemConfig.rateType || process.env.mrateType || 3
// 是否刷新token，可能是导致封号的原因
// const refreshToken = process.env.mrefreshToken || true
const debug = process.env.mdebug || false
// 访问密码 大小写字母和数字 添加后访问格式 http://ip:port/mpass/...
const pass = systemConfig.pass || process.env.mpass || ""
// 是否开启hdr
const enableHDR = systemConfig.enableHDR !== undefined ? systemConfig.enableHDR : (process.env.menableHDR || true)
// 是否开启h265(原画画质)，开启可能存在兼容性问题，比如浏览器播放没有画面
const enableH265 = systemConfig.enableH265 !== undefined ? systemConfig.enableH265 : (process.env.menableH265 || true)
// 节目信息更新间隔 单位小时 不建议设置太短
const programInfoUpdateInterval = systemConfig.programInfoUpdateInterval || process.env.mupdateInterval || "8"

export { userId, token, port, host, rateType, debug/* , refreshToken */, pass, enableHDR, programInfoUpdateInterval, enableH265 }
