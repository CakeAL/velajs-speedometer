import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const load = async path => import('data:text/javascript;base64,' + Buffer.from(await readFile(new URL(path, import.meta.url))).toString('base64'))
const { normalizeSpeed, normalizeLocation, coordinate, locationView, createLocationTracker, SPEED_STALE_AFTER, STALE_AFTER } = await load('../src/common/location.js')
const { screenLayout } = await load('../src/common/layout.js')
const sample = { latitude: 31.230416, longitude: 121.473701, speed: 10, altitude: 12.6, accuracy: 8 }

function harness() {
  let now = 100000
  let interval = null
  let unsubscribes = 0
  const requests = []
  const subscriptions = []
  const changes = []
  const api = {
    getLocation(options) { requests.push(options) },
    subscribe(options) { subscriptions.push(options) },
    unsubscribe() { unsubscribes += 1 }
  }
  const clock = {
    now: () => now,
    setInterval(callback) { interval = callback; return 1 },
    clearInterval() { interval = null }
  }
  const tracker = createLocationTracker(api, state => changes.push(state), clock)
  return {
    api, tracker, requests, subscriptions,
    advance(ms) { now += ms; if (interval) interval() },
    view(unit = 0) { return locationView(changes.at(-1), unit, now) },
    get state() { return changes.at(-1) },
    get running() { return interval !== null },
    get unsubscribes() { return unsubscribes }
  }
}

test('speed follows the reference conversion, threshold and rounding', () => {
  assert.equal(normalizeSpeed(10), 36)
  assert.equal(normalizeSpeed('10'), 36)
  assert.equal(normalizeSpeed(0), 0)
  assert.equal(normalizeSpeed(0.1), 0)
  assert.equal(normalizeSpeed(0.5 / 3.6), 0.5)
  assert.equal(normalizeSpeed(5.56), 20)
  for (const value of [undefined, null, '', ' ', true, NaN, Infinity, -1, 'bad']) {
    assert.equal(normalizeSpeed(value), null)
  }
})

test('valid speed is displayed without any coordinate or altitude fields', () => {
  const fix = normalizeLocation({ speed: '10' })
  const view = locationView({ phase: 'live', fix, updatedAt: 0 }, 0, 0)
  assert.equal(view.speed, '36')
  assert.equal(view.latitude, '--')
  assert.equal(view.longitude, '--')
  assert.equal(view.altitude, '--')
})

test('malformed coordinates do not discard an otherwise valid speed', () => {
  for (const latitude of [undefined, NaN, Infinity, 91, '31']) {
    const fix = normalizeLocation({ ...sample, latitude })
    assert.equal(fix.latitude, null)
    assert.equal(fix.speed, 36)
  }
  assert.equal(normalizeLocation({ ...sample, longitude: -181 }).longitude, null)
  assert.equal(normalizeLocation({ latitude: NaN, longitude: Infinity, speed: -1 }), null)
})

test('missing speed and altitude remain unavailable', () => {
  const fix = normalizeLocation({ ...sample, speed: -1, altitude: null })
  const view = locationView({ phase: 'live', fix, updatedAt: 10 }, 0, 10)
  assert.equal(view.speed, '--')
  assert.equal(view.altitude, '--')
  assert.equal(view.latitude, '31.23042° N')
})

test('zero coordinates and below-sea-level altitude are valid', () => {
  const fix = normalizeLocation({ latitude: 0, longitude: 0, speed: 0, altitude: -10 })
  const view = locationView({ phase: 'live', fix, updatedAt: 0 }, 0, 0)
  assert.equal(view.speed, '0')
  assert.equal(view.altitude, '-10')
  assert.equal(view.latitude, '0.00000° N')
})

test('formats units and hemispheres without mutating the speed sample', () => {
  const state = { phase: 'live', fix: normalizeLocation(sample), updatedAt: 0 }
  assert.equal(locationView(state, 0, 0).speed, '36')
  assert.equal(locationView(state, 1, 0).speed, '10.0')
  assert.equal(locationView(state, 2, 0).speed, '22')
  assert.equal(locationView(state, 0, 0).speed, '36')
  assert.equal(coordinate(-121.473701, false, 6), '121.473701° W')
  assert.equal(coordinate(-31.230416, true, 5), '31.23042° S')
})

test('prefers horizontal accuracy and warns about poor precision', () => {
  const fix = normalizeLocation({ ...sample, accuracyInfo: { horizontal: 80 } })
  const view = locationView({ phase: 'live', fix, updatedAt: 0 }, 0, 0)
  assert.equal(view.accuracy, '±80 m')
  assert.equal(view.tone, 'warning')
})

test('after five seconds speed resets to zero and is labelled as stale', () => {
  const state = { phase: 'live', fix: normalizeLocation(sample), updatedAt: 0 }
  assert.equal(locationView(state, 0, SPEED_STALE_AFTER - 1).speed, '36')
  const view = locationView(state, 0, SPEED_STALE_AFTER)
  assert.equal(view.speed, '0')
  assert.equal(view.tone, 'warning')
  assert.equal(view.hint, '5 秒未更新，速度已归零')
  assert.equal(view.latitude, '31.23042° N')
  assert.equal(locationView(state, 0, STALE_AFTER).latitude, '--')
})

