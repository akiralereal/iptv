import { fetchUpstreamResponse } from '../../utils/hlsProxy.js'
import { printYellow } from '../../utils/colorOut.js'

// VLC 会边收 TS 边解码；仅断开超时连接仍会把半片交给它，恢复画面后可能丢音频。
// TS 必须完整取回后才交给通用代理。失败只重取同一片一次，绝不拼接两次下载的残片。
// 总预算小于通用代理等待响应头的 15 秒；正常片仍只请求一次。
export const MEDIA_TIMEOUT_MS = 12_000
export const MEDIA_ATTEMPT_TIMEOUT_MS = 6_000
export const MAX_SEGMENT_BYTES = 32 * 1024 * 1024

export function createMediaFetcher({
  timeoutMs = MEDIA_TIMEOUT_MS,
  attemptTimeoutMs = Math.min(MEDIA_ATTEMPT_TIMEOUT_MS, Math.floor(timeoutMs / 2)),
  maxSegmentBytes = MAX_SEGMENT_BYTES,
  fetchImpl = fetchUpstreamResponse,
} = {}) {
  return async (url, options = {}) => {
    const deadline = AbortSignal.timeout(timeoutMs)
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
    if (options.method === 'HEAD' || !new URL(url).pathname.endsWith('.ts')) {
      return fetchImpl(url, { ...options, signal })
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted()
      const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(attemptTimeoutMs)])
      let response
      try {
        response = await fetchImpl(url, { ...options, signal: attemptSignal })
        if (!response.ok) {
          if (attempt === 0 && response.status >= 500) throw new Error(`深圳分片 HTTP ${response.status}`)
          return response
        }
        const chunks = []
        let bytes = 0
        for await (const chunk of response.body) {
          bytes += chunk.length
          if (bytes > maxSegmentBytes) {
            const error = new Error('深圳分片超过完整缓存大小上限')
            error.code = 'SEGMENT_TOO_LARGE'
            throw error
          }
          chunks.push(chunk)
        }
        if (!bytes) throw new Error('深圳分片正文为空')
        const headers = new Headers(response.headers)
        // fetch 已经完成解压；下发的是完整正文的真实长度。
        headers.delete('content-encoding')
        headers.delete('transfer-encoding')
        headers.set('content-length', String(bytes))
        const complete = new Response(Buffer.concat(chunks, bytes), {
          status: response.status, statusText: response.statusText, headers,
        })
        Object.defineProperty(complete, 'url', { value: response.url || String(url) })
        return complete
      } catch (error) {
        await response?.body?.cancel().catch(() => {})
        if (signal.aborted || attempt === 1 || error.code === 'SEGMENT_TOO_LARGE') throw error
        printYellow(`深圳分片未完整下载，重试一次：${new URL(url).pathname}（${error.message}）`)
      }
    }
  }
}

export const fetchMedia = createMediaFetcher()
