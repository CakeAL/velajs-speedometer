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

export function finiteNumber(value) {
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

export function coordinate(value, latitude, digits) {
  if (!finiteNumber(value)) return '--'
  const direction = latitude ? (value < 0 ? 'S' : 'N') : (value < 0 ? 'W' : 'E')
  return Math.abs(value).toFixed(digits) + '° ' + direction
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
  return {
    speed,
    unit: unit.label,
    altitude: fix && fix.altitude !== null ? fix.altitude.toFixed(0) : '--',
    latitude: coordinate(fix && fix.latitude, true, 5),
    longitude: coordinate(fix && fix.longitude, false, 5),
    latitudeDetail: coordinate(fix && fix.latitude, true, 6),
    longitudeDetail: coordinate(fix && fix.longitude, false, 6),
    accuracy: fix && fix.accuracy !== null ? '±' + Math.round(fix.accuracy) + ' m' : '--',
    age: state.updatedAt === null ? '尚未获取位置' : (fresh ? Math.floor(ageMs / 1000) + ' 秒前更新' : '等待新的位置'),
    hint: speedStale ? '5 秒未更新，速度已归零' : (fresh ? (fix.speed === null ? '设备未返回速度' :
      (fix.accuracy !== null && fix.accuracy > 50 ? '定位精度较低' : '点击单位切换')) : state.message),
    tone: fresh && !speedStale ? (fix.accuracy !== null && fix.accuracy > 50 ? 'warning' : 'good') :
      (state.phase === 'paused' ? 'muted' : 'warning')
  }
}

// Use the reference app's one initial snapshot plus continuous subscription.
// The tick updates freshness only; it never replaces the subscription with polling.
export function createLocationTracker(api, onChange, clock) {
  const time = clock || { now: () => Date.now(), setInterval, clearInterval }
  let state = { phase: 'idle', fix: null, updatedAt: null, message: '等待定位' }
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
    let message = '定位失败，请重试'
    if (code === 203) { phase = 'unsupported'; message = '设备未开放 GPS 定位接口' }
    if (code === 204) { phase = 'timeout'; message = '定位超时，请到开阔处重试' }
    if ([201, 207, 400, 402].indexOf(code) >= 0) { phase = 'denied'; message = '请在设置中允许定位权限' }
    state = { ...state, phase, message }
    emit()
  }

  function accept(data) {
    const fix = normalizeLocation(data)
    if (!fix) {
      // Do not let invalid callbacks extend the lifetime of an old speed reading.
      if (!state.fix) {
        state = { ...state, message: '等待有效的 GPS 数据' }
        emit()
      }
      return
    }
    revision += 1
    state = { phase: 'live', fix, updatedAt: time.now(), message: '' }
    emit()
  }

  function tick() {
    if (!active) return
    const age = state.updatedAt === null ? null : time.now() - state.updatedAt
    if (age !== null && age >= SPEED_STALE_AFTER && state.phase === 'live') {
      state = { ...state, phase: 'stale', message: '等待新的 GPS 数据' }
    } else if (state.phase === 'locating' && time.now() - startedAt >= INITIAL_TIMEOUT) {
      state = { ...state, phase: 'timeout', message: '定位超时，请到开阔处重试' }
    }
    emit()
  }

  return {
    start() {
      if (active) return
      active = true
      generation += 1
      revision = 0
      startedAt = time.now()
      const token = generation
      const current = () => active && token === generation
      state = { phase: 'locating', fix: null, updatedAt: null, message: '请在室外等待 GPS 定位' }
      emit()
      timer = time.setInterval(tick, 1000)
      // Start both immediately, as the reference does. Neither waits for the
      // other; a late snapshot must not overwrite a newer subscription fix.
      try {
        api.getLocation({
          timeout: INITIAL_TIMEOUT,
          success(data) { if (current() && revision === 0) accept(data) },
          fail(data, code) { if (current()) fail(code, false) }
        })
      } catch (error) {
        if (current()) fail(typeof api.getLocation === 'function' ? -1 : 203, false)
      }
      if (!current()) return
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
    },
    stop() {
      cleanup()
      state = { ...state, phase: 'paused', message: '定位已暂停' }
      emit()
    },
    retry() {
      cleanup()
      this.start()
    }
  }
}
