import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const load = async path => import('data:text/javascript;base64,' + Buffer.from(await readFile(new URL(path, import.meta.url))).toString('base64'))
const { normalizeSpeed, normalizeLocation, locationView, createLocationTracker, SPEED_STALE_AFTER, STALE_AFTER } = await load('../src/common/location.js')
const { screenLayout, dashboardLayout } = await load('../src/common/layout.js')
const sample = { latitude: 31.230416, longitude: 121.473701, speed: 10, altitude: 12.6, accuracy: 8 }

function harness() {
  let now = 100000
  let interval = null
  let unsubscribes = 0
  const requests = []
  const subscriptions = []
  const changes = []
  const calls = []
  const api = {
    getLocation() { requests.push('unexpected'); throw new Error('single requests must never run') },
    subscribe(options) { calls.push('subscribe'); subscriptions.push(options) },
    unsubscribe() { unsubscribes += 1 }
  }
  const clock = {
    now: () => now,
    setInterval(callback) { interval = callback; return 1 },
    clearInterval() { interval = null }
  }
  const tracker = createLocationTracker(api, state => changes.push(state), clock)
  return {
    api, tracker, requests, subscriptions, calls,
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
  assert.equal(view.latitudeNumber, '--')
  assert.equal(view.longitudeNumber, '--')
  assert.equal(view.latitudeDirection, '纬度')
  assert.equal(view.longitudeDirection, '经度')
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
  assert.equal(view.latitudeNumber, '31.230416')
})

test('zero coordinates and below-sea-level altitude are valid', () => {
  const fix = normalizeLocation({ latitude: 0, longitude: 0, speed: 0, altitude: -10 })
  const view = locationView({ phase: 'live', fix, updatedAt: 0 }, 0, 0)
  assert.equal(view.speed, '0')
  assert.equal(view.altitude, '-10.0')
  assert.equal(view.latitudeNumber, '0.000000')
  assert.equal(view.latitudeDirection, '北纬 N')
  assert.equal(view.longitudeDirection, '东经 E')
})

test('formats units and hemispheres without mutating the speed sample', () => {
  const state = { phase: 'live', fix: normalizeLocation(sample), updatedAt: 0 }
  assert.equal(locationView(state, 0, 0).speed, '36')
  assert.equal(locationView(state, 1, 0).speed, '10.0')
  assert.equal(locationView(state, 2, 0).speed, '22')
  assert.equal(locationView(state, 0, 0).speed, '36')
  const southern = locationView({ ...state, fix: normalizeLocation({ ...sample, latitude: -31.230416, longitude: -121.473701 }) }, 0, 0)
  assert.equal(southern.latitudeNumber, '31.230416')
  assert.equal(southern.latitudeDirection, '南纬 S')
  assert.equal(southern.longitudeNumber, '121.473701')
  assert.equal(southern.longitudeDirection, '西经 W')
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
  assert.equal(view.detailNote, '5 秒前更新')
  assert.equal(view.latitudeNumber, '31.230416')
  assert.equal(locationView(state, 0, STALE_AFTER).latitudeNumber, '--')
})

test('paused and failed states hide old measurements', () => {
  for (const phase of ['paused', 'error', 'denied', 'unsupported']) {
    const view = locationView({ phase, fix: normalizeLocation(sample), updatedAt: 0 }, 0, 1)
    assert.equal(view.speed, '--')
    assert.equal(view.latitudeNumber, '--')
    assert.equal(view.altitude, '--')
  }
})

test('starts continuous subscription immediately once, without requesting a single fix', () => {
  const h = harness(); h.tracker.start(); h.tracker.start()
  assert.equal(h.requests.length, 0); assert.equal(h.subscriptions.length, 1)
  assert.deepEqual(h.calls, ['subscribe'])
  h.subscriptions[0].callback({ speed: '10' })
  assert.equal(h.state.phase, 'live'); assert.equal(h.view().speed, '36')
})

