import test from 'node:test'
import assert from 'node:assert/strict'
import { load, fakeClock, fakeFiles, settle } from './helpers.mjs'
const { createSession } = await load('../src/common/session.js')
const sample = { latitude: 31.23, longitude: 121.47, speed: 10, altitude: 12.6, accuracy: 8 }
function harness(saved = '') {
  const clock = fakeClock(); const fs = fakeFiles(); const subscriptions = []; const requests = []; const screen = []
  let unsubscribes = 0; let stored = saved; let storageCalls = 0
  const session = createSession({
    file: fs.api,
    storage: { get(o) { storageCalls++; o.success(stored) }, set(o) { storageCalls++; stored = o.value; o.success({}) } },
    brightness: { setKeepScreenOn(o) { screen.push(o.keepScreenOn) } },
    geolocation: { getLocation(o) { requests.push(o) }, subscribe(o) { subscriptions.push(o) }, unsubscribe() { unsubscribes++ } }
  }, clock)
  session.activate()
  return { session, clock, fs, subscriptions, requests, screen, get unsubscribes() { return unsubscribes }, get stored() { return stored }, get storageCalls() { return storageCalls } }
}

test('unrecorded GPS stays live through page hide and background, so wake immediately displays the newest speed', async () => {
  const h = harness(); const values = []; const home = value => values.push(value); const details = () => {}
  assert.equal(h.subscriptions.length, 1, 'GPS starts before a page attaches')
  h.session.activate(); assert.equal(h.subscriptions.length, 1)
  h.session.acquire(home); h.subscriptions[0].callback(sample)
  h.session.release(home); h.clock.advance(500)
  h.session.acquire(details); assert.equal(h.subscriptions.length, 1)
  h.session.release(details); h.session.suspend(); h.clock.advance(20000)
  assert.equal(h.unsubscribes, 0); assert.equal(h.screen.at(-1), false)
  const visibleUpdates = values.length
  for (let i = 0; i < 20; i++) {
    h.subscriptions[0].callback({ ...sample, speed: 20 })
    h.clock.advance(1000)
  }
  assert.equal(values.length, visibleUpdates, 'background fixes do not update hidden pages')
  h.subscriptions[0].callback({ ...sample, speed: 5 })
  h.session.resume(); h.session.acquire(home)
  assert.equal(values.at(-1).speed, '18', 'the first visible frame uses the background fix')
  assert.equal(h.subscriptions.length, 1); assert.equal(h.requests.length, 1)
  assert.equal(h.fs.data.size, 0); assert.equal(h.fs.writes.length, 0)
  await h.session.dispose(); assert.equal(h.unsubscribes, 1); assert.equal(h.clock.tasks, 0)
  h.subscriptions[0].callback(sample); h.session.activate(); h.session.resume(); h.clock.advance(10000)
  assert.equal(h.subscriptions.length, 1); assert.equal(h.session.snapshot().speed, '--')
})

test('native subscription errors retry in background, ignore old callbacks and stop retrying on destruction', async () => {
  const h = harness(); const listener = () => {}; h.session.acquire(listener)
  h.session.release(listener); h.session.suspend()
  h.subscriptions[0].fail('error', 1000)
  assert.match(h.session.snapshot().statusText, /自动重试/)
  h.clock.advance(4999); assert.equal(h.subscriptions.length, 1)
  h.clock.advance(1); assert.equal(h.subscriptions.length, 2)
  h.subscriptions[0].callback(sample); assert.equal(h.session.snapshot().speed, '--')
  h.subscriptions[1].callback(sample); assert.equal(h.session.snapshot().speed, '36')
  h.subscriptions[1].fail('denied', 400)
  await h.session.dispose(); h.clock.advance(30000)
  assert.equal(h.subscriptions.length, 2); assert.equal(h.clock.tasks, 0)
})

test('slow first fix and a long signal gap do not cancel an existing GPS subscription', async () => {
  const h = harness(); h.session.acquire(() => {})
  h.requests[0].fail('timeout', 204)
  assert.match(h.session.snapshot().statusText, /继续等待/)
  h.clock.advance(180000)
  assert.equal(h.subscriptions.length, 1); assert.equal(h.unsubscribes, 0)
  h.subscriptions[0].callback(sample); assert.equal(h.session.snapshot().speed, '36')
  h.clock.advance(180000)
  assert.equal(h.subscriptions.length, 1); assert.equal(h.unsubscribes, 0)
  assert.equal(h.session.snapshot().speed, '0', 'old measurements are still marked stale')
  h.subscriptions[0].callback({ ...sample, speed: 5 }); assert.equal(h.session.snapshot().speed, '18')
  await h.session.dispose()
})

