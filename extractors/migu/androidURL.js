import { getStringMD5 } from "../../utils/EncryUtils.js";
import { getddCalcuURL, getddCalcuURL720p } from "./ddCalcuURL.js";
import { printDebug, printGreen, printRed, printYellow } from "../../utils/colorOut.js";
import { fetchUrl } from "../../utils/net.js";
import { delay } from "../../utils/fetchList.js";
// 画质开关的默认来源。模块化之后它们由 migu 模块的 configSchema 提供、经 opts 传进来；
// 这里保留 import 作为默认值，让根目录那个一次性脚本 fetchURLByAndroid720p.js
// （直接调 getAndroidURL720p(pid)、不传 opts）继续可用，也便于回滚。
import { enableH265, enableHDR } from "../../config.js";
import fetch from 'node-fetch';

/**
 * @typedef {object} SaltSign
 * @property {string} salt 盐值
 * @property {string} sign 签名
 */

/**
 * @param {string} md5 - md5字符串
 * @returns {SaltSign} - 
 */
function getSaltAndSign(md5) {

  const salt = 1230024
  const suffix = "3ce941cc3cbc40528bfd1c64f9fdf6c0migu0123"
  const sign = getStringMD5(md5 + suffix)
  return {
    salt: salt,
    sign: sign
  }
}

/**
 * @param {string} userId - 用户ID
 * @param {string} token - 用户token
 * @param {string} pid - 节目ID
 * @param {number} rateType - 清晰度
 * @returns {} - 
 */
// 咪咕 playurl 接口请求失败的统一收敛（用户日志截图反馈）：
// fetchUrl 在超时/网络不通/非 JSON 响应时返回 undefined，部分风控/限流响应则没有 body 字段——
// 此前直接读 respData.rid / respData.body 会抛 "Cannot read properties of undefined" 刷日志。
// 统一返回干净的失败结果：channel() 会把 message 展示出来并按 1 分钟短缓存自动重试。
function miguFetchFail(respData) {
  const message = (respData && (respData.message || respData.desc))
    || "咪咕接口请求失败：网络超时或不可达（服务器挂代理、海外部署、DNS 异常最常见），请检查服务器到 miguvideo.com 的网络"
  return { url: "", rateType: 0, content: { message, raw: respData } }
}

// playurl 各档位的文案，只用于日志。与 extractors/migu/index.js 的画质选项一致；
// 咪咕回应里出现的档位以外的数字兜底按数字打印。
const RATE_LABELS = { 1: '流畅', 2: '标清 540P', 3: '高清 720P', 4: '蓝光 1080P', 7: '原画', 9: '4K 臻享超高清' }
function rateLabel(rt) { return RATE_LABELS[rt] || `档位 ${rt}` }

// 把咪咕拒绝时的原话带进日志。此前拒绝一律打「该账号没有会员」，可用户明明有会员、
// 只是档位不含所请求的画质 / 终端权益，被这句话带着去纠结账号本身（issue #117）。
function serverHint(respData) {
  const msg = respData?.message
  return msg && msg !== 'SUCCESS' ? `（咪咕：${msg}）` : ''
}

