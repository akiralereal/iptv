export function attrs(line) {
  return Object.fromEntries([...line.slice(line.indexOf(':') + 1).matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)]
    .map(m => [m[1], m[2].replace(/^"|"$/g, '')]))
}
export function checkHls(text, { live = false } = {}) {
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('官方未返回 HLS 清单')
  for (const line of text.split(/\r?\n/)) {
    if (!/^#EXT-X-(SESSION-)?KEY:/.test(line)) continue
    const key = attrs(line)
    if (!['NONE', 'AES-128'].includes(key.METHOD) || (key.KEYFORMAT || 'identity') !== 'identity') throw new Error('DRM 频道请使用官方播放器')
  }
  if (live && /^#EXT-X-ENDLIST/m.test(text)) throw new Error('已结束的点播清单不作为直播')
  return text
}
export function variantsIn(text) {
  const result = []; let pending
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      if (pending) throw new Error('HLS 缺少档位地址')
      pending = line
    } else if (line && !line.startsWith('#') && pending) {
      result.push({ line: pending, attributes: attrs(pending), uri: line }); pending = null
    }
  }
  if (pending) throw new Error('HLS 缺少档位地址')
  return result
}
export function rank(a) {
  const dim = /^(\d+)x(\d+)$/.exec(a.RESOLUTION || '')
  return [dim ? Number(dim[1]) * Number(dim[2]) : 0, Number(a['FRAME-RATE'] || 0),
    Number(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH || 0), Number(a.BANDWIDTH || 0)]
}
const compare = (a, b) => { const x = rank(a.attributes), y = rank(b.attributes); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i]; return 0 }
export function mediaInfo(text, base) {
  checkHls(text, { live: true })
  const segments = text.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#')).map(s => new URL(s, base).href)
  if (!text.includes('#EXTINF:') || !segments.length) throw new Error('直播清单没有媒体分片')
  return { segments, sequence: Number(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m.exec(text)?.[1] || 0),
    duration: Number(/^#EXT-X-TARGETDURATION:([\d.]+)/m.exec(text)?.[1] || 6) }
}
export function highestPlaylist(text, base, validate = url => url) {
  checkHls(text)
  const variants = variantsIn(text).sort(compare), chosen = variants[0]
  const definitions = new Map(), query = new URL(base).searchParams
  for (const line of text.split(/\r?\n/)) if (line.startsWith('#EXT-X-DEFINE:')) {
    const a = attrs(line)
    if (a.QUERYPARAM && query.has(a.QUERYPARAM)) definitions.set(a.QUERYPARAM, query.get(a.QUERYPARAM))
    else if (a.NAME && a.VALUE !== undefined) definitions.set(a.NAME, a.VALUE)
    else throw new Error('HLS 变量定义不完整')
  }
  function expand(value) {
    for (let i = 0; i < 10; i++) {
      if (!/\{\$[^}]+\}/.test(value)) return value
      value = value.replace(/\{\$([^}]+)\}/g, (_, name) => { if (!definitions.has(name)) throw new Error('HLS 变量未定义'); return definitions.get(name) })
    }
    throw new Error('HLS 变量循环引用')
  }
  function absolute(value) {
    const url = new URL(expand(value), base)
    if (!['https:', 'http:'].includes(url.protocol) || /[\r\n"]/.test(url.href)) throw new Error('无效的 HLS 地址')
    return validate(url.href)
  }
  function rewrite(line) {
    if (line.startsWith('#EXT-X-DEFINE:')) {
      const a = attrs(line), name = a.NAME || a.QUERYPARAM, value = expand(definitions.get(name))
      if (/[\r\n"]/.test(name + value)) throw new Error('无效的 HLS 变量')
      return `#EXT-X-DEFINE:NAME="${name}",VALUE="${value}"`
    }
    return line.replace(/(?<![A-Z0-9-])URI="([^"]*)"/g, (_, value) => `URI="${absolute(value)}"`)
  }
  if (!chosen) {
    mediaInfo(text, base)
    return { text: text.split(/\r?\n/).map(line => line.startsWith('#') ? rewrite(line) : line.trim() ? absolute(line.trim()) : '').join('\n'), selected: null }
  }
  const output = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('#') || /^#EXT-X-(STREAM-INF|I-FRAME-STREAM-INF|IMAGE-STREAM-INF|CONTENT-STEERING):/.test(line)) continue
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = attrs(line)
      if (chosen.attributes[a.TYPE] !== a['GROUP-ID']) continue
    }
    output.push(rewrite(line))
  }
  output.push(chosen.line, absolute(chosen.uri), '')
  return { text: output.join('\n'), selected: chosen.attributes }
}
