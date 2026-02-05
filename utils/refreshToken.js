import { AESencrypt, getStringMD5, RSAencrypt } from "./EncryUtils.js"
import { fetchUrl } from "./net.js";

/**
 * @param {string} str - 
 * @returns {string} - 
 */
function encodeURLEncoder(str) {
  return encodeURIComponent(str)
    .replace(/[!'()*]/g, (c) =>
      '%' + c.charCodeAt(0).toString(16).toUpperCase()
    )
    .replace(/%20/g, '+');
}

/**
 * 刷新token
 * @param {string} userId - 用户ID
 * @param {string} token - 用户token
 * @returns {} - 是否成功
 */
async function refreshToken(userId, token) {

  if (userId == null || userId == undefined || token == null || token == undefined) {
    return false
  }

  // 请求体data加密前
  const time = Math.floor(Date.now() / 1000)
  const baseData = `{"userToken":"${token}","autoDelay":true,"deviceId":"","userId":"${userId}","timestamp":"${time}"}`

  // 请求体加密
  const encryData = AESencrypt(baseData)
  const data = '{"data":"' + encryData + '"}'

  // 签名
  const str = getStringMD5(data)
  const sign = encodeURLEncoder(RSAencrypt(str))

  const headers = {
    userId: userId,
    userToken: token,
    "Content-Type": "appsication/json; charset=utf-8"
  }

  const baseURL = "https://migu-app-umnb.miguvideo.com/login/token_refresh_migu_plus"
  const params = `?clientId=27fb3129-5a54-45bc-8af1-7dc8f1155501&sign=${sign}&signType=RSA`

  try {
    // 发送请求
    const respResult = await fetchUrl(baseURL + params, {
      headers: headers,
      method: "post",
      body: data
    })

    // 处理响应结果
    if (respResult.resultCode == "REFRESH_TOKEN_SUCCESS") {
      // console.log(respResult)
      return true
    }
    console.dir(respResult, { depth: null })
  } catch (error) {
  }

  return false
}

export default refreshToken
