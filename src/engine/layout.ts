import { halfLength } from '../fft/index.ts'

/**
 * Geometry shared by the main thread and workers.
 *
 * Three coordinate systems are in play:
 *  - display (dx, dy): the centered W×H spectrum image, DC at (cx, cy).
 *  - signed frequency (kx, ky) = (dx - cx, dy - cy).
 *  - stored bin: index into the half spectrum [ky mod H][kx], kx < wh.
 *    Bins with kx >= wh are the conjugate of the bin at (-kx, -ky).
 */
export interface Dims {
  w: number
  h: number
  /** Stored half width: floor(w/2) + 1. */
  wh: number
  /** Display column / row of DC. */
  cx: number
  cy: number
  /** Stored column of the Nyquist frequency when w is even, else -1. */
  nyqX: number
  /** Row of the Nyquist frequency when h is even, else -1. */
  nyqY: number
}

export function makeDims(w: number, h: number): Dims {
  return {
    w,
    h,
    wh: halfLength(w),
    cx: w >> 1,
    cy: h >> 1,
    nyqX: w % 2 === 0 ? w >> 1 : -1,
    nyqY: h % 2 === 0 ? h >> 1 : -1,
  }
}

const mod = (a: number, n: number) => {
  const r = a % n
  return r < 0 ? r + n : r
}

/**
 * Stored bin for signed frequency (kx, ky). Returns the bin index, or its
 * bitwise complement (~index, negative) when the value there must be
 * conjugated to get the value at (kx, ky).
 */
export function binOf(d: Dims, kx: number, ky: number): number {
  let x = mod(kx, d.w)
  let y = mod(ky, d.h)
  if (x < d.wh) return y * d.wh + x
  x = d.w - x
  y = y === 0 ? 0 : d.h - y
  return ~(y * d.wh + x)
}

/**
 * Like binOf, but also folds the two self-mirrored stored columns (kx = 0
 * and kx = Nyquist, which hold both ky and -ky) onto rows 0..floor(h/2).
 * Every frequency pair {k, -k} then has exactly one canonical bin, which is
 * where edits are written. See `mirrorBin` for the partner that must follow.
 */
export function canonicalBin(d: Dims, kx: number, ky: number): number {
  let x = mod(kx, d.w)
  let y = mod(ky, d.h)
  let conj = false
  if (x >= d.wh) {
    x = d.w - x
    y = y === 0 ? 0 : d.h - y
    conj = true
  }
  if ((x === 0 || x === d.nyqX) && y > d.h >> 1) {
    y = d.h - y
    conj = !conj
  }
  const i = y * d.wh + x
  return conj ? ~i : i
}

/**
 * For a canonical bin in a self-mirrored column, the second stored bin
 * that must hold its conjugate, or -1 if there is none.
 */
export function mirrorBin(d: Dims, x: number, y: number): number {
  if (x !== 0 && x !== d.nyqX) return -1
  if (y === 0 || y === d.nyqY) return -1
  return (d.h - y) * d.wh + x
}

export interface Rect {
  x0: number
  y0: number
  /** Exclusive. */
  x1: number
  y1: number
}

/** Split [a, b) (b - a <= n) taken modulo n into at most two in-range spans. */
function wrapSpan(a: number, b: number, n: number): [number, number][] {
  if (b - a >= n) return [[0, n]]
  const s = mod(a, n)
  const e = s + (b - a)
  return e <= n ? [[s, e]] : [
    [s, n],
    [0, e - n],
  ]
}

/** Split an unwrapped display rect into in-bounds rects, wrapping modulo (w, h). */
export function wrapRect(d: Dims, r: Rect): Rect[] {
  const out: Rect[] = []
  for (const [x0, x1] of wrapSpan(r.x0, r.x1, d.w)) {
    for (const [y0, y1] of wrapSpan(r.y0, r.y1, d.h)) out.push({ x0, y0, x1, y1 })
  }
  return out
}

/** The display rects holding the point-mirrored frequencies (-k) of an in-bounds display rect. */
export function mirrorRects(d: Dims, r: Rect): Rect[] {
  return wrapRect(d, {
    x0: 2 * d.cx - r.x1 + 1,
    x1: 2 * d.cx - r.x0 + 1,
    y0: 2 * d.cy - r.y1 + 1,
    y1: 2 * d.cy - r.y0 + 1,
  })
}

