import { assertTrackUri, readTrackChunk, READ_CHUNK_BYTES } from './files'
import { asciiText } from './bytes'

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
  for (;;) {
    const bytes = await readTrackChunk(api, uri, position)
    if (!bytes.length) break
    const text = carry + asciiText(bytes)
    let consumed = 0
    const tags = /<trkpt\s|<time>([^<]+)<\/time>|<ele>([^<]+)<\/ele>|<\/gpx>/g
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
    }
    carry = text.slice(consumed).slice(-256)
    position += bytes.length
    if (bytes.length < READ_CHUNK_BYTES) break
  }
  const duration = firstTime && lastTime ? Math.max(0, Math.floor((Date.parse(lastTime) - Date.parse(firstTime)) / 1000)) : 0
  return { points, duration: Math.floor(duration / 60) + ' 分 ' + duration % 60 + ' 秒',
    elevation: minAltitude === null ? '未返回海拔' : minAltitude.toFixed(0) + ' ～ ' + maxAltitude.toFixed(0) + ' m',
    complete }
}
