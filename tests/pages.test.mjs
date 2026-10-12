import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { load, fakeFiles, fakeClock, settle } from './helpers.mjs'
const { createRecorder } = await load('../src/common/recording.js')
let counter = 0
async function mockedModule(path, apis, ux = false) {
  const key = '__speedometerPageTest' + ++counter
  globalThis[key] = apis
  const cache = new Map()
  async function build(url, isUx) {
    if (cache.has(url.href)) return cache.get(url.href)
    let code = await readFile(url, 'utf8')
    if (isUx) code = code.match(/<script>([\s\S]*?)<\/script>/)[1]
    code = code.replace(/import (\w+) from ['"](@system\.[^'"]+)['"]/g, (_, name, api) =>
      'const ' + name + ' = globalThis[' + JSON.stringify(key) + '][' + JSON.stringify(api) + ']')
    for (const match of [...code.matchAll(/from ['"](\.\.?\/[^'"]+)['"]/g)]) {
      const dep = new URL(match[1].endsWith('.js') ? match[1] : match[1] + '.js', url)
      code = code.replace(match[0], 'from ' + JSON.stringify(await build(dep, false)))
    }
    const result = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
    cache.set(url.href, result); return result
  }
  try { return await import(await build(new URL(path, import.meta.url), ux)) }
  finally { delete globalThis[key] }
}

test('app starts GPS on first foreground entry and keeps it through app hide until destruction', async () => {
  const fs = fakeFiles(); const calls = []
  const { default: definition } = await mockedModule('../src/app.ux', {
    '@system.file': fs.api,
    '@system.geolocation': {
      subscribe() { calls.push('subscribe') }, getLocation() { calls.push('snapshot') },
      unsubscribe() { calls.push('unsubscribe') }
    },
    '@system.brightness': { setKeepScreenOn() {} },
    '@system.interconnect': { instance() { return { connect() {}, close() {} } } }
  }, true)
  const app = { ...definition }
  try {
    app.onCreate()
    assert.deepEqual(calls, [], 'creation does not request GPS before the app becomes visible')
    app.onShow()
    assert.deepEqual(calls, ['subscribe'], 'continuous background positioning starts without a competing snapshot')
    app.onHide(); app.onShow()
    assert.deepEqual(calls, ['subscribe'], 'hiding and waking do not reacquire GPS')
    assert.equal(fs.data.size, 0)
  } finally { app.onDestroy() }
  assert.deepEqual(calls, ['subscribe', 'unsubscribe'])
})

test('app error callback is retained in the active GPX and shown by the file page', async () => {
  const fs = fakeFiles()
  const { default: definition } = await mockedModule('../src/app.ux', {
    '@system.file': fs.api,
    '@system.geolocation': { subscribe() {}, unsubscribe() {} },
    '@system.brightness': { setKeepScreenOn() {} },
    '@system.interconnect': { instance() { return { connect() {}, close() {} } } }
  }, true)
  const app = { ...definition }
  try {
    app.onCreate(); app.onShow(); await app.session.toggleRecording()
    app.onError(); await app.session.toggleRecording()
    const uri = [...fs.data.keys()].find(name => name.endsWith('.gpx'))
    const { default: page } = await mockedModule('../src/pages/tracks/tracks.ux', {
      '@system.file': fs.api,
      '@system.device': { getInfo(o) { o.success({ screenWidth: 432, screenHeight: 514 }) } },
      '@system.router': {}
    }, true)
    const vm = { ...page, ...page.private, $app: { $def: app } }
    vm.onInit(); vm.onShow(); await settle(); await settle()
    await vm.selectFile(uri)
    assert.match(vm.runtimeTrace, /收到应用错误回调/)
    assert.match(vm.runtimeTrace, /手动结束记录/)
    vm.onHide(); vm.onDestroy()
  } finally { app.onDestroy() }
})

