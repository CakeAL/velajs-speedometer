import test from 'node:test'
import assert from 'node:assert/strict'
import { load, fakeClock } from './helpers.mjs'
const { createNavigation } = await load('../src/common/navigation.js')
const point = (x, y, identifier = 0) => ({ clientX: x, clientY: y, identifier })
function gesture(nav, clock, start, end, ms = 100) {
  nav.start({ touches: [start] }); clock.advance(ms); nav.end({ changedTouches: [end] })
}

test('left/right gestures cycle three pages using replace rather than growing a stack', () => {
  const routes = ['/pages/index', '/pages/position', '/pages/tracks']
  for (let page = 0; page < 3; page++) {
    const clock = fakeClock(); const calls = []
    const nav = createNavigation({ replace(o) { calls.push(o.uri) } }, page, clock)
    gesture(nav, clock, point(150, 100), point(40, 105))
    assert.deepEqual(calls, [routes[(page + 1) % 3]])
    nav.shown()
    gesture(nav, clock, point(40, 105), point(150, 100))
    assert.equal(calls[1], routes[(page + 2) % 3])
  }
})

test('vertical scrolling, taps, long drags, malformed points and multitouch do not navigate', () => {
  const clock = fakeClock(); const calls = []
  const nav = createNavigation({ replace(o) { calls.push(o.uri) } }, 0, clock)
  gesture(nav, clock, point(40, 40), point(50, 180))
  gesture(nav, clock, point(40, 40), point(42, 42))
  gesture(nav, clock, point(40, 40), point(150, 40), 1000)
  gesture(nav, clock, {}, {})
  gesture(nav, clock, point(40, 40), point(150, 40, 2))
  nav.start({ touches: [point(150, 40)] }); nav.move({ touches: [point(120, 40), point(110, 40, 1)] })
  nav.end({ changedTouches: [point(40, 40)] })
  assert.deepEqual(calls, [])
})

test('one gesture navigates once even with repeated end events or taps during replacement', () => {
  const clock = fakeClock(); const calls = []
  const nav = createNavigation({ replace(o) { calls.push(o.uri) } }, 0, clock)
  gesture(nav, clock, point(150, 40), point(40, 40))
  nav.end({ changedTouches: [point(40, 40)] }); nav.go(2)
  assert.equal(calls.length, 1)
})
