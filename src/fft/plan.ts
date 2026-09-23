import { nextSmooth, primeFactors, radixPlan } from './factor.ts'

/**
 * Prime radices up to this size get a direct O(p^2) butterfly. Larger
 * prime factors switch the whole transform to Bluestein's algorithm.
 */
const MAX_DIRECT_PRIME = 61

interface Stage {
  /** Radix of this pass. */
  p: number
  /** Length of the sub-transforms combined by this pass. */
  ns: number
  /** Twiddles laid out [k][r-1] as interleaved (re, im): e^{-2πi·k·r/(ns·p)}. */
  tw: Float64Array
  /** Generic-radix roots e^{-2πi·q/p}, interleaved; empty for specialised radices. */
  roots: Float64Array
}

/**
 * Exact complex DFT of one fixed length n (any n >= 1).
 *
 * Data is interleaved complex in a Float64Array: [re0, im0, re1, im1, ...].
 * Transforms run in place. Forward uses e^{-2πi·jk/n}; inverse is the
 * unnormalized conjugate transform, so inverse(forward(x)) = n·x.
 *
 * A plan owns scratch memory and is not re-entrant. Use one per thread.
 */
export class FFTPlan {
  readonly n: number
  private readonly stages: Stage[] = []
  private readonly blue: Bluestein | null = null
  private readonly scratch: Float64Array
  private readonly genIn: Float64Array
  private readonly genOut: Float64Array

  constructor(n: number) {
    if (!Number.isInteger(n) || n < 1) throw new Error(`FFT length must be a positive integer, got ${n}`)
    this.n = n
    const largest = primeFactors(n).at(-1) ?? 1
    let maxGeneric = 0
    if (largest > MAX_DIRECT_PRIME) {
      this.blue = new Bluestein(n)
      this.scratch = new Float64Array(0)
    } else {
      this.scratch = new Float64Array(2 * n)
      let ns = 1
      for (const p of radixPlan(n)) {
        this.stages.push(makeStage(p, ns))
        if (p > 5) maxGeneric = Math.max(maxGeneric, p)
        ns *= p
      }
    }
    this.genIn = new Float64Array(2 * maxGeneric)
    this.genOut = new Float64Array(2 * maxGeneric)
  }

  forward(x: Float64Array): void {
    if (this.blue) {
      this.blue.run(x)
      return
    }
    const n = this.n
    let src = x
    let dst = this.scratch
    for (const st of this.stages) {
      const q = n / st.p
      switch (st.p) {
        case 2:
          radix2(src, dst, q, st.ns, st.tw)
          break
        case 3:
          radix3(src, dst, q, st.ns, st.tw)
          break
        case 4:
          radix4(src, dst, q, st.ns, st.tw)
          break
        case 5:
          radix5(src, dst, q, st.ns, st.tw)
          break
        default:
          radixGeneric(src, dst, q, st, this.genIn, this.genOut)
      }
      const t = src
      src = dst
      dst = t
    }
    if (src !== x) x.set(src.subarray(0, 2 * n))
  }

  /** Unnormalized inverse: conj(forward(conj(x))). */
  inverse(x: Float64Array): void {
    const len = 2 * this.n
    for (let i = 1; i < len; i += 2) x[i] = -x[i]
    this.forward(x)
    for (let i = 1; i < len; i += 2) x[i] = -x[i]
  }
}

function makeStage(p: number, ns: number): Stage {
  const tw = new Float64Array(2 * ns * (p - 1))
  const span = ns * p
  for (let k = 0; k < ns; k++) {
    for (let r = 1; r < p; r++) {
      const a = (-2 * Math.PI * k * r) / span
      const o = 2 * (k * (p - 1) + r - 1)
      tw[o] = Math.cos(a)
      tw[o + 1] = Math.sin(a)
    }
  }
  let roots = new Float64Array(0)
  if (p > 5) {
    roots = new Float64Array(2 * p)
    for (let q = 0; q < p; q++) {
      const a = (-2 * Math.PI * q) / p
      roots[2 * q] = Math.cos(a)
      roots[2 * q + 1] = Math.sin(a)
    }
  }
  return { p, ns, tw, roots }
}

