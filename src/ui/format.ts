export function formatBytes(b: number): string {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(b >= 100 * 1024 ** 2 ? 0 : 1)} MB`
  if (b >= 1024) return `${Math.round(b / 1024)} KB`
  return `${b} B`
}

/** A measured duration, to the millisecond. */
export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`
}

/** A rough estimate, rounded to a sensible unit. */
export function formatEstimate(s: number): string {
  if (s < 1) return `${Math.max(1, Math.round(s * 1000))} ms`
  if (s < 90) return `${s.toFixed(s < 10 ? 1 : 0)} s`
  return `${Math.round(s / 60)} min`
}
