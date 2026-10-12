// Vela attaches native timers to the page that created them. Create the native
// pulse in app.onCreate; page navigation only registers jobs with this app clock.
export function createAppClock() {
  let nextId = 0
  const jobs = {}
  const pulse = setInterval(() => {
    const now = Date.now()
    Object.keys(jobs).forEach(id => {
      const job = jobs[id]
      if (!job || now < job.at) return
      if (job.repeat) job.at = now + job.repeat
      else delete jobs[id]
      try { job.callback() }
      catch (error) { console.error('应用定时任务失败：' + error.message) }
    })
  }, 250)
  function register(callback, delay, repeat) {
    const id = ++nextId
    jobs[id] = { callback, at: Date.now() + delay, repeat }
    return id
  }
  return {
    now: () => Date.now(),
    setInterval(callback, delay) { return register(callback, delay, delay) },
    clearInterval(id) { delete jobs[id] },
    setTimeout(callback, delay) { return register(callback, delay, 0) },
    clearTimeout(id) { delete jobs[id] },
    dispose() { clearInterval(pulse); Object.keys(jobs).forEach(id => { delete jobs[id] }) }
  }
}