// Stockham autosort passes. Each combines p interleaved sub-transforms of
// length ns into transforms of length ns·p, reading from `src` with stride
// q = n/p and writing self-sorted output to `dst`, so no bit reversal is
// needed for any mix of radices.

function radix2(src: Float64Array, dst: Float64Array, q: number, ns: number, tw: Float64Array): void {
  for (let jb = 0; jb < q; jb += ns) {
    const db = jb * 2
    for (let k = 0; k < ns; k++) {
      const i0 = 2 * (jb + k)
      const i1 = i0 + 2 * q
      const wr = tw[2 * k]
      const wi = tw[2 * k + 1]
      const ar = src[i0]
      const ai = src[i0 + 1]
      const br = src[i1] * wr - src[i1 + 1] * wi
      const bi = src[i1] * wi + src[i1 + 1] * wr
      const d0 = 2 * (db + k)
      const d1 = d0 + 2 * ns
      dst[d0] = ar + br
      dst[d0 + 1] = ai + bi
      dst[d1] = ar - br
      dst[d1 + 1] = ai - bi
    }
  }
}

const S3 = Math.sqrt(3) / 2

function radix3(src: Float64Array, dst: Float64Array, q: number, ns: number, tw: Float64Array): void {
  const s = 2 * q
  for (let jb = 0; jb < q; jb += ns) {
    const db = jb * 3
    for (let k = 0; k < ns; k++) {
      const i0 = 2 * (jb + k)
      const t = 4 * k
      const ar = src[i0]
      const ai = src[i0 + 1]
      let xr = src[i0 + s]
      let xi = src[i0 + s + 1]
      const br = xr * tw[t] - xi * tw[t + 1]
      const bi = xr * tw[t + 1] + xi * tw[t]
      xr = src[i0 + 2 * s]
      xi = src[i0 + 2 * s + 1]
      const cr = xr * tw[t + 2] - xi * tw[t + 3]
      const ci = xr * tw[t + 3] + xi * tw[t + 2]
      const sr = br + cr
      const si = bi + ci
      const mr = ar - 0.5 * sr
      const mi = ai - 0.5 * si
      // -i·(√3/2)·(b - c)
      const ur = S3 * (bi - ci)
      const ui = -S3 * (br - cr)
      const d0 = 2 * (db + k)
      const d = 2 * ns
      dst[d0] = ar + sr
      dst[d0 + 1] = ai + si
      dst[d0 + d] = mr + ur
      dst[d0 + d + 1] = mi + ui
      dst[d0 + 2 * d] = mr - ur
      dst[d0 + 2 * d + 1] = mi - ui
    }
  }
}

function radix4(src: Float64Array, dst: Float64Array, q: number, ns: number, tw: Float64Array): void {
  const s = 2 * q
  for (let jb = 0; jb < q; jb += ns) {
    const db = jb * 4
    for (let k = 0; k < ns; k++) {
      const i0 = 2 * (jb + k)
      const t = 6 * k
      const ar = src[i0]
      const ai = src[i0 + 1]
      let xr = src[i0 + s]
      let xi = src[i0 + s + 1]
      const br = xr * tw[t] - xi * tw[t + 1]
      const bi = xr * tw[t + 1] + xi * tw[t]
      xr = src[i0 + 2 * s]
      xi = src[i0 + 2 * s + 1]
      const cr = xr * tw[t + 2] - xi * tw[t + 3]
      const ci = xr * tw[t + 3] + xi * tw[t + 2]
      xr = src[i0 + 3 * s]
      xi = src[i0 + 3 * s + 1]
      const er = xr * tw[t + 4] - xi * tw[t + 5]
      const ei = xr * tw[t + 5] + xi * tw[t + 4]
      const t0r = ar + cr
      const t0i = ai + ci
      const t1r = ar - cr
      const t1i = ai - ci
      const t2r = br + er
      const t2i = bi + ei
      // -i·(b - e)
      const t3r = bi - ei
      const t3i = er - br
      const d0 = 2 * (db + k)
      const d = 2 * ns
      dst[d0] = t0r + t2r
      dst[d0 + 1] = t0i + t2i
      dst[d0 + d] = t1r + t3r
      dst[d0 + d + 1] = t1i + t3i
      dst[d0 + 2 * d] = t0r - t2r
      dst[d0 + 2 * d + 1] = t0i - t2i
      dst[d0 + 3 * d] = t1r - t3r
      dst[d0 + 3 * d + 1] = t1i - t3i
    }
  }
}