async function getAndroidURL(userId, token, pid, rateType, opts = {}) {
  const useHDR = opts.enableHDR ?? enableHDR
  const useH265 = opts.enableH265 ?? enableH265
  // 可注入的请求函数，只给回归测试用（scripts/test-migu-4k-fallback.mjs）
  const doFetch = opts.fetchUrl ?? fetchUrl

  if (rateType <= 1) {
    return {
      url: "",
      rateType: 0,
      content: null
    }
  }
  // 获取url
  const timestramp = Date.now()
  const appVersion = "26000370"
  let headers = {
    AppVersion: 2600037000,
    TerminalId: "android",
    "X-UP-CLIENT-CHANNEL-ID": "2600037000-99000-200300220100002",
  }
  // cctv5和5+开启flv后不能回放
  if (pid != "641886683" && pid != "641886773") {
    headers["appCode"] = "miguvideo_default_android"
  }

  if (rateType != 2 && userId != "" && token != "") {
    headers.UserId = userId
    headers.UserToken = token
  }
  // console.log(headers)
  const str = timestramp + pid + appVersion
  const md5 = getStringMD5(str)
  const result = getSaltAndSign(md5)

  let enableHDRStr = ""
  if (useHDR) {
    enableHDRStr = "&4kvivid=true&2Kvivid=true&vivid=2"
  }
  let enableH265Str = ""
  if (useH265) {
    enableH265Str = "&h265N=true"
  }
  // 请求
  const baseURL = "https://play.miguvideo.com/playurl/v1/play/playurl"
  const requestPlayurl = async (rt, withOtt) => {
    const params = "?sign=" + result.sign + "&rateType=" + rt
      + "&contId=" + pid + "&timestamp=" + timestramp + "&salt=" + result.salt
      + "&flvEnable=true&super4k=true" + (withOtt ? "&ott=true" : "") + enableH265Str + enableHDRStr
    printDebug(`请求链接: ${baseURL + params}`)
    const resp = await doFetch(baseURL + params, {
      headers: headers
    })
    printDebug(resp)
    return resp
  }

  // 4K 先带 ott=true 请求。ott 是「大屏 / 电视终端」取流策略，咪咕按大屏（四屏）权益判定；
  // 实测游客带 ott 直接 409 连降级流都不给，不带 ott 则正常给 540P、且 mediaFiles 里就列着
  // rateType 9「臻享 超高清」——手机策略本身就有 4K。足球通这类不含电视端的「三屏」会员在
  // 大屏策略下被判 TIPS_NEED_MEMBER，此前这里直接降到蓝光，1080P 就成了他们的天花板
  // （issue #117）。现在被拒后先原样按手机策略再要一次 4K，仍被拒才降级；含大屏权益的
  // 账号第一次就成功，路径不变。
  let respData = await requestPlayurl(rateType, rateType == 9)
  if (!respData) return miguFetchFail(respData)

  if (respData.rid == 'TIPS_NEED_MEMBER' && rateType == 9) {
    printYellow(`4K 按大屏策略被拒${serverHint(respData)}，改按手机策略再要一次 4K`)
    respData = await requestPlayurl(9, false)
    if (!respData) return miguFetchFail(respData)
  }
  if (respData.rid == 'TIPS_NEED_MEMBER') {
    // 拒绝回应的 urlInfo.rateType 是咪咕愿意给的档位（同一字段在游客被拒时就是它降到的
    // 540P）。它给到蓝光或更高就先要蓝光，否则直接高清；再被拒一次兜底到高清。
    const offered = parseInt(respData.body?.urlInfo?.rateType)
    const fallback = offered >= 4 ? 4 : 3
    printYellow(`${rateLabel(rateType)} 超出账号权益${serverHint(respData)}，已降到 ${rateLabel(fallback)}`)
    respData = await requestPlayurl(fallback, false)
    if (!respData) return miguFetchFail(respData)
    if (respData.rid == 'TIPS_NEED_MEMBER' && fallback != 3) {
      printYellow(`${rateLabel(fallback)} 仍超出账号权益${serverHint(respData)}，已降到 ${rateLabel(3)}`)
      respData = await requestPlayurl(3, false)
    }
  }
  // console.log(respData)
  if (!respData || !respData.body) return miguFetchFail(respData)
  const url = respData.body.urlInfo?.url
  // console.log(rateType)
  // console.log(url)
  if (!url) {
    return {
      url: "",
      rateType: 0,
      content: respData
    }
  }
  pid = respData.body.content?.contId || pid

  // 将URL加密
  const resURL = getddCalcuURL(url, pid, "android", rateType, userId)

  rateType = respData.body.urlInfo?.rateType
  // console.log("清晰度" + rateType)
  return {
    url: resURL,
    rateType: parseInt(rateType),
    content: respData
  }

}


/**
 * 旧版高清画质
 * @param {string} pid - 节目ID
 * @returns {} - 
 */
