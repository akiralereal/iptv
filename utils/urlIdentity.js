/**
 * 频道地址的「身份」部分：剥掉时效 / 签名参数后剩下的地址。
 *
 * 两处用它：playlistConfig.buildChannelId 算频道主键（隐藏、改名、归类、排序按它存），
 * customSourceProxy 算自定义源经代理转发时的频道引用（播放器收藏的本机地址按它定）。
 * 两处口径必须一致，所以放在这里，不各写一份。
 */

// 播放地址里的「时效 / 签名」参数（issue #123）。
// buildChannelId 把地址算进频道主键，而 hiddenChannels / channelRenameMap /
// channelGroupMap / channelOrder 四张表都按 `原始分组::频道ID` 存——地址每换一次签名，
// 主键就变一次，这四项个性化设置会静默全部失效（隐藏的频道自己冒回分组、改过的名字复原），
// 且界面上没有任何线索：「已隐藏」列表是按当前全集反查渲染的，失配那条直接不显示。
// 实测：内置源纬来体育写盘地址带 ?expire=&sign=，每个抓取周期必变。
//
// 只列「确定与频道身份无关」的时效类参数。qn / quality / q 这些可能区分清晰度或线路的
// 一律保留——剥错会让两条频道算出同一个 ID，在 applyConfig 的 channelMap 里互相覆盖，
// 表现为播放列表静默少一个频道，比原 bug 更严重。
const VOLATILE_URL_PARAMS = /^(expire|expires|exp|sign|signature|sigparams|token|auth|auth_key|authkey|wssecret|txsecret|timestamp|nonce|_t)$/i

/**
 * 剥掉地址里的时效 / 签名参数，其余原样保留（含 #fragment）。
 * 只用于计算频道主键——播放用的地址必须是原样的，绝不能拿这个结果去请求。
 */
export function stripVolatileParams(url) {
  const queryAt = url.indexOf('?')
  if (queryAt === -1) return url

  const hashAt = url.indexOf('#', queryAt)
  const head = url.slice(0, queryAt)
  const query = hashAt === -1 ? url.slice(queryAt + 1) : url.slice(queryAt + 1, hashAt)
  const tail = hashAt === -1 ? '' : url.slice(hashAt)

  // 格尔木、海东的官方直链使用 sign + t。t 是这两条入口的签名时效，
  // 换签后频道身份不变；其它来源的 t 可能是台号，不能一起剥掉。
  const signedTime = (head === 'https://miku-live-hls-gemwkl-tv.geermurmt.cn/gemwkl-tv/xwzh.m3u8'
    || head === 'https://hls-hdapp.hdhhy.cn/ashh-tv/zhds.m3u8')
    && /(?:^|&)sign=[a-f0-9]{32}(?:&|$)/i.test(query)
    && /(?:^|&)t=\d{10}(?:&|$)/.test(query)

  const kept = query.split('&').filter(pair => {
    if (!pair) return false
    const eq = pair.indexOf('=')
    const key = eq === -1 ? pair : pair.slice(0, eq)
    return !VOLATILE_URL_PARAMS.test(key) && !(signedTime && key === 't')
  })

  return kept.length ? `${head}?${kept.join('&')}${tail}` : `${head}${tail}`
}
