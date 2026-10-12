import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
const source = (await readFile(new URL('../src/common/app-clock.js', import.meta.url), 'utf8')).replace('export function', 'function')

test('a throwing job cannot prevent recording jobs or cleanup in the app-owned clock', () => {
  let pulse; let cleared = false; let now = 0; let samples = 0; const errors = []
  const context = vm.createContext({
    Date: { now: () => now }, console: { error: value => errors.push(value) },
    setInterval(fn) { pulse = fn; return 1 }, clearInterval(id) { assert.equal(id, 1); cleared = true }
  })
  vm.runInContext(source + '\nthis.createClock = createAppClock', context)
  const clock = context.createClock()
  const failed = clock.setInterval(() => { throw new Error('UI timer failed') }, 1000)
  clock.setInterval(() => { samples++ }, 1000)
  now = 1000; pulse()
  assert.equal(samples, 1); assert.equal(errors.length, 1)
  clock.clearInterval(failed); now = 2000; pulse(); assert.equal(samples, 2)
  clock.dispose(); now = 3000; pulse(); assert.equal(samples, 2); assert.equal(cleared, true)
})
