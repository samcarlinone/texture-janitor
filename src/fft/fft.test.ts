// Run with: npm test   (node --test, with native TypeScript type stripping)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FFTPlan, RealFFT2D, forwardRealPair, halfLength, inverseRealPair, nextSmooth, primeFactors } from './index.ts'

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5
  }
}

function naiveDFT(x: Float64Array, n: number, sign = -1): Float64Array {
  const out = new Float64Array(2 * n)
  for (let k = 0; k < n; k++) {
    let sr = 0
    let si = 0
    for (let j = 0; j < n; j++) {
      const a = (sign * 2 * Math.PI * ((j * k) % n)) / n
      const c = Math.cos(a)
      const s = Math.sin(a)
      sr += x[2 * j] * c - x[2 * j + 1] * s
      si += x[2 * j] * s + x[2 * j + 1] * c
    }
    out[2 * k] = sr
    out[2 * k + 1] = si
  }
  return out
}

function maxRelErr(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let err = 0
  let mag = 1e-300
  for (let i = 0; i < a.length; i++) {
    err = Math.max(err, Math.abs(a[i] - b[i]))
    mag = Math.max(mag, Math.abs(b[i]))
  }
  return err / mag
}

function randomComplex(n: number, r: () => number): Float64Array {
  const x = new Float64Array(2 * n)
  for (let i = 0; i < x.length; i++) x[i] = r()
  return x
}

test('factor helpers', () => {
  assert.deepEqual(primeFactors(1), [])
  assert.deepEqual(primeFactors(360), [2, 2, 2, 3, 3, 5])
  assert.deepEqual(primeFactors(4001), [4001])
  assert.equal(nextSmooth(7), 8)
  assert.equal(nextSmooth(4001), 4050)
})

test('1D forward matches naive DFT for every length 1..160', () => {
  const r = rng(1)
  for (let n = 1; n <= 160; n++) {
    const x = randomComplex(n, r)
    const want = naiveDFT(x, n)
    const got = x.slice()
    new FFTPlan(n).forward(got)
    assert.ok(maxRelErr(got, want) < 1e-12, `n=${n} err=${maxRelErr(got, want)}`)
  }
})

test('1D forward matches naive DFT for awkward lengths (large primes → Bluestein)', () => {
  const r = rng(2)
  for (const n of [67, 127, 211, 257, 331, 49 * 67, 997, 1009, 2 * 3 * 5 * 7 * 11, 4096, 4001]) {
    const x = randomComplex(n, r)
    const want = naiveDFT(x, n)
    const got = x.slice()
    new FFTPlan(n).forward(got)
    assert.ok(maxRelErr(got, want) < 1e-10, `n=${n} err=${maxRelErr(got, want)}`)
  }
})

test('1D inverse(forward(x)) = n·x, including big sizes', () => {
  const r = rng(3)
  for (const n of [1, 2, 3, 1000, 1920, 4096, 6000, 7919, 8191, 65537]) {
    const x = randomComplex(n, r)
    const y = x.slice()
    const p = new FFTPlan(n)
    p.forward(y)
    p.inverse(y)
    for (let i = 0; i < y.length; i++) y[i] /= n
    assert.ok(maxRelErr(y, x) < 1e-11, `n=${n} err=${maxRelErr(y, x)}`)
  }
})

test('real pair transform matches complex FFT of each signal', () => {
  const r = rng(4)
  for (const n of [1, 2, 3, 4, 5, 8, 9, 17, 100, 101, 257]) {
    const a = Array.from({ length: n }, r)
    const b = Array.from({ length: n }, r)
    const plan = new FFTPlan(n)
    const z = new Float64Array(2 * n)
    for (let j = 0; j < n; j++) {
      z[2 * j] = a[j]
      z[2 * j + 1] = b[j]
    }
    const nh = halfLength(n)
    const outA = new Float64Array(2 * nh)
    const outB = new Float64Array(2 * nh)
    forwardRealPair(plan, z, outA, outB)
    const ca = new Float64Array(2 * n)
    const cb = new Float64Array(2 * n)
    a.forEach((v, j) => (ca[2 * j] = v))
    b.forEach((v, j) => (cb[2 * j] = v))
    const wa = naiveDFT(ca, n).subarray(0, 2 * nh)
    const wb = naiveDFT(cb, n).subarray(0, 2 * nh)
    assert.ok(maxRelErr(outA, wa) < 1e-12, `A n=${n}`)
    assert.ok(maxRelErr(outB, wb) < 1e-12, `B n=${n}`)

    inverseRealPair(plan, outA, outB, z)
    for (let j = 0; j < n; j++) {
      assert.ok(Math.abs(z[2 * j] / n - a[j]) < 1e-12, `inv A n=${n}`)
      assert.ok(Math.abs(z[2 * j + 1] / n - b[j]) < 1e-12, `inv B n=${n}`)
    }
  }
})

