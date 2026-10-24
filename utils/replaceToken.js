/**
 * 订阅输出时的本机地址占位符 `${replace}`。
 *
 * interfaceStr（utils/appUtils.js）对外输出播放列表时，把它整篇替换成「本机地址 + 访问前缀」
 * （/<pass> 或 /u/<token>，带咪咕账号时还有 /<userId>/<token>）。只有本项目自己生成的位置
 * 可以写它：订阅头、咪咕 / 模块的占位地址、本机托管的台标、公告频道。
 *
 * 第三方订阅、内置源 JSON、各平台接口返回的数据里如果出现它，也会被同样展开，把访问凭据
 * 拼进指向第三方的地址，播放、取台标、回看时发给对方。这类外来数据一律不许带它。
 */
export const REPLACE_TOKEN = '${replace}'

/** 值里是否含占位符；非字符串（数字 pID 等）按字符串看 */
export function hasReplaceToken(value) {
  return value != null && String(value).includes(REPLACE_TOKEN)
}
