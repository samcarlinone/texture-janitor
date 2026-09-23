import { FFTPlan, RealFFT2D } from '../fft/index.ts'
import { QMAX, binOf, channelIndex, makeDims, makeRange, quantize, shapeBounds, shapeWeight, type Dims } from './layout.ts'
import {
  bm3d,
  bm3dParams,
  fromOpponent,
  nlm,
  nlmParams,
  padReflect,
  toOpponent,
  wienerGains,
  type Planes,
} from '../denoise/index.ts'
import { LUMA, editedMag } from './edited.ts'
import { deflate, filterPixels, inflate, unfilterPixels } from '../project/codec.ts'
import { encodePng } from './png.ts'
import type { DenoiseResult, EnvelopeResult, FwdColsResult, LocalResult, SharedBuffers, Task } from './protocol.ts'


let B: SharedBuffers
let d: Dims
let src: Uint8ClampedArray
let out: Uint8ClampedArray
let spec: Float32Array[]
let mult: Float32Array
/** Multiplier per colour channel: all `mult` when shared, or R = mult, G, B. */
let mults: Float32Array[]
let work: Float32Array
let magY: Float32Array
let disp0: Uint16Array
let ctrl: Int32Array
let preview: Uint8ClampedArray

// Plans are built lazily; building them costs about as much as one pass.
let full: RealFFT2D | null = null
const fullFFT = () => (full ??= new RealFFT2D(d.w, d.h))
let small: { fft: RealFFT2D; buf: Float32Array; tapX: Float32Array; tapY: Float32Array } | null = null
const planCache = new Map<number, FFTPlan>()
const plan = (n: number) => {
  let p = planCache.get(n)
  if (!p) {
    if (planCache.size > 8) planCache.clear()
    p = new FFTPlan(n)
    planCache.set(n, p)
  }
  return p
}

function init(buffers: SharedBuffers): void {
  B = buffers
  d = makeDims(B.w, B.h)
  src = new Uint8ClampedArray(B.src)
  out = new Uint8ClampedArray(B.out)
  spec = B.spec.map((b) => new Float32Array(b))
  mult = new Float32Array(B.mult)
  mults = [mult, mult, mult]
  work = new Float32Array(B.work)
  magY = new Float32Array(B.magY)
  disp0 = new Uint16Array(B.disp0)
  ctrl = new Int32Array(B.ctrl)
  preview = new Uint8ClampedArray(B.preview)
  full = null
  small = null
}

function fwdRows(y0: number, y1: number): void {
  const f = fullFFT()
  const w = d.w
  for (let c = 0; c < 3; c++) {
    f.forwardRows(
      y0,
      y1,
      (y, row) => {
        const base = y * w * 4 + c
        for (let x = 0; x < w; x++) row[x] = src[base + 4 * x]
      },
      spec[c],
    )
  }
}

function fwdCols(x0: number, x1: number): FwdColsResult {
  const f = fullFFT()
  for (let c = 0; c < 3; c++) f.forwardColumns(x0, x1, spec[c])
  const [R, G, Bl] = spec
  const { wh, h } = d
  let maxLog = 0
  const count = (x1 - x0) * h
  const step = Math.max(1, Math.floor(count / 4000))
  const samples: number[] = []
  let n = 0
  for (let y = 0; y < h; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * wh + x
      const re = LUMA[0] * R[2 * i] + LUMA[1] * G[2 * i] + LUMA[2] * Bl[2 * i]
      const im = LUMA[0] * R[2 * i + 1] + LUMA[1] * G[2 * i + 1] + LUMA[2] * Bl[2 * i + 1]
      const m = Math.hypot(re, im)
      magY[i] = m
      if (i !== 0) {
        const l = Math.log1p(m)
        if (l > maxLog) maxLog = l
        if (n++ % step === 0) samples.push(l)
      }
    }
  }
  return { maxLog, samples: Float32Array.from(samples) }
}

