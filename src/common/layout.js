// Ratio detection accommodates new GPS devices without a model whitelist.
export function screenLayout(info) {
  const width = info && info.screenWidth
  const height = info && info.screenHeight
  const ratio = width > 0 && height > 0 ? width / height : 1
  const shape = info && info.screenShape
  const narrow = shape === 'pill-shaped' || ratio < 0.6
  const round = shape === 'circle' || (!shape && ratio > 0.95)
  return {
    pageClass: narrow ? 'band-page' : (round ? 'round-page' : 'rect-page'),
    narrow,
    height: width > 0 && height > 0 ? height / width * 240 : 240
  }
}

// Reserve header, footer and padding before distributing the dashboard rows.
export function dashboardLayout(layout, speed) {
  const { narrow, pageClass, height } = layout
  const rectangular = pageClass === 'rect-page'
  const width = narrow || rectangular ? 208 : 192
  const available = height - (narrow ? 72 + 34 + 148 : (rectangular ? 32 : 40) + 18 + 30)
  const unitHeight = narrow ? 38 : 22
  const metricsHeight = narrow ? 78 : (available >= 190 ? 54 : 44)
  const speedHeight = narrow ? 112 : Math.max(50, Math.min(86, available - unitHeight - metricsHeight - 32))
  return {
    unitHeight, metricsHeight, speedHeight,
    summaryHeight: Math.max(narrow ? 116 : 32, available - speedHeight - unitHeight - metricsHeight),
    speedFont: Math.min(narrow ? 100 : speedHeight - 6, Math.floor(width / (Math.max(3, speed.length) * 0.65)))
  }
}
