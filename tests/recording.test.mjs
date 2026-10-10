import test from 'node:test'
import assert from 'node:assert/strict'
import { load, fakeFiles, settle } from './helpers.mjs'
const { createRecorder, trackPoint, recoverTracks, GPX_END } = await load('../src/common/recording.js')
const { listTracks, assertTrackUri, TRACK_DIR } = await load('../src/common/files.js')
const { summarizeTrack } = await load('../src/common/track-summary.js')
const fix = { latitude: 0, longitude: 121.4, altitude: -12.5, speed: 36 }

test('records at most one point per second, includes elevation/UTC and closes valid GPX', async () => {
  const fs = fakeFiles(); const changes = []
  const recorder = createRecorder(fs.api, state => changes.push(state))
  await recorder.start(100000)
  recorder.sample(fix, 101000, true); await settle()
  recorder.sample(fix, 101500, true); await settle()
  recorder.sample({ ...fix, altitude: null }, 102000, true); await settle()
  recorder.sample(fix, 103000, false); await settle()
  recorder.sample({ ...fix, latitude: null }, 104000, true); await settle()
  const uri = await recorder.finish()
  assert.match(uri, /\.gpx$/)
  assert.equal(changes.at(-1).points, 2)
  const text = fs.data.get(uri)
  assert.equal((text.match(/<trkpt /g) || []).length, 2)
  assert.match(text, /xmlns="http:\/\/www.topografix.com\/GPX\/1\/1"/)
  assert.match(text, /<ele>-12.50<\/ele>/)
  assert.match(text, /<time>1970-01-01T00:01:41.000Z<\/time>/)
  assert.ok(text.endsWith(GPX_END))
  assert.doesNotMatch(text, /[\r\n]/)
  assert.equal((text.match(/<ele>/g) || []).length, 1, 'missing altitude is not invented')
  assert.equal((await listTracks(fs.api)).length, 1)
  const summary = await summarizeTrack(fs.api, uri)
  assert.equal(summary.points, 2); assert.equal(summary.complete, true)
  assert.equal(summary.elevation, '-13 ～ -13 m')
})

test('invalid coordinates cannot be serialized as GPX positions', () => {
  for (const latitude of [null, undefined, NaN, Infinity, 91]) assert.equal(trackPoint({ ...fix, latitude }, 0), null)
  assert.equal(trackPoint({ ...fix, longitude: -181 }, 0), null)
})

test('write failure stops recording and retains an unfinished file for recovery', async () => {
  const fs = fakeFiles(); const recorder = createRecorder(fs.api, () => {})
  await recorder.start(100000)
  recorder.sample(fix, 101000, true); await settle()
  fs.failNextWrite(); recorder.sample(fix, 102000, true); await settle()
  assert.equal(recorder.snapshot().recording, false)
  assert.match(recorder.snapshot().message, /写入失败/)
  await recoverTracks(fs.api, null)
  const tracks = await listTracks(fs.api)
  assert.equal(tracks.length, 1)
  assert.ok(fs.data.get(tracks[0].uri).endsWith(GPX_END))
})

for (const format of ['full', 'filename', 'double-slash']) {
test('recovery truncates a partial point and protects the active recording with ' + format + ' URIs', async () => {
  const fs = fakeFiles(uri => format === 'full' ? uri : format === 'double-slash' ? uri.replace('/track-', '//track-') : uri.split('/').pop())
  const recorder = createRecorder(fs.api, () => {})
  await recorder.start(100000)
  const active = recorder.snapshot().uri
  const stale = TRACK_DIR + 'track-old.part'
  fs.data.set(stale, fs.data.get(active) + trackPoint(fix, 101000) + '<trkpt lat="3')
  assert.deepEqual(await recoverTracks(fs.api, active), { recovered: 1, failed: 0 })
  assert.equal(fs.data.has(active), true)
  const text = fs.data.get(stale.replace('.part', '.gpx'))
  assert.ok(text.endsWith(GPX_END)); assert.equal((text.match(/<trkpt /g) || []).length, 1)
  assert.doesNotMatch(text, /[\r\n]/)
})
}

test('recovery compacts legacy CRLF files without losing complete points or elevation', async () => {
  const fs = fakeFiles(); const recorder = createRecorder(fs.api, () => {})
  await recorder.start(100000)
  const active = recorder.snapshot().uri
  const uri = TRACK_DIR + 'track-legacy.part'
  const points = Array.from({ length: 120 }, (_, i) => trackPoint({ ...fix, altitude: i }, 101000 + i * 1000)).join('')
  fs.data.set(uri, (fs.data.get(active) + points + '<trkpt lat="3').replace(/></g, '>\r\n<'))
  assert.deepEqual(await recoverTracks(fs.api, active), { recovered: 1, failed: 0 })
  const repaired = uri.replace(/\.part$/, '.gpx')
  assert.doesNotMatch(fs.data.get(repaired), /[\r\n]/)
  const summary = await summarizeTrack(fs.api, repaired)
  assert.equal(summary.points, 120); assert.equal(summary.complete, true)
  assert.equal(summary.elevation, '0 ～ 119 m')
})

test('inspection spans chunk boundaries and long recordings with bounded reads', async () => {
  const fs = fakeFiles(); const recorder = createRecorder(fs.api, () => {})
  await recorder.start(100000)
  for (let i = 0; i < 120; i++) { recorder.sample({ ...fix, altitude: i }, 101000 + i * 1000, true); await settle() }
  const uri = await recorder.finish()
  const summary = await summarizeTrack(fs.api, uri)
  assert.equal(summary.points, 120); assert.equal(summary.elevation, '0 ～ 119 m')
  assert.equal(summary.duration, '2 分 0 秒'); assert.equal(summary.complete, true)
})

test('file operations reject paths outside this app track directory', () => {
  for (const uri of ['internal://files/elsewhere.gpx', TRACK_DIR + 'track-../x.gpx', TRACK_DIR + 'track-a.part']) {
    assert.throws(() => assertTrackUri(uri))
  }
  assert.doesNotThrow(() => assertTrackUri(TRACK_DIR + 'track-a.gpx'))
})
