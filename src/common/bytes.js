const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function toBytes(buffer) {
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer)
  if (buffer instanceof Uint8Array) return buffer
  throw new Error('无效的文件数据')
}

// App-generated GPX is ASCII, so chunk boundaries cannot split a character.
export function asciiText(buffer) {
  const bytes = toBytes(buffer)
  let text = ''
  for (let i = 0; i < bytes.length; i += 1) text += String.fromCharCode(bytes[i])
  return text
}

export function base64(bytes) {
  let result = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const value = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0)
    result += ALPHABET[(value >>> 18) & 63] + ALPHABET[(value >>> 12) & 63] +
      (i + 1 < bytes.length ? ALPHABET[(value >>> 6) & 63] : '=') +
      (i + 2 < bytes.length ? ALPHABET[value & 63] : '=')
  }
  return result
}

export function crc32(bytes) {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i]
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  const hex = ((crc ^ 0xffffffff) >>> 0).toString(16)
  return ('00000000' + hex).slice(-8)
}