test('pause clears the timer, unsubscribes and ignores callbacks', () => {
  const h = harness(); h.tracker.start()
  const stream = h.subscriptions[0]; stream.callback(sample)
  h.tracker.stop()
  assert.equal(h.running, false); assert.equal(h.unsubscribes, 1)
  assert.equal(h.view().speed, '--')
  stream.callback({ ...sample, speed: 40 }); stream.fail('denied', 400)
  assert.equal(h.state.phase, 'paused')
  h.tracker.stop(); assert.equal(h.unsubscribes, 1)
})

test('callbacks from a previous subscription cannot corrupt a resumed session', () => {
  const h = harness(); h.tracker.start()
  const previous = h.subscriptions[0]; h.tracker.retry()
  previous.callback(sample); previous.fail('denied', 400)
  assert.equal(h.state.phase, 'locating')
  h.subscriptions[1].callback(sample); assert.equal(h.state.phase, 'live')
})

test('synchronous native errors and an absent subscription API stop tracking safely', () => {
  for (const absent of [true, false]) {
    const h = harness()
    h.api.subscribe = absent ? undefined : options => options.fail('unsupported', 203)
    h.tracker.start()
    assert.equal(h.state.phase, 'unsupported'); assert.equal(h.tracker.isListening(), false)
    assert.equal(h.running, false); assert.equal(h.requests.length, 0)
  }
})

test('a long first fix wait and stale readings keep the same subscription active', () => {
  const h = harness(); h.tracker.start(); h.advance(60000)
  assert.equal(h.state.phase, 'timeout'); assert.equal(h.tracker.isListening(), true)
  h.advance(600000)
  assert.equal(h.requests.length, 0); assert.equal(h.subscriptions.length, 1); assert.equal(h.unsubscribes, 0)
  h.subscriptions[0].callback(sample); h.advance(5000)
  assert.equal(h.state.phase, 'stale'); assert.equal(h.view().speed, '0')
  h.advance(60000)
  assert.equal(h.requests.length, 0); assert.equal(h.unsubscribes, 0)
  h.subscriptions[0].callback({ ...sample, speed: 20 })
  assert.equal(h.state.phase, 'live'); assert.equal(h.view().speed, '72')
})

test('manual refresh replaces the subscription without stopping GPS or freshening old measurements', () => {
  const h = harness(); h.tracker.start(); h.subscriptions[0].callback(sample)
  h.advance(1000); const timestamp = h.state.updatedAt
  h.tracker.refresh()
  assert.equal(h.subscriptions.length, 2); assert.equal(h.unsubscribes, 0)
  assert.equal(h.state.updatedAt, timestamp); assert.equal(h.view().speed, '36')
  h.subscriptions[0].callback({ ...sample, speed: 99 }); h.subscriptions[0].fail('denied', 400)
  assert.equal(h.view().speed, '36'); assert.equal(h.tracker.isListening(), true)
  h.advance(5000); assert.equal(h.view().speed, '0')
  h.subscriptions[1].callback({ ...sample, altitude: 20.25, speed: 5 })
  assert.equal(h.view().speed, '18'); assert.equal(h.view().altitude, '20.3')
  assert.equal(h.requests.length, 0)
  h.tracker.stop(); h.tracker.refresh(); assert.equal(h.subscriptions.length, 2)
})

test('invalid callbacks cannot keep an old speed alive', () => {
  const h = harness(); h.tracker.start(); h.subscriptions[0].callback(sample)
  h.advance(4000); h.subscriptions[0].callback({ speed: NaN }); h.advance(1000)
  assert.equal(h.view().speed, '0')
})

for (const [code, phase] of [[203, 'unsupported'], [201, 'denied'], [207, 'denied'], [400, 'denied'], [402, 'denied']]) {
  test('subscription error ' + code + ' is visible and stops tracking', () => {
    const h = harness(); h.tracker.start(); h.subscriptions[0].fail('failed', code)
    assert.equal(h.state.phase, phase); assert.equal(h.running, false)
    assert.equal(h.unsubscribes, 1); assert.equal(h.requests.length, 0)
  })
}