function fillDisp0(y0: number, y1: number, range: ReturnType<typeof makeRange>, ch: number): void {
  const { w, cx, cy } = d
  for (let dy = y0; dy < y1; dy++) {
    const ky = dy - cy
    const row = dy * w
    for (let dx = 0; dx < w; dx++) {
      const b = binOf(d, dx - cx, ky)
      const i = b < 0 ? ~b : b
      disp0[row + dx] = quantize(editedMag(i, ch, spec, mults, magY), range)
    }
  }
}

function invCols(c: number, x0: number, x1: number, gen: number): boolean {
  const abort = () => Atomics.load(ctrl, 0) !== gen
  return fullFFT().inverseColumns(x0, x1, spec[c], work, mults[c], abort)
}

function invRows(c: number, y0: number, y1: number, gen: number): boolean {
  const abort = () => Atomics.load(ctrl, 0) !== gen
  const w = d.w
  return fullFFT().inverseRows(
    y0,
    y1,
    work,
    (y, row) => {
      const base = y * w * 4 + c
      for (let x = 0; x < w; x++) out[base + 4 * x] = row[x]
    },
    abort,
  )
}

/** Raised-cosine roll-off over the top 40% of the band, to tame ringing in the low-pass preview. */
function taper(n: number, len: number, signed: boolean): Float32Array {
  const t = new Float32Array(len)
  const half = n / 2 + 1
  for (let i = 0; i < len; i++) {
    const k = signed && i >= n - (n >> 1) ? n - i : i
    const u = k / half
    t[i] = u < 0.6 ? 1 : 0.5 * (1 + Math.cos((Math.PI * (u - 0.6)) / 0.4))
  }
  return t
}

/**
 * Exact low-pass downsample of channel c: take the centered pw×ph block of
 * the edited spectrum and inverse-transform it at that size.
 */
function renderPreview(c: number): void {
  const { pw, ph } = B
  if (!small) {
    const fft = new RealFFT2D(pw, ph)
    small = {
      fft,
      buf: new Float32Array(fft.spectrumLength),
      tapX: taper(pw, fft.halfWidth, false),
      tapY: taper(ph, ph, true),
    }
  }
  const { fft, buf, tapX, tapY } = small
  const pwh = fft.halfWidth
  const S = spec[c]
  for (let sy = 0; sy < ph; sy++) {
    const ky = sy >= ph - (ph >> 1) ? sy - ph : sy
    const by = ((ky % d.h) + d.h) % d.h
    for (let kx = 0; kx < pwh; kx++) {
      const i = 2 * (by * d.wh + kx)
      const o = 2 * (sy * pwh + kx)
      const t = tapX[kx] * tapY[sy]
      const re = S[i]
      const im = S[i + 1]
      const mr = mults[c][i]
      const mi = mults[c][i + 1]
      buf[o] = (re * mr - im * mi) * t
      buf[o + 1] = (re * mi + im * mr) * t
    }
  }
  fft.inverseColumns(0, pwh, buf, buf, null)
  // inverseRows normalizes by 1/(pw·ph); the full-size spectrum needs 1/(W·H).
  const k = (pw * ph) / (d.w * d.h)
  fft.inverseRows(0, ph, buf, (y, row) => {
    const base = y * pw * 4 + c
    for (let x = 0; x < pw; x++) preview[base + 4 * x] = row[x] * k
  })
  if (c === 0) {
    for (let y = 0; y < ph; y++) {
      const sy = Math.min(d.h - 1, Math.floor(((y + 0.5) * d.h) / ph))
      for (let x = 0; x < pw; x++) {
        const sx = Math.min(d.w - 1, Math.floor(((x + 0.5) * d.w) / pw))
        preview[(y * pw + x) * 4 + 3] = src[(sy * d.w + sx) * 4 + 3]
      }
    }
  }
}

/**
 * Amplitude envelope of the image content inside a spectrum selection:
 * |IFFT(Y restricted to the selection)|, the local strength of those
 * frequencies at each image position. The selection is demodulated to DC
 * first, which leaves |·| unchanged and lets a small grid sample it exactly.
 */
