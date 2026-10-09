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
    narrow
  }
}
