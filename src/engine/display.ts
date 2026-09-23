import { binOf, channelIndex, quantize, type DisplayRange, type Dims, type Rect, type SpectrumChannel } from './layout.ts'
import { editedMag, originalMag } from './edited.ts'
import type { LocalResult } from './protocol.ts'

export interface View {
  /** Device pixels per content pixel. */
  zoom: number
  /** Content coordinate at the canvas center. */
  cx: number
  cy: number
}

export interface RenderOptions {
  lut: Uint32Array
  background: number
  /**
   * Tint edited bins: cut bins show the removed energy in the cut colour at
   * the brightness the unedited spectrum had there; boosted bins shift
   * toward the boost colour at their current brightness.
   */
  overlay: boolean
  /** Show this patch spectrum (mapped onto global frequency axes) instead of the global one. */
  local: LocalResult | null
}

/** Stop building pyramid levels once the longer side is this small. */
const MIN_LEVEL = 128

// Keep in sync with --cut / --boost in index.css.
const TINT_CUT = [255, 96, 64]
const TINT_BOOST = [74, 222, 128]

/**
 * The centered log-magnitude spectrum as 12-bit values, plus a max-pooled
 * pyramid so zoomed-out views never drop isolated peaks (the periodic-noise
 * spikes you usually want to find).
 */
export class SpectrumDisplay {
  readonly d: Dims
  readonly levels: Uint16Array[]
  readonly lw: number[]
  readonly lh: number[]
  private readonly magY: Float32Array
  private readonly specs: Float32Array[]
  /** Channel shown: 0..2 for R, G, B, or -1 for luminance. */
  private ch = -1
  /** Multiplier per colour channel (all the same array in shared mode). */
  private mults: Float32Array[]
  private readonly range: DisplayRange
  private colBuf = new Int32Array(0)
  private colK = new Int32Array(0)

  constructor(
    d: Dims,
    level0: Uint16Array,
    magY: Float32Array,
    specs: Float32Array[],
    mults: Float32Array[],
    range: DisplayRange,
    channel: SpectrumChannel,
  ) {
    this.d = d
    this.magY = magY
    this.specs = specs
    this.setChannel(channel)
    this.mults = mults
    this.range = range
    this.levels = [level0]
    this.lw = [d.w]
    this.lh = [d.h]
    let w = d.w
    let h = d.h
    while (Math.max(w, h) > MIN_LEVEL) {
      w = Math.ceil(w / 2)
      h = Math.ceil(h / 2)
      this.levels.push(new Uint16Array(w * h))
      this.lw.push(w)
      this.lh.push(h)
    }
  }

  /** Which spectrum's magnitude is shown. Level 0 must be refilled after a change. */
  setChannel(c: SpectrumChannel): void {
    this.ch = channelIndex(c)
  }

  /** Switch between shared and per-channel multipliers. Level 0 must be refilled after. */
  setMults(mults: Float32Array[]): void {
    this.mults = mults
  }

  /** Unedited magnitude of stored bin i in the shown spectrum. */
  magAt(i: number): number {
    return originalMag(i, this.ch, this.specs, this.magY)
  }

  /** Edited magnitude of stored bin i in the shown spectrum. */
  editedAt(i: number): number {
    return editedMag(i, this.ch, this.specs, this.mults, this.magY)
  }

  /** How much the edits scale stored bin i in the shown spectrum (1 = unedited). */
  gainAt(i: number): number {
    const m = this.ch >= 0 ? this.mults[this.ch] : this.mults[0]
    if (this.ch >= 0 || this.mults[0] === this.mults[1]) return Math.hypot(m[2 * i], m[2 * i + 1])
    const o = this.magAt(i)
    return o > 0 ? this.editedAt(i) / o : 1
  }

  /** Rebuild every pyramid level above level 0. */
  buildPyramid(): void {
    for (let l = 1; l < this.levels.length; l++) this.poolRect(l, 0, 0, this.lw[l], this.lh[l])
  }

  /** Recompute level 0 in display rects from the multiplier, then the pyramid above them. */
  refresh(rects: Rect[]): void {
    const { d, range } = this
    const lv = this.levels[0]
    for (const r of rects) {
      for (let dy = r.y0; dy < r.y1; dy++) {
        const ky = dy - d.cy
        for (let dx = r.x0; dx < r.x1; dx++) {
          const b = binOf(d, dx - d.cx, ky)
          const i = b < 0 ? ~b : b
          lv[dy * d.w + dx] = quantize(this.editedAt(i), range)
        }
      }
      let { x0, y0, x1, y1 } = r
      for (let l = 1; l < this.levels.length; l++) {
        x0 >>= 1
        y0 >>= 1
        x1 = Math.min(this.lw[l], (x1 + 1) >> 1)
        y1 = Math.min(this.lh[l], (y1 + 1) >> 1)
        this.poolRect(l, x0, y0, x1, y1)
      }
    }
  }

