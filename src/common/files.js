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

export async function listTracks(api) {
  await ensureDirectory(api)
  const result = await fileCall(api, 'list', { uri: TRACK_DIR })
  return (result.fileList || []).filter(item => /\.gpx$/.test(item.uri))
    .sort((a, b) => b.lastModifiedTime - a.lastModifiedTime)
    .map(item => ({ ...item, name: item.uri.split('/').pop(),
      size: (item.length / 1024).toFixed(1) + ' KB',
      label: item.uri.split('/').pop().replace(/^track-/, '').replace(/\.gpx$/, '').replace('T', ' ') }))
}

export function assertTrackUri(uri) {
  if (typeof uri !== 'string' || uri.indexOf(TRACK_DIR + 'track-') !== 0 ||
      !/\.gpx$/.test(uri) || uri.indexOf('..') >= 0 || uri.slice(TRACK_DIR.length).indexOf('/') >= 0) {
    throw new Error('无效的轨迹文件')
  }
}
