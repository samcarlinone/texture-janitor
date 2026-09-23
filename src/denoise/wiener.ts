/**
 * Global spectral Wiener filter on the half spectrum.
 *
 * With noise of per-pixel variance σ², the expected noise power in each
 * DFT bin is W·H·σ² (white noise). The observed power |Y|² is smoothed over
 * a (2r+1)² neighbourhood of bins to estimate the local power spectrum P̂,
 * and each bin gets the power-subtraction Wiener gain max(0, 1 − α·N/P̂).
 * DC is left at 1.
 *
 * `mag` is |Y| per stored bin (layout [ky][kx], kx < wh); `mult`, if given,
 * is the current complex edit multiplier, so the filter sees the edited
 * spectrum (pass null when `mag` is already the edited magnitude).
 */
export function wienerGains(
  wh: number,
  h: number,
  mag: Float32Array,
  mult: Float32Array | null,
  noisePower: number,
  alpha: number,
  radius: number,
): Float32Array {
  const n = wh * h
  const pw = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const g2 = mult ? mult[2 * i] * mult[2 * i] + mult[2 * i + 1] * mult[2 * i + 1] : 1
    pw[i] = mag[i] * mag[i] * g2
  }
  // Box smoothing: x clamps at the half-spectrum edges, y wraps (periodic).
  const tx = new Float32Array(n)
  for (let y = 0; y < h; y++) {
    const o = y * wh
    for (let x = 0; x < wh; x++) {
      let s = 0
      let c = 0
      for (let d = -radius; d <= radius; d++) {
        const xx = x + d
        if (xx < 0 || xx >= wh) continue
        s += pw[o + xx]
        c++
      }
      tx[o + x] = s / c
    }
  }
  const gains = new Float32Array(n)
  const span = 2 * radius + 1
  for (let x = 0; x < wh; x++) {
    let s = 0
    for (let d = -radius; d <= radius; d++) s += tx[(((d % h) + h) % h) * wh + x]
    for (let y = 0; y < h; y++) {
      if (y > 0) s += tx[((y + radius) % h) * wh + x] - tx[(((y - 1 - radius) % h) + h) % h * wh + x]
      const p = s / span
      gains[y * wh + x] = p > 0 ? Math.max(0, 1 - (alpha * noisePower) / p) : 0
    }
  }
  gains[0] = 1
  return gains
}
