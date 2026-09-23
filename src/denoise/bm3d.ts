import type { Planes } from './color.ts'

/**
 * Colour BM3D: Dabov, Foi, Katkovnik & Egiazarian, "Image Denoising by
 * Sparse 3-D Transform-Domain Collaborative Filtering" (IEEE TIP 2007),
 * following the parameter choices of Lebrun, "An Analysis and
 * Implementation of the BM3D Image Denoising Method" (IPOL 2012).
 *
 * Correlated noise: given a noise spectrum (σ per 8×8 DCT coefficient),
 * shrinkage uses each coefficient's own noise level instead of one σ, as in
 * Mäkinen, Azzari & Foi, "Collaborative Filtering of Correlated Noise"
 * (IEEE TIP 2020). The group-wise Walsh–Hadamard mixes different patches,
 * whose noise is independent, so per-coefficient variances carry through.
 *
 * Block matching in step 1 runs on a guide image from a sliding-window
 * DCT hard-threshold denoiser (Yu & Sapiro, IPOL 2011) using the same
 * per-coefficient noise levels. This plays the role of IPOL's λ2D
 * prefiltering of patch transforms, computed once per tile, and keeps
 * matching reliable when low-frequency noise would otherwise dominate
 * patch distances.
 *
 * Simplification: an 8×8 orthonormal DCT for both steps (IPOL uses
 * Bior1.5 in step 1).
 */

const N1 = 8
const P = N1 * N1

export interface Bm3dParams {
  twoStep: boolean
  /** Search half-width, steps 1 and 2. */
  ns1: number
  ns2: number
  /** Stride between reference patches. */
  step: number
  /** Max group sizes (powers of two). */
  n2Hard: number
  n2Wien: number
  lambda: number
  /** Match thresholds on mean squared patch distance. */
  tauHard: number
  tauWien: number
}

export function bm3dParams(sigma: number, quality: 'fast' | 'balanced' | 'best'): Bm3dParams {
  const q =
    quality === 'fast'
      ? { twoStep: false, ns1: 8, ns2: 8, step: 4, n2Hard: 8, n2Wien: 8 }
      : quality === 'balanced'
        ? { twoStep: true, ns1: 12, ns2: 12, step: 3, n2Hard: 16, n2Wien: 16 }
        : { twoStep: true, ns1: 19, ns2: 19, step: 3, n2Hard: 16, n2Wien: 32 }
  // IPOL's thresholds assume σ ≤ ~100; grow them for extreme noise so
  // similar patches still match.
  const grow = Math.max(1, (sigma / 50) ** 2)
  return {
    ...q,
    lambda: sigma > 40 ? 2.8 : 2.7,
    tauHard: (sigma > 35 ? 5000 : 2500) * grow,
    tauWien: (sigma > 35 ? 3500 : 400) * grow,
  }
}

export const bm3dHalo = (p: Bm3dParams) => Math.max(p.ns1, p.ns2) + N1

// Orthonormal DCT-II matrix, and a separable 2-D Kaiser window (β = 2).
const DCT = (() => {
  const c = new Float64Array(P)
  for (let k = 0; k < N1; k++) {
    const s = k === 0 ? Math.sqrt(1 / N1) : Math.sqrt(2 / N1)
    for (let n = 0; n < N1; n++) c[k * N1 + n] = s * Math.cos((Math.PI * (2 * n + 1) * k) / (2 * N1))
  }
  return c
})()

const KAISER = (() => {
  const i0 = (x: number) => {
    let s = 1
    let t = 1
    for (let k = 1; k < 30; k++) {
      t *= (x / (2 * k)) ** 2
      s += t
    }
    return s
  }
  const beta = 2
  const k1 = Array.from({ length: N1 }, (_, n) => i0(beta * Math.sqrt(1 - ((2 * n) / (N1 - 1) - 1) ** 2)) / i0(beta))
  const k = new Float32Array(P)
  for (let y = 0; y < N1; y++) for (let x = 0; x < N1; x++) k[y * N1 + x] = k1[y] * k1[x]
  return k
})()

const tmp = new Float64Array(P)

/** 2-D DCT of the 8×8 block at (x, y) of plane `p` (width w) into out[o..o+64). */
function dct2(p: Float32Array, w: number, x: number, y: number, out: Float32Array, o: number): void {
  // rows: tmp[r][k] = Σ_n p[r][n] C[k][n]
  for (let r = 0; r < N1; r++) {
    const b = (y + r) * w + x
    for (let k = 0; k < N1; k++) {
      let s = 0
      for (let n = 0; n < N1; n++) s += p[b + n] * DCT[k * N1 + n]
      tmp[r * N1 + k] = s
    }
  }
  // columns: out[k][c] = Σ_r C[k][r] tmp[r][c]
  for (let k = 0; k < N1; k++) {
    for (let c = 0; c < N1; c++) {
      let s = 0
      for (let r = 0; r < N1; r++) s += DCT[k * N1 + r] * tmp[r * N1 + c]
      out[o + k * N1 + c] = s
    }
  }
}

