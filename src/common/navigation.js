const ROUTES = ['/pages/index', '/pages/position', '/pages/tracks']
function validPoint(point) {
  return point && typeof point.clientX === 'number' && isFinite(point.clientX) &&
    typeof point.clientY === 'number' && isFinite(point.clientY)
}

// Touch events bubble from list children; swipe events do not. Recognize a
// horizontal gesture on the whole page without intercepting vertical scrolling.
export function createNavigation(router, page, clock = { now: () => Date.now() }) {
  let touch = null
  let navigating = false
  function go(target) {
    if (navigating || target === page) return
    navigating = true
    try { router.replace({ uri: ROUTES[target] }) }
    catch (error) { navigating = false; throw error }
  }
  return {
    go,
    shown() { navigating = false },
    start(event) {
      const points = event && event.touches
      touch = points && points.length === 1 && validPoint(points[0]) ? { ...points[0], at: clock.now() } : null
    },
    move(event) {
      if (!event || !event.touches || event.touches.length !== 1) touch = null
    },
    end(event) {
      const start = touch; touch = null
      const points = event && event.changedTouches
      if (!start || !points || points.length !== 1 || clock.now() - start.at > 800) return
      const end = points[0]
      if (!validPoint(end)) return
      if (end.identifier !== start.identifier) return
      const dx = end.clientX - start.clientX
      const dy = end.clientY - start.clientY
      if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.5) return
      go((page + (dx < 0 ? 1 : 2)) % ROUTES.length)
    }
  }
}
