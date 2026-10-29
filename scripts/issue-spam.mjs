/**
 * 广告 issue 判定，供 .github/workflows/issue_spam.yaml 调用
 *
 * 仓库名带 IPTV，常被 IPTV 转售商拿来发英文软文刷 SEO（#188、#208、#209）：标题「Best IPTV …」、
 * 正文推广站点、末尾堆几百个逗号分隔的关键词。正常 issue 都是中文，所以「全文没有中文」也算一项，
 * 但只靠它不够：几项累计到 SPAM_THRESHOLD 才判定，海外用户的英文 issue 不会只因为是英文被关。
 *
 * 新冒出来的推广站点加进 BLOCKED_SITES 即可，命中一个就直接判定。
 */

export const SPAM_THRESHOLD = 3

const BLOCKED_SITES = [/liveiptvservice/i]

const SPAM_TITLE = /\bbest\s+iptv\b/i

// 卖号话术：Xtream Codes 登录、WhatsApp 客服、「15,000+ channels」、免费试用、包年套餐……
const PROMO_PHRASES = [
  /\bxtream[\s-]*codes?\b/i,
  /\bwhats\s?app\b/i,
  /\bfree\s+trial\b/i,
  /\b\d{1,3}(?:,\d{3})+\+?\s*(?:live\s+)?(?:tv\s+)?channels\b/i,
  /\baffordable\b/i,
  /\bhighly\s+recommend/i,
  /\bbuffer(?:ing)?[\s-]*free\b|\bno\s+buffering\b/i,
  /\b(?:yearly|annual|monthly)\s+(?:plan|package|subscription)\b/i,
]

const CJK = /[㐀-鿿]/

// 关键词堆砌：同一行里有一长串逗号分隔的英文短语，且多数是多词短语。
// 只看多词短语，是为了不把「CCTV1,CCTV2,…」这类频道清单当成堆砌。
const STUFFING_MIN_PHRASES = 30
function hasKeywordStuffing(body) {
  return body.split('\n').some((line) => {
    const parts = line.split(',').map(s => s.trim()).filter(Boolean)
    if (parts.length < STUFFING_MIN_PHRASES) return false
    const phrases = parts.filter(s => /^[A-Za-z][\w&'’.+-]*(?: [\w&'’.+-]+){1,5}$/.test(s))
    return phrases.length >= parts.length * 0.8
  })
}

/** 返回 { spam, score, reasons }，reasons 写进 Actions 日志，方便排查误判 */
export function detectSpam(title = '', body = '') {
  title = title || ''
  body = body || ''
  const text = `${title}\n${body}`
  const reasons = []
  let score = 0
  const hit = (points, reason) => { score += points; reasons.push(`+${points} ${reason}`) }

  const site = BLOCKED_SITES.find(re => re.test(text))
  if (site) hit(SPAM_THRESHOLD, `推广站点 ${site.source}`)
  if (SPAM_TITLE.test(title)) hit(2, '标题是「Best IPTV」软文')
  if (hasKeywordStuffing(body)) hit(2, '正文堆砌关键词')
  const promos = PROMO_PHRASES.filter(re => re.test(text)).length
  if (promos >= 4) hit(2, `卖号话术 ${promos} 处`)
  else if (promos >= 2) hit(1, `卖号话术 ${promos} 处`)
  if (!CJK.test(text)) hit(1, '全文没有中文')

  return { spam: score >= SPAM_THRESHOLD, score, reasons }
}