/** Inverse of dct2, in place on g[o..o+64). */
function idct2(g: Float32Array, o: number): void {
  for (let r = 0; r < N1; r++) {
    for (let c = 0; c < N1; c++) {
      let s = 0
      for (let k = 0; k < N1; k++) s += DCT[k * N1 + r] * g[o + k * N1 + c]
      tmp[r * N1 + c] = s
    }
  }
  for (let r = 0; r < N1; r++) {
    for (let n = 0; n < N1; n++) {
      let s = 0
      for (let k = 0; k < N1; k++) s += tmp[r * N1 + k] * DCT[k * N1 + n]
      g[o + r * N1 + n] = s
    }
  }
}

/** Orthonormal Walsh–Hadamard transform across a group of k patches (k a power of two), per coefficient. */
function wht(g: Float32Array, k: number): void {
  if (k === 1) return
  const s = 1 / Math.sqrt(k)
  for (let j = 0; j < P; j++) {
    for (let len = 1; len < k; len <<= 1) {
      for (let i = 0; i < k; i += len << 1) {
        for (let t = i; t < i + len; t++) {
          const a = g[t * P + j]
          const b = g[(t + len) * P + j]
          g[t * P + j] = a + b
          g[(t + len) * P + j] = a - b
        }
      }
    }
    for (let t = 0; t < k; t++) g[t * P + j] *= s
  }
}

/**
 * Block matching: up to `max` patches most similar to the one at (rx, ry)
 * within ±ns, with mean squared distance below tau. Writes positions to
 * `pos` and returns the group size, rounded down to a power of two.
 */
function match(
  p: Float32Array,
  w: number,
  h: number,
  rx: number,
  ry: number,
  ns: number,
  max: number,
  tau: number,
  pos: Int32Array,
  dist: Float32Array,
): number {
  const limit = tau * P
  let n = 0
  const x0 = Math.max(0, rx - ns)
  const x1 = Math.min(w - N1, rx + ns)
  const y0 = Math.max(0, ry - ns)
  const y1 = Math.min(h - N1, ry + ns)
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      // Stop early once worse than the worst kept candidate.
      const cut = n < max ? limit : dist[n - 1]
      let d = 0
      for (let r = 0; r < N1 && d < cut; r++) {
        const a = (ry + r) * w + rx
        const b = (y + r) * w + x
        for (let c = 0; c < N1; c++) {
          const e = p[a + c] - p[b + c]
          d += e * e
        }
      }
      if (d >= cut) continue
      // Insert, keeping dist sorted ascending.
      let i = n < max ? n++ : max - 1
      while (i > 0 && dist[i - 1] > d) {
        dist[i] = dist[i - 1]
        pos[i] = pos[i - 1]
        i--
      }
      dist[i] = d
      pos[i] = y * w + x
    }
  }
  let k = 1
  while (k * 2 <= n) k *= 2
  return k
}

function refPositions(n: number, step: number): number[] {
  const out: number[] = []
  for (let v = 0; v <= n - N1; v += step) out.push(v)
  if (out.at(-1) !== n - N1) out.push(n - N1)
  return out
}

/**
 * Matching guide: sliding 8×8 DCT hard thresholding at λ2D·σ_j per
 * coefficient, patches every 2 pixels, uniform aggregation.
 */
function dctGuide(p: Float32Array, w: number, h: number, coef: Float32Array): Float32Array {
  const LAMBDA_2D = 2
  const num = new Float32Array(w * h)
  const den = new Float32Array(w * h)
  const g = new Float32Array(P)
  for (const y of refPositions(h, 2)) {
    for (const x of refPositions(w, 2)) {
      dct2(p, w, x, y, g, 0)
      for (let j = 1; j < P; j++) if (Math.abs(g[j]) < LAMBDA_2D * coef[j]) g[j] = 0
      idct2(g, 0)
      for (let r = 0; r < N1; r++) {
        const o = (y + r) * w + x
        for (let c = 0; c < N1; c++) {
          num[o + c] += g[r * N1 + c]
          den[o + c] += 1
        }
      }
    }
  }
  for (let i = 0; i < num.length; i++) num[i] = den[i] > 0 ? num[i] / den[i] : p[i]
  return num
}

/**
 * Denoise a padded tile. `planes` are w×h opponent-colour planes with at
 * least `bm3dHalo` pixels of context around the core [m, w-m)×[m, h-m);
 * the returned planes cover only the core.
 */
