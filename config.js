// 用户id
const userId = process.env.muserId || ""
// 用户token 可以使用网页登录获取
const token = process.env.mtoken || ""
// 本地运行端口号
const port = process.env.mport || 1234
// 公网/自定义访问地址
const host = process.env.mhost || ""
// 画质
// 4蓝光(需要登录且账号有VIP)
// 3高清
// 2标清
const rateType = process.env.mrateType || 3
// 是否刷新token，可能是导致封号的原因
// const refreshToken = process.env.mrefreshToken || true
const debug = process.env.mdebug || false
// 访问密码 大小写字母和数字 添加后访问格式 http://ip:port/mpass/...
const pass = process.env.mpass || ""
// 是否开启hdr
const enableHDR = process.env.menableHDR || true
// 是否开启h265(原画画质)，开启可能存在兼容性问题，比如浏览器播放没有画面
const enableH265 = process.env.menableH265 || true
// 节目信息更新间隔 单位小时 不建议设置太短
const programInfoUpdateInterval = process.env.mupdateInterval || "6"

export { userId, token, port, host, rateType, debug/* , refreshToken */, pass, enableHDR, programInfoUpdateInterval, enableH265 }