async function getAndroidURL720p(pid, opts = {}) {
  const useHDR = opts.enableHDR ?? enableHDR
  const useH265 = opts.enableH265 ?? enableH265
  // 获取url
  const timestramp = Math.round(Date.now()).toString()
  const appVersion = "2600034600"
  const appVersionID = appVersion + "-99000-201600010010028"
  let headers = {
    AppVersion: `${appVersion}`,
    TerminalId: "android",
    "X-UP-CLIENT-CHANNEL-ID": `${appVersionID}`,
  }
  // cctv5和5+开启flv后不能回放
  if (pid != "641886683" && pid != "641886773") {
    headers["appCode"] = "miguvideo_default_android"
  }
  // console.log(headers)
  const str = timestramp + pid + appVersion.substring(0, 8)
  const md5 = getStringMD5(str)

  const salt = String(Math.floor(Math.random() * 1000000)).padStart(6, '0') + '25'
  const suffix = "2cac4f2c6c3346a5b34e085725ef7e33migu" + salt.substring(0, 4)
  const sign = getStringMD5(md5 + suffix)

  let rateType = 3
  let enableHDRStr = ""
  if (useHDR) {
    enableHDRStr = "&4kvivid=true&2Kvivid=true&vivid=2"
  }
  let enableH265Str = ""
  if (useH265) {
    enableH265Str = "&h265N=true"
  }
  // 请求
  const baseURL = "https://play.miguvideo.com/playurl/v1/play/playurl"
  const params = "?sign=" + sign + "&rateType=" + rateType
    + "&contId=" + pid + "&timestamp=" + timestramp + "&salt=" + salt
    + "&flvEnable=true&super4k=true" + enableH265Str + enableHDRStr
  printDebug(`请求链接: ${baseURL + params}`)
  const respData = await fetchUrl(baseURL + params, {
    headers: headers
  })

  printDebug(respData)
  // console.dir(respData, { depth: null })
  if (!respData || !respData.body) return miguFetchFail(respData)
  const url = respData.body.urlInfo?.url
  // console.log(rateType)
  // console.log(url)
  if (!url) {
    return {
      url: "",
      rateType: 0,
      content: respData
    }
  }

  rateType = respData.body.urlInfo?.rateType
  pid = respData.body.content?.contId || pid

  // 将URL加密
  const resURL = getddCalcuURL720p(url, pid)

  return {
    url: resURL,
    rateType: parseInt(rateType),
    content: respData
  }

}

async function get302URL(resObj) {
  try {
    let z = 1
    while (z <= 6) {
      if (z >= 2) {
        printYellow(`获取失败,正在第${z - 1}次重试`)
      }
      const controller = new AbortController()
      let timedOut = false;
      const timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort()
        // 只在最后一次才打印红字
        if (z === 6) {
          printRed("请求超时（最终失败）")
        } else {
          printYellow("请求超时，准备重试")
        }
      }, 6000);
      const obj = await fetch(`${resObj.url}`, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal
      }).catch(err => {
        clearTimeout(timeoutId);
        if (!timedOut) {
          console.log(err)
        }
      })
      clearTimeout(timeoutId);
      const location = obj?.headers?.get("Location")

      if (location != "" && location != undefined && location != null) {
        if (!location.startsWith("http://bofang")) {
          return location
        }
      }
      if (z != 6) {
        await delay(150)
      }
      z++
    }
  } catch (error) {
    console.log(error)
  }
  printRed(`获取失败,返回原链接`)
  return ""
}

function printLoginInfo(resObj) {
  // content 可能是 null——rateType <= 1 时 getAndroidURL 直接返回 {url:"", content:null}
  // （见本文件 :49-55）。而调用点 utils/appUtils.js:293 在 try 之外，app.js 的
  // 请求 handler 也没有顶层 try，于是这里一个 TypeError 就让请求永远不 end：
  // 客户端挂死到超时，服务端只在 unhandledRejection 留一行日志。
  if (resObj?.content?.body?.auth?.logined) {
    printGreen("登录认证成功")
    if (resObj.content.body.auth.authResult == "FAIL") {
      printRed(`认证失败 视频内容不完整 可能缺少相关VIP: ${resObj.content.body.auth.resultDesc}`)
    }
  } else {
    // printYellow("未登录")
  }
}

export { getAndroidURL, getAndroidURL720p, get302URL, printLoginInfo }
