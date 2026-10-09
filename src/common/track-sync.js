import { PROTOCOL, createTrackProtocol } from './track-protocol'

function requestData(event) {
  let data = event && typeof event === 'object' && event.protocol === undefined ? event.data : event
  if (typeof data === 'string') {
    if (data.length > 4096) return null
    try { data = JSON.parse(data) } catch (error) { return null }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.protocol !== PROTOCOL || data.ok !== undefined) return null
  if (JSON.stringify(data).length > 4096 || typeof data.id !== 'string' || !data.id || data.id.length > 64 ||
      typeof data.op !== 'string' || data.op.length > 16) return null
  return data
}

// Register at app level so navigation does not replace the native message handler.
export function createTrackSync(interconnect, file, session, clock) {
  let connect = null
  let disposed = false
  let generation = 0
  let pending = 0
  let queue = Promise.resolve()
  const cancellations = []
  let listeners = []
  const handle = createTrackProtocol(file, () => session.activeUri(), name => {
    listeners.slice().forEach(listener => { try { listener(name) } catch (error) { /* UI does not affect deletion. */ } })
  })
  function send(response, epoch) {
    if (disposed || epoch !== generation) return Promise.resolve()
    return new Promise(resolve => {
      let done = false
      let timer
      function finish() {
        if (done) return
        done = true
        if (timer !== undefined) clock.clearTimeout(timer)
        const index = cancellations.indexOf(finish)
        if (index >= 0) cancellations.splice(index, 1)
        resolve()
      }
      cancellations.push(finish)
      timer = clock.setTimeout(finish, 10000)
      try { connect.send({ data: response, success: finish, fail: finish }) }
      catch (error) { finish() }
    })
  }
  function disconnect() {
    generation += 1
    cancellations.slice().forEach(cancel => cancel())
  }
  function receive(event) {
    if (disposed) return Promise.resolve()
    let request
    try { request = requestData(event) } catch (error) { return Promise.resolve() }
    if (!request) return Promise.resolve()
    // A plugin waits for each reply before sending the next request. Drop floods
    // rather than buffering unbounded data; the client retries on its timeout.
    if (pending >= 4) return Promise.resolve()
    const epoch = generation
    pending += 1
    const operation = queue.then(async () => {
      if (disposed || epoch !== generation) return
      const response = await handle(request)
      await send(response, epoch)
    }).catch(() => {}).then(() => { pending -= 1 })
    queue = operation
    return operation
  }
  return {
    start() {
      if (disposed || connect) return
      try {
        connect = interconnect.instance()
        connect.onmessage = receive
        connect.onopen = () => { disconnect() }
        connect.onclose = disconnect
        connect.onerror = disconnect
      } catch (error) { connect = null; console.log('轨迹通信暂不可用: ' + error.message) }
    },
    subscribe(listener) {
      listeners.push(listener)
      return () => { listeners = listeners.filter(item => item !== listener) }
    },
    dispose() {
      disposed = true; disconnect(); listeners = []
      if (connect) {
        connect.onmessage = null; connect.onopen = null; connect.onclose = null; connect.onerror = null
      }
      connect = null
    }
  }
}