const C1 = Math.cos((2 * Math.PI) / 5)
const C2 = Math.cos((4 * Math.PI) / 5)
const S1 = Math.sin((2 * Math.PI) / 5)
const S2 = Math.sin((4 * Math.PI) / 5)

function radix5(src: Float64Array, dst: Float64Array, q: number, ns: number, tw: Float64Array): void {
  const s = 2 * q
  for (let jb = 0; jb < q; jb += ns) {
    const db = jb * 5
    for (let k = 0; k < ns; k++) {
      const i0 = 2 * (jb + k)
      const t = 8 * k
      const a0r = src[i0]
      const a0i = src[i0 + 1]
      let xr = src[i0 + s]
      let xi = src[i0 + s + 1]
      const a1r = xr * tw[t] - xi * tw[t + 1]
      const a1i = xr * tw[t + 1] + xi * tw[t]
      xr = src[i0 + 2 * s]
      xi = src[i0 + 2 * s + 1]
      const a2r = xr * tw[t + 2] - xi * tw[t + 3]
      const a2i = xr * tw[t + 3] + xi * tw[t + 2]
      xr = src[i0 + 3 * s]
      xi = src[i0 + 3 * s + 1]
      const a3r = xr * tw[t + 4] - xi * tw[t + 5]
      const a3i = xr * tw[t + 5] + xi * tw[t + 4]
      xr = src[i0 + 4 * s]
      xi = src[i0 + 4 * s + 1]
      const a4r = xr * tw[t + 6] - xi * tw[t + 7]
      const a4i = xr * tw[t + 7] + xi * tw[t + 6]
      const b1r = a1r + a4r
      const b1i = a1i + a4i
      const b2r = a2r + a3r
      const b2i = a2i + a3i
      const d1r = a1r - a4r
      const d1i = a1i - a4i
      const d2r = a2r - a3r
      const d2i = a2i - a3i
      const t1r = a0r + C1 * b1r + C2 * b2r
      const t1i = a0i + C1 * b1i + C2 * b2i
      const t2r = a0r + C2 * b1r + C1 * b2r
      const t2i = a0i + C2 * b1i + C1 * b2i
      const u1r = S1 * d1r + S2 * d2r
      const u1i = S1 * d1i + S2 * d2i
      const u2r = S2 * d1r - S1 * d2r
      const u2i = S2 * d1i - S1 * d2i
      const o = 2 * (db + k)
      const d = 2 * ns
      dst[o] = a0r + b1r + b2r
      dst[o + 1] = a0i + b1i + b2i
      // t - i·u  and  t + i·u
      dst[o + d] = t1r + u1i
      dst[o + d + 1] = t1i - u1r
      dst[o + 4 * d] = t1r - u1i
      dst[o + 4 * d + 1] = t1i + u1r
      dst[o + 2 * d] = t2r + u2i
      dst[o + 2 * d + 1] = t2i - u2r
      dst[o + 3 * d] = t2r - u2i
      dst[o + 3 * d + 1] = t2i + u2r
    }
  }
}

