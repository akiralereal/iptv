/**
 * 后台确认「填的是不是自己的」用：凭据只回结尾几位，拿去用不了。
 * 16 位及以上露 4 位，8～15 位露 2 位，更短的不露（短密码露几位就猜得出来）。
 * Cookie 结尾常带分号和空白，先去掉再取，免得露出来的全是标点。
 */
export function secretHint(value) {
  const text = value == null ? '' : String(value).trim().replace(/[;\s]+$/, '')
  const shown = text.length >= 16 ? 4 : text.length >= 8 ? 2 : 0
  return shown ? text.slice(-shown) : ''
}