test('statistics stay in memory, ignore old stored values and sample only fresh GPS seconds including stops', async () => {
  const legacy = JSON.stringify({ samples: 2, sum: 40, max: 30 })
  const h = harness(legacy)
  h.session.acquire(() => {}); h.subscriptions[0].callback(sample)
  h.clock.advance(1000)
  h.subscriptions[0].callback({ ...sample, speed: 0 }); h.clock.advance(1000)
  assert.equal(h.session.snapshot().average, '18.0'); assert.equal(h.session.snapshot().maximum, '36.0')
  h.session.changeUnit(); assert.equal(h.session.snapshot().average, '5.0'); assert.equal(h.session.snapshot().maximum, '10.0')
  h.clock.advance(10000)
  assert.equal(h.session.snapshot().average, '2.0', 'stale GPS seconds must not add synthetic zero samples')
  await h.session.suspend(); await h.session.dispose()
  assert.equal(h.storageCalls, 0); assert.equal(h.stored, legacy)
  assert.equal(h.fs.data.size, 0); assert.equal(h.fs.writes.length, 0)
  const restarted = harness(legacy)
  assert.equal(restarted.session.snapshot().average, '--'); assert.equal(restarted.session.snapshot().maximum, '--')
  await restarted.session.dispose(); assert.equal(restarted.storageCalls, 0)
})

test('reopening without recording resets statistics in either app/page lifecycle order, while navigation preserves them', async () => {
  for (const appFirst of [true, false]) {
    const h = harness(); const home = () => {}; const details = () => {}
    h.session.acquire(home); h.subscriptions[0].callback(sample); h.clock.advance(1000)
    h.session.release(home); h.session.acquire(details)
    assert.equal(h.session.snapshot().average, '36.0'); assert.equal(h.session.snapshot().maximum, '36.0')
    h.session.release(details); h.session.suspend()
    if (appFirst) { h.session.resume(); h.session.acquire(home) }
    else { h.session.acquire(home); h.session.resume() }
    assert.equal(h.session.snapshot().average, '--'); assert.equal(h.session.snapshot().maximum, '--')
    h.subscriptions.at(-1).callback({ ...sample, speed: 5 }); h.clock.advance(1000)
    assert.equal(h.session.snapshot().average, '18.0'); assert.equal(h.session.snapshot().maximum, '18.0')
    await h.session.dispose(); assert.equal(h.storageCalls, 0)
    assert.equal(h.fs.data.size, 0)
  }
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
  assert.ok(files[0][1].endsWith('</trkseg></trk></gpx>'))
  assert.doesNotMatch(files[0][1], /[\r\n]/)
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
  h.clock.advance(1000); await settle()
  h.session.release(listener); h.session.suspend()
  h.subscriptions[0].callback({ ...sample, speed: 20 })
  h.clock.advance(1000); await settle()
  assert.equal(h.session.snapshot().recording, true)
  h.session.resume(); h.session.acquire(listener)
  assert.equal(h.subscriptions.length, 1); assert.equal(h.session.activeUri(), uri)
  assert.equal(h.session.snapshot().average, '54.0'); assert.equal(h.session.snapshot().maximum, '72.0')
  assert.equal(h.screen.at(-1), true)
  h.clock.advance(10000); assert.equal(h.screen.at(-1), false)
  await h.session.toggleRecording(); assert.equal(h.session.snapshot().recording, false)
  await h.session.dispose()
})

test('finishing or failing a background recording keeps GPS live until app destruction', async () => {
  for (const fail of [false, true]) {
    const h = harness(); const listener = () => {}
    h.session.acquire(listener); h.subscriptions[0].callback(sample)
    await h.session.toggleRecording()
    h.session.release(listener); h.session.suspend(); h.clock.advance(200)
    if (fail) { h.fs.failNextWrite(); h.clock.advance(1000); await settle() }
    else await h.session.toggleRecording()
    assert.equal(h.session.snapshot().recording, false)
    assert.equal(h.unsubscribes, 0); assert.ok(h.clock.tasks > 0)
    h.subscriptions[0].callback({ ...sample, speed: 5 })
    h.session.resume(); h.session.acquire(listener)
    assert.equal(h.session.snapshot().speed, '18'); assert.equal(h.subscriptions.length, 1)
    await h.session.dispose(); assert.equal(h.unsubscribes, 1); assert.equal(h.clock.tasks, 0)
  }
})

test('a synchronous initial timeout cannot later tear down the successfully attached GPS stream', async () => {
  const clock = fakeClock(); const fs = fakeFiles(); let streams = 0; let unsubscribes = 0
  const session = createSession({
    file: fs.api, brightness: { setKeepScreenOn() {} },
    geolocation: {
      getLocation(options) { options.fail('timeout', 204) },
      subscribe() { streams++ }, unsubscribe() { unsubscribes++ }
    }
  }, clock)
  session.activate(); clock.advance(180000)
  assert.equal(streams, 1); assert.equal(unsubscribes, 0)
  assert.match(session.snapshot().gpsError, /单次定位错误 204/)
  assert.equal(fs.data.size, 0, 'diagnostics remain in memory only')
  await session.dispose(); assert.equal(unsubscribes, 1); assert.equal(clock.tasks, 0)
})
