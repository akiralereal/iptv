import { createDecipheriv } from 'node:crypto'

/**
 * 青岛广电官网直播分片的 ARCVIDEO 封装解密。
 *
 * video10.qtv.com.cn/drm/<频道>/ 下的 .ts 不是标准 HLS 加密（清单里没有 EXT-X-KEY），
 * 而是整片套了一层自定义封装，官网播放器（DHYPlayer）在浏览器里解开后再喂给解码器：
 *
 *   0..17   'ARCVIDEO-PROTECTED'
 *   18      版本字符 '0'
 *   19      TS 包长（188）
 *   20..23  明文长度 s（大端），等于整数个 TS 包
 *   28..    密文（AES-128-CBC、零 IV、无填充，长度是 s 向上取整到 16）
 *
 * 分片自己的 16 字节 AES 密钥藏在密文中间：位置 o = (第 32 字节 + 1) × 188，密文在 o 处断开、
 * 插入 16 字节密钥（用固定串 MASTER_KEY 以同样的 CBC 零 IV 加密过），后半段密文接在后面。
 * 第 32 字节本身是密文的第 5 个字节，所以每片的密钥位置都不同。固定串就是官网
 * player.min.js 里 `ott` + `words` 两段十六进制拼出来的 ottKey，属于公开网页播放器的参数。
 *
 * 解出的明文只取前 s 字节（整数个 TS 包），丢掉对齐到 16 的尾巴；不是这种封装的数据原样返回。
 */
export const ARCVIDEO_MAGIC = 'ARCVIDEO-PROTECTED'
export const MASTER_KEY = Buffer.from('qdxmtottarcvidet', 'latin1')

const HEADER_BYTES = 28
const KEY_BYTES = 16
const ZERO_IV = Buffer.alloc(16)
const MAGIC_BYTES = Buffer.from(ARCVIDEO_MAGIC, 'latin1')

export function isArcvideoProtected(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length > HEADER_BYTES + KEY_BYTES
    && buffer.subarray(0, MAGIC_BYTES.length).equals(MAGIC_BYTES)
}

function aesCbcDecrypt(key, data) {
  const decipher = createDecipheriv('aes-128-cbc', key, ZERO_IV)
  decipher.setAutoPadding(false)
  return Buffer.concat([decipher.update(data), decipher.final()])
}

/** 分片里的密钥位置与明文长度。导出给测试构造样本用。 */
export function arcvideoLayout(buffer) {
  const packetSize = buffer[19]
  const plainLength = buffer.readUInt32BE(20)
  const keyOffset = (buffer[32] + 1) * packetSize
  return { packetSize, plainLength, keyOffset, cipherLength: Math.ceil(plainLength / 16) * 16 }
}

/**
 * 解一片。返回新的 Buffer（明文 TS）；不是 ARCVIDEO 封装、或封装内容不完整解不出时返回原样，
 * 让播放器自己报错，而不是让代理请求失败。
 */
export function decryptArcvideo(buffer) {
  if (!isArcvideoProtected(buffer)) return buffer
  try {
    const { packetSize, plainLength, keyOffset, cipherLength } = arcvideoLayout(buffer)
    if (!packetSize || !plainLength || plainLength % packetSize !== 0) return buffer
    const keyAt = Math.min(keyOffset, plainLength) + HEADER_BYTES
    if (buffer.length < keyAt + KEY_BYTES) return buffer
    const segmentKey = aesCbcDecrypt(MASTER_KEY, buffer.subarray(keyAt, keyAt + KEY_BYTES))

    let cipher
    if (keyOffset < cipherLength) {
      // 密钥插在密文中间：前半段 + 跳过密钥后的后半段
      const tail = HEADER_BYTES + keyOffset + KEY_BYTES
      if (buffer.length < tail + (cipherLength - keyOffset)) return buffer
      cipher = Buffer.concat([
        buffer.subarray(HEADER_BYTES, HEADER_BYTES + keyOffset),
        buffer.subarray(tail, tail + (cipherLength - keyOffset)),
      ])
    } else {
      // 官网播放器的另一条分支：密钥落在密文之后，密文连续。实测分片都走上一条，这里照官网逻辑保留
      cipher = buffer.subarray(HEADER_BYTES, plainLength)
      if (cipher.length % 16 !== 0) return buffer
    }
    const plain = aesCbcDecrypt(segmentKey, cipher)
    return plain.subarray(0, Math.min(plainLength, plain.length))
  } catch {
    return buffer
  }
}