test('paused and failed states hide old measurements', () => {
  for (const phase of ['paused', 'error', 'denied', 'unsupported']) {
    const view = locationView({ phase, fix: normalizeLocation(sample), updatedAt: 0 }, 0, 1)
    assert.equal(view.speed, '--')
    assert.equal(view.latitude, '--')
    assert.equal(view.altitude, '--')
  }
})

test('starts the reference initial request and subscription immediately, once', () => {
  const h = harness()
  h.tracker.start()
  h.tracker.start()
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].timeout, 60000)
  assert.equal(h.subscriptions.length, 1)
  h.subscriptions[0].callback({ speed: '10' })
  assert.equal(h.state.phase, 'live')
  assert.equal(h.view().speed, '36')
})

test('a late initial fix cannot overwrite a newer stream sample', () => {
  const h = harness()
  h.tracker.start()
  h.subscriptions[0].callback({ ...sample, speed: 20 })
  h.requests[0].success({ ...sample, speed: 5 })
  h.requests[0].fail('timeout', 204)
  assert.equal(h.state.phase, 'live')
  assert.equal(h.view().speed, '72')
})

test('pause clears the timer, unsubscribes and ignores callbacks', () => {
  const h = harness()
  h.tracker.start()
  const request = h.requests[0]
  const stream = h.subscriptions[0]
  stream.callback(sample)
  h.tracker.stop()
  assert.equal(h.running, false)
  assert.equal(h.unsubscribes, 1)
  assert.equal(h.view().speed, '--')
  request.success({ ...sample, speed: 30 })
  stream.callback({ ...sample, speed: 40 })
  assert.equal(h.state.phase, 'paused')
  h.tracker.stop()
  assert.equal(h.unsubscribes, 1)
})

test('callbacks from a previous session cannot corrupt a resumed session', () => {
  const h = harness()
  h.tracker.start()
  const previous = h.requests[0]
  const stream = h.subscriptions[0]
  h.tracker.retry()
  previous.success(sample)
  previous.fail('denied', 400)
  stream.callback(sample)
  stream.fail('denied', 400)
  assert.equal(h.state.phase, 'locating')
  h.subscriptions[1].callback(sample)
  assert.equal(h.state.phase, 'live')
})

test('initial snapshot timeout does not stop continuous listening', () => {
  const h = harness()
  h.tracker.start()
  h.requests[0].fail('timeout', 204)
  assert.equal(h.state.phase, 'timeout')
  assert.equal(h.unsubscribes, 0)
  h.subscriptions[0].callback(sample)
  assert.equal(h.view().speed, '36')
})

test('stale timeout keeps the subscription and never starts repeated snapshots', () => {
  const h = harness()
  h.tracker.start()
  h.subscriptions[0].callback(sample)
  h.advance(5000)
  assert.equal(h.state.phase, 'stale')
  assert.equal(h.view().speed, '0')
  h.advance(60000)
  assert.equal(h.requests.length, 1)
  assert.equal(h.unsubscribes, 0)
  h.subscriptions[0].callback({ ...sample, speed: 20 })
  assert.equal(h.state.phase, 'live')
  assert.equal(h.view().speed, '72')
})

test('invalid callbacks cannot keep an old speed alive', () => {
  const h = harness()
  h.tracker.start()
  h.subscriptions[0].callback(sample)
  h.advance(4000)
  h.subscriptions[0].callback({ speed: NaN })
  h.advance(1000)
  assert.equal(h.view().speed, '0')
})

for (const [code, phase] of [[203, 'unsupported'], [201, 'denied'], [207, 'denied'], [400, 'denied'], [402, 'denied']]) {
  test('subscription error ' + code + ' is visible and stops tracking', () => {
    const h = harness()
    h.tracker.start()
    h.subscriptions[0].fail('failed', code)
    assert.equal(h.state.phase, phase)
    assert.equal(h.running, false)
    assert.equal(h.unsubscribes, 1)
    h.requests[0].success(sample)
    assert.equal(h.state.phase, phase)
  })
}

test('missing native timeout callback still produces a search timeout', () => {
  const h = harness()
  h.tracker.start()
  h.advance(60000)
  assert.equal(h.state.phase, 'timeout')
  h.subscriptions[0].callback(sample)
  assert.equal(h.state.phase, 'live')
})

test('layouts follow screen shape and aspect ratio instead of a model list', () => {
  assert.equal(screenLayout({ screenWidth: 466, screenHeight: 466, screenShape: 'circle' }).pageClass, 'round-page')
  assert.equal(screenLayout({ screenWidth: 432, screenHeight: 514, screenShape: 'rect' }).pageClass, 'rect-page')
  assert.equal(screenLayout({ screenWidth: 336, screenHeight: 480, screenShape: 'rect' }).pageClass, 'rect-page')
  assert.equal(screenLayout({ screenWidth: 212, screenHeight: 520, screenShape: 'pill-shaped' }).narrow, true)
  assert.equal(screenLayout(null).pageClass, 'round-page')
})
