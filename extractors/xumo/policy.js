// 官方目录、持久快照、播放入口均执行同一宗教排除策略。
export const DENIED_IDS = new Set([99951481, 99951543, 99951189, 99951344, 99951434, 99951592,
  99951407, 99951401, 99991708, 99951141, 99951524])
export const FAMILY_NAMES = { 99951528: 'SparkTV: Light & Love', 99991333: 'Dove Channel', 99991353: 'Xumo Free Family Movies' }
const religious = /\b(christian|christianity|church|churches|bible|biblical|jesus|gospel|ministry|ministries|pastor|pastors|sermon|sermons|worship|catholic|evangelical|religious|religion|faith|faithope|daystar|gaither|jewish|judaism|torah|rabbi|islam|islamic|muslim|quran|hindu|hinduism|buddhist|buddhism|cristiano|cristiana|cristianos|iglesia|evangelio|dios)\b|joel\s+osteen|pure\s*flix|trinity\s+broadcast|in\s+touch\s*\+?\s*network|highway\s+to\s+heaven|宗教|基督|佛教|伊斯兰|传教|福音/i
export function exclusionReason(channel) {
  if (DENIED_IDS.has(Number(channel.id))) return '已确认的宗教或宗教主题频道'
  if (religious.test(`${channel.name || ''} ${channel.description || ''}`)) return '宗教频道名称或介绍'
  if ((Number(channel.genreId) === 768 || /faith|religio/i.test(String(channel.genre))) && FAMILY_NAMES[channel.id] !== channel.name?.trim()) return '未经核对的 Faith & Family 频道'
  return ''
}
export const eligible = channels => Object.fromEntries(Object.entries(channels).filter(([, c]) => !exclusionReason(c)))
