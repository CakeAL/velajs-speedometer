export function emptyStats() { return { samples: 0, sum: 0, max: 0 } }

export function restoreStats(value) {
  if (!value || !Number.isInteger(value.samples) || value.samples < 0 ||
      typeof value.sum !== 'number' || !isFinite(value.sum) || value.sum < 0 ||
      typeof value.max !== 'number' || !isFinite(value.max) || value.max < 0) return emptyStats()
  return { samples: value.samples, sum: value.sum, max: value.max }
}

export function addSpeed(stats, speed) {
  if (typeof speed !== 'number' || !isFinite(speed) || speed < 0) return stats
  return { samples: stats.samples + 1, sum: stats.sum + speed, max: Math.max(stats.max, speed) }
}

export function mergeStats(a, b) {
  return { samples: a.samples + b.samples, sum: a.sum + b.sum, max: Math.max(a.max, b.max) }
}

export function statsView(stats, factor) {
  return { average: stats.samples ? (stats.sum / stats.samples * factor).toFixed(1) : '--',
    maximum: stats.samples ? (stats.max * factor).toFixed(1) : '--' }
}