export function bm3d(
  planes: Planes,
  w: number,
  h: number,
  m: number,
  sigma: number[],
  p: Bm3dParams,
  abort: () => boolean,
  psd?: Float32Array[],
): Planes | null {
  // Per-coefficient noise σ: the measured spectrum, or flat (white noise).
  const coef = [0, 1, 2].map((c) => {
    const s = new Float32Array(P)
    for (let j = 0; j < P; j++) s[j] = Math.max(1e-3, psd ? psd[c][j] : sigma[c])
    return s
  })
  // Match on the DCT guide when raw patch distances would be noise-dominated:
  // high noise, or correlated noise (low-frequency σ well above high-frequency σ).
  const cy = coef[0]
  const low = (cy[1] + cy[N1] + cy[N1 + 1]) / 3
  const high = (cy[P - 1] + cy[P - 2] + cy[P - 1 - N1] + cy[P - 2 - N1]) / 4
  const pixel = Math.sqrt(cy.reduce((a, v) => a + v * v, 0) / P)
  const guide = pixel > 40 || low > 1.5 * high ? dctGuide(planes[0], w, h, cy) : planes[0]
  if (abort()) return null
  const basic = stage(planes, planes, guide, w, h, coef, p, false, abort)
  if (!basic) return null
  const fin = p.twoStep ? stage(planes, basic, basic[0], w, h, coef, p, true, abort) : basic
  if (!fin) return null
  const cw = w - 2 * m
  const ch = h - 2 * m
  return fin.map((f) => {
    const o = new Float32Array(cw * ch)
    for (let y = 0; y < ch; y++) o.set(f.subarray((y + m) * w + m, (y + m) * w + m + cw), y * cw)
    return o
  }) as Planes
}

/**
 * One BM3D step over the whole tile; returns full-size planes. Step 1
 * filters `noisy`; step 2 uses `guide` (the basic estimate) for the Wiener
 * gains. Patches are grouped by similarity in `matchPlane`.
 */
function stage(
  noisy: Planes,
  guide: Planes,
  matchPlane: Float32Array,
  w: number,
  h: number,
  coef: Float32Array[],
  p: Bm3dParams,
  wiener: boolean,
  abort: () => boolean,
): Planes | null {
  const n = w * h
  const num: Planes = [new Float32Array(n), new Float32Array(n), new Float32Array(n)]
  const den: Planes = [new Float32Array(n), new Float32Array(n), new Float32Array(n)]
  const max = wiener ? p.n2Wien : p.n2Hard
  const ns = wiener ? p.ns2 : p.ns1
  const tau = wiener ? p.tauWien : p.tauHard
  const pos = new Int32Array(max)
  const dist = new Float32Array(max)
  const g = new Float32Array(max * P)
  const gb = new Float32Array(max * P)
  const xs = refPositions(w, p.step)
  const ys = refPositions(h, p.step)

  for (const ry of ys) {
    if (abort()) return null
    for (const rx of xs) {
      const k = match(matchPlane, w, h, rx, ry, ns, max, tau, pos, dist)
      for (let c = 0; c < 3; c++) {
        const sc = coef[c]
        for (let t = 0; t < k; t++) dct2(noisy[c], w, pos[t] % w, (pos[t] / w) | 0, g, t * P)
        wht(g, k)
        // Aggregation weight: inverse of the retained noise variance.
        let wgt: number
        if (!wiener) {
          let kept = 0
          for (let i = 0; i < k * P; i++) {
            const s = sc[i % P]
            if (Math.abs(g[i]) < p.lambda * s) g[i] = 0
            else kept += s * s
          }
          wgt = kept > 0 ? 1 / kept : 1
        } else {
          for (let t = 0; t < k; t++) dct2(guide[c], w, pos[t] % w, (pos[t] / w) | 0, gb, t * P)
          wht(gb, k)
          let kept = 0
          for (let i = 0; i < k * P; i++) {
            const s2 = sc[i % P] * sc[i % P]
            const b2 = gb[i] * gb[i]
            const f = b2 / (b2 + s2)
            g[i] *= f
            kept += f * f * s2
          }
          wgt = kept > 0 ? 1 / kept : 1
        }
        wht(g, k)
        const nc = num[c]
        const dc = den[c]
        for (let t = 0; t < k; t++) {
          idct2(g, t * P)
          const base = pos[t]
          for (let r = 0; r < N1; r++) {
            for (let q = 0; q < N1; q++) {
              const kw = wgt * KAISER[r * N1 + q]
              const i = base + r * w + q
              nc[i] += kw * g[t * P + r * N1 + q]
              dc[i] += kw
            }
          }
        }
      }
    }
  }
  return num.map((a, c) => {
    const d = den[c]
    const src = noisy[c]
    for (let i = 0; i < n; i++) a[i] = d[i] > 0 ? a[i] / d[i] : src[i]
    return a
  }) as Planes
}
