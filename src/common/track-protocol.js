import { listTracks, TRACK_DIR, assertTrackUri, fileCall } from './files'
import { toBytes, base64, crc32 } from './bytes'

export const PROTOCOL = 'speedometer.gpx'
export const VERSION = 1
export const CHUNK_BYTES = 768
export const PAGE_SIZE = 4

function problem(code, message) {
  const error = new Error(message); error.code = code; return error
}
function integer(value, fallback, maximum) {
  const result = value === undefined ? fallback : value
  if (typeof result !== 'number' || !isFinite(result) || Math.floor(result) !== result || result < 0 || result > maximum) {
    throw problem('BAD_REQUEST', '参数必须是有效的非负整数')
  }
  return result
}
function etag(entry) { return String(entry.length) + ':' + String(entry.lastModifiedTime) }
function metadata(entry) {
  return { name: entry.name, bytes: entry.length, modifiedAt: entry.lastModifiedTime,
    displayTime: entry.label, etag: etag(entry) }
}

// Pull one bounded chunk per request. Repeating an offset is safe after a lost reply.
export function createTrackProtocol(file, activeUri, onDelete = () => {}) {
  async function execute(request) {
    if (request.op === 'hello') return { package: 'com.cakeal.speedometer',
      operations: ['hello', 'list', 'read', 'delete'], chunkBytes: CHUNK_BYTES, pageSize: PAGE_SIZE }
    if (request.op !== 'list' && request.op !== 'read' && request.op !== 'delete') {
      throw problem('UNKNOWN_OPERATION', '不支持的操作')
    }
    let uri
    if (request.op !== 'list') {
      if (typeof request.name !== 'string' || request.name.length > 160 || /[/\\]/.test(request.name)) {
        throw problem('BAD_REQUEST', '只允许轨迹文件名')
      }
      uri = TRACK_DIR + request.name
      try { assertTrackUri(uri) } catch (error) { throw problem('BAD_REQUEST', '无效的 GPX 文件名') }
      const active = activeUri()
      if (active && (uri === active || uri === active.replace(/\.part$/, '.gpx'))) {
        throw problem('RECORDING_ACTIVE', '轨迹仍在记录或保存中')
      }
    }
    const entries = (await listTracks(file)).filter(entry => {
      const active = activeUri()
      return !active || (entry.uri !== active && entry.uri !== active.replace(/\.part$/, '.gpx'))
    })
    if (request.op === 'list') {
      const offset = integer(request.offset, 0, 9007199254740991)
      const limit = integer(request.limit, PAGE_SIZE, PAGE_SIZE)
      if (!limit || offset > entries.length) throw problem('BAD_REQUEST', '无效的分页范围')
      const files = entries.slice(offset, offset + limit).map(metadata)
      const next = offset + files.length
      return { files, total: entries.length, nextOffset: next < entries.length ? next : null }
    }
    const entry = entries.filter(item => item.uri === uri)[0]
    // Deleting an already absent GPX is a successful no-op, including reconnect retries.
    if (!entry && request.op === 'delete') return { name: request.name, deleted: false }
    if (!entry) throw problem('NOT_FOUND', '轨迹文件不存在')
    if (typeof request.etag !== 'string' || request.etag !== etag(entry)) {
      throw problem('FILE_CHANGED', '文件已变化，请刷新列表')
    }
    if (request.op === 'delete') {
      await fileCall(file, 'delete', { uri })
      onDelete(entry.name)
      return { name: entry.name, deleted: true }
    }
    const offset = integer(request.offset, 0, entry.length)
    const length = integer(request.length, CHUNK_BYTES, CHUNK_BYTES)
    if (!length) throw problem('BAD_REQUEST', '分块长度不能为零')
    const expected = Math.min(length, entry.length - offset)
    const data = expected ? await fileCall(file, 'readArrayBuffer', { uri, position: offset, length: expected }) : null
    const bytes = expected ? toBytes(data.buffer) : new Uint8Array(0)
    if (bytes.length !== expected) throw problem('FILE_CHANGED', '文件长度已变化，请重新下载')
    return { name: entry.name, etag: etag(entry), offset, nextOffset: offset + bytes.length,
      total: entry.length, bytes: bytes.length, eof: offset + bytes.length === entry.length,
      encoding: 'base64', data: base64(bytes), crc32: crc32(bytes) }
  }
  return async request => {
    const response = { protocol: PROTOCOL, version: VERSION, id: request.id, op: request.op }
    try {
      if (request.version !== VERSION) throw problem('UNSUPPORTED_VERSION', '协议版本不兼容')
      return { ...response, ok: true, result: await execute(request) }
    } catch (error) {
      return { ...response, ok: false, error: { code: error.code || 'FILE_ERROR', message: error.message } }
    }
  }
}
