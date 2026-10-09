import test from 'node:test'
import assert from 'node:assert/strict'
import { load, fakeClock, fakeFiles, settle } from './helpers.mjs'
const { createSession } = await load('../src/common/session.js')
const sample = { latitude: 31.23, longitude: 121.47, speed: 10, altitude: 12.6, accuracy: 8 }
function harness(saved = '') {
  const clock = fakeClock(); const fs = fakeFiles(); const subscriptions = []; const requests = []; const screen = []
  let unsubscribes = 0; let stored = saved
  const session = createSession({
    file: fs.api,
    storage: { get(o) { o.success(stored) }, set(o) { stored = o.value; o.success({}) } },
    brightness: { setKeepScreenOn(o) { screen.push(o.keepScreenOn) } },
    geolocation: { getLocation(o) { requests.push(o) }, subscribe(o) { subscriptions.push(o) }, unsubscribe() { unsubscribes++ } }
  }, clock)
  return { session, clock, fs, subscriptions, requests, screen, get unsubscribes() { return unsubscribes }, get stored() { return stored } }
}

test('navigation shares one live GPS stream and stops when the app leaves foreground', async () => {
  const h = harness(); const home = () => {}; const details = () => {}
  h.session.acquire(home); h.subscriptions[0].callback(sample)
  h.session.release(home); h.session.acquire(details); h.clock.advance(200)
  assert.equal(h.subscriptions.length, 1); assert.equal(h.session.snapshot().speed, '36')
  await h.session.suspend()
  assert.equal(h.unsubscribes, 1); assert.equal(h.screen.at(-1), false); assert.equal(h.clock.tasks, 0)
  h.session.acquire(home); assert.equal(h.subscriptions.length, 2)
  h.subscriptions[0].callback({ ...sample, speed: 50 }); assert.equal(h.session.snapshot().speed, '--')
  await h.session.dispose(); assert.equal(h.clock.tasks, 0)
})

test('location errors retry automatically, ignore old callbacks and stop retrying on exit', async () => {
  const h = harness(); h.session.acquire(() => {})
  h.subscriptions[0].fail('error', 1000)
  assert.match(h.session.snapshot().statusText, /自动重试/)
  h.clock.advance(4999); assert.equal(h.subscriptions.length, 1)
  h.clock.advance(1); assert.equal(h.subscriptions.length, 2)
  h.subscriptions[0].callback(sample); assert.equal(h.session.snapshot().speed, '--')
  h.subscriptions[1].callback(sample); assert.equal(h.session.snapshot().speed, '36')
  h.subscriptions[1].fail('denied', 400)
  await h.session.suspend(); h.clock.advance(30000)
  assert.equal(h.subscriptions.length, 2); await h.session.dispose()
})

test('average samples each fresh second including stops, persists and follows the chosen unit', async () => {
  const h = harness(JSON.stringify({ samples: 2, sum: 40, max: 30 }))
  h.session.acquire(() => {}); h.subscriptions[0].callback(sample)
  h.clock.advance(1000)
  h.subscriptions[0].callback({ ...sample, speed: 0 }); h.clock.advance(1000)
  assert.equal(h.session.snapshot().average, '19.0'); assert.equal(h.session.snapshot().maximum, '36.0')
  h.session.changeUnit(); assert.equal(h.session.snapshot().average, '5.3'); assert.equal(h.session.snapshot().maximum, '10.0')
  h.clock.advance(10000)
  const before = JSON.parse(h.stored)
  assert.equal(before.samples, 7, 'stale GPS seconds must not add synthetic zero samples')
  await h.session.suspend()
  const restored = harness(h.stored)
  assert.equal(restored.session.snapshot().maximum, '36.0')
  await restored.session.dispose(); await h.session.dispose()
})