function naive2D(img: Float64Array, w: number, h: number): Float64Array {
  // Returns full W×H complex spectrum, [ky][kx].
  const out = new Float64Array(2 * w * h)
  for (let ky = 0; ky < h; ky++) {
    for (let kx = 0; kx < w; kx++) {
      let sr = 0
      let si = 0
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const a = -2 * Math.PI * (((kx * x) % w) / w + ((ky * y) % h) / h)
          sr += img[y * w + x] * Math.cos(a)
          si += img[y * w + x] * Math.sin(a)
        }
      }
      out[2 * (ky * w + kx)] = sr
      out[2 * (ky * w + kx) + 1] = si
    }
  }
  return out
}

function run2D(f: RealFFT2D, img: Float64Array, spec: Float32Array, chunks: number): void {
  const { width: w, height: h, halfWidth: wh } = f
  const read = (y: number, out: Float64Array) => out.set(img.subarray(y * w, (y + 1) * w))
  // Split into uneven chunks, the way worker threads would.
  const ys = splits(h, chunks)
  for (let i = 0; i < ys.length - 1; i++) f.forwardRows(ys[i], ys[i + 1], read, spec)
  const xs = splits(wh, chunks)
  for (let i = 0; i < xs.length - 1; i++) f.forwardColumns(xs[i], xs[i + 1], spec)
}

function splits(n: number, k: number): number[] {
  const out = [0]
  for (let i = 1; i < k; i++) out.push(Math.round((n * i) / k) | 1)
  out.push(n)
  return [...new Set(out.map((v) => Math.min(v, n)))].sort((a, b) => a - b)
}

test('2D real forward matches naive 2D DFT (odd/even sizes, chunked)', () => {
  const r = rng(5)
  for (const [w, h] of [
    [1, 1],
    [1, 7],
    [7, 1],
    [4, 4],
    [5, 3],
    [6, 9],
    [13, 8],
    [16, 11],
    [67, 5],
  ]) {
    const img = Float64Array.from({ length: w * h }, r)
    const f = new RealFFT2D(w, h)
    const spec = new Float32Array(f.spectrumLength)
    run2D(f, img, spec, 3)
    const want = naive2D(img, w, h)
    const wantHalf = new Float64Array(f.spectrumLength)
    for (let ky = 0; ky < h; ky++) {
      for (let kx = 0; kx < f.halfWidth; kx++) {
        wantHalf[2 * (ky * f.halfWidth + kx)] = want[2 * (ky * w + kx)]
        wantHalf[2 * (ky * f.halfWidth + kx) + 1] = want[2 * (ky * w + kx) + 1]
      }
    }
    assert.ok(maxRelErr(spec, wantHalf) < 1e-6, `${w}x${h} err=${maxRelErr(spec, wantHalf)}`)
  }
})

test('2D round trip reproduces 8-bit images exactly at odd, prime and large sizes', () => {
  const r = rng(6)
  for (const [w, h] of [
    [3, 2],
    [101, 67],
    [640, 480],
    [1009, 257],
    [1500, 1001],
  ]) {
    const img = Float64Array.from({ length: w * h }, () => Math.round((r() + 0.5) * 255))
    const f = new RealFFT2D(w, h)
    const spec = new Float32Array(f.spectrumLength)
    run2D(f, img, spec, 4)
    const work = new Float32Array(f.spectrumLength)
    const xs = splits(f.halfWidth, 4)
    for (let i = 0; i < xs.length - 1; i++) f.inverseColumns(xs[i], xs[i + 1], spec, work, null)
    let worst = 0
    const ys = splits(h, 4)
    for (let i = 0; i < ys.length - 1; i++) {
      f.inverseRows(ys[i], ys[i + 1], work, (y, row) => {
        for (let x = 0; x < w; x++) worst = Math.max(worst, Math.abs(row[x] - img[y * w + x]))
      })
    }
    assert.ok(worst < 0.05, `${w}x${h} worst=${worst}`)
  }
})

test('inverse with a Hermitian multiplier applies a real filter', () => {
  // Multiplier = 0 everywhere except DC → output is the image mean.
  const w = 37
  const h = 20
  const r = rng(7)
  const img = Float64Array.from({ length: w * h }, r)
  const mean = img.reduce((a, b) => a + b, 0) / (w * h)
  const f = new RealFFT2D(w, h)
  const spec = new Float32Array(f.spectrumLength)
  run2D(f, img, spec, 1)
  const mult = new Float32Array(f.spectrumLength)
  mult[0] = 1
  const work = new Float32Array(f.spectrumLength)
  f.inverseColumns(0, f.halfWidth, spec, work, mult)
  f.inverseRows(0, h, work, (_y, row) => {
    for (let x = 0; x < w; x++) assert.ok(Math.abs(row[x] - mean) < 1e-6)
  })
})

test('abort check stops a pass early', () => {
  const f = new RealFFT2D(64, 64)
  const spec = new Float32Array(f.spectrumLength)
  assert.equal(f.forwardColumns(0, f.halfWidth, spec, () => true), false)
})
