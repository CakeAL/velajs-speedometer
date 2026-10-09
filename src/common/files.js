export const TRACK_DIR = 'internal://files/speedometer/'

export function fileCall(api, method, options) {
  return new Promise((resolve, reject) => {
    try {
      api[method]({ ...options, success: resolve,
        fail(data, code) { reject(new Error('文件操作失败 (' + code + ')')) } })
    } catch (error) { reject(error) }
  })
}

export async function ensureDirectory(api) {
  try { await fileCall(api, 'access', { uri: TRACK_DIR }) }
  catch (error) { await fileCall(api, 'mkdir', { uri: TRACK_DIR, recursive: true }) }
}

// file.list may return a filename instead of a complete internal:// URI.
// Resolve only direct children of our track directory before any file operation.
export function resolveTrackUri(uri) {
  if (typeof uri !== 'string') return null
  let name = uri
  if (name.indexOf(TRACK_DIR) === 0) name = name.slice(TRACK_DIR.length).replace(/^\/+/, '')
  else if (name.indexOf('speedometer/') === 0) name = name.slice('speedometer/'.length)
  else if (name.indexOf('./') === 0) name = name.slice(2)
  if (!/^track-[A-Za-z0-9._+-]+\.(gpx|part)$/.test(name) || name.indexOf('..') >= 0) return null
  return TRACK_DIR + name
}

export async function listTrackFiles(api) {
  await ensureDirectory(api)
  // The device joins directory + '/' + filename; a trailing slash produces '//'.
  const result = await fileCall(api, 'list', { uri: TRACK_DIR.slice(0, -1) })
  return (result.fileList || []).map(item => ({ ...item, uri: resolveTrackUri(item.uri) }))
    .filter(item => item.uri)
}

function pad(value) { return value < 10 ? '0' + value : String(value) }

export function trackName(now) {
  const date = new Date(now)
  const offset = -date.getTimezoneOffset()
  const minutes = Math.abs(offset)
  return 'track-' + date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    'T' + pad(date.getHours()) + '-' + pad(date.getMinutes()) + '-' + pad(date.getSeconds()) +
    '-' + date.getMilliseconds() + (offset < 0 ? '-' : '+') + pad(Math.floor(minutes / 60)) + pad(minutes % 60)
}

export function trackLabel(name) {
  const match = /^track-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{1,3})(?:([+-])(\d{2})(\d{2}))?\.gpx$/.exec(name)
  if (!match) return name.replace(/^track-/, '').replace(/\.gpx$/, '').replace('T', ' ')
  // Legacy filenames without an offset were UTC; new filenames include their local offset.
  const offset = match[8] ? (match[8] === '-' ? -1 : 1) * (+match[9] * 60 + +match[10]) : 0
  const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6], +match[7]) - offset * 60000)
  // Local getters follow the watch's current timezone, even after a timezone change.
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
}

export async function listTracks(api) {
  const entries = await listTrackFiles(api)
  return entries.filter(item => /\.gpx$/.test(item.uri))
    .sort((a, b) => b.lastModifiedTime - a.lastModifiedTime || (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0))
    .map(item => ({ ...item, name: item.uri.split('/').pop(),
      size: (item.length / 1024).toFixed(1) + ' KB',
      label: trackLabel(item.uri.split('/').pop()) }))
}

export function assertTrackUri(uri) {
  if (!uri || resolveTrackUri(uri) !== uri || !/\.gpx$/.test(uri)) {
    throw new Error('无效的轨迹文件')
  }
}
