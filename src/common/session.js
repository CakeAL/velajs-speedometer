import { createLocationTracker, locationView, UNITS, SPEED_STALE_AFTER } from './location'
import { createRecorder } from './recording'
import { emptyStats, addSpeed, statsView } from './statistics'

const STATUS = {
  idle: '等待定位', locating: 'GPS 搜星中', live: 'GPS 已定位', stale: '等待 GPS 更新',
  paused: '定位已暂停', timeout: '搜星较久 · 继续等待', denied: '请允许定位权限',
  unsupported: 'GPS 接口不可用', error: '失败 · 自动重试'
}

const SCREEN_HOLD_MS = 10000

export function createSession(deps, clock) {
  const time = clock || { now: () => Date.now(), setInterval, clearInterval, setTimeout, clearTimeout }
  let state = { phase: 'idle', fix: null, updatedAt: null }
  let stats = emptyStats()
  let unitIndex = 0
  let listeners = []
  let foreground = true
  let trackingRequested = false
  let tickTimer = null
  let retryTimer = null
  let screenTimer = null
  let lastSecond = null
  let disposed = false
  let record = { recording: false, saving: false, points: 0, startedAt: null, message: '' }

  function view() {
    const now = time.now()
    const readings = locationView(state, unitIndex, now)
    const elapsed = record.startedAt === null ? 0 : Math.floor((now - record.startedAt) / 1000)
    const duration = Math.floor(elapsed / 60) + ':' + ('0' + elapsed % 60).slice(-2)
    return { ...readings, ...statsView(stats, UNITS[unitIndex].factor),
      statusText: STATUS[state.phase] || STATUS.error,
      statusColor: readings.tone === 'good' ? '#7ef7c5' : '#f2bf68',
      recording: record.recording, saving: record.saving,
      recordText: record.saving ? '保存中' : (record.recording ? '结束' : '记录'),
      recordDuration: duration, recordPoints: record.points,
      recordNotice: record.recording ? '' : record.message }
  }
  function emit() {
    if (!foreground) return
    const current = view(); listeners.slice().forEach(listener => listener(current))
  }
  function keepScreenOn(enabled) {
    try { deps.brightness.setKeepScreenOn({ keepScreenOn: enabled, fail() {} }) } catch (error) { /* Optional on older firmware. */ }
  }
  function releaseScreen() {
    if (screenTimer !== null) time.clearTimeout(screenTimer)
    screenTimer = null
    keepScreenOn(false)
  }
  function holdScreenBriefly() {
    if (screenTimer !== null) time.clearTimeout(screenTimer)
    keepScreenOn(true)
    screenTimer = time.setTimeout(() => {
      screenTimer = null
      keepScreenOn(false)
    }, SCREEN_HOLD_MS)
  }
  function enterForeground() {
    // A new opening starts fresh; returning to an active recording continues it.
    // Page navigation never hides the app, so it cannot reset these statistics.
    if (!foreground && !record.recording && !record.saving) {
      stats = emptyStats()
      lastSecond = null
    }
    foreground = true
  }
  const recorder = createRecorder(deps.file, next => {
    record = next; emit()
  })
  function wanted() {
    // GPS belongs to the app, not to a visible page or an active GPX recording.
    return !disposed && trackingRequested
  }
  function clearRetry() { if (retryTimer !== null) time.clearTimeout(retryTimer); retryTimer = null }
  function scheduleRetry() {
    // A pending fix or a quiet stream is not a failed subscription. Unsubscribing
    // here can interrupt a cold start; only restart after a native stream error.
    if (retryTimer !== null || !wanted() || tracker.isListening()) return
    const delay = state.phase === 'denied' || state.phase === 'unsupported' ? 15000 : 5000
    retryTimer = time.setTimeout(() => { retryTimer = null; if (wanted()) tracker.retry() }, delay)
  }
  const tracker = createLocationTracker(deps.geolocation, next => {
    state = next
    if (next.phase === 'live') {
      clearRetry()
      if (next.fix.speed !== null) stats.max = Math.max(stats.max, next.fix.speed)
    } else if (['error', 'timeout', 'denied', 'unsupported'].indexOf(next.phase) >= 0) scheduleRetry()
    emit()
  }, time)
  function tick() {
    const now = time.now()
    const second = Math.floor(now / 1000)
    const fresh = state.fix && state.updatedAt !== null && now - state.updatedAt < SPEED_STALE_AFTER &&
      (state.phase === 'live' || state.phase === 'stale')
    if (second !== lastSecond) {
      lastSecond = second
      if (fresh) stats = addSpeed(stats, state.fix.speed)
      recorder.sample(state.fix, now, fresh)
    }
    emit()
  }
  function start() {
    if (!wanted()) return
    if (tickTimer === null) tickTimer = time.setInterval(tick, 1000)
    tracker.start()
  }
  function stop() {
    clearRetry()
    if (tickTimer !== null) time.clearInterval(tickTimer)
    tickTimer = null
    releaseScreen()
    tracker.stop()
  }

  return {
    snapshot: view,
    activate() {
      if (disposed) return
      trackingRequested = true
      // Called from app.onCreate so Vela owns the native subscription at app scope.
      start()
    },
    acquire(listener) {
      if (disposed) return
      const visibleAgain = !foreground || listeners.length === 0
      enterForeground()
      if (listeners.indexOf(listener) < 0) listeners.push(listener)
      listener(view())
      if (visibleAgain) holdScreenBriefly()
    },
    release(listener) {
      listeners = listeners.filter(item => item !== listener)
    },
    changeUnit() { unitIndex = (unitIndex + 1) % UNITS.length; emit() },
    async toggleRecording() {
      if (record.saving) return
      if (record.recording) return recorder.finish()
      await recorder.start(time.now())
    },
    activeUri() {
      const current = recorder.snapshot()
      return current.recording || current.saving ? current.uri : null
    },
    resume() {
      if (disposed) return
      const visibleAgain = !foreground
      enterForeground()
      if (listeners.length > 0) {
        if (visibleAgain) holdScreenBriefly()
        start(); emit()
      }
    },
    suspend() {
      foreground = false
      releaseScreen()
      // Keep the declared background geolocation feature running even when not
      // recording. Only the display sleeps; fresh fixes stay available on wake.
    },
    async dispose() {
      disposed = true
      trackingRequested = false
      foreground = false
      stop()
      if (record.recording) {
        try { await recorder.finish() } catch (error) { /* Recoverable .part is retained. */ }
      }
      listeners = []
    }
  }
}
