import crypto from 'crypto'

const KEY_AES = "MQDUjI19MGe3BhaqTlpc9g==";
const IV = "abcdefghijklmnop";

const RSA_PRIVATE_KEY_PKCS8 = "MIICdQIBADANBgkqhkiG9w0BAQEFAASCAl8wggJbAgEAAoGBAOhvWsrglBpQGpjB\r8okxLUCaaiKKOytn9EtvytB5tKDchmgkSaXpreWcDy/9imsuOiVCSdBr6hHjrTN7\rQKkA4/QYS8ptiFv1ap61PiAyRFDI1b8wp2haJ6HF1rDShG2XdfWIhLk4Hj6efVZA\rSfa3taM7C8NseWoWh05Cp26g4hXZAgMBAAECgYBzqZXghsisH1hc04ZBRrth/nT6\rIxc2jlA+ia6+9xEvSw2HHSeY7COgsnvMQbpzg1lj2QyqLkkYBdfWWmrerpa/mb7j\rm6w95YKs5Ndii8NhFWvC0eGK8Ygt02DeLohmkQu3B+Yq8JszjB7tQJRR2kdG6cPt\rKp99ZTyyPom/9uD+AQJBAPxCwajHAkCuH4+aKdZhH6n7oDAxZoMH/mihDRxHZJof\rnT+K662QCCIx0kVCl64s/wZ4YMYbP8/PWDvLMNNWC7ECQQDr4V23KRT9fAPAN8vB\rq2NqjLAmEx+tVnd4maJ16Xjy5Q4PSRiAXYLSr9uGtneSPP2fd/tja0IyawlP5UPL\rl76pAkAeXqMWAK+CvfPKxBKZXqQDQOnuI2RmDgZQ7mK3rtirvXae+ciZ4qc4Bqt7\r7yJ3s68YRlHQR+OMzzeeKz47kzZhAkAPteH1ChJw06q4Sb8TdiPX++jbkFiCxgiN\rCsaMTfGVU/Y8xGSSYCgPelEHxu1t2wwVa/tdYs505zYmkSGT1NaJAkBCS5hymXsA\rB92Fx8eGW5WpLfnpvxl8nOcP+eNXobi8Sc6q1FmoHi8snbcmBhidcDdcieKn+DbX\rGG3BQE/OCOkM\r";

/**
 * MD5 加密
 * @param {string} str - 
 * @returns {string} - 
 */
function getStringMD5(str) {
  // 创建 MD5 哈希对象
  const md5 = crypto.createHash("md5");
  // 更新数据（默认 UTF-8 编码）
  md5.update(str);
  // 生成十六进制哈希值并转为小写
  return md5.digest("hex").toLowerCase();
}

/**
 * base64 加密
 * @param {string} str - 
 * @returns {string} - 
 */
function Base64encrypt(str) {
  const buff = Buffer.from(str, 'utf-8');
  return buff.toString('base64')
}

/**
 * base64 解密
 * @param {string} str - 
 * @returns {string} - 
 */
function Base64decrypt(str) {
  const buff = Buffer.from(str, 'base64');
  return buff.toString('utf-8')
}

/**
 * AES 加密
 * @param {string} data - 
 * @param {string} baseKey - 
 * @param {string} ivStr - 
 * @returns {string} - 
 */
function AESencrypt(data, baseKey = KEY_AES, ivStr = IV) {
  let key = Buffer.from(baseKey, "utf8")
  let iv = Buffer.from(ivStr, "utf8")

  // 填充长度
  if (key.length < 32) {
    const paddedKey = Buffer.alloc(32);
    key.copy(paddedKey);
    key = paddedKey;
  }
  if (iv.length < 16) {
    const paddedIV = Buffer.alloc(16);
    iv.copy(paddedIV);
    iv = paddedIV;
  } const cipher = crypto.createCipheriv("aes-256-cbc", key, iv)
  const dest = cipher.update(data, "utf8", "base64") + cipher.final("base64")
  return dest.toString()
}

/**
 * AES 解密
 * @param {string} baseData - 
 * @param {string} baseKey - 
 * @param {string} ivStr - 
 * @returns {string} - 
 */
function AESdecrypt(baseData, baseKey = KEY_AES, ivStr = IV) {
  let key = Buffer.from(baseKey, "utf8")
  let iv = Buffer.from(ivStr, "utf8")

  // 填充长度
  if (key.length < 32) {
    const paddedKey = Buffer.alloc(32);
    key.copy(paddedKey);
    key = paddedKey;
  } if (iv.length < 16) {
    const paddedIV = Buffer.alloc(16);
    iv.copy(paddedIV);
    iv = paddedIV;
  }
  const data = Buffer.from(baseData, "utf8")
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv)
  const dest = Buffer.concat([decipher.update(data), decipher.final()])
  return dest.toString()
}


/**
 * RSA 私钥签名加密
 * @param {string} data - 
 * @param {string} publicKeyBase - 
 * @returns {string} - 
 */
function RSAencrypt(data, publicKeyBase = RSA_PRIVATE_KEY_PKCS8) {
  const clearKey = publicKeyBase.replace(/\r/g, "")
  const keyBytes = Buffer.from(clearKey, "base64")
  const privateKey = crypto.createPrivateKey({
    key: keyBytes,
    format: "der",
    type: "pkcs8"
  })
  const dest = crypto.privateEncrypt({
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PADDING,
  }, data)
  return dest.toString("base64")
}

export { getStringMD5, AESdecrypt, AESencrypt, Base64decrypt, Base64encrypt, RSAencrypt }