  private poolRect(l: number, x0: number, y0: number, x1: number, y1: number): void {
    const src = this.levels[l - 1]
    const sw = this.lw[l - 1]
    const sh = this.lh[l - 1]
    const dst = this.levels[l]
    const dw = this.lw[l]
    for (let y = y0; y < y1; y++) {
      const sy = 2 * y
      const sy1 = Math.min(sh - 1, sy + 1)
      for (let x = x0; x < x1; x++) {
        const sx = 2 * x
        const sx1 = Math.min(sw - 1, sx + 1)
        let m = src[sy * sw + sx]
        let v = src[sy * sw + sx1]
        if (v > m) m = v
        v = src[sy1 * sw + sx]
        if (v > m) m = v
        v = src[sy1 * sw + sx1]
        if (v > m) m = v
        dst[y * dw + x] = m
      }
    }
  }

  /** Draw the view into a tw×th RGBA canvas buffer (as packed ABGR words). */
  render(out: Uint32Array, tw: number, th: number, view: View, opts: RenderOptions): void {
    const { d } = this
    const { lut, background: bg } = opts
    const inv = 1 / view.zoom
    const L = view.zoom >= 1 ? 0 : Math.min(this.levels.length - 1, Math.floor(Math.log2(inv) + 1e-9))
    if (this.colBuf.length < tw) {
      this.colBuf = new Int32Array(tw)
      this.colK = new Int32Array(tw)
    }
    const col = this.colBuf
    const colK = this.colK
    const local = opts.local
    const lcx = local ? local.pw >> 1 : 0
    const lcy = local ? local.ph >> 1 : 0
    for (let sx = 0; sx < tw; sx++) {
      const x = Math.floor((sx + 0.5 - tw / 2) * inv + view.cx)
      col[sx] = x < 0 || x >= d.w ? -1 : x
      if (local && x >= 0 && x < d.w) {
        const lx = Math.round(((x - d.cx) * local.pw) / d.w) + lcx
        colK[sx] = Math.min(local.pw - 1, Math.max(0, lx))
      }
    }
    const lv = this.levels[L]
    const lw = this.lw[L]
    for (let sy = 0; sy < th; sy++) {
      const y = Math.floor((sy + 0.5 - th / 2) * inv + view.cy)
      let o = sy * tw
      if (y < 0 || y >= d.h) {
        out.fill(bg, o, o + tw)
        continue
      }
      if (local) {
        const ly = Math.min(local.ph - 1, Math.max(0, Math.round(((y - d.cy) * local.ph) / d.h) + lcy))
        const base = ly * local.pw
        const map = local.map
        for (let sx = 0; sx < tw; sx++) out[o++] = col[sx] < 0 ? bg : lut[map[base + colK[sx]]]
      } else {
        const base = (y >> L) * lw
        for (let sx = 0; sx < tw; sx++) {
          const x = col[sx]
          out[o++] = x < 0 ? bg : lut[lv[base + (x >> L)]]
        }
      }
      if (opts.overlay) this.tintRow(out, sy * tw, tw, y, col, lut)
    }
  }

  private tintRow(out: Uint32Array, o: number, tw: number, y: number, col: Int32Array, lut: Uint32Array): void {
    const { d, range } = this
    const ky = y - d.cy
    for (let sx = 0; sx < tw; sx++) {
      const x = col[sx]
      if (x < 0) continue
      const b = binOf(d, x - d.cx, ky)
      const i = b < 0 ? ~b : b
      const g = this.gainAt(i)
      if (Math.abs(g - 1) < 1e-3) continue
      const p = out[o + sx]
      let r = p & 255
      let gr = (p >>> 8) & 255
      let bl = (p >>> 16) & 255
      const cut = g < 1
      // Brightness to tint at: the unedited value for cuts (what was
      // removed), the current value for boosts. Dark stays dark, so a
      // heavy global filter doesn't flood the view with colour.
      const ref = cut ? lut[quantize(this.magAt(i), range)] : p
      const v = Math.min(1, (1.4 * (0.3 * (ref & 255) + 0.59 * ((ref >>> 8) & 255) + 0.11 * ((ref >>> 16) & 255))) / 255)
      const t = 0.85 * (cut ? 1 - g : Math.min(1, Math.log(g) / Math.log(8)))
      const c = cut ? TINT_CUT : TINT_BOOST
      r += (c[0] * v - r) * t
      gr += (c[1] * v - gr) * t
      bl += (c[2] * v - bl) * t
      out[o + sx] = 0xff000000 | ((bl & 255) << 16) | ((gr & 255) << 8) | (r & 255)
    }
  }
}
