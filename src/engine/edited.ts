/** Rec. 601 luminance weights for R, G, B. */
export const LUMA = [0.299, 0.587, 0.114] as const

/**
 * Magnitude of stored bin i of the edited spectrum shown for channel `ch`
 * (0..2 for R, G, B; -1 for luminance). `mults` holds one multiplier per
 * channel; in shared mode all three are the same array, and luminance takes
 * the fast path |Y|·|m| using the precomputed `magY`.
 */
export function editedMag(i: number, ch: number, spec: Float32Array[], mults: Float32Array[], magY: Float32Array): number {
  if (ch >= 0) {
    const s = spec[ch]
    const m = mults[ch]
    return Math.hypot(s[2 * i], s[2 * i + 1]) * Math.hypot(m[2 * i], m[2 * i + 1])
  }
  if (mults[0] === mults[1] && mults[1] === mults[2]) {
    const m = mults[0]
    return magY[i] * Math.hypot(m[2 * i], m[2 * i + 1])
  }
  let re = 0
  let im = 0
  for (let c = 0; c < 3; c++) {
    const s = spec[c]
    const m = mults[c]
    const sr = s[2 * i]
    const si = s[2 * i + 1]
    const mr = m[2 * i]
    const mi = m[2 * i + 1]
    re += LUMA[c] * (sr * mr - si * mi)
    im += LUMA[c] * (sr * mi + si * mr)
  }
  return Math.hypot(re, im)
}

/** Unedited magnitude of stored bin i for channel `ch` (-1: luminance). */
export function originalMag(i: number, ch: number, spec: Float32Array[], magY: Float32Array): number {
  if (ch < 0) return magY[i]
  const s = spec[ch]
  return Math.hypot(s[2 * i], s[2 * i + 1])
}