function radixGeneric(
  src: Float64Array,
  dst: Float64Array,
  q: number,
  st: Stage,
  v: Float64Array,
  out: Float64Array,
): void {
  const { p, ns, tw, roots } = st
  for (let jb = 0; jb < q; jb += ns) {
    const db = jb * p
    for (let k = 0; k < ns; k++) {
      const i0 = 2 * (jb + k)
      const t = 2 * k * (p - 1)
      v[0] = src[i0]
      v[1] = src[i0 + 1]
      for (let r = 1; r < p; r++) {
        const xr = src[i0 + 2 * r * q]
        const xi = src[i0 + 2 * r * q + 1]
        const wr = tw[t + 2 * (r - 1)]
        const wi = tw[t + 2 * (r - 1) + 1]
        v[2 * r] = xr * wr - xi * wi
        v[2 * r + 1] = xr * wi + xi * wr
      }
      for (let f = 0; f < p; f++) {
        let sr = 0
        let si = 0
        let e = 0
        for (let r = 0; r < p; r++) {
          const wr = roots[2 * e]
          const wi = roots[2 * e + 1]
          sr += v[2 * r] * wr - v[2 * r + 1] * wi
          si += v[2 * r] * wi + v[2 * r + 1] * wr
          e += f
          if (e >= p) e -= p
        }
        out[2 * f] = sr
        out[2 * f + 1] = si
      }
      const o = 2 * (db + k)
      for (let f = 0; f < p; f++) {
        dst[o + 2 * f * ns] = out[2 * f]
        dst[o + 2 * f * ns + 1] = out[2 * f + 1]
      }
    }
  }
}

/**
 * Bluestein / chirp-z: rewrites a length-n DFT as a circular convolution of
 * length M >= 2n-1 (M chosen 5-smooth), which the direct Stockham plan handles.
 */
class Bluestein {
  private readonly n: number
  private readonly inner: FFTPlan
  /** Chirp w_k = e^{-iπk²/n}, interleaved. */
  private readonly chirp: Float64Array
  /** FFT of the conjugate chirp kernel, pre-scaled by 1/M. */
  private readonly kernel: Float64Array
  private readonly work: Float64Array

  constructor(n: number) {
    this.n = n
    const m = nextSmooth(2 * n - 1)
    this.inner = new FFTPlan(m)
    this.chirp = new Float64Array(2 * n)
    const twoN = 2 * n
    for (let k = 0; k < n; k++) {
      // k² mod 2n keeps the angle small, and so accurate, for large k.
      const e = (k * k) % twoN
      const a = (-Math.PI * e) / n
      this.chirp[2 * k] = Math.cos(a)
      this.chirp[2 * k + 1] = Math.sin(a)
    }
    const b = new Float64Array(2 * m)
    b[0] = 1
    for (let k = 1; k < n; k++) {
      const re = this.chirp[2 * k]
      const im = -this.chirp[2 * k + 1]
      b[2 * k] = re
      b[2 * k + 1] = im
      b[2 * (m - k)] = re
      b[2 * (m - k) + 1] = im
    }
    this.inner.forward(b)
    for (let i = 0; i < 2 * m; i++) b[i] /= m
    this.kernel = b
    this.work = new Float64Array(2 * m)
  }

  run(x: Float64Array): void {
    const { n, chirp, kernel, work: a } = this
    a.fill(0)
    for (let k = 0; k < n; k++) {
      const xr = x[2 * k]
      const xi = x[2 * k + 1]
      const wr = chirp[2 * k]
      const wi = chirp[2 * k + 1]
      a[2 * k] = xr * wr - xi * wi
      a[2 * k + 1] = xr * wi + xi * wr
    }
    this.inner.forward(a)
    for (let i = 0; i < a.length; i += 2) {
      const ar = a[i]
      const ai = a[i + 1]
      const br = kernel[i]
      const bi = kernel[i + 1]
      a[i] = ar * br - ai * bi
      a[i + 1] = ar * bi + ai * br
    }
    this.inner.inverse(a)
    for (let k = 0; k < n; k++) {
      const ar = a[2 * k]
      const ai = a[2 * k + 1]
      const wr = chirp[2 * k]
      const wi = chirp[2 * k + 1]
      x[2 * k] = ar * wr - ai * wi
      x[2 * k + 1] = ar * wi + ai * wr
    }
  }
}
