/**
 * Noise standard deviation of a plane, by Donoho's robust estimator: the
 * median absolute value of the finest diagonal Haar wavelet coefficients,
 * divided by 0.6745. Image structure is sparse in that subband, so the
 * median mostly sees noise.
 *
 * For large images a fixed-size sample of 2×2 blocks keeps this fast.
 */
export function estimateSigma(p: Float32Array, w: number, h: number): number {
  const bw = w >> 1
  const bh = h >> 1
  const blocks = bw * bh
  if (blocks === 0) return 0
  const step = Math.max(1, Math.floor(blocks / 400_000))
  const vals: number[] = []
  for (let b = 0; b < blocks; b += step) {
    const x = 2 * (b % bw)
    const y = 2 * ((b / bw) | 0)
    const i = y * w + x
    // HH = (a - b - c + d) / 2 for an orthonormal Haar step.
    vals.push(Math.abs(p[i] - p[i + 1] - p[i + w] + p[i + w + 1]) / 2)
  }
  const arr = Float32Array.from(vals).sort()
  return arr[arr.length >> 1] / 0.6745
}

export interface NoiseEstimate {
  /** Per-pixel noise σ of the opponent channels Y, U, V (see color.ts). */
  opponent: [number, number, number]
  /** Per-pixel noise σ of Rec. 601 luminance, as the spectrum uses. */
  luma: number
  /**
   * Noise σ of each 8×8 orthonormal DCT coefficient, per opponent channel
   * (row-major, DC first). Correlated noise concentrates in low
   * frequencies; white noise would be flat.
   */
  psd: [Float32Array, Float32Array, Float32Array]
}

const B = 8
/** Fraction of blocks, flattest first, used to measure the noise. */
const FLAT = 0.4
/**
 * Selecting the flattest blocks biases their energy low. For white noise
 * over 63 AC coefficients, the lowest 40% of a χ²(63) distribution
 * averages about 0.83 of its mean; divide that back out.
 */
const FLAT_BIAS = 1 / 0.83

const DCT8 = (() => {
  const c = new Float64Array(64)
  for (let k = 0; k < B; k++) {
    const s = k === 0 ? Math.sqrt(1 / B) : Math.sqrt(2 / B)
    for (let n = 0; n < B; n++) c[k * B + n] = s * Math.cos((Math.PI * (2 * n + 1) * k) / (2 * B))
  }
  return c
})()

function dct8(block: Float64Array, out: Float64Array, tmp: Float64Array): void {
  for (let r = 0; r < B; r++) {
    for (let k = 0; k < B; k++) {
      let s = 0
      for (let n = 0; n < B; n++) s += block[r * B + n] * DCT8[k * B + n]
      tmp[r * B + k] = s
    }
  }
  for (let k = 0; k < B; k++) {
    for (let c = 0; c < B; c++) {
      let s = 0
      for (let r = 0; r < B; r++) s += DCT8[k * B + r] * tmp[r * B + c]
      out[k * B + c] = s
    }
  }
}

/**
 * Noise model straight from RGBA8: the per-coefficient noise spectrum in
 * the 8×8 DCT domain, measured on the flattest blocks, following the
 * correlated-noise model of Mäkinen, Azzari & Foi, "Collaborative
 * Filtering of Correlated Noise" (IEEE TIP 2020).
 *
 * Blocks are ranked by luminance AC energy; the flattest 40% hold mostly
 * noise, and their mean squared AC coefficients give each coefficient's
 * noise variance. DC can't be separated from image content within a
 * block, so it borrows the mean of the three lowest AC frequencies. Per
 * pixel σ follows by Parseval (mean variance over all 64 coefficients).
 * Blocks are sampled, so no full-size planes are allocated.
 */
export function estimateNoiseRGBA(rgba: ArrayLike<number>, w: number, h: number): NoiseEstimate {
  const bw = Math.floor(w / B)
  const bh = Math.floor(h / B)
  const blocks = bw * bh
  const empty = (): NoiseEstimate => ({
    opponent: [0, 0, 0],
    luma: 0,
    psd: [new Float32Array(64), new Float32Array(64), new Float32Array(64)],
  })
  if (blocks === 0) return empty()
  const step = Math.max(1, Math.floor(blocks / 20_000))
  const n = Math.ceil(blocks / step)
  const k = [1 / Math.sqrt(3), 1 / Math.sqrt(2), 1 / Math.sqrt(6)]
  // Squared DCT coefficients per sampled block: channels Y, U, V, luma.
  const sq = Array.from({ length: 4 }, () => new Float32Array(n * 64))
  const energy = new Float32Array(n)
  const blk = Array.from({ length: 4 }, () => new Float64Array(64))
  const out = new Float64Array(64)
  const tmp = new Float64Array(64)
  let m = 0
  for (let b = 0; b < blocks; b += step, m++) {
    const x0 = B * (b % bw)
    const y0 = B * ((b / bw) | 0)
    for (let y = 0; y < B; y++) {
      for (let x = 0; x < B; x++) {
        const i = 4 * ((y0 + y) * w + x0 + x)
        const r = rgba[i]
        const g = rgba[i + 1]
        const bl = rgba[i + 2]
        const j = y * B + x
        blk[0][j] = (r + g + bl) * k[0]
        blk[1][j] = (r - bl) * k[1]
        blk[2][j] = (r - 2 * g + bl) * k[2]
        blk[3][j] = 0.299 * r + 0.587 * g + 0.114 * bl
      }
    }
    for (let c = 0; c < 4; c++) {
      dct8(blk[c], out, tmp)
      let e = 0
      for (let j = 0; j < 64; j++) {
        const v = out[j] * out[j]
        sq[c][m * 64 + j] = v
        if (j > 0) e += v
      }
      if (c === 0) energy[m] = e
    }
  }
  const order = Array.from({ length: m }, (_, i) => i).sort((a, b) => energy[a] - energy[b])
  const flat = order.slice(0, Math.max(1, Math.floor(m * FLAT)))
  const measure = (c: number) => {
    const v = new Float64Array(64)
    for (const i of flat) for (let j = 1; j < 64; j++) v[j] += sq[c][i * 64 + j]
    for (let j = 1; j < 64; j++) v[j] = (v[j] / flat.length) * FLAT_BIAS
    v[0] = (v[1] + v[B] + v[B + 1]) / 3
    const pixel = Math.sqrt(v.reduce((a, x) => a + x, 0) / 64)
    return { psd: Float32Array.from(v, Math.sqrt), pixel }
  }
  const [Y, U, V, L] = [0, 1, 2, 3].map(measure)
  return { opponent: [Y.pixel, U.pixel, V.pixel], luma: L.pixel, psd: [Y.psd, U.psd, V.psd] }
}