test('remote deletion removes the visible track and closes its selected detail', async () => {
  const fs = fakeFiles(); const recorder = createRecorder(fs.api, () => {})
  await recorder.start(100000); const uri = await recorder.finish()
  let listener; let unsubscribed = 0
  const session = { acquire() {}, release() {}, activeUri: () => null }
  const trackSync = { subscribe(fn) { listener = fn; return () => { unsubscribed++ } } }
  const { default: page } = await mockedModule('../src/pages/tracks/tracks.ux', {
    '@system.file': fs.api,
    '@system.device': { getInfo(o) { o.success({ screenWidth: 432, screenHeight: 514 }) } },
    '@system.router': { back() {} }
  }, true)
  const vm = { ...page, ...page.private, $app: { $def: { session, trackSync } } }
  vm.onInit(); vm.onShow()
  for (let i = 0; i < 30; i++) await Promise.resolve()
  await vm.selectFile(uri); vm.confirmDelete = true
  listener(uri.split('/').pop())
  assert.equal(vm.files.length, 0); assert.equal(vm.selectedUri, ''); assert.equal(vm.confirmDelete, false)
  assert.equal(vm.message, '文件已通过 AstroBox 删除')
  vm.onHide(); vm.onDestroy(); assert.equal(unsubscribed, 1)
})

test('reading pages replace routes, keep their shared session and fit a round screen', async () => {
  const routes = []; const listeners = new Set()
  const state = { speed: '36', altitude: '13', average: '20.0', maximum: '36.0', unit: 'km/h' }
  const session = {
    snapshot: () => state,
    acquire(fn) { listeners.add(fn); fn(state) }, release(fn) { listeners.delete(fn) },
    changeUnit() { state.unit = 'm/s'; listeners.forEach(fn => fn(state)) },
    async toggleRecording() { state.recording = true; state.recordText = '结束'; listeners.forEach(fn => fn(state)) }
  }
  const { createReadingPage } = await mockedModule('../src/common/page.js', {
    '@system.device': { getInfo(o) { o.success({ screenWidth: 466, screenHeight: 466, screenShape: 'circle' }) } },
    '@system.router': { replace(o) { routes.push(o.uri) } }
  })
  function mount(index) {
    const page = createReadingPage(index)
    const vm = { ...page, ...page.private, $app: { $def: { session } } }
    vm.onInit(); vm.onShow(); return vm
  }
  const home = mount(0)
  assert.equal(home.speed, '36'); assert.ok(home.speedFont > 0 && home.speedFont < home.speedHeight)
  assert.equal(home.speedHeight + home.unitHeight + home.metricsHeight + home.summaryHeight, 152)
  home.openPosition(); home.onHide(); home.onDestroy()
  const details = mount(1)
  await details.toggleRecording(); assert.equal(details.recordText, '结束')
  details.changeUnit(); assert.equal(details.unit, 'm/s')
  assert.equal(details.average, '20.0')
  assert.equal(details.onBackPress(), true)
  details.onHide(); details.onDestroy()
  assert.deepEqual(routes, ['/pages/position', '/pages/index'])
  assert.equal(listeners.size, 0)
})

