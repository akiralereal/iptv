// 节目单（playback.xml）按 gzip 输出。
//
// 带上往前 6 天的回看节目单后，这份 XML 从 3 MB 左右涨到 5 MB 以上，播放器每次刷新节目单都整份
// 下载；XML 重复度高，gzip 后只剩一成不到。播放器声明了 Accept-Encoding: gzip 才压，没声明的照旧
// 拿原文。压缩结果按文件的「修改时间 + 大小」记着，节目单一轮更新才变一次，不必每个请求都压。

import { readFileSync, statSync } from 'node:fs'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'

const gzipAsync = promisify(gzip)

/** 请求头是否接受 gzip（`gzip;q=0` 是明确不要）。 */
export function acceptsGzip(headers) {
  const value = String(headers?.['accept-encoding'] || '').toLowerCase()
  return value.split(',').some(part => {
    const [coding, ...params] = part.trim().split(';').map(piece => piece.trim())
    if (coding !== 'gzip' && coding !== 'x-gzip' && coding !== '*') return false
    const q = params.find(piece => piece.startsWith('q='))
    return !q || Number(q.slice(2)) > 0
  })
}

/**
 * 返回「取某个文件的 gzip 版本」的函数；同一份文件只压一次。
 * 文件不存在或读不了时抛出，由调用方退回不压缩的老路。
 */
export function createGzipFileCache({ stat = statSync, read = readFileSync, compress = gzipAsync } = {}) {
  let cached = { key: '', promise: null }
  return function gzipFile(file) {
    // 先看签名再读内容：更新落盘是改名替换，万一正好卡在两步之间，记下的是「旧签名 + 新内容」，
    // 下一个请求签名对不上会重压；反过来（旧内容记在新签名下）就要错到下一轮更新。
    const info = stat(file)
    const key = `${file}|${info.mtimeMs}|${info.size}`
    if (cached.key !== key) {
      const promise = Promise.resolve().then(() => compress(read(file)))
      cached = { key, promise }
      // 压失败不留着：下个请求重来
      promise.catch(() => { if (cached.promise === promise) cached = { key: '', promise: null } })
    }
    return cached.promise
  }
}
