/**
 * 咪咕的播放时解析：pID → 签名地址。
 *
 * 从 utils/appUtils.js 的 channel() 原样搬来，**刻意不做任何"顺手优化"**——
 * 这段代码在所有用户的播放器订阅里跑，每一个可观察行为都被存量地址锁死：
 *
 * - 缓存键只含 pid，与账号/画质/回看参数无关。站长用 /<userId>/<token>/<pid>
 *   注入 VIP 账号时，若同一 pid 三小时内已被游客路径缓存过，拿到的就是游客画质
 *   地址。这看着像 bug，其实是存量行为——把账号加进键是行为变更，不是修 bug。
 * - 缓存 3 小时、节目调整时 1 分钟，两档都不能动。
 * - 失败返回 { url: '' } 而不是抛异常：app.js 的请求 handler 整段没有顶层 try，
 *   一个未捕获的异常 = 请求永远不 res.end()、客户端挂死到超时。
 * - 地址一律裸字符串拼接。用 new URL() / URLSearchParams 统一构造会把 puData
 *   与 ddCalcu 里的原始字符重新编码，签名当场失效。
 *
 * 缓存放在模块里而不是外壳里：它缓存的 content 是咪咕的响应体（登录态信息由此
 * 而来），3 小时也是签名有效期这个平台属性，不是通用的 HTTP 缓存策略。
 */
import { get302URL, getAndroidURL, getAndroidURL720p, printStreamInfo } from "./androidURL.js"
import { printDebug } from "../../utils/colorOut.js"

// 键是裸 pid。过期条目只是不命中、不回收——这是搬家前的行为，不加 LRU/上限，
// 那会改变「重启前一直命中」这个存量特性。
const urlCache = {}

/** 画质/编码等参数改动后必须清空，否则三小时内继续下发旧编码的流（issue #60）。 */
export function clearCache() {
  for (const key of Object.keys(urlCache)) delete urlCache[key]
}

/** 读缓存。命中返回 { url, desc }，未命中返回 null。 */
function readCache(pid) {
  if (typeof urlCache[pid] !== "object") return null
  if (urlCache[pid].valTime - Date.now() < 0) return null

  let msg = "节目调整，暂不提供服务"
  if (urlCache[pid].content != null) {
    msg = urlCache[pid].content.message
  }
  const url = urlCache[pid].url
  // 节目调整
  if (url == "") return { url: "", desc: `${pid} ${msg}` }

  // 一行「咪咕取流（缓存）：档位」替代原来的「登录认证成功」+「使用缓存数据」两行
  printStreamInfo(urlCache[pid], { cached: true })
  return { url, desc: "缓存获取成功" }
}

/**
 * 解析一个 ref（咪咕的 pID）成可播地址。
 *
 * @param {string} ref  裸 pid
 * @param {object} ctx  { account: { userId, token } }
 * @returns {Promise<{url: string, desc: string}>} url 为空串表示不可用，desc 是原因
 */
export async function resolve(ref, ctx = {}) {
  const pid = ref
  const userId = ctx.account?.userId ?? ""
  const token = ctx.account?.token ?? ""
  // 画质参数来自模块自己的 configSchema（经 extractorManager.effectiveConfig →
  // appUtils 的路由外壳传进来），不再直接 import 全局 config.js。
  const config = ctx.config || {}
  const rateType = config.rateType ?? 3
  const enableClientDispatch = config.enableClientDispatch === true
  const qualityOpts = { enableHDR: config.enableHDR, enableH265: config.enableH265 }

  const cached = readCache(pid)
  if (cached) return cached

  let resObj = {}
  try {
    // 未登录请求720p
    if (rateType >= 3 && (userId == "" || token == "")) {
      resObj = await getAndroidURL720p(pid, qualityOpts)
    } else {
      resObj = await getAndroidURL(userId, token, pid, rateType, qualityOpts)
    }
  } catch (error) {
    console.log(error)
    return { url: "", desc: "链接请求出错" }
  }
  printDebug(`添加加密字段后链接 ${resObj.url}`)

  if (resObj.url != "") {
    // 客户端就近取流（issue #82）：不在服务端解析调度地址，直接把 gslbmgsplive 调度地址 302 给播放器，
    // 由观看设备的网络就近分配 CDN 节点——服务器与观看设备运营商不同时，服务端解析会拿到「服务器侧运营商」
    // 的节点，跨网访问卡顿/播不了。调度地址与解析后节点地址携带同一组鉴权参数，时效一致，缓存逻辑照用。
    if (enableClientDispatch) {
      printDebug("客户端就近取流：跳过服务端节点解析，直接下发调度地址")
    } else {
      const location = await get302URL(resObj)
      if (location != "") {
        resObj.url = location
      }
    }
  }
  printStreamInfo(resObj)

  // 缓存有效时长
  let addTime = 3 * 60 * 60 * 1000
  // 节目调整
  if (resObj.url == "") {
    addTime = 1 * 60 * 1000
  }
  // 加入缓存
  urlCache[pid] = {
    // 有效期3小时 节目调整时改为1分钟
    valTime: Date.now() + addTime,
    url: resObj.url,
    content: resObj.content,
  }

  if (resObj.url == "") {
    const msg = resObj.content != null ? resObj.content.message : "节目调整，暂不提供服务"
    return { url: "", desc: `${pid} ${msg}` }
  }

  return { url: resObj.url, desc: "链接获取成功" }
}