function envelope(shape: Parameters<typeof shapeWeight>[0], gw: number, gh: number): EnvelopeResult {
  const env = new Float32Array(gw * gh)
  const bb = shapeBounds(d, shape)
  if (!bb) return { env, gw, gh }
  const g = new Float64Array(2 * gw * gh)
  const mx = Math.round((bb.x0 + bb.x1) / 2)
  const my = Math.round((bb.y0 + bb.y1) / 2)
  const [R, G, Bl] = spec
  for (let dy = bb.y0; dy < bb.y1; dy++) {
    for (let dx = bb.x0; dx < bb.x1; dx++) {
      const wgt = shapeWeight(shape, dx, dy)
      if (wgt <= 0) continue
      const b = binOf(d, dx - d.cx, dy - d.cy)
      const i = b < 0 ? ~b : b
      // Edited luminance: Σ weight · spectrum · that channel's multiplier.
      let re = 0
      let im = 0
      const S = [R, G, Bl]
      for (let c = 0; c < 3; c++) {
        const sr = S[c][2 * i]
        const si = S[c][2 * i + 1]
        const mr = mults[c][2 * i]
        const mi = mults[c][2 * i + 1]
        re += LUMA[c] * (sr * mr - si * mi)
        im += LUMA[c] * (sr * mi + si * mr)
      }
      if (b < 0) im = -im
      const gx = (((dx - mx) % gw) + gw) % gw
      const gy = (((dy - my) % gh) + gh) % gh
      const o = 2 * (gy * gw + gx)
      g[o] += re * wgt
      g[o + 1] += im * wgt
    }
  }
  const rp = plan(gw)
  const row = new Float64Array(2 * gw)
  for (let y = 0; y < gh; y++) {
    row.set(g.subarray(2 * y * gw, 2 * (y + 1) * gw))
    rp.inverse(row)
    g.set(row, 2 * y * gw)
  }
  const cp = plan(gh)
  const col = new Float64Array(2 * gh)
  for (let x = 0; x < gw; x++) {
    for (let y = 0; y < gh; y++) {
      col[2 * y] = g[2 * (y * gw + x)]
      col[2 * y + 1] = g[2 * (y * gw + x) + 1]
    }
    cp.inverse(col)
    for (let y = 0; y < gh; y++) env[y * gw + x] = Math.hypot(col[2 * y], col[2 * y + 1]) / (d.w * d.h)
  }
  return { env, gw, gh }
}

/** Log-magnitude spectrum of an image patch (luminance), Hann-windowed, centered. */
function localSpectrum(lum: Float32Array, pw: number, ph: number): LocalResult {
  let mean = 0
  for (let i = 0; i < lum.length; i++) mean += lum[i]
  mean /= lum.length
  const hx = Float64Array.from({ length: pw }, (_, i) => (pw > 1 ? 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (pw - 1)) : 1))
  const hy = Float64Array.from({ length: ph }, (_, i) => (ph > 1 ? 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (ph - 1)) : 1))
  const f = new RealFFT2D(pw, ph)
  const s = new Float32Array(f.spectrumLength)
  f.forwardRows(
    0,
    ph,
    (y, row) => {
      for (let x = 0; x < pw; x++) row[x] = (lum[y * pw + x] - mean) * hx[x] * hy[y]
    },
    s,
  )
  f.forwardColumns(0, f.halfWidth, s)
  const ld = makeDims(pw, ph)
  const logs = new Float32Array(pw * ph)
  let hi = 0
  for (let dy = 0; dy < ph; dy++) {
    for (let dx = 0; dx < pw; dx++) {
      const b = binOf(ld, dx - ld.cx, dy - ld.cy)
      const i = b < 0 ? ~b : b
      const l = Math.log1p(Math.hypot(s[2 * i], s[2 * i + 1]))
      logs[dy * pw + dx] = l
      if (i !== 0 && l > hi) hi = l
    }
  }
  const sample = logs.filter((_, i) => i % Math.max(1, Math.floor(logs.length / 5000)) === 0).sort()
  const range = makeRange(sample[Math.floor(sample.length * 0.01)] ?? 0, hi)
  const map = new Uint16Array(pw * ph)
  for (let i = 0; i < map.length; i++) {
    const q = (logs[i] - range.lo) * range.scale
    map[i] = q <= 0 ? 0 : q >= QMAX ? QMAX : q
  }
  return { map, pw, ph }
}