test('layouts follow screen shape and aspect ratio instead of a model list', () => {
  assert.equal(screenLayout({ screenWidth: 466, screenHeight: 466, screenShape: 'circle' }).pageClass, 'round-page')
  assert.equal(screenLayout({ screenWidth: 432, screenHeight: 514, screenShape: 'rect' }).pageClass, 'rect-page')
  assert.equal(screenLayout({ screenWidth: 336, screenHeight: 480, screenShape: 'rect' }).pageClass, 'rect-page')
  assert.equal(screenLayout({ screenWidth: 212, screenHeight: 520, screenShape: 'pill-shaped' }).narrow, true)
  assert.equal(screenLayout(null).pageClass, 'round-page')
})

test('dashboard fits watch screens and keeps narrow scrolling rows and long speeds readable', () => {
  for (const info of [
    { screenWidth: 466, screenHeight: 466, screenShape: 'circle' },
    { screenWidth: 432, screenHeight: 514, screenShape: 'rect' },
    { screenWidth: 212, screenHeight: 520, screenShape: 'pill-shaped' }
  ]) {
    const layout = screenLayout(info)
    const rows = dashboardLayout(layout, '1234.5')
    const occupied = rows.speedHeight + rows.unitHeight + rows.metricsHeight + rows.summaryHeight
    const reserved = layout.narrow ? 254 : (layout.pageClass === 'rect-page' ? 80 : 88)
    if (layout.narrow) {
      // Bands scroll the list while leaving its header and action buttons visible.
      assert.ok(Math.max(rows.speedHeight, rows.unitHeight, rows.metricsHeight, rows.summaryHeight) <= layout.height - reserved)
    } else assert.ok(occupied + reserved <= layout.height + 0.001, 'content fits ' + layout.pageClass)
    assert.ok(rows.speedFont > 0 && rows.speedFont < rows.speedHeight)
    assert.ok(rows.speedFont * 6 * 0.65 <= (layout.pageClass === 'round-page' ? 192 : 208))
  }
})

test('watch-visible diagnostics distinguish a silent stream, rejected data and native errors', () => {
  const h = harness(); h.tracker.start(); h.advance(59000)
  assert.match(h.view().gpsSubscription, /等待回调/)
  assert.match(h.view().gpsCallbacks, /订阅回调 0 次/)
  assert.equal(h.view().gpsError, '')
  h.subscriptions[0].callback({ speed: 'invalid' })
  assert.match(h.view().gpsCallbacks, /订阅回调 1 次 · 无效 1 次/)
  assert.equal(h.state.updatedAt, null)
  h.subscriptions[0].callback(sample)
  assert.equal(h.view().speed, '36'); assert.match(h.view().gpsSubscription, /已回调/)
  assert.match(h.view().gpsCallbacks, /订阅回调 2 次 · 无效 1 次/)
  h.subscriptions[0].fail('unsupported', 203)
  assert.match(h.view().gpsError, /订阅错误 203/); assert.match(h.view().gpsSubscription, /失败/)
  assert.equal(h.tracker.isListening(), false)
})

test('altitude is updated exclusively from subscription callbacks, including sub-meter changes', () => {
  const h = harness(); h.tracker.start(); h.subscriptions[0].callback(sample)
  h.advance(15000)
  h.subscriptions[0].callback({ ...sample, altitude: 12.85, speed: 5 })
  assert.equal(h.view().altitude, '12.8'); assert.equal(h.view().speed, '18')
  assert.match(h.view().gpsAltitude, /海拔回传 2 次 · 变化 1 次/)
  h.advance(15000)
  h.subscriptions[0].callback({ ...sample, altitude: null })
  assert.equal(h.view().altitude, '--', 'missing altitude is never filled from an older sample')
  assert.equal(h.requests.length, 0)
})
