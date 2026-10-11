// Follow WristSpeed's measurement pipeline: m/s -> km/h, a 0.5 km/h stop
// threshold, one decimal of precision internally, and an integer main reading.
export const STOP_THRESHOLD_KMH = 0.5
export const SPEED_STALE_AFTER = 5000
export const STALE_AFTER = 15000
export const INITIAL_TIMEOUT = 60000
export const UNITS = [
  { label: 'km/h', factor: 1 },
  { label: 'm/s', factor: 1 / 3.6 },
  { label: 'mph', factor: 1 / 1.609344 }
]

function finiteNumber(value) {
  return typeof value === 'number' && isFinite(value)
}

export function normalizeSpeed(value) {
  // Numeric strings occur on some firmware. Missing fields are not zero speed.
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && value.trim() === '') return null
  const metersPerSecond = Number(value)
  if (!isFinite(metersPerSecond) || metersPerSecond < 0) return null
  const kmh = metersPerSecond * 3.6
  if (!isFinite(kmh)) return null
  return kmh < STOP_THRESHOLD_KMH ? 0 : Math.round(kmh * 10) / 10
}

export function formatCurrentSpeed(kmh, unitIndex) {
  if (!finiteNumber(kmh) || kmh < 0) return '--'
  const index = unitIndex || 0
  const unit = UNITS[index] || UNITS[0]
  const value = kmh * unit.factor
  return index === 1 ? value.toFixed(1) : String(Math.round(value))
}

export function normalizeLocation(data) {
  if (!data || typeof data !== 'object') return null
  // Speed must not depend on the availability of latitude, longitude or altitude.
  const horizontal = data.accuracyInfo && data.accuracyInfo.horizontal
  const fix = {
    latitude: finiteNumber(data.latitude) && Math.abs(data.latitude) <= 90 ? data.latitude : null,
    longitude: finiteNumber(data.longitude) && Math.abs(data.longitude) <= 180 ? data.longitude : null,
    altitude: finiteNumber(data.altitude) ? data.altitude : null,
    speed: normalizeSpeed(data.speed),
    accuracy: finiteNumber(horizontal) && horizontal > 0 ? horizontal :
      (finiteNumber(data.accuracy) && data.accuracy > 0 ? data.accuracy : null)
  }
  return fix.speed !== null || fix.latitude !== null || fix.longitude !== null || fix.altitude !== null ? fix : null
}

function coordinateView(value, latitude) {
  return {
    number: finiteNumber(value) ? Math.abs(value).toFixed(6) : '--',
    direction: !finiteNumber(value) ? (latitude ? '纬度' : '经度') :
      (latitude ? (value < 0 ? '南纬 S' : '北纬 N') : (value < 0 ? '西经 W' : '东经 E'))
  }
}

export function locationView(state, unitIndex, now) {
  const unit = UNITS[unitIndex] || UNITS[0]
  const tracking = state.phase === 'live' || state.phase === 'stale'
  const ageMs = state.updatedAt === null ? null : Math.max(0, now - state.updatedAt)
  const fresh = tracking && state.fix && ageMs < STALE_AFTER
  const fix = fresh ? state.fix : null
  // Like WristSpeed, reset a previously valid speed after five seconds. Mark the
  // reading as awaiting updates, so this zero is not presented as a fresh fix.
  const speed = tracking && state.fix && state.fix.speed !== null ?
    formatCurrentSpeed(ageMs >= SPEED_STALE_AFTER ? 0 : state.fix.speed, unitIndex) : '--'
  const speedStale = tracking && ageMs >= SPEED_STALE_AFTER
  const latitude = coordinateView(fix && fix.latitude, true)
  const longitude = coordinateView(fix && fix.longitude, false)
  return {
    speed,
    unit: unit.label,
    altitude: fix && fix.altitude !== null ? fix.altitude.toFixed(0) : '--',
    latitudeNumber: latitude.number, latitudeDirection: latitude.direction,
    longitudeNumber: longitude.number, longitudeDirection: longitude.direction,
    accuracy: fix && fix.accuracy !== null ? '±' + Math.round(fix.accuracy) + ' m' : '--',
    detailNote: state.updatedAt === null ? '尚未获取位置' : (fresh ? Math.floor(ageMs / 1000) + ' 秒前更新' : '等待新的位置'),
    tone: fresh && !speedStale ? (fix.accuracy !== null && fix.accuracy > 50 ? 'warning' : 'good') :
      (state.phase === 'paused' ? 'muted' : 'warning')
  }
}

