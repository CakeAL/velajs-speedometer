import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { load, fakeFiles } from './helpers.mjs'
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

test('reading pages navigate independently, keep their shared session and fit a round screen', async () => {
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
    '@system.router': { push(o) { routes.push(o.uri) }, back() { routes.push('back') } }
  })
  const page = createReadingPage()
  const vm = { ...page, ...page.private, $app: { $def: { session } } }
  vm.onInit(); vm.onShow()
  assert.equal(vm.speed, '36'); assert.equal(vm.speedFont, 76)
  assert.equal(vm.speedHeight + 70, 152, 'home content fits normalized circle height')
  vm.openPosition(); vm.openTracks(); vm.back()
  assert.deepEqual(routes, ['/pages/position', '/pages/tracks', 'back'])
  await vm.toggleRecording(); assert.equal(vm.recordText, '结束')
  vm.changeUnit(); assert.equal(vm.unit, 'm/s')
  vm.onHide(); vm.onDestroy(); assert.equal(listeners.size, 0)
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
    '@system.router': { back() { backs++ } }
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
