export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
  return `${m}:${String(ss).padStart(2, '0')}`
}

export function formatDurationLong(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0 min'
  const totalMin = sec / 60
  if (totalMin < 1) return `${Math.round(sec)} sec`
  if (totalMin < 60) return `${totalMin.toFixed(1)} min`
  const h = Math.floor(totalMin / 60)
  const m = Math.round(totalMin - h * 60)
  return `${h} h ${m} min`
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log10(bytes) / 3), units.length - 1)
  return `${(bytes / 10 ** (i * 3)).toFixed(1)} ${units[i]}`
}

export function basename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] ?? p
}
