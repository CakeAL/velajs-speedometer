import { assertTrackUri, readTrackChunk, READ_CHUNK_BYTES } from './files'
import { asciiText } from './bytes'

function localTime(iso) {
  const date = new Date(iso)
  const pad = value => ('0' + value).slice(-2)
  return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
}

function runtimeView(notes) {
  const lines = []
  if (notes.hide) lines.push('转入后台 ' + localTime(notes.hide.time))
  if (notes.tick) {
    const seconds = notes.hide ? Math.max(0, Math.floor((Date.parse(notes.tick.time) - Date.parse(notes.hide.time)) / 1000)) : null
    lines.push('最后后台运行' + (seconds === null ? ' ' + localTime(notes.tick.time) : ' +' + seconds + ' 秒') +
      ' · GPS ' + notes.tick.gps + ' 次 · ' + (notes.tick.phase === 'live' ? '已定位' : '等待定位'))
  }
  if (notes.gpsfail) lines.push('定位报错 ' + localTime(notes.gpsfail.time) +
    (notes.gpsfail.code === 'none' ? '' : ' (' + notes.gpsfail.code + ')'))
  if (notes.error) lines.push('收到应用错误回调 ' + localTime(notes.error.time))
  if (notes.end) lines.push(notes.end.kind === 'recovered' ? '中断后恢复 · 原因待查' :
    (notes.end.kind === 'dispose' ? '收到应用销毁回调' : '手动结束记录'))
  return lines.join('\n')
}

// GPX produced by this app is ASCII. Inspect a bounded window of the file so
// opening a long recording does not load the whole XML into the watch's RAM.
export async function summarizeTrack(api, uri) {
  assertTrackUri(uri)
  let position = 0
  let carry = ''
  let points = 0
  let firstTime = null
  let lastTime = null
  let minAltitude = null
  let maxAltitude = null
  let complete = false
  const notes = {}
  for (;;) {
    const bytes = await readTrackChunk(api, uri, position)
    if (!bytes.length) break
    const text = carry + asciiText(bytes)
    let consumed = 0
    const tags = /<trkpt\s|<time>([^<]+)<\/time>|<ele>([^<]+)<\/ele>|<\/gpx>|<!--speedometer:event=([a-z]+);time=([^;<>]+);gps=(\d+);phase=([a-z]+);code=(none|-?\d+)-->/g
    let match
    while ((match = tags.exec(text))) {
      consumed = tags.lastIndex
      if (match[0].indexOf('<trkpt') === 0) points += 1
      if (match[1]) { if (firstTime === null) firstTime = match[1]; lastTime = match[1] }
      if (match[2]) {
        const altitude = Number(match[2])
        if (isFinite(altitude)) {
          minAltitude = minAltitude === null ? altitude : Math.min(minAltitude, altitude)
          maxAltitude = maxAltitude === null ? altitude : Math.max(maxAltitude, altitude)
        }
      }
      if (match[0] === '</gpx>') complete = true
      if (match[3] && isFinite(Date.parse(match[4]))) {
        const kind = match[3]
        const note = { kind, time: match[4], gps: match[5], phase: match[6], code: match[7] }
        if (['hide', 'tick', 'gpsfail', 'error'].indexOf(kind) >= 0) notes[kind] = note
        if (kind === 'hide') notes.tick = null
        if (['stop', 'dispose', 'recovered'].indexOf(kind) >= 0) notes.end = note
      }
    }
    carry = text.slice(consumed).slice(-256)
    position += bytes.length
    if (bytes.length < READ_CHUNK_BYTES) break
  }
  const duration = firstTime && lastTime ? Math.max(0, Math.floor((Date.parse(lastTime) - Date.parse(firstTime)) / 1000)) : 0
  return { points, duration: Math.floor(duration / 60) + ' 分 ' + duration % 60 + ' 秒',
    elevation: minAltitude === null ? '未返回海拔' : minAltitude.toFixed(0) + ' ～ ' + maxAltitude.toFixed(0) + ' m',
    complete, runtimeTrace: runtimeView(notes) }
}
