import type { Planes } from './color.ts'

export interface NlmParams {
  /** Patch radius (patch is (2r+1)²). */
  patchR: number
  /** Search radius (window is (2s+1)²). */
  searchR: number
  /** Filtering parameter h = k·σ. */
  k: number
}

/**
 * Parameters by noise level and quality, after Buades, Coll & Morel,
 * "Non-Local Means Denoising", IPOL 2011 (colour table).
 */
export function nlmParams(sigma: number, quality: 'fast' | 'balanced' | 'best'): NlmParams {
  const base =
    sigma <= 25 ? { patchR: 1, searchR: 10, k: 0.55 } : sigma <= 55 ? { patchR: 2, searchR: 17, k: 0.4 } : { patchR: 3, searchR: 17, k: 0.35 }
  const cap = quality === 'fast' ? 5 : quality === 'balanced' ? 10 : base.searchR
  return { ...base, searchR: Math.min(base.searchR, cap) }
}

/** Halo a tile needs around its core. */
export const nlmHalo = (p: NlmParams) => p.patchR + p.searchR

/**
 * Pixelwise colour non-local means on a padded tile.
 *
 * `planes` are w×h with at least `nlmHalo` pixels of context around the
 * core [m, w-m)×[m, h-m); only the core is written to the result.
 * Distances are normalized per channel by that channel's σ, so luminance
 * and chroma can carry different noise levels. With d the per-pixel
 * noise-normalized squared patch distance (2 for pure noise), the weight is
 * exp(-max(d - 2, 0) / k²), and the centre pixel gets the best weight
 * found, as in the IPOL implementation.
 *
 * Runs over offsets rather than pixels: for each offset, one pass builds
 * the pixel difference map and a separable box filter turns it into patch
 * distances for the whole tile, so cost is O(pixels · window) with no
 * per-patch loop.
 */
export function nlm(planes: Planes, w: number, h: number, m: number, sigma: number[], p: NlmParams, abort: () => boolean): Planes | null {
  const { patchR: r, searchR: S, k } = p
  const cw = w - 2 * m
  const ch = h - 2 * m
  const n = cw * ch
  const num: Planes = [new Float32Array(n), new Float32Array(n), new Float32Array(n)]
  const den = new Float32Array(n)
  const best = new Float32Array(n)
  const inv = sigma.map((s) => 1 / Math.max(s, 1e-3) ** 2)
  const invK2 = 1 / (k * k)
  const norm = 1 / (3 * (2 * r + 1) ** 2)
  // Difference map over the core plus the patch margin.
  const dw = cw + 2 * r
  const dh = ch + 2 * r
  const diff = new Float32Array(dw * dh)
  const rows = new Float32Array(cw * dh)
  const [P0, P1, P2] = planes
  const x0 = m - r
  const y0 = m - r

  for (let oy = -S; oy <= S; oy++) {
    if (abort()) return null
    for (let ox = -S; ox <= S; ox++) {
      if (ox === 0 && oy === 0) continue
      // 1. Noise-normalized squared colour difference.
      for (let y = 0; y < dh; y++) {
        let a = (y0 + y) * w + x0
        let b = a + oy * w + ox
        const o = y * dw
        for (let x = 0; x < dw; x++, a++, b++) {
          const d0 = P0[a] - P0[b]
          const d1 = P1[a] - P1[b]
          const d2 = P2[a] - P2[b]
          diff[o + x] = d0 * d0 * inv[0] + d1 * d1 * inv[1] + d2 * d2 * inv[2]
        }
      }
      // 2. Horizontal box sums (radius r).
      for (let y = 0; y < dh; y++) {
        const o = y * dw
        let s = 0
        for (let x = 0; x < 2 * r + 1; x++) s += diff[o + x]
        const ro = y * cw
        rows[ro] = s
        for (let x = 1; x < cw; x++) {
          s += diff[o + x + 2 * r] - diff[o + x - 1]
          rows[ro + x] = s
        }
      }
      // 3. Vertical box sums, weights and accumulation.
      for (let x = 0; x < cw; x++) {
        let s = 0
        for (let y = 0; y < 2 * r + 1; y++) s += rows[y * cw + x]
        for (let y = 0; y < ch; y++) {
          if (y > 0) s += rows[(y + 2 * r) * cw + x] - rows[(y - 1) * cw + x]
          const d = s * norm - 2
          const wgt = d <= 0 ? 1 : Math.exp(-d * invK2)
          if (wgt < 1e-4) continue
          const i = y * cw + x
          const q = (m + y + oy) * w + m + x + ox
          num[0][i] += wgt * P0[q]
          num[1][i] += wgt * P1[q]
          num[2][i] += wgt * P2[q]
          den[i] += wgt
          if (wgt > best[i]) best[i] = wgt
        }
      }
    }
  }
  const out: Planes = [new Float32Array(n), new Float32Array(n), new Float32Array(n)]
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = y * cw + x
      const q = (m + y) * w + m + x
      const wc = best[i] || 1
      const dn = den[i] + wc
      out[0][i] = (num[0][i] + wc * P0[q]) / dn
      out[1][i] = (num[1][i] + wc * P1[q]) / dn
      out[2][i] = (num[2][i] + wc * P2[q]) / dn
    }
  }
  return out
}