for (const format of ['full', 'filename', 'relative', 'double-slash']) {
test('track page reads and confirms deletion when file.list returns ' + format + ' URIs', async () => {
  const fs = fakeFiles(uri => format === 'full' ? uri : format === 'double-slash' ? uri.replace('/track-', '//track-') :
    (format === 'relative' ? 'speedometer/' : '') + uri.split('/').pop())
  const recorder = createRecorder(fs.api, () => {})
  await recorder.start(100000); const first = await recorder.finish()
  await recorder.start(200000); const second = await recorder.finish()
  let backs = 0; let owners = 0
  const session = { acquire() { owners++ }, release() { owners-- }, activeUri() { return null } }
  const { default: page } = await mockedModule('../src/pages/tracks/tracks.ux', {
    '@system.file': fs.api,
    '@system.device': { getInfo(o) { o.success({ screenWidth: 432, screenHeight: 514, screenShape: 'rect' }) } },
    '@system.router': { replace(options) { assert.equal(options.uri, '/pages/index'); backs++ } }
  }, true)
  const vm = { ...page, ...page.private, $app: { $def: { session } } }
  vm.onInit(); vm.onShow()
  // onShow starts refresh asynchronously; wait for the file listing to finish.
  for (let i = 0; i < 30; i++) await Promise.resolve()
  assert.equal(vm.files.length, 2)
  await vm.selectFile(first); assert.equal(vm.pointCount, '0')
  assert.equal(vm.selectedName, vm.files.find(item => item.uri === first).label)
  assert.equal(vm.message, '时间按手表当前时区显示')
  await vm.deleteSelected(); assert.equal(vm.confirmDelete, true); assert.equal(fs.data.has(first), true)
  vm.cancelDelete(); assert.equal(fs.data.has(first), true)
  await vm.deleteSelected(); await vm.deleteSelected()
  assert.equal(fs.data.has(first), false); assert.equal(fs.data.has(second), true)
  assert.equal(vm.files.length, 1); assert.equal(vm.selectedUri, '')
  await vm.selectFile(second); assert.equal(vm.onBackPress(), true); assert.equal(backs, 0)
  vm.back(); assert.equal(backs, 1)
  vm.onHide(); vm.onDestroy(); assert.equal(owners, 0)
})
}

test('recording errors appear in the visible notice and cannot update a destroyed page', async () => {
  let reject
  const session = {
    snapshot: () => ({ speed: '--' }), acquire() {}, release() {},
    toggleRecording: () => new Promise((resolve, fail) => { reject = fail })
  }
  const { createReadingPage } = await mockedModule('../src/common/page.js', {
    '@system.device': { getInfo(o) { o.success({ screenWidth: 432, screenHeight: 514 }) } },
    '@system.router': {}
  })
  const page = createReadingPage()
  const vm = { ...page, ...page.private, $app: { $def: { session } } }
  vm.onInit(); vm.onShow()
  let operation = vm.toggleRecording()
  reject(new Error('文件操作失败')); await operation
  assert.equal(vm.recordNotice, '文件操作失败')
  operation = vm.toggleRecording(); vm.onDestroy()
  reject(new Error('迟到的错误')); await operation
  assert.equal(vm.recordNotice, '文件操作失败')
})

