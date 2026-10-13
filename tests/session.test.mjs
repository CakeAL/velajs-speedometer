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
  assert.equal(h.subscriptions.length, 1); assert.equal(h.requests.length, 0)
  assert.equal(h.fs.data.size, 0); assert.equal(h.fs.writes.length, 0)
  await h.session.dispose(); assert.equal(h.unsubscribes, 1); assert.equal(h.clock.tasks, 0)
  h.subscriptions[0].callback(sample); h.session.activate(); h.session.resume(); h.clock.advance(10000)
  assert.equal(h.subscriptions.length, 1); assert.equal(h.session.snapshot().speed, '--')
})

test('native subscription errors retry in background, ignore old callbacks and stop retrying on destruction', async () => {
  const h = harness(); const listener = () => {}; h.session.acquire(listener)
  h.session.release(listener); h.session.suspend()
  h.subscriptions[0].fail('error', 1000)
  assert.match(h.session.snapshot().statusText, /搜星中/)
  assert.equal(h.subscriptions.length, 2, 'restore the native background feature before returning from failure')
  h.subscriptions[0].callback(sample); assert.equal(h.session.snapshot().speed, '--')
  h.subscriptions[1].callback(sample); assert.equal(h.session.snapshot().speed, '36')
  h.subscriptions[1].fail('denied', 400)
  await h.session.dispose(); h.clock.advance(30000)
  assert.equal(h.subscriptions.length, 2); assert.equal(h.clock.tasks, 0)
})

test('synchronous background subscription failures have bounded retries and permission failures stay delayed', async () => {
  const clock = fakeClock(); const fs = fakeFiles(); const streams = []
  let failImmediately = false
  const session = createSession({ file: fs.api, brightness: { setKeepScreenOn() {} },
    geolocation: { subscribe(options) { streams.push(options); if (failImmediately) options.fail('unavailable', 1000) }, unsubscribe() {} }
  }, clock)
  session.activate(); session.suspend(); failImmediately = true
  streams[0].fail('unavailable', 1000)
  assert.equal(streams.length, 2, 'one immediate retry must not recurse after synchronous failure')
  clock.advance(4999); assert.equal(streams.length, 2)
  clock.advance(1); assert.equal(streams.length, 4, 'delayed retry plus one bounded immediate recovery')
  failImmediately = false
  clock.advance(5000); assert.equal(streams.length, 5)
  streams[4].fail('denied', 400)
  clock.advance(14999); assert.equal(streams.length, 5, 'permission errors must not retry immediately')
  clock.advance(1); assert.equal(streams.length, 6)
  await session.dispose(); clock.advance(30000)
  assert.equal(streams.length, 6); assert.equal(clock.tasks, 0)
})