test('recording survives page hide and app background, then finalizes on destruction', async () => {
  const h = harness(); const home = () => {}; const tracks = () => {}
  h.session.acquire(home); h.subscriptions[0].callback(sample)
  await h.session.toggleRecording()
  h.clock.advance(1000); await settle()
  h.session.release(home); h.session.acquire(tracks)
  h.clock.advance(1000); await settle()
  assert.equal(h.subscriptions.length, 1)
  assert.equal(h.session.snapshot().recording, true)
  h.session.release(tracks)
  h.session.suspend()
  assert.equal(h.session.snapshot().recording, true)
  assert.equal(h.unsubscribes, 0)
  assert.equal(h.screen.at(-1), false)
  for (let i = 0; i < 3; i++) {
    h.subscriptions[0].callback({ ...sample, longitude: sample.longitude + i * 0.001 })
    h.clock.advance(1000); await settle()
  }
  assert.equal(h.session.snapshot().recording, true)
  await h.session.dispose()
  assert.equal(h.session.snapshot().recording, false)
  assert.equal(h.unsubscribes, 1)
  const files = [...h.fs.data].filter(([uri]) => uri.endsWith('.gpx'))
  assert.equal(files.length, 1)
  assert.equal((files[0][1].match(/<trkpt /g) || []).length, 5)
  assert.ok(files[0][1].endsWith('</trkseg></trk></gpx>\n'))
  await h.session.dispose()
})

test('failed recording is released so the file page can recover its partial GPX', async () => {
  const h = harness(); h.session.acquire(() => {}); h.subscriptions[0].callback(sample)
  await h.session.toggleRecording(); assert.match(h.session.activeUri(), /\.part$/)
  h.fs.failNextWrite(); h.clock.advance(1000); await settle()
  assert.equal(h.session.snapshot().recording, false)
  assert.equal(h.session.activeUri(), null)
  await h.session.dispose()
})

test('screen hold expires after ten seconds without stopping GPS, and recording/retry do not rearm it', async () => {
  const h = harness(); h.session.acquire(() => {})
  assert.equal(h.screen.at(-1), true)
  h.clock.advance(9999); assert.equal(h.screen.at(-1), true)
  h.clock.advance(1); assert.equal(h.screen.at(-1), false)
  assert.equal(h.subscriptions.length, 1); assert.equal(h.unsubscribes, 0)
  await h.session.toggleRecording(); assert.equal(h.screen.at(-1), false)
  h.subscriptions[0].fail('failed', 1000)
  h.clock.advance(5000); assert.equal(h.subscriptions.length, 2)
  assert.equal(h.screen.at(-1), false)
  await h.session.dispose(); assert.equal(h.clock.tasks, 0)
})

test('returning from background preserves the recording and stream and starts a new short screen hold', async () => {
  const h = harness(); const listener = () => {}
  h.session.acquire(listener); h.subscriptions[0].callback(sample)
  await h.session.toggleRecording(); const uri = h.session.activeUri()
  h.session.release(listener); h.session.suspend()
  h.clock.advance(1000); await settle()
  assert.equal(h.session.snapshot().recording, true)
  h.session.resume(); h.session.acquire(listener)
  assert.equal(h.subscriptions.length, 1); assert.equal(h.session.activeUri(), uri)
  assert.equal(h.screen.at(-1), true)
  h.clock.advance(10000); assert.equal(h.screen.at(-1), false)
  await h.session.toggleRecording(); assert.equal(h.session.snapshot().recording, false)
  await h.session.dispose()
})

test('finishing or failing a background recording releases GPS and all session timers', async () => {
  for (const fail of [false, true]) {
    const h = harness(); const listener = () => {}
    h.session.acquire(listener); h.subscriptions[0].callback(sample)
    await h.session.toggleRecording()
    h.session.release(listener); h.session.suspend(); h.clock.advance(200)
    if (fail) { h.fs.failNextWrite(); h.clock.advance(1000); await settle() }
    else await h.session.toggleRecording()
    assert.equal(h.session.snapshot().recording, false)
    assert.equal(h.unsubscribes, 1); assert.equal(h.clock.tasks, 0)
    assert.equal(h.screen.at(-1), false)
    await h.session.dispose()
  }
})
