import { createLocationTracker, locationView, UNITS, SPEED_STALE_AFTER } from './location'
import { createRecorder } from './recording'
import { emptyStats, restoreStats, addSpeed, mergeStats, statsView } from './statistics'

const STATUS = {
  idle: '等待定位', locating: 'GPS 搜星中', live: 'GPS 已定位', stale: '等待 GPS 更新',
  paused: '定位已暂停', timeout: '超时 · 自动重试', denied: '请允许定位权限',
  unsupported: 'GPS 接口不可用', error: '失败 · 自动重试'
}

export function createSession(deps, clock) {
  const time = clock || { now: () => Date.now(), setInterval, clearInterval, setTimeout, clearTimeout }
  let state = { phase: 'idle', fix: null, updatedAt: null, message: '请在室外等待 GPS 定位' }
  let stats = emptyStats()
  let unitIndex = 0
  let listeners = []
  let foreground = true
  let tickTimer = null
  let retryTimer = null
  let releaseTimer = null
  let lastSecond = null
  let persistenceBusy = false
  let persistencePending = false
  let statsReady = false
  let disposed = false
  let record = { recording: false, saving: false, points: 0, startedAt: null, message: '' }

  function view() {
    const now = time.now()
    const readings = locationView(state, unitIndex, now)
    const elapsed = record.startedAt === null ? 0 : Math.floor((now - record.startedAt) / 1000)
    return { ...readings, ...statsView(stats, UNITS[unitIndex].factor),
      statusText: STATUS[state.phase] || STATUS.error,
      statusColor: readings.tone === 'good' ? '#7ef7c5' : '#f2bf68',
      recording: record.recording, saving: record.saving,
      recordText: record.saving ? '保存中' : (record.recording ? '结束' : '记录'),
      recordInfo: record.recording ? Math.floor(elapsed / 60) + ':' + ('0' + elapsed % 60).slice(-2) + ' · ' + record.points + ' 点' : record.message,
      recordNotice: record.recording ? '' : record.message,
      detailNote: readings.age,
      latitudeNumber: readings.latitudeDetail === '--' ? '--' : readings.latitudeDetail.split('°')[0],
      latitudeDirection: readings.latitudeDetail === '--' ? '纬度' : (readings.latitudeDetail.indexOf('S') >= 0 ? '南纬 S' : '北纬 N'),
      longitudeNumber: readings.longitudeDetail === '--' ? '--' : readings.longitudeDetail.split('°')[0],
      longitudeDirection: readings.longitudeDetail === '--' ? '经度' : (readings.longitudeDetail.indexOf('W') >= 0 ? '西经 W' : '东经 E') }
  }
  function emit() { const current = view(); listeners.slice().forEach(listener => listener(current)) }
  function keepScreenOn(enabled) {
    try { deps.brightness.setKeepScreenOn({ keepScreenOn: enabled, fail() {} }) } catch (error) { /* Optional on older firmware. */ }
  }
  function saveStats() {
    if (!statsReady) return
    if (persistenceBusy) { persistencePending = true; return }
    persistenceBusy = true
    const done = () => {
      persistenceBusy = false
      if (persistencePending) { persistencePending = false; saveStats() }
    }
    try { deps.storage.set({ key: 'speedometer.statistics.v1', value: JSON.stringify(stats), success: done,
      fail() { record = { ...record, message: '统计保存失败，请检查存储空间' }; emit(); done() } }) }
    catch (error) { persistenceBusy = false }
  }
  const recorder = createRecorder(deps.file, next => { record = next; emit() })
  function wanted() { return foreground && !disposed && (listeners.length > 0 || record.recording || record.saving) }
  function clearRetry() { if (retryTimer !== null) time.clearTimeout(retryTimer); retryTimer = null }
  function scheduleRetry() {
    if (retryTimer !== null || !wanted()) return
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
      if (second % 5 === 0) saveStats()
    }
    if (state.phase === 'stale' && state.updatedAt !== null && now - state.updatedAt >= 60000) scheduleRetry()
    emit()
  }
  function start() {
    if (!wanted()) return
    keepScreenOn(true)
    if (tickTimer === null) tickTimer = time.setInterval(tick, 1000)
    tracker.start()
  }
  function stop() {
    clearRetry()
    if (tickTimer !== null) time.clearInterval(tickTimer)
    tickTimer = null
    keepScreenOn(false)
    tracker.stop()
    saveStats()
  }
  try {
    deps.storage.get({ key: 'speedometer.statistics.v1', default: '', success(data) {
      if (statsReady) return
      try { stats = mergeStats(restoreStats(JSON.parse(data || '{}')), stats) } catch (error) { /* First launch. */ }
      statsReady = true; emit()
    }, fail() { statsReady = true } })
  } catch (error) { statsReady = true }

  return {
    snapshot: view,
    acquire(listener) {
      if (releaseTimer !== null) time.clearTimeout(releaseTimer)
      releaseTimer = null
      foreground = true
      if (listeners.indexOf(listener) < 0) listeners.push(listener)
      listener(view()); start()
    },
    release(listener) {
      listeners = listeners.filter(item => item !== listener)
      if (releaseTimer !== null) time.clearTimeout(releaseTimer)
      // Allow router handoff to the next page without resetting the GPS stream.
      releaseTimer = time.setTimeout(() => { releaseTimer = null; if (!wanted()) stop() }, 150)
    },
    changeUnit() { unitIndex = (unitIndex + 1) % UNITS.length; emit() },
    async toggleRecording() {
      if (record.saving) return
      if (record.recording) { const uri = await recorder.finish(); saveStats(); return uri }
      await recorder.start(time.now()); start()
    },
    activeUri() {
      const current = recorder.snapshot()
      return current.recording || current.saving ? current.uri : null
    },
    async suspend() {
      foreground = false
      stop()
      if (record.recording) {
        try { await recorder.finish() } catch (error) { /* Recoverable .part is retained. */ }
      }
    },
    async dispose() {
      disposed = true
      if (releaseTimer !== null) time.clearTimeout(releaseTimer)
      releaseTimer = null
      await this.suspend()
      listeners = []
    }
  }
}
