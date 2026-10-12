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
  const diagnostics = state.diagnostics
  return {
    speed,
    unit: unit.label,
    altitude: fix && fix.altitude !== null ? fix.altitude.toFixed(1) : '--',
    latitudeNumber: latitude.number, latitudeDirection: latitude.direction,
    longitudeNumber: longitude.number, longitudeDirection: longitude.direction,
    accuracy: fix && fix.accuracy !== null ? '±' + Math.round(fix.accuracy) + ' m' : '--',
    detailNote: state.updatedAt === null ? '尚未获取位置' : (fresh ? Math.floor(ageMs / 1000) + ' 秒前更新' : '等待新的位置'),
    gpsRequest: diagnostics ? '单次定位：' + diagnostics.snapshot : '单次定位：未启动',
    gpsCallbacks: diagnostics ? '订阅回调 ' + diagnostics.stream + ' 次 · 无效 ' + diagnostics.invalid + ' 次' : '订阅尚未启动',
    gpsError: diagnostics && diagnostics.error ? diagnostics.error : '',
    gpsAltitude: diagnostics ? '海拔回传 ' + diagnostics.altitudeSamples + ' 次 · 变化 ' + diagnostics.altitudeChanges + ' 次' : '尚未收到海拔',
    tone: fresh && !speedStale ? (fix.accuracy !== null && fix.accuracy > 50 ? 'warning' : 'good') :
      (state.phase === 'paused' ? 'muted' : 'warning')
  }
}

// Keep the stream active in background. Supplemental foreground snapshots can
// refresh fields that some firmware only updates in getLocation(), such as height.
export function createLocationTracker(api, onChange, clock, options = {}) {
  const time = clock || { now: () => Date.now(), setInterval, clearInterval }
  let state = { phase: 'idle', fix: null, updatedAt: null }
  let active = false
  let foreground = true
  let generation = 0
  let streamGeneration = 0
  let timer = null
  let subscribed = false
  let revision = 0
  let startedAt = 0
  let requestId = 0
  let pendingSnapshot = false
  let snapshotDeadline = 0
  let lastSnapshotAt = 0
  let lastAltitude = null
  let diagnostics = { snapshot: '未启动', stream: 0, invalid: 0, error: '', altitudeSamples: 0, altitudeChanges: 0 }

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
    pendingSnapshot = false
    if (timer !== null) time.clearInterval(timer)
    timer = null
    if (subscribed) {
      subscribed = false
      try { api.unsubscribe() } catch (error) { /* Firmware may already have stopped. */ }
    }
  }
  function fail(code, terminal, data) {
    code = Number(code)
    diagnostics.error = (terminal ? '订阅' : '单次定位') + '错误 ' + (isFinite(code) ? code : '未知') +
      (typeof data === 'string' && data ? ' · ' + data.slice(0, 80) : '')
    if (!terminal) diagnostics.snapshot = code === 204 ? '超时 (204)' : '失败'
    if (!terminal && state.fix) { emit(); return }
    if (terminal) cleanup()
    let phase = 'error'
    if (code === 203) phase = 'unsupported'
    if (code === 204) phase = terminal ? 'error' : 'timeout'
    if ([201, 207, 400, 402].indexOf(code) >= 0) phase = 'denied'
    if (!terminal && phase !== 'timeout' && phase !== 'denied') phase = 'locating'
    state = { ...state, phase }
    emit()
  }
  function accept(data) {
    const fix = normalizeLocation(data)
    // Invalid callbacks must not extend the lifetime of an old speed reading.
    if (!fix) { diagnostics.invalid += 1; emit(); return }
    observeAltitude(fix.altitude)
    revision += 1
    state = { phase: 'live', fix, updatedAt: time.now() }
    emit()
  }
  function attachStream() {
    if (!active) return
    if (typeof api.subscribe !== 'function') { fail(203, true); return }
    const token = generation
    const stream = ++streamGeneration
    const current = () => active && token === generation && stream === streamGeneration
    subscribed = true
    try {
      api.subscribe({
        callback(data) {
          if (!current() || !subscribed) return
          diagnostics.stream += 1
          accept(data)
        },
        fail(data, code) { if (current()) fail(code, true, data) }
      })
    } catch (error) { if (current()) fail(-1, true, error.message) }
  }
  function finishSnapshot() {
    pendingSnapshot = false
    // A one-shot request may complete after screen-off. Reassert the app-owned
    // stream after that completion, without unsubscribe() or stopping the GNSS.
    if (active && !foreground && subscribed) attachStream()
  }
  function requestSnapshot(timeout = 10000) {
    if (!active || !foreground || pendingSnapshot) return
    const token = generation
    const id = ++requestId
    const atRevision = revision
    const altitudeAtRequest = state.fix && state.fix.altitude
    const current = () => active && token === generation && id === requestId && pendingSnapshot
    pendingSnapshot = true
    lastSnapshotAt = time.now()
    snapshotDeadline = lastSnapshotAt + timeout
    diagnostics.snapshot = '等待返回'
    emit()
    try {
      api.getLocation({
        timeout,
        success(data) {
          if (!current()) return
          diagnostics.snapshot = '已返回'
          if (revision === atRevision) accept(data)
          else {
            const fix = normalizeLocation(data)
            // Never overwrite newer speed/coordinates or revive stale samples.
            // A supplement can update height if the stream hasn't changed it.
            if (fix && fix.altitude !== null && state.fix && state.fix.altitude === altitudeAtRequest &&
                time.now() - state.updatedAt < SPEED_STALE_AFTER) {
              observeAltitude(fix.altitude)
              state = { ...state, fix: { ...state.fix, altitude: fix.altitude } }
            }
            emit()
          }
          finishSnapshot()
        },
        fail(data, code) {
          if (!current()) return
          fail(code, false, data)
          finishSnapshot()
        }
      })
    } catch (error) {
      if (current()) { fail(typeof api.getLocation === 'function' ? -1 : 203, false, error.message); finishSnapshot() }
    }
  }
  function tick() {
    if (!active) return
    const now = time.now()
    if (pendingSnapshot && now >= snapshotDeadline) {
      requestId += 1
      fail(204, false, '未收到结束回调')
      finishSnapshot()
    }
    const age = state.updatedAt === null ? null : now - state.updatedAt
    if (age !== null && age >= SPEED_STALE_AFTER && state.phase === 'live') {
      state = { ...state, phase: 'stale' }; emit()
    } else if (state.phase === 'locating' && now - startedAt >= INITIAL_TIMEOUT) {
      state = { ...state, phase: 'timeout' }; emit()
    }
    if (options.refreshInterval && foreground && subscribed && state.fix &&
        now - lastSnapshotAt >= options.refreshInterval) requestSnapshot()
  }
  function start() {
    if (active) return
    active = true
    generation += 1
    revision = 0
    startedAt = time.now()
    lastSnapshotAt = startedAt
    diagnostics.snapshot = options.initialSnapshot === false ? '等待前台补充刷新' : '未启动'
    diagnostics.error = ''
    state = { phase: 'locating', fix: null, updatedAt: null }
    emit()
    timer = time.setInterval(tick, 1000)
    // Production sessions start with subscribe only; no one-shot request can
    // complete later and interfere with the initial background feature binding.
    if (options.initialSnapshot !== false) requestSnapshot(INITIAL_TIMEOUT)
    attachStream()
  }
  return {
    isListening() { return active && subscribed },
    start,
    refresh: requestSnapshot,
    setForeground(value) { foreground = value },
    stop() { cleanup(); state = { ...state, phase: 'paused' }; emit() },
    retry() { cleanup(); start() }
  }
}
