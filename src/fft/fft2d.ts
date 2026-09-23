import { FFTPlan } from './plan.ts'
import { forwardRealPair, halfLength, inverseRealPair } from './real.ts'

/** Columns gathered per pass. 8 complex float32 = one 64-byte cache line. */
const BATCH = 8

export type AbortCheck = () => boolean

/**
 * 2D DFT of a real W×H image, storing only the non-redundant half spectrum.
 *
 * Spectrum layout: Float32Array, interleaved complex, row-major
 * [ky][kx] with kx in 0..halfWidth-1 and ky in 0..H-1 (unshifted order).
 * Bins with kx > W/2 are implied by X[-kx, -ky] = conj(X[kx, ky]).
 *
 * Each pass works on a row or column range, so several threads can share
 * one spectrum buffer: run all row ranges, then all column ranges (or the
 * reverse for the inverse), with a barrier in between.
 */
export class RealFFT2D {
  readonly width: number
  readonly height: number
  readonly halfWidth: number
  private readonly rowPlan: FFTPlan
  private readonly colPlan: FFTPlan
  private readonly z: Float64Array
  private readonly rowA: Float64Array
  private readonly rowB: Float64Array
  private readonly cols: Float64Array[]

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.halfWidth = halfLength(width)
    this.rowPlan = new FFTPlan(width)
    this.colPlan = new FFTPlan(height)
    this.z = new Float64Array(2 * width)
    this.rowA = new Float64Array(2 * this.halfWidth)
    this.rowB = new Float64Array(2 * this.halfWidth)
    this.cols = Array.from({ length: BATCH }, () => new Float64Array(2 * height))
  }

  /** Length of a spectrum buffer, in floats. */
  get spectrumLength(): number {
    return 2 * this.halfWidth * this.height
  }

  /**
   * Row pass of the forward transform for rows y0..y1-1.
   * `readRow(y, out)` fills out[0..W-1] with the real samples of row y.
   */
  forwardRows(
    y0: number,
    y1: number,
    readRow: (y: number, out: Float64Array) => void,
    spec: Float32Array,
    abort?: AbortCheck,
  ): boolean {
    const { width: w, halfWidth: wh, z, rowA, rowB } = this
    const line = new Float64Array(w)
    for (let y = y0; y < y1; y += 2) {
      if (abort?.()) return false
      readRow(y, line)
      for (let x = 0; x < w; x++) z[2 * x] = line[x]
      const pair = y + 1 < y1
      if (pair) readRow(y + 1, line)
      for (let x = 0; x < w; x++) z[2 * x + 1] = pair ? line[x] : 0
      forwardRealPair(this.rowPlan, z, rowA, rowB)
      spec.set(rowA, 2 * wh * y)
      if (pair) spec.set(rowB, 2 * wh * (y + 1))
    }
    return true
  }

  /** Column pass of the forward transform for kx in x0..x1-1, in place. */
  forwardColumns(x0: number, x1: number, spec: Float32Array, abort?: AbortCheck): boolean {
    return this.columnPass(x0, x1, spec, spec, null, false, abort)
  }

  /**
   * Column pass of the inverse transform for kx in x0..x1-1:
   * dst = IFFT_columns(spec · mult). `mult` is an optional per-bin complex
   * multiplier in the same layout as `spec`. `dst` may be `spec`.
   */
  inverseColumns(
    x0: number,
    x1: number,
    spec: Float32Array,
    dst: Float32Array,
    mult: Float32Array | null,
    abort?: AbortCheck,
  ): boolean {
    return this.columnPass(x0, x1, spec, dst, mult, true, abort)
  }

  /**
   * Row pass of the inverse transform for rows y0..y1-1,
   * reading the output of `inverseColumns`. `writeRow(y, row)` receives
   * normalized real samples in row[0..W-1].
   */
  inverseRows(
    y0: number,
    y1: number,
    src: Float32Array,
    writeRow: (y: number, row: Float64Array) => void,
    abort?: AbortCheck,
  ): boolean {
    const { width: w, halfWidth: wh, z, rowA, rowB } = this
    const scale = 1 / (w * this.height)
    const line = new Float64Array(w)
    for (let y = y0; y < y1; y += 2) {
      if (abort?.()) return false
      const pair = y + 1 < y1
      const oa = 2 * wh * y
      for (let i = 0; i < 2 * wh; i++) rowA[i] = src[oa + i]
      if (pair) {
        const ob = oa + 2 * wh
        for (let i = 0; i < 2 * wh; i++) rowB[i] = src[ob + i]
      } else {
        rowB.fill(0)
      }
      inverseRealPair(this.rowPlan, rowA, rowB, z)
      for (let x = 0; x < w; x++) line[x] = z[2 * x] * scale
      writeRow(y, line)
      if (pair) {
        for (let x = 0; x < w; x++) line[x] = z[2 * x + 1] * scale
        writeRow(y + 1, line)
      }
    }
    return true
  }

  private columnPass(
    x0: number,
    x1: number,
    src: Float32Array,
    dst: Float32Array,
    mult: Float32Array | null,
    inverse: boolean,
    abort?: AbortCheck,
  ): boolean {
    const { halfWidth: wh, height: h, cols, colPlan } = this
    const stride = 2 * wh
    for (let xb = x0; xb < x1; xb += BATCH) {
      if (abort?.()) return false
      const nb = Math.min(BATCH, x1 - xb)
      // Gather: walk rows once, pulling nb adjacent columns per row.
      for (let y = 0; y < h; y++) {
        const row = y * stride + 2 * xb
        for (let b = 0; b < nb; b++) {
          const i = row + 2 * b
          let re = src[i]
          let im = src[i + 1]
          if (mult) {
            const mr = mult[i]
            const mi = mult[i + 1]
            const t = re * mr - im * mi
            im = re * mi + im * mr
            re = t
          }
          cols[b][2 * y] = re
          cols[b][2 * y + 1] = im
        }
      }
      for (let b = 0; b < nb; b++) {
        if (inverse) colPlan.inverse(cols[b])
        else colPlan.forward(cols[b])
      }
      for (let y = 0; y < h; y++) {
        const row = y * stride + 2 * xb
        for (let b = 0; b < nb; b++) {
          dst[row + 2 * b] = cols[b][2 * y]
          dst[row + 2 * b + 1] = cols[b][2 * y + 1]
        }
      }
    }
    return true
  }
}
