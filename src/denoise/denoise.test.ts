// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bm3d, bm3dHalo, bm3dParams, estimateNoiseRGBA, estimateSigma, nlm, nlmHalo, nlmParams, padReflect, type Planes } from './index.ts'

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), s | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r())

/** Piecewise-smooth test scene in 3 planes: gradients, discs, stripes. */
function scene(w: number, h: number): Planes {
  const p: Planes = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)]
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const disc = Math.hypot(x - w * 0.35, y - h * 0.4) < w * 0.2 ? 60 : 0
      const stripes = x > w * 0.6 ? 40 * Math.sign(Math.sin(x * 0.4)) : 0
      p[0][i] = 120 + 0.3 * x + disc + stripes
      p[1][i] = 20 + disc * 0.5 - 0.1 * y
      p[2][i] = -10 + stripes * 0.3
    }
  }
  return p
}

function addNoise(p: Planes, sigma: number, seed: number): Planes {
  const r = rng(seed)
  return p.map((a) => a.map((v) => v + sigma * gauss(r))) as Planes
}

function psnr(a: Planes, b: Planes): number {
  let se = 0
  let n = 0
  for (let c = 0; c < 3; c++) for (let i = 0; i < a[c].length; i++, n++) se += (a[c][i] - b[c][i]) ** 2
  return 10 * Math.log10((255 * 255) / (se / n))
}

function runTiled(
  noisy: Planes,
  w: number,
  h: number,
  m: number,
  f: (p: Planes, w: number, h: number, m: number) => Planes | null,
): Planes {
  const padded = noisy.map((a) => padReflect(a, w, h, m, m, m, m)) as Planes
  return f(padded, w + 2 * m, h + 2 * m, m)!
}

const W = 96
const H = 80
const clean = scene(W, H)
const noisy = addNoise(clean, 30, 1)
const never = () => false

test('noise estimate is close to the true σ', () => {
  const s = estimateSigma(noisy[0], W, H)
  assert.ok(Math.abs(s - 30) < 4, `estimated ${s}`)
})

test('block noise estimate matches white noise on a flat image', () => {
  const r = rng(3)
  const w = 200
  const h = 200
  const rgba = new Uint8ClampedArray(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : 128 + 15 * gauss(r)))
  const est = estimateNoiseRGBA(rgba, w, h)
  for (const s of est.opponent) assert.ok(Math.abs(s - 15) < 1.5, `opponent σ ${s}`)
  assert.ok(Math.abs(est.luma - 15 * Math.hypot(0.299, 0.587, 0.114)) < 1.2, `luma σ ${est.luma}`)
})

test('block noise estimate sees correlated noise the wavelet estimate misses', () => {
  // Flat grey with noise that is constant over 2×2 blocks (like upscaled or
  // chroma-subsampled noise): per-pixel σ is 20 in every channel.
  const w = 256
  const h = 256
  const r = rng(9)
  const rgba = new Uint8ClampedArray(w * h * 4)
  const cell = new Float32Array((w / 2) * (h / 2) * 3).map(() => 20 * gauss(r))
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = ((y >> 1) * (w / 2) + (x >> 1)) * 3
      for (let ch = 0; ch < 3; ch++) rgba[4 * (y * w + x) + ch] = 128 + cell[c + ch]
      rgba[4 * (y * w + x) + 3] = 255
    }
  }
  const est = estimateNoiseRGBA(rgba, w, h)
  for (const s of est.opponent) assert.ok(Math.abs(s - 20) < 3, `opponent σ ${s}`)
  // The finest-scale Haar estimate sees none of it (2×2-constant noise has no HH energy).
  const y = new Float32Array(w * h).map((_, i) => rgba[4 * i])
  assert.ok(estimateSigma(y, w, h) < 2)
})

test('reflect padding mirrors without repeating the edge', () => {
  const p = padReflect(Float32Array.from([1, 2, 3]), 3, 1, 2, 0, 2, 0)
  assert.deepEqual(Array.from(p), [3, 2, 1, 2, 3, 2, 1])
})

test('NLM improves PSNR at σ=30', () => {
  const prm = nlmParams(30, 'balanced')
  const out = runTiled(noisy, W, H, nlmHalo(prm), (p, w, h, m) => nlm(p, w, h, m, [30, 30, 30], prm, never))
  const before = psnr(noisy, clean)
  const after = psnr(out, clean)
  assert.ok(after > before + 6, `PSNR ${before.toFixed(2)} → ${after.toFixed(2)}`)
})

test('BM3D improves PSNR at σ=30, and two steps beat one', () => {
  const before = psnr(noisy, clean)
  const run = (q: 'fast' | 'balanced') => {
    const prm = bm3dParams(30, q)
    return psnr(
      runTiled(noisy, W, H, bm3dHalo(prm), (p, w, h, m) => bm3d(p, w, h, m, [30, 30, 30], prm, never)),
      clean,
    )
  }
  const fast = run('fast')
  const bal = run('balanced')
  assert.ok(fast > before + 7, `fast ${before.toFixed(2)} → ${fast.toFixed(2)}`)
  assert.ok(bal > fast, `balanced ${bal.toFixed(2)} vs fast ${fast.toFixed(2)}`)
})

test('abort stops a denoiser', () => {
  const prm = bm3dParams(30, 'fast')
  assert.equal(runTiled(noisy, W, H, bm3dHalo(prm), (p, w, h, m) => bm3d(p, w, h, m, [30, 30, 30], prm, () => true)), null)
})
