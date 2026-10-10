export function emptyStats() { return { samples: 0, sum: 0, max: 0 } }

export function addSpeed(stats, speed) {
  if (typeof speed !== 'number' || !isFinite(speed) || speed < 0) return stats
  return { samples: stats.samples + 1, sum: stats.sum + speed, max: Math.max(stats.max, speed) }
}

export function statsView(stats, factor) {
  return { average: stats.samples ? (stats.sum / stats.samples * factor).toFixed(1) : '--',
    maximum: stats.samples ? (stats.max * factor).toFixed(1) : '--' }
}