// Use the reference app's one initial snapshot plus continuous subscription.
// The tick updates freshness only; it never replaces the subscription with polling.
export function createLocationTracker(api, onChange, clock) {
  const time = clock || { now: () => Date.now(), setInterval, clearInterval }
  let state = { phase: 'idle', fix: null, updatedAt: null }
  let active = false
  let generation = 0
  let timer = null
  let subscribed = false
  let revision = 0
  let startedAt = 0

  function emit() { onChange({ ...state }) }

  function cleanup() {
    active = false
    generation += 1
    if (timer !== null) time.clearInterval(timer)
    timer = null
    if (subscribed) {
      subscribed = false
      try { api.unsubscribe() } catch (error) { /* Firmware may already have stopped. */ }
    }
  }

  function fail(code, terminal) {
    code = Number(code)
    if (!terminal && state.fix) return
    if (terminal) cleanup()
    let phase = 'error'
    if (code === 203) phase = 'unsupported'
    if (code === 204) phase = terminal ? 'error' : 'timeout'
    if ([201, 207, 400, 402].indexOf(code) >= 0) phase = 'denied'
    if (!terminal && subscribed && phase !== 'timeout' && phase !== 'denied') {
      phase = 'locating'
    }
    state = { ...state, phase }
    emit()
  }

  function accept(data) {
    const fix = normalizeLocation(data)
    // Invalid callbacks must not extend the lifetime of an old speed reading.
    if (!fix) return
    revision += 1
    state = { phase: 'live', fix, updatedAt: time.now() }
    emit()
  }

  function tick() {
    if (!active) return
    const age = state.updatedAt === null ? null : time.now() - state.updatedAt
    if (age !== null && age >= SPEED_STALE_AFTER && state.phase === 'live') {
      state = { ...state, phase: 'stale' }
    } else if (state.phase === 'locating' && time.now() - startedAt >= INITIAL_TIMEOUT) {
      state = { ...state, phase: 'timeout' }
    } else return
    // Session's clock refreshes the visible values; notify only on state changes.
    emit()
  }

  return {
    isListening() { return active && subscribed },
    start() {
      if (active) return
      active = true
      generation += 1
      revision = 0
      startedAt = time.now()
      const token = generation
      const current = () => active && token === generation
      state = { phase: 'locating', fix: null, updatedAt: null }
      emit()
      timer = time.setInterval(tick, 1000)
      // Establish the long-lived background feature before requesting a snapshot.
      // Neither waits for a fix; a late snapshot cannot overwrite the stream.
      if (typeof api.subscribe !== 'function') { fail(203, true); return }
      subscribed = true
      try {
        api.subscribe({
          callback(data) { if (current() && subscribed) accept(data) },
          fail(data, code) { if (current()) fail(code, true) }
        })
      } catch (error) {
        if (current()) fail(-1, true)
      }
      if (!current()) return
      try {
        api.getLocation({
          timeout: INITIAL_TIMEOUT,
          success(data) { if (current() && revision === 0) accept(data) },
          fail(data, code) { if (current()) fail(code, false) }
        })
      } catch (error) {
        if (current()) fail(typeof api.getLocation === 'function' ? -1 : 203, false)
      }
    },
    stop() {
      cleanup()
      state = { ...state, phase: 'paused' }
      emit()
    },
    retry() {
      cleanup()
      this.start()
    }
  }
}
