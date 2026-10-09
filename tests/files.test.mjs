import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { load, moduleUrl, fakeFiles } from './helpers.mjs'
const { resolveTrackUri, listTracks, assertTrackUri, TRACK_DIR } = await load('../src/common/files.js')

test('resolves only direct track files inside the app directory', () => {
  for (const prefix of ['', './', 'speedometer/', TRACK_DIR, TRACK_DIR + '/', TRACK_DIR + '//']) {
    assert.equal(resolveTrackUri(prefix + 'track-a.gpx'), TRACK_DIR + 'track-a.gpx')
    assert.equal(resolveTrackUri(prefix + 'track-a.part'), TRACK_DIR + 'track-a.part')
  }
  for (const uri of [null, {}, '../track-a.gpx', 'track-../a.gpx', 'track-a\\b.gpx',
    'internal://files/other/track-a.gpx', TRACK_DIR + 'sub/track-a.gpx',
    'track-%2e%2e.gpx', 'track-a.gpx?x', 'notes.gpx', 'track-a.repair']) {
    assert.equal(resolveTrackUri(uri), null)
    assert.throws(() => assertTrackUri(uri))
  }
})

test('normalizes the double slash returned by the device and lists without a trailing slash', async () => {
  let directory
  const name = 'track-2026-10-09T11-33-50-183.gpx'
  const fs = fakeFiles()
  fs.data.set(TRACK_DIR, null)
  fs.api.list = options => {
    directory = options.uri
    options.success({ fileList: [{ uri: TRACK_DIR + '/' + name,
      type: 'file', length: 259, lastModifiedTime: 1791545630000 }] })
  }
  const entries = await listTracks(fs.api)
  assert.equal(directory, 'internal://files/speedometer')
  assert.equal(entries.length, 1)
  assert.equal(entries[0].uri, TRACK_DIR + name)
  assert.doesNotThrow(() => assertTrackUri(entries[0].uri))
})

test('list ignores unrelated or unsafe entries without blocking valid tracks', async () => {
  const fs = fakeFiles(uri => uri.split('/').pop())
  fs.data.set(TRACK_DIR, null)
  fs.data.set(TRACK_DIR + 'track-good.gpx', '<gpx/>')
  fs.data.set(TRACK_DIR + 'notes.gpx', 'notes')
  fs.data.set(TRACK_DIR + 'track-pending.part', 'pending')
  const tracks = await listTracks(fs.api)
  assert.equal(tracks.length, 1)
  assert.equal(tracks[0].uri, TRACK_DIR + 'track-good.gpx')
  assert.doesNotThrow(() => assertTrackUri(tracks[0].uri))
})

test('track timestamps follow the device timezone, including date rollover and DST', async () => {
  const url = await moduleUrl('../src/common/files.js')
  const examples = [
    ['Asia/Shanghai', 'track-2026-10-09T11-33-50-183.gpx', '2026-10-09 19:33:50'],
    ['Asia/Shanghai', 'track-2026-10-09T23-33-50-183.gpx', '2026-10-10 07:33:50'],
    ['America/Los_Angeles', 'track-2026-10-09T11-33-50-183.gpx', '2026-10-09 04:33:50'],
    ['America/Los_Angeles', 'track-2026-12-09T11-33-50-183.gpx', '2026-12-09 03:33:50'],
    ['UTC', 'track-2026-10-09T11-33-50-183.gpx', '2026-10-09 11:33:50'],
    ['Asia/Shanghai', 'track-2026-10-09T19-33-50-183+0800.gpx', '2026-10-09 19:33:50'],
    ['Asia/Shanghai', 'track-2026-10-09T04-33-50-183-0700.gpx', '2026-10-09 19:33:50'],
    ['UTC', 'track-2026-10-09T19-33-50-183+0800.gpx', '2026-10-09 11:33:50']
  ]
  for (const [timezone, name, expected] of examples) {
    const code = 'import {trackLabel} from ' + JSON.stringify(url) + '; process.stdout.write(trackLabel(' + JSON.stringify(name) + '))'
    const actual = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, TZ: timezone }, encoding: 'utf8'
    })
    assert.equal(actual, expected, timezone)
  }
})

test('new recordings use local time and an explicit timezone offset in filenames, with UTC GPX times', async () => {
  const filesUrl = await moduleUrl('../src/common/files.js')
  const recordingUrl = await moduleUrl('../src/common/recording.js')
  for (const [timezone, expected] of [
    ['Asia/Shanghai', 'track-2026-10-09T19-33-50-183+0800'],
    ['Asia/Kathmandu', 'track-2026-10-09T17-18-50-183+0545'],
    ['America/Los_Angeles', 'track-2026-10-09T04-33-50-183-0700'],
    ['UTC', 'track-2026-10-09T11-33-50-183+0000']
  ]) {
    const code = 'import {trackName} from ' + JSON.stringify(filesUrl) + ';' +
      'import {createRecorder} from ' + JSON.stringify(recordingUrl) + ';' +
      'const now=Date.UTC(2026,9,9,11,33,50,183); let header;' +
      'const api={access:o=>o.success({}), writeText:o=>{header=o.text;o.success({})}};' +
      'const recorder=createRecorder(api,()=>{}); await recorder.start(now);' +
      'process.stdout.write(JSON.stringify({name:trackName(now),uri:recorder.snapshot().uri,header}))'
    const actual = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, TZ: timezone }, encoding: 'utf8'
    }))
    assert.equal(actual.name, expected, timezone)
    assert.equal(actual.uri, TRACK_DIR + expected + '.part')
    assert.match(actual.header, /<time>2026-10-09T11:33:50.183Z<\/time>/)
    assert.equal(resolveTrackUri(TRACK_DIR + expected + '.gpx'), TRACK_DIR + expected + '.gpx')
  }
})