test('all pages use a full-screen cover above their padded contents with an isolated wake handler', async () => {
  for (const page of ['index/index', 'position/position', 'tracks/tracks']) {
    const ux = await readFile(new URL('../src/pages/' + page + '.ux', import.meta.url), 'utf8')
    const template = ux.match(/<template>([\s\S]*?)<\/template>/)[1].trim()
    assert.ok(template.startsWith('<stack class="screen">'))
    assert.ok(template.endsWith('</stack>'))
    assert.match(template, /<\/div>\s*<div if="\{\{screenCovered\}\}" class="sleep-cover" onclick="wakeScreen">/)
    assert.match(template, /class="sleep-dot" style="background-color: \{\{statusColor\}\}; left: \{\{sleepDotLeft\}\}px;"/)
  }
  const styles = await readFile(new URL('../src/common/page.less', import.meta.url), 'utf8')
  assert.match(styles, /\.sleep-dot \{ position: absolute; top: 8px; width: 4px; height: 4px;/)
})

test('covered reading pages only paint GPS status and consume back/swipe without navigating or ending recording', async () => {
  const { createSession } = await load('../src/common/session.js')
  const clock = fakeClock(); const fs = fakeFiles(); const routes = []; let stream
  const session = createSession({ file: fs.api, brightness: { setKeepScreenOn() {} },
    geolocation: { subscribe(options) { stream = options }, unsubscribe() {} }
  }, clock)
  session.activate()
  const { createReadingPage } = await mockedModule('../src/common/page.js', {
    '@system.device': { getInfo(o) { o.success({ screenWidth: 432, screenHeight: 514 }) } },
    '@system.router': { replace(o) { routes.push(o.uri) } }
  })
  for (const index of [0, 1]) {
    const page = createReadingPage(index)
    const vm = { ...page, ...page.private, $app: { $def: { session, clock } } }
    vm.onInit(); vm.onShow()
    if (index === 0) { session.changeScreenMode(); session.changeScreenMode(); await session.toggleRecording() }
    stream.callback({ latitude: 31, longitude: 121, altitude: 12, speed: 10 })
    clock.advance(10000); await settle()
    assert.equal(vm.screenCovered, true)
    const previousSpeed = vm.speed
    stream.callback({ latitude: 31, longitude: 121, altitude: 13, speed: 20 })
    assert.equal(vm.speed, previousSpeed, 'covered reading rows do not repaint')
    assert.equal(vm.statusColor, '#7ef7c5')
    assert.equal(vm.sleepDotLeft, 118)
    clock.advance(20000)
    assert.equal(vm.sleepDotLeft, 122, 'covered pages repaint the moving indicator')
    stream.callback({ latitude: 31, longitude: 121, altitude: 13, speed: 20 })
    vm.onTouchStart({ touches: [{ clientX: 200, clientY: 100 }] })
    vm.onTouchEnd({ changedTouches: [{ clientX: 20, clientY: 100 }] })
    assert.deepEqual(routes, [])
    vm.wakeScreen()
    assert.equal(vm.screenCovered, false); assert.equal(vm.speed, '72')
    assert.equal(session.snapshot().recording, true)
    clock.advance(10000); await settle()
    assert.equal(vm.onBackPress(), true)
    assert.equal(vm.screenCovered, false); assert.deepEqual(routes, [])
    vm.onHide(); vm.onDestroy()
  }
  await session.dispose()
})

test('waking the covered track page preserves selected file and delete confirmation', async () => {
  const { createSession } = await load('../src/common/session.js')
  const clock = fakeClock(); const fs = fakeFiles(); const recorder = createRecorder(fs.api, () => {})
  await recorder.start(100000); const uri = await recorder.finish()
  let stream; const routes = []
  const session = createSession({ file: fs.api, brightness: { setKeepScreenOn() {} },
    geolocation: { subscribe(options) { stream = options }, unsubscribe() {} }
  }, clock)
  session.activate(); session.changeScreenMode(); session.changeScreenMode()
  const { default: page } = await mockedModule('../src/pages/tracks/tracks.ux', {
    '@system.file': fs.api,
    '@system.device': { getInfo(o) { o.success({ screenWidth: 432, screenHeight: 514 }) } },
    '@system.router': { replace(o) { routes.push(o.uri) } }
  }, true)
  const vm = { ...page, ...page.private, $app: { $def: { session, clock } } }
  vm.onInit(); vm.onShow(); await settle(); await settle()
  await vm.selectFile(uri); await vm.deleteSelected()
  clock.advance(10000)
  assert.equal(vm.screenCovered, true)
  stream.callback({ latitude: 31, longitude: 121, speed: 10, altitude: 13 })
  assert.equal(vm.statusColor, '#7ef7c5')
  assert.equal(vm.sleepDotLeft, 118)
  clock.advance(20000); assert.equal(vm.sleepDotLeft, 122)
  assert.equal(vm.onBackPress(), true)
  assert.equal(vm.screenCovered, false); assert.equal(vm.selectedUri, uri); assert.equal(vm.confirmDelete, true)
  assert.equal(fs.data.has(uri), true); assert.deepEqual(routes, [])
  clock.advance(10000); vm.wakeScreen()
  assert.equal(vm.screenCovered, false); assert.equal(vm.selectedUri, uri)
  vm.onHide(); vm.onDestroy(); await session.dispose()
})
