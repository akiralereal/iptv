import { once } from 'node:events'

// Forward HTTP-FLV with backpressure, no transcoding and no concatenation on reconnect.
// Only the resolver uses account credentials; this media transport never receives them.
export async function pipeFlv(url, req, res, validateUrl, { fetchImpl = fetch } = {}) {
  const ctrl = new AbortController()
  const onClose = () => ctrl.abort()
  res.once('close', onClose)
  let reader, timer, bytes = 0
  const deadline = () => {
    clearTimeout(timer)
    timer = setTimeout(() => ctrl.abort(new Error('直播连接超时')), 20000)
  }
  try {
    if (res.destroyed || req.aborted) ctrl.abort()
    if (typeof validateUrl !== 'function') throw new Error('直播模块缺少媒体地址校验')
    let current = validateUrl(url), response
    for (let hop = 0; hop < 6; hop++) {
      ctrl.signal.throwIfAborted(); deadline()
      response = await fetchImpl(current, { redirect: 'manual', signal: ctrl.signal, headers: { 'Accept-Encoding': 'identity' } })
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location || hop === 5) throw new Error('官方直播调度跳转失败')
      current = validateUrl(new URL(location, current).href)
    }
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`直播媒体 HTTP ${response.status}`) }
    reader = response.body.getReader()
    const read = async () => { deadline(); return reader.read() }
    let first = Buffer.alloc(0)
    while (first.length < 3) {
      const chunk = await read()
      if (chunk.done) throw new Error('上游未返回直播视频')
      first = Buffer.concat([first, chunk.value])
    }
    if (first.subarray(0, 3).toString() !== 'FLV') throw new Error('上游响应不是 FLV 直播')
    res.writeHead(200, { 'Content-Type': 'video/x-flv', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' })
    const write = async chunk => { bytes += chunk.length; if (!res.write(chunk)) await once(res, 'drain', { signal: ctrl.signal }) }
    await write(first)
    while (!ctrl.signal.aborted) {
      const chunk = await read(); if (chunk.done) break
      await write(chunk.value)
    }
    if (!res.destroyed) res.end()
    return { ok: true, bytes }
  } catch (error) {
    const disconnected = res.destroyed || req.aborted
    if (!disconnected && !res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain;charset=UTF-8' }); res.end('直播取流失败，请重新连接或检查模块配置') }
    else if (!res.destroyed) res.destroy()
    return { ok: false, bytes, disconnected, error: /^直播媒体 HTTP \d{3}$/.test(error.message) ? error.message : '直播连接结束或上游异常' }
  } finally {
    clearTimeout(timer); ctrl.abort(); await reader?.cancel().catch(() => {}); res.off('close', onClose)
  }
}
