import type { DenoiseAlgo, Quality } from '../denoise/index.ts'
import type { DisplayRange, Shape, SpectrumChannel } from './layout.ts'

/**
 * Memory shared by the main thread and every worker. Allocated once per
 * loaded image.
 */
export interface SharedBuffers {
  w: number
  h: number
  /** Size of the low-pass preview image. */
  pw: number
  ph: number
  /** Source pixels, RGBA8. */
  src: SharedArrayBuffer
  /** Result pixels, RGBA8 (alpha copied from src). */
  out: SharedArrayBuffer
  /** Original half spectra of R, G, B (Float32, interleaved complex). */
  spec: [SharedArrayBuffer, SharedArrayBuffer, SharedArrayBuffer]
  /** Per-bin complex edit multiplier, same layout as spec. Written by the main thread. */
  mult: SharedArrayBuffer
  /** Scratch spectrum for the inverse column pass. */
  work: SharedArrayBuffer
  /** |Y| of the original luminance spectrum, Float32 per stored bin. */
  magY: SharedArrayBuffer
  /** Level 0 of the spectrum display, Uint16 per display pixel (W×H, centered). */
  disp0: SharedArrayBuffer
  /** Int32 control words: [0] full-render generation, [1] denoise generation (abort when they change). */
  ctrl: SharedArrayBuffer
  /** Preview pixels, RGBA8, pw×ph. */
  preview: SharedArrayBuffer
  /** Green and blue multipliers for per-channel editing, allocated on demand. */
  gb?: [SharedArrayBuffer, SharedArrayBuffer]
}

export type Task =
  | { type: 'init'; buffers: SharedBuffers }
  /** Per-channel editing: G and B multipliers (R uses `mult`), or null to share `mult` across all three. */
  | { type: 'mults'; gb: [SharedArrayBuffer, SharedArrayBuffer] | null }
  | { type: 'fwdRows'; y0: number; y1: number }
  | { type: 'fwdCols'; x0: number; x1: number }
  | { type: 'disp0'; y0: number; y1: number; range: DisplayRange; channel: SpectrumChannel }
  | { type: 'invCols'; c: number; x0: number; x1: number; gen: number }
  | { type: 'invRows'; c: number; y0: number; y1: number; gen: number }
  | { type: 'preview'; c: number }
  | { type: 'envelope'; shape: Shape; gw: number; gh: number }
  | { type: 'local'; lum: Float32Array; pw: number; ph: number }
  | { type: 'png'; rgba: Uint8ClampedArray; w: number; h: number }
  | {
      type: 'denoise'
      algo: Exclude<DenoiseAlgo, 'wiener'>
      quality: Quality
      /** Tile pixels (RGBA8) including whatever halo lies inside the image. */
      rgba: Uint8ClampedArray
      tw: number
      th: number
      /** Halo missing on each side (outside the image), filled by reflection: [left, top, right, bottom]. */
      missing: [number, number, number, number]
      /** Halo width around the core. */
      halo: number
      sigma: number[]
      /** Noise σ per 8×8 DCT coefficient for each channel (BM3D), or null for white noise. */
      psd: Float32Array[] | null
      gen: number
    }
  | { type: 'wiener'; noisePower: number; alpha: number; radius: number }
  /** Project files: RGBA8 image ⇄ Paeth-filtered, deflated bytes. */
  | { type: 'packPixels'; rgba: Uint8ClampedArray; w: number; h: number }
  | { type: 'unpackPixels'; data: Uint8Array; w: number; h: number }

export interface FwdColsResult {
  /** max log1p(|Y|) over the columns, excluding DC. */
  maxLog: number
  /** A sample of log1p(|Y|) values for estimating percentiles. */
  samples: Float32Array
}

export interface EnvelopeResult {
  env: Float32Array
  gw: number
  gh: number
}

export interface LocalResult {
  map: Uint16Array
  pw: number
  ph: number
}

export interface DenoiseResult {
  /** Denoised core, RGBA8 (alpha 255), or null if cancelled. */
  rgba: Uint8ClampedArray | null
}

export type Reply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string }
