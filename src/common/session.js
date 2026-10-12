import { createLocationTracker, locationView, UNITS, SPEED_STALE_AFTER } from './location'
import { createRecorder } from './recording'
import { emptyStats, addSpeed, statsView } from './statistics'

const STATUS = {
  idle: '等待定位', locating: 'GPS 搜星中', live: 'GPS 已定位', stale: '等待 GPS 更新',
  paused: '定位已暂停', timeout: '搜星较久 · 继续等待', denied: '请允许定位权限',
  unsupported: 'GPS 接口不可用', error: '失败 · 自动重试'
}

const SCREEN_HOLD_MS = 10000
const SCREEN_MODES = ['记录时常亮', '始终常亮', '10 秒自动熄屏']

export function createSession(deps, clock) {
  const time = clock || { now: () => Date.now(), setInterval, clearInterval, setTimeout, clearTimeout }
  let state = { phase: 'idle', fix: null, updatedAt: null }
  let stats = emptyStats()
  let unitIndex = 0
  let listeners = []
  let foreground = true
  let screenMode = 0
  let screenCovered = false
  let screenError = ''
  let trackingRequested = false
  let tickTimer = null
  let retryTimer = null
  let recoveringInBackground = false
  let lastBackgroundRetry = -Infinity
  let lastRuntimeNote = 0
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
      screenModeText: SCREEN_MODES[screenMode], screenError, screenCovered,
      recordText: record.saving ? '保存中' : (record.recording ? '结束' : '记录'),
      recordDuration: duration, recordPoints: record.points,
      recordNotice: record.recording ? '' : record.message }
  }
  function emit() {
    if (!foreground) return
    const current = view()
    listeners.slice().forEach(listener => {
      try { listener(current) } catch (error) { console.error('页面更新失败：' + error.message) }
    })
  }
  function keepScreenOn(enabled) {
    function failed(data, code) {
      if (disposed) return
      screenError = '常亮设置失败' + (code === undefined ? '' : ' (' + code + ')')
      emit()
    }
    try { deps.brightness.setKeepScreenOn({ keepScreenOn: enabled,
      success() { if (!disposed && screenError) { screenError = ''; emit() } }, fail: failed }) }
    catch (error) { failed() }
  }
  function releaseScreen() {
    if (screenTimer !== null) time.clearTimeout(screenTimer)
    screenTimer = null
    screenCovered = false
    keepScreenOn(false)
  }
  function holdScreenBriefly() {
    if (screenTimer !== null) time.clearTimeout(screenTimer)
    screenTimer = null
    if (!foreground || disposed) { keepScreenOn(false); return }
    screenCovered = false
    keepScreenOn(true)
    if (screenMode === 1 || (screenMode === 0 && (record.recording || record.saving))) return
    screenTimer = time.setTimeout(() => {
      screenTimer = null
      if (!foreground || disposed || screenError) return
      // Keep the native screen awake. This is an in-app overlay, so GPS,
      // recording and statistics continue in the same foreground session.
      screenCovered = true
      emit()
    }, SCREEN_HOLD_MS)
  }
  function enterForeground() {
    // Only creating a new session resets statistics. Sleep and page navigation
    // do not end this app session, regardless of whether GPX is recording.
    foreground = true
  }
  const recorder = createRecorder(deps.file, next => {
    const changed = record.recording !== next.recording || record.saving !== next.saving
    record = next; emit()
    if (changed && foreground && !disposed) holdScreenBriefly()
  })
  function noteRuntime(kind) {
    const diagnostics = state.diagnostics || {}
    const code = /错误 (-?\d+)/.exec(diagnostics.error || '')
    recorder.noteEvent(kind, time.now(), { gps: diagnostics.stream || 0, phase: state.phase,
      code: code ? Number(code[1]) : null })
  }
  function wanted() {
    // GPS belongs to the app, not to a visible page or an active GPX recording.
    return !disposed && trackingRequested
  }
  function clearRetry() { if (retryTimer !== null) time.clearTimeout(retryTimer); retryTimer = null }
  function scheduleRetry() {
    // A pending fix or a quiet stream is not a failed subscription. Unsubscribing
    // here can interrupt a cold start; only restart after a native stream error.
    if (retryTimer !== null || !wanted() || tracker.isListening()) return
    // Once the last native background feature stops, Vela may suspend JS before
    // a delayed timer can run. Restore one ordinary stream error immediately.
    // Bound synchronous failures to one attempt instead of recursive retrying.
    if (!foreground && state.phase === 'error' && !recoveringInBackground && time.now() - lastBackgroundRetry >= 5000) {
      lastBackgroundRetry = time.now(); recoveringInBackground = true
      noteRuntime('retry')
      try { tracker.retry() } finally { recoveringInBackground = false }
      if (tracker.isListening() || retryTimer !== null) return
    }
    const delay = state.phase === 'denied' || state.phase === 'unsupported' ? 15000 : 5000
    retryTimer = time.setTimeout(() => {
      retryTimer = null
      if (wanted() && !tracker.isListening()) tracker.retry()
    }, delay)
  }
  const tracker = createLocationTracker(deps.geolocation, next => {
    const previous = state
    state = next
    if (['error', 'denied', 'unsupported'].indexOf(next.phase) >= 0 &&
        (previous.phase !== next.phase || (previous.diagnostics || {}).error !== next.diagnostics.error)) noteRuntime('gpsfail')
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
      if (record.recording && !foreground && now - lastRuntimeNote >= 60000) {
        lastRuntimeNote = now; noteRuntime('tick')
      }
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
      // Called from app.onShow: the app is visible and can request permission.
      // Later foreground entries keep the same app-owned native subscription.
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
    changeScreenMode() {
      if (disposed) return
      screenMode = (screenMode + 1) % SCREEN_MODES.length
      holdScreenBriefly(); emit()
    },
    interact() {
      if (!foreground || disposed) return
      holdScreenBriefly(); emit()
    },
    refreshLocation() {
      if (!foreground || !wanted()) return
      if (tracker.isListening()) tracker.refresh()
      else { clearRetry(); tracker.retry() }
    },
    async toggleRecording() {
      if (record.saving) return
      if (record.recording) { noteRuntime('stop'); return recorder.finish() }
      await recorder.start(time.now())
      lastRuntimeNote = time.now(); noteRuntime(foreground ? 'show' : 'hide')
    },
    activeUri() {
      const current = recorder.snapshot()
      return current.recording || current.saving ? current.uri : null
    },
    resume() {
      if (disposed) return
      const visibleAgain = !foreground
      if (visibleAgain) noteRuntime('show')
      enterForeground()
      if (listeners.length > 0) {
        if (visibleAgain) holdScreenBriefly()
        start(); emit()
      }
    },
    suspend() {
      if (foreground) { noteRuntime('hide'); lastRuntimeNote = time.now() }
      foreground = false
      releaseScreen()
      // Keep the declared background geolocation feature running even when not
      // recording. Only the display sleeps; fresh fixes stay available on wake.
    },
    async dispose() {
      noteRuntime('dispose')
      disposed = true
      trackingRequested = false
      foreground = false
      stop()
      if (record.recording) {
        try { await recorder.finish() } catch (error) { /* Recoverable .part is retained. */ }
      }
      listeners = []
    },
    reportError() {
      if (!disposed) noteRuntime('error')
    }
  }
}