function denoiseTile(t: Extract<Task, { type: 'denoise' }>): DenoiseResult {
  const abort = () => Atomics.load(ctrl, 1) !== t.gen
  const [l, tp, r, b] = t.missing
  const pw = t.tw + l + r
  const ph = t.th + tp + b
  const planes = toOpponent(t.rgba, t.tw * t.th).map((p) => padReflect(p, t.tw, t.th, l, tp, r, b)) as Planes
  const s = Math.max(...t.sigma)
  const out =
    t.algo === 'nlm'
      ? nlm(planes, pw, ph, t.halo, t.sigma, nlmParams(s, t.quality), abort)
      : bm3d(planes, pw, ph, t.halo, t.sigma, bm3dParams(t.sigma[0], t.quality), abort, t.psd ?? undefined)
  if (!out) return { rgba: null }
  const n = (pw - 2 * t.halo) * (ph - 2 * t.halo)
  const rgba = new Uint8ClampedArray(4 * n)
  fromOpponent(out, rgba, n)
  return { rgba }
}

async function handle(t: Task): Promise<{ result: unknown; transfer?: Transferable[] }> {
  switch (t.type) {
    case 'init':
      init(t.buffers)
      return { result: null }
    case 'mults':
      mults = t.gb ? [mult, new Float32Array(t.gb[0]), new Float32Array(t.gb[1])] : [mult, mult, mult]
      return { result: null }
    case 'fwdRows':
      fwdRows(t.y0, t.y1)
      return { result: null }
    case 'fwdCols': {
      const r = fwdCols(t.x0, t.x1)
      return { result: r, transfer: [r.samples.buffer] }
    }
    case 'disp0':
      fillDisp0(t.y0, t.y1, t.range, channelIndex(t.channel))
      return { result: null }
    case 'invCols':
      return { result: invCols(t.c, t.x0, t.x1, t.gen) }
    case 'invRows':
      return { result: invRows(t.c, t.y0, t.y1, t.gen) }
    case 'preview':
      renderPreview(t.c)
      return { result: null }
    case 'envelope': {
      const r = envelope(t.shape, t.gw, t.gh)
      return { result: r, transfer: [r.env.buffer] }
    }
    case 'local': {
      const r = localSpectrum(t.lum, t.pw, t.ph)
      return { result: r, transfer: [r.map.buffer] }
    }
    case 'png':
      return { result: await encodePng(t.rgba, t.w, t.h) }
    case 'denoise': {
      const r = denoiseTile(t)
      return { result: r, transfer: r.rgba ? [r.rgba.buffer] : [] }
    }
    case 'packPixels': {
      const out = await deflate(filterPixels(t.rgba, t.w, t.h))
      return { result: out, transfer: [out.buffer] }
    }
    case 'unpackPixels': {
      const out = unfilterPixels(await inflate(t.data), t.w, t.h)
      return { result: out, transfer: [out.buffer] }
    }
    case 'wiener': {
      // Wiener sees the edited luminance: shared mode folds the multiplier in,
      // per-channel mode needs the combined edited magnitude.
      const shared = mults[0] === mults[1]
      const mag = shared ? magY : Float32Array.from({ length: d.wh * d.h }, (_, i) => editedMag(i, -1, spec, mults, magY))
      const g = wienerGains(d.wh, d.h, mag, shared ? mult : null, t.noisePower, t.alpha, t.radius)
      return { result: g, transfer: [g.buffer] }
    }
  }
}

self.onmessage = async (e: MessageEvent<{ id: number; task: Task }>) => {
  const { id, task } = e.data
  try {
    const { result, transfer } = await handle(task)
    self.postMessage({ id, ok: true, result }, { transfer: transfer ?? [] })
  } catch (err) {
    self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
