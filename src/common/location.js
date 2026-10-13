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

// The black cover needs only GPS health, without formatting any readings.
export function locationTone(state, now) {
  const tracking = state.phase === 'live' || state.phase === 'stale'
  const ageMs = state.updatedAt === null ? null : Math.max(0, now - state.updatedAt)
  const fresh = tracking && state.fix && ageMs < SPEED_STALE_AFTER
  return fresh ? (state.fix.accuracy !== null && state.fix.accuracy > 50 ? 'warning' : 'good') :
    (state.phase === 'paused' ? 'muted' : 'warning')
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
  const latitude = coordinateView(fix && fix.latitude, true)
  const longitude = coordinateView(fix && fix.longitude, false)
  const diagnostics = state.diagnostics
  return {
    speed,
    unit: unit.label,
    altitude: fix && fix.altitude !== null ? fix.altitude.toFixed(1) : '--',
    latitudeNumber: latitude.number, latitudeDirection: latitude.direction,
    longitudeNumber: longitude.number, longitudeDirection: longitude.direction,
    accuracy: fix && fix.accuracy !== null ? '±' + Math.round(fix.accuracy) + ' m' : '--',
    detailNote: state.updatedAt === null ? '尚未获取位置' : (fresh ? Math.floor(ageMs / 1000) + ' 秒前更新' : '等待新的位置'),
    gpsSubscription: '定位订阅：' + (diagnostics ? diagnostics.subscription : '未启动'),
    gpsCallbacks: diagnostics ? '订阅回调 ' + diagnostics.stream + ' 次 · 无效 ' + diagnostics.invalid + ' 次' : '订阅尚未启动',
    gpsError: diagnostics && diagnostics.error ? diagnostics.error : '',
    gpsAltitude: diagnostics ? '海拔回传 ' + diagnostics.altitudeSamples + ' 次 · 变化 ' + diagnostics.altitudeChanges + ' 次' : '尚未收到海拔',
    tone: locationTone(state, now)
  }
}

// The same continuous subscription supplies every reading in foreground and
// background. A manual refresh replaces its callbacks without unsubscribing.
export function createLocationTracker(api, onChange, clock) {
  const time = clock || { now: () => Date.now(), setInterval, clearInterval }
  let state = { phase: 'idle', fix: null, updatedAt: null }
  let active = false
  let generation = 0
  let streamGeneration = 0
  let timer = null
  let subscribed = false
  let startedAt = 0
  let lastAltitude = null
  let diagnostics = { subscription: '未启动', stream: 0, invalid: 0, error: '', altitudeSamples: 0, altitudeChanges: 0 }

  function emit() { onChange({ ...state, diagnostics: { ...diagnostics } }) }
  function observeAltitude(value) {
    if (value === null) return
    diagnostics.altitudeSamples += 1
    if (lastAltitude !== null && value !== lastAltitude) diagnostics.altitudeChanges += 1
    lastAltitude = value
  }
  function cleanup() {
    active = false
    generation += 1
    if (timer !== null) time.clearInterval(timer)
    timer = null
    diagnostics.subscription = '已停止'
    if (subscribed) {
      subscribed = false
      try { api.unsubscribe() } catch (error) { /* Firmware may already have stopped. */ }
    }
  }
  function fail(code, data) {
    code = Number(code)
    diagnostics.error = '订阅错误 ' + (isFinite(code) ? code : '未知') +
      (typeof data === 'string' && data ? ' · ' + data.slice(0, 80) : '')
    cleanup()
    diagnostics.subscription = '失败'
    let phase = 'error'
    if (code === 203) phase = 'unsupported'
    if ([201, 207, 400, 402].indexOf(code) >= 0) phase = 'denied'
    state = { ...state, phase }
    emit()
  }
  function accept(data) {
    const fix = normalizeLocation(data)
    // Invalid callbacks must not extend the lifetime of an old speed reading.
    if (!fix) { diagnostics.invalid += 1; emit(); return }
    observeAltitude(fix.altitude)
    state = { phase: 'live', fix, updatedAt: time.now() }
    emit()
  }
  function attachStream() {
    if (!active) return
    if (typeof api.subscribe !== 'function') { fail(203); return }
    const token = generation
    const stream = ++streamGeneration
    const current = () => active && token === generation && stream === streamGeneration
    subscribed = true
    diagnostics.subscription = '等待回调'
    diagnostics.error = ''
    try {
      api.subscribe({
        callback(data) {
          if (!current() || !subscribed) return
          diagnostics.subscription = '已回调'
          diagnostics.stream += 1
          accept(data)
        },
        fail(data, code) { if (current()) fail(code, data) }
      })
    } catch (error) { if (current()) fail(-1, error.message) }
    emit()
  }
  function tick() {
    if (!active) return
    const now = time.now()
    const age = state.updatedAt === null ? null : now - state.updatedAt
    if (age !== null && age >= SPEED_STALE_AFTER && state.phase === 'live') {
      state = { ...state, phase: 'stale' }; emit()
    } else if (state.phase === 'locating' && now - startedAt >= INITIAL_TIMEOUT) {
      state = { ...state, phase: 'timeout' }; emit()
    }
  }
  function start() {
    if (active) return
    active = true
    generation += 1
    startedAt = time.now()
    diagnostics.subscription = '等待回调'
    diagnostics.error = ''
    state = { phase: 'locating', fix: null, updatedAt: null }
    emit()
    timer = time.setInterval(tick, 1000)
    attachStream()
  }
  return {
    isListening() { return active && subscribed },
    start,
    refresh() { if (active && subscribed) attachStream() },
    stop() { cleanup(); state = { ...state, phase: 'paused' }; emit() },
    retry() { cleanup(); start() }
  }
}