test('slow first fix and a long signal gap do not cancel an existing GPS subscription', async () => {
  const h = harness(); h.session.acquire(() => {})
  h.clock.advance(60000)
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

test('screen-off and background return preserve statistics in either lifecycle order until app destruction', async () => {
  for (const appFirst of [true, false]) {
    const h = harness(); const home = () => {}; const details = () => {}
    h.session.acquire(home); h.subscriptions[0].callback(sample); h.clock.advance(1000)
    h.session.release(home); h.session.acquire(details)
    assert.equal(h.session.snapshot().average, '36.0'); assert.equal(h.session.snapshot().maximum, '36.0')
    h.session.release(details); h.session.suspend()
    if (appFirst) { h.session.resume(); h.session.acquire(home) }
    else { h.session.acquire(home); h.session.resume() }
    assert.equal(h.session.snapshot().average, '36.0'); assert.equal(h.session.snapshot().maximum, '36.0')
    h.subscriptions.at(-1).callback({ ...sample, speed: 5 }); h.clock.advance(1000)
    assert.equal(h.session.snapshot().average, '27.0'); assert.equal(h.session.snapshot().maximum, '36.0')
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

test('unrecorded idle shows a black cover, while recording keeps the full UI bright by default', async () => {
  const h = harness(); h.session.acquire(() => {})
  assert.equal(h.screen.at(-1), true)
  h.clock.advance(9999); assert.equal(h.screen.at(-1), true)
  h.clock.advance(1); assert.equal(h.screen.at(-1), true)
  assert.equal(h.session.snapshot().screenCovered, true)
  assert.equal(h.subscriptions.length, 1); assert.equal(h.unsubscribes, 0)
  await h.session.toggleRecording(); assert.equal(h.screen.at(-1), true)
  assert.equal(h.session.snapshot().screenCovered, false)
  h.subscriptions[0].fail('failed', 1000)
  h.clock.advance(5000); assert.equal(h.subscriptions.length, 2)
  assert.equal(h.screen.at(-1), true)
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
  h.clock.advance(10000); assert.equal(h.screen.at(-1), true)
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

test('manual refresh and prolonged foreground or background tracking use only subscription callbacks', async () => {
  const h = harness(); h.session.acquire(() => {})
  h.subscriptions[0].callback(sample); h.clock.advance(1000)
  const average = h.session.snapshot().average
  h.session.refreshLocation()
  assert.equal(h.subscriptions.length, 2); assert.equal(h.unsubscribes, 0)
  assert.equal(h.session.snapshot().average, average); assert.equal(h.session.snapshot().speed, '36')
  h.subscriptions[0].fail('obsolete error', 203)
  for (let i = 0; i < 60; i++) {
    h.subscriptions[1].callback({ ...sample, altitude: 13 + i / 10 })
    h.clock.advance(1000)
  }
  h.session.suspend(); h.session.refreshLocation(); h.clock.advance(180000)
  assert.equal(h.subscriptions.length, 2, 'no new requests or subscriptions while hidden')
  assert.equal(h.requests.length, 0); assert.equal(h.unsubscribes, 0)
  assert.equal(h.session.snapshot().gpsError, '')
  assert.equal(h.fs.data.size, 0, 'diagnostics remain in memory when not recording')
  await h.session.dispose(); assert.equal(h.unsubscribes, 1); assert.equal(h.clock.tasks, 0)
})

test('ten minutes of background GPX keep one subscription, bounded timers, updated altitude and session statistics', async () => {
  const h = harness(); const listener = () => {}; h.session.acquire(listener)
  // Explicitly choose automatic screen-off instead of the safe recording default.
  h.session.changeScreenMode(); h.session.changeScreenMode()
  assert.match(h.session.snapshot().screenModeText, /自动熄屏/)
  h.subscriptions[0].callback(sample); await h.session.toggleRecording()
  h.session.release(listener); h.session.suspend()
  const timerCount = h.clock.tasks
  for (let i = 0; i < 600; i++) {
    h.subscriptions[0].callback({ ...sample, speed: i % 2 ? 20 : 10, altitude: 100 + i / 10 })
    h.clock.advance(1000); await settle()
    assert.equal(h.clock.tasks, timerCount, 'jobs must not accumulate during long recordings')
  }
  assert.equal(h.session.snapshot().recordPoints, 600)
  assert.equal(h.session.snapshot().altitude, '159.9')
  assert.equal(h.session.snapshot().average, '54.0'); assert.equal(h.session.snapshot().maximum, '72.0')
  assert.equal(h.requests.length, 0, 'background uses only the active native subscription')
  assert.equal(h.subscriptions.length, 1); assert.equal(h.unsubscribes, 0)
  assert.equal(h.screen.at(-1), false)
  h.session.resume(); h.session.acquire(listener)
  assert.equal(h.session.snapshot().average, '54.0')
  await h.session.toggleRecording()
  const gpx = [...h.fs.data].find(([uri]) => uri.endsWith('.gpx'))[1]
  assert.equal((gpx.match(/<trkpt /g) || []).length, 600)
  assert.match(gpx, /<ele>159\.90<\/ele>/); assert.doesNotMatch(gpx, /[\r\n]/)
  await h.session.dispose(); assert.equal(h.clock.tasks, 0)
})

test('screen modes keep the native display awake and only cover the UI in automatic mode', async () => {
  const h = harness(); h.session.acquire(() => {})
  h.session.changeScreenMode()
  assert.equal(h.session.snapshot().screenModeText, '始终常亮')
  h.clock.advance(60000); assert.equal(h.screen.at(-1), true)
  assert.equal(h.session.snapshot().screenCovered, false)
  h.session.changeScreenMode()
  assert.match(h.session.snapshot().screenModeText, /自动熄屏/)
  await h.session.toggleRecording()
  h.clock.advance(10000); assert.equal(h.screen.at(-1), true)
  assert.equal(h.session.snapshot().screenCovered, true)
  h.session.suspend(); h.session.resume()
  h.clock.advance(10000); assert.equal(h.screen.at(-1), true)
  assert.equal(h.session.snapshot().screenCovered, true)
  await h.session.toggleRecording(); await h.session.dispose()
  const fresh = harness()
  assert.equal(fresh.session.snapshot().screenModeText, '记录时常亮', 'preferences are not saved to storage')
  await fresh.session.dispose()
})

test('ten minutes behind the black cover keep GPS, altitude, recording and statistics in the foreground', async () => {
  const h = harness(); const values = []; h.session.acquire(value => values.push(value))
  h.session.changeScreenMode(); h.session.changeScreenMode()
  await h.session.toggleRecording()
  let coveredTimerCount
  for (let i = 0; i < 600; i++) {
    h.subscriptions[0].callback({ ...sample, speed: i % 2 ? 20 : 10, altitude: 100 + i / 10 })
    h.clock.advance(1000); await settle()
    if (i === 9) coveredTimerCount = h.clock.tasks
    if (i >= 9) {
      assert.equal(h.session.snapshot().screenCovered, true)
      assert.equal(h.clock.tasks, coveredTimerCount)
    }
  }
  assert.ok(h.screen.every(value => value === true), 'virtual screen-off must never release native keepScreenOn')
  assert.equal(h.session.snapshot().recordPoints, 600)
  assert.equal(h.session.snapshot().average, '54.0'); assert.equal(h.session.snapshot().maximum, '72.0')
  assert.equal(h.session.snapshot().altitude, '159.9')
  assert.equal(h.subscriptions.length, 1); assert.equal(h.unsubscribes, 0); assert.equal(h.requests.length, 0)
  assert.equal(values.at(-1).statusColor, '#7ef7c5')
  h.clock.advance(5000); await settle()
  assert.equal(values.at(-1).statusColor, '#f2bf68', 'the covered GPS indicator reflects stale readings')
  const averageBeforeWake = h.session.snapshot().average
  h.session.interact()
  assert.equal(h.session.snapshot().screenCovered, false)
  assert.equal(h.session.snapshot().average, averageBeforeWake)
  h.clock.advance(9999); assert.equal(h.session.snapshot().screenCovered, false)
  h.clock.advance(1); assert.equal(h.session.snapshot().screenCovered, true)
  await h.session.toggleRecording()
  const text = [...h.fs.data].find(([uri]) => uri.endsWith('.gpx'))[1]
  assert.doesNotMatch(text, /event=hide|event=tick|[\r\n]/)
  assert.ok(text.endsWith('</trkseg></trk></gpx>'))
  await h.session.dispose(); assert.equal(h.screen.at(-1), false); assert.equal(h.clock.tasks, 0)
})

test('touching the UI restarts its idle delay and leaving the app clears the overlay timer', async () => {
  const h = harness(); h.session.acquire(() => {})
  h.clock.advance(9000); h.session.interact(); h.clock.advance(9000)
  assert.equal(h.session.snapshot().screenCovered, false)
  h.clock.advance(1000); assert.equal(h.session.snapshot().screenCovered, true)
  h.session.interact(); h.session.suspend(); h.clock.advance(10000)
  assert.equal(h.session.snapshot().screenCovered, false); assert.equal(h.screen.at(-1), false)
  h.session.resume(); h.clock.advance(10000)
  assert.equal(h.session.snapshot().screenCovered, true); assert.equal(h.screen.at(-1), true)
  await h.session.dispose(); h.session.interact(); h.clock.advance(10000)
  assert.equal(h.clock.tasks, 0); assert.equal(h.screen.at(-1), false)
})

test('missing, throwing or failing keep-screen-on APIs cannot block the black overlay or GPX recording', async () => {
  for (const [brightness, expected] of [
    [undefined, /未提供常亮接口/],
    [{}, /未提供常亮接口/],
    [{ setKeepScreenOn() { throw new Error('native call unavailable') } }, /native call unavailable/],
    [{ setKeepScreenOn(o) { o.fail('unsupported', 203) } }, /常亮未生效 \(203\)/],
    [{ setKeepScreenOn(o) { o.fail() } }, /常亮未生效/]
  ]) {
    const clock = fakeClock(); const fs = fakeFiles(); let stream
    const session = createSession({ file: fs.api, brightness,
      geolocation: { subscribe(options) { stream = options }, unsubscribe() {} }
    }, clock)
    session.activate(); session.acquire(() => {})
    session.changeScreenMode(); session.changeScreenMode()
    await session.toggleRecording()
    assert.match(session.snapshot().screenError, expected)
    for (let i = 0; i < 10; i++) {
      stream.callback(sample); clock.advance(1000); await settle()
    }
    assert.equal(session.snapshot().screenCovered, true)
    assert.equal(session.snapshot().recordPoints, 10)
    assert.equal(session.snapshot().average, '36.0')
    session.interact(); assert.equal(session.snapshot().screenCovered, false)
    assert.equal(session.snapshot().recording, true)
    await session.dispose(); assert.equal(clock.tasks, 0)
  }
})

test('a later successful keep-screen-on request clears its warning without changing overlay timing', async () => {
  const clock = fakeClock(); const fs = fakeFiles(); let failed = true
  const session = createSession({ file: fs.api,
    brightness: { setKeepScreenOn(o) { if (failed) o.fail('unavailable', 200); else o.success() } },
    geolocation: { subscribe() {}, unsubscribe() {} }
  }, clock)
  session.activate(); session.acquire(() => {})
  clock.advance(10000)
  assert.equal(session.snapshot().screenCovered, true); assert.match(session.snapshot().screenError, /200/)
  failed = false; session.interact()
  assert.equal(session.snapshot().screenError, ''); assert.equal(session.snapshot().screenCovered, false)
  clock.advance(10000); assert.equal(session.snapshot().screenCovered, true)
  await session.dispose()
})

test('the top-edge GPS dot shifts every twenty seconds without adding timers or altering the session', async () => {
  const h = harness(); h.session.acquire(() => {})
  h.clock.advance(10000)
  const jobs = h.clock.tasks
  assert.equal(h.session.snapshot().screenCovered, true)
  assert.equal(h.session.snapshot().sleepDotLeft, 118)
  h.clock.advance(19999); assert.equal(h.session.snapshot().sleepDotLeft, 118)
  h.clock.advance(1); assert.equal(h.session.snapshot().sleepDotLeft, 122)
  for (const expected of [126, 122, 118, 114, 110, 114, 118]) {
    h.clock.advance(20000)
    assert.equal(h.session.snapshot().sleepDotLeft, expected)
    assert.equal(h.clock.tasks, jobs)
  }
  assert.equal(h.subscriptions.length, 1); assert.equal(h.unsubscribes, 0)
  assert.equal(h.fs.data.size, 0); assert.equal(h.storageCalls, 0)
  h.session.interact(); assert.equal(h.session.snapshot().sleepDotLeft, 118)
  h.clock.advance(10000); assert.equal(h.session.snapshot().screenCovered, true)
  assert.equal(h.session.snapshot().sleepDotLeft, 118)
  await h.session.dispose(); assert.equal(h.clock.tasks, 0)
})

test('foreground, background and subscription retries never append runtime notes to GPX', async () => {
  const h = harness(); h.session.acquire(() => {})
  h.subscriptions[0].callback(sample); await h.session.toggleRecording()
  h.clock.advance(1000); await settle(); h.session.suspend()
  h.clock.advance(60000); await settle()
  h.subscriptions[0].fail('native stopped', 1000)
  assert.equal(h.subscriptions.length, 2)
  h.subscriptions[1].callback(sample)
  h.clock.advance(1000); await settle(); h.session.resume()
  await h.session.dispose()
  const [uri, text] = [...h.fs.data].find(([name]) => name.endsWith('.gpx'))
  assert.match(text, /<trkpt /); assert.match(text, /<ele>12\.60<\/ele>/)
  assert.doesNotMatch(text, /<!--|speedometer:event|native stopped|[\r\n]/)
  assert.equal(h.storageCalls, 0)
  assert.ok([...h.fs.data].every(([name, content]) => content === null || name === uri))
  const { summarizeTrack } = await load('../src/common/track-summary.js')
  assert.equal((await summarizeTrack(h.fs.api, uri)).complete, true)
})
