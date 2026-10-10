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
  let statusListeners = []
  let status = '手机通信：等待连接'
  function updateStatus(value) {
    status = value
    statusListeners.slice().forEach(listener => {
      try { listener(status) } catch (error) { /* UI must not block transport. */ }
    })
  }
  const handle = createTrackProtocol(file, () => session.activeUri(), name => {
    listeners.slice().forEach(listener => { try { listener(name) } catch (error) { /* UI does not affect deletion. */ } })
  })
  function send(response, epoch) {
    if (disposed || epoch !== generation) return Promise.resolve()
    return new Promise(resolve => {
      let done = false
      let timer
      function finish(message) {
        if (done) return
        done = true
        if (message) updateStatus(message)
        if (timer !== undefined) clock.clearTimeout(timer)
        const index = cancellations.indexOf(finish)
        if (index >= 0) cancellations.splice(index, 1)
        resolve()
      }
      cancellations.push(finish)
      timer = clock.setTimeout(() => finish('手机通信：回复发送超时'), 10000)
      try {
        connect.send({ data: response,
          success: () => finish('手机通信：已回复 ' + response.op),
          fail: (data, code) => finish('手机通信：回复失败 ' + (code === undefined ? '' : code)) })
      } catch (error) { finish('手机通信：回复发送异常') }
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
    updateStatus('手机通信：收到 ' + request.op)
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
        // onopen can arrive after onmessage on initial connection. Only an
        // actual disconnect invalidates queued requests, never opening a link.
        connect.onopen = () => { updateStatus('手机通信：已连接') }
        connect.onclose = () => { disconnect(); updateStatus('手机通信：已断开') }
        connect.onerror = event => {
          disconnect(); updateStatus('手机通信：连接错误 ' + (event && event.code !== undefined ? event.code : ''))
        }
        if (typeof connect.getReadyState === 'function') connect.getReadyState({
          success: event => { if (!disposed) updateStatus(event.status === 1 ? '手机通信：已连接' : '手机通信：等待连接') },
          fail: () => { if (!disposed) updateStatus('手机通信：连接状态不可用') }
        })
      } catch (error) { connect = null; updateStatus('手机通信：接口不可用'); console.log('轨迹通信暂不可用: ' + error.message) }
    },
    status() { return status },
    subscribeStatus(listener) {
      statusListeners.push(listener); listener(status)
      return () => { statusListeners = statusListeners.filter(item => item !== listener) }
    },
    subscribe(listener) {
      listeners.push(listener)
      return () => { listeners = listeners.filter(item => item !== listener) }
    },
    dispose() {
      disposed = true; disconnect(); listeners = []; statusListeners = []
      if (connect) {
        connect.onmessage = null; connect.onopen = null; connect.onclose = null; connect.onerror = null
      }
      connect = null
    }
  }
}