/** Display rects covering every appearance (k and -k) of a stored-bin rect. */
export function displayRectsForStored(d: Dims, r: Rect): Rect[] {
  const direct = wrapRect(d, { x0: r.x0 + d.cx, x1: r.x1 + d.cx, y0: r.y0 + d.cy, y1: r.y1 + d.cy })
  const mirror = wrapRect(d, {
    x0: d.cx - r.x1 + 1,
    x1: d.cx - r.x0 + 1,
    y0: d.cy - r.y1 + 1,
    y1: d.cy - r.y0 + 1,
  })
  return direct.concat(mirror)
}

export function clipRect(d: Dims, r: Rect): Rect | null {
  const x0 = Math.max(0, r.x0)
  const y0 = Math.max(0, r.y0)
  const x1 = Math.min(d.w, r.x1)
  const y1 = Math.min(d.h, r.y1)
  return x0 < x1 && y0 < y1 ? { x0, y0, x1, y1 } : null
}

// ---- Spectrum display quantization -------------------------------------

/** Display values are 12-bit: 0..QMAX. */
export const QMAX = 4095

/** Extra log-magnitude range kept above the image's peak so amplified bins stay visible. */
export const HEADROOM = Math.log(16)

export interface DisplayRange {
  /** log1p(|Y|) mapped to 0. */
  lo: number
  /** Multiplier from (log1p(|Y|) - lo) to 0..QMAX. */
  scale: number
  /** Fraction of the quantized range at which the unedited peak sits (default white point). */
  peak: number
}

export function makeRange(lo: number, hiNoDC: number): DisplayRange {
  const hi = Math.max(hiNoDC, lo + 1e-3)
  const top = hi + HEADROOM
  return { lo, scale: QMAX / (top - lo), peak: (hi - lo) / (top - lo) }
}

export function quantize(mag: number, r: DisplayRange): number {
  const q = (Math.log1p(mag) - r.lo) * r.scale
  return q <= 0 ? 0 : q >= QMAX ? QMAX : q | 0
}

// ---- Which spectrum is displayed ------------------------------------------

/** 'l' = Rec. 601 luminance (the default), or one colour channel. */
export type SpectrumChannel = 'l' | 'r' | 'g' | 'b'

/** Index into the RGB spectra, or -1 for luminance. */
export const channelIndex = (c: SpectrumChannel): number => (c === 'l' ? -1 : 'rgb'.indexOf(c))

// ---- Selection shapes (display coordinates) -----------------------------

export interface Shape {
  kind: 'rect' | 'ellipse'
  x0: number
  y0: number
  x1: number
  y1: number
  /** Soft edge width in bins. */
  feather: number
}

export function normShape(s: Shape): Shape {
  return {
    ...s,
    x0: Math.min(s.x0, s.x1),
    x1: Math.max(s.x0, s.x1),
    y0: Math.min(s.y0, s.y1),
    y1: Math.max(s.y0, s.y1),
  }
}

/** Weight in [0,1] of display pixel center (px, py) in a normalized shape. */
export function shapeWeight(s: Shape, px: number, py: number): number {
  const x = px + 0.5
  const y = py + 0.5
  let inside: number
  if (s.kind === 'rect') {
    inside = Math.min(x - s.x0, s.x1 - x, y - s.y0, s.y1 - y)
  } else {
    const rx = Math.max(0.5, (s.x1 - s.x0) / 2)
    const ry = Math.max(0.5, (s.y1 - s.y0) / 2)
    const nx = (x - (s.x0 + s.x1) / 2) / rx
    const ny = (y - (s.y0 + s.y1) / 2) / ry
    inside = (1 - Math.hypot(nx, ny)) * Math.min(rx, ry)
  }
  if (inside <= 0) return 0
  if (s.feather <= 0 || inside >= s.feather) return 1
  const t = inside / s.feather
  return t * t * (3 - 2 * t)
}

/** Integer display bbox of a normalized shape, clipped. */
export function shapeBounds(d: Dims, s: Shape): Rect | null {
  return clipRect(d, {
    x0: Math.floor(s.x0),
    y0: Math.floor(s.y0),
    x1: Math.ceil(s.x1),
    y1: Math.ceil(s.y1),
  })
}
