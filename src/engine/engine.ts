import {
  bm3dHalo,
  bm3dParams,
  estimateNoiseRGBA,
  nlmHalo,
  nlmParams,
  type DenoiseAlgo,
  type NoiseEstimate,
  type NoiseModel,
  type Quality,
} from '../denoise/index.ts'
import { nextSmooth } from '../fft/index.ts'
import { sample } from './colormap.ts'
import { SpectrumDisplay } from './display.ts'
import { EditField, type Dirty, type EditMode, type EditParams, type SavedWorking, type Snap, type UndoEntry } from './edits.ts'
import { closeTiles, decodeImage, makeTiles, type TileSet } from './image.ts'
import {
  binOf,
  channelIndex,
  clipRect,
  makeDims,
  makeRange,
  mirrorRects,
  normShape,
  shapeBounds,
  shapeWeight,
  type Dims,
  type DisplayRange,
  type Rect,
  type Shape,
  type SpectrumChannel,
} from './layout.ts'
import { WorkerPool, ranges } from './pool.ts'
import { findSpikes } from './spikes.ts'
import type { DenoiseResult, EnvelopeResult, FwdColsResult, LocalResult, SharedBuffers, Task } from './protocol.ts'

/** Longer side of the low-pass preview shown while brushing large images. */
const PREVIEW_SIZE = 1280
/** Below this measured forward-transform time, always render at full resolution. */
const FAST_FULL_MS = 90
/** Idle time after the last edit before a full-resolution refine starts. */
const REFINE_DELAY_MS = 180
/** Longer side of the "where" heatmap grid (grown to fit wide selections). */
const HEAT_SIZE = 768
const HEAT_MAX = 2048
/** Largest image patch analysed for the local spectrum. */
const LOCAL_MAX = 4096
/** Smallest subregion side, in pixels. */
export const MIN_SUBREGION = 16

export interface BrushSettings extends EditParams {
  /** Radius in frequency bins. */
  radius: number
  hardness: number
}

export interface EngineInfo {
  status: 'empty' | 'loading' | 'ready' | 'error'
  message: string
  name: string
  w: number
  h: number
  workers: number
  forwardMs: number
  lastFullMs: number
  lastPreviewMs: number
  /** Full-resolution result matches the current edits. */
  upToDate: boolean
  refining: boolean
  fastFull: boolean
  canUndo: boolean
  canRedo: boolean
  edited: boolean
  region: Rect | null
  selection: Shape | null
  hasLocal: boolean
  /** Oldest first; index 0 is the loaded image. */
  checkpoints: CheckpointInfo[]
  activeCheckpoint: number
  /** Creating or switching checkpoints. */
  switching: boolean
  /** Running denoise job, if any. */
  denoise: DenoiseStatus | null
  /** Noise estimate of the current result (null until computed). */
  noise: NoiseEstimate | null
  /** A region preview of a denoiser is being shown. */
  denoisePreview: string | null
  /** Completed edits (strokes, selection fills, filters); only ever increases. */
  strokes: number
  /** The active checkpoint's area when it is a subregion (canvas pixels), else null. */
  subregion: Rect | null
  /** Spectrum shown: luminance or one colour channel. */
  spectrumChannel: SpectrumChannel
  /**
   * What the active checkpoint's edits are committed to: 'shared'
   * (luminance, all channels together) or 'rgb' (per channel). Null until
   * its first edit. Editing in the other kind of view needs a new checkpoint.
   */
  editMode: EditMode | null
  /** Bumped when an edit is refused because the view doesn't match `editMode`. */
  editBlocked: number
}

/** 'overlay' only changes marks drawn over the spectrum (hints, selections). */
export type RenderKind = 'image' | 'spectrum' | 'overlay'

export type MemoryMode = 'low' | 'balanced' | 'high'

export interface DenoiseSettings {
  algo: DenoiseAlgo
  quality: Quality
  memory: MemoryMode
  /** Multiplies the estimated noise level. */
  strength: number
  /** Extra multiplier on the chroma noise level (NLM, BM3D). */
  chroma: number
  /** BM3D noise model. */
  model: NoiseModel
}

export interface DenoisePlan {
  /** σ per opponent channel after strength/chroma, or [σ luma] for Wiener. */
  sigma: number[]
  tiles: number
  threads: number
  /** Estimated peak working memory, bytes. */
  peakBytes: number
  /** Rough time estimate, seconds. */
  seconds: number
}

export interface DenoiseStatus {
  scope: 'region' | 'full'
  done: number
  total: number
  label: string
}

export interface MemoryPart {
  label: string
  bytes: number
}

/**
 * A baked image that acts as the base for further edits. Each checkpoint
 * keeps its own working edits and undo history, parked while it's inactive.
 */
export interface Checkpoint {
  id: number
  label: string
  /** The checkpoint's own (working) image and its size. */
  pixels: Uint8ClampedArray<ArrayBuffer>
  w: number
  h: number
  tiles: TileSet
  /** Object URL of a small preview image. */
  thumb: string
  edits: EditField | null
  saved: SavedWorking | null
  /**
   * Set for a subregion checkpoint: its working image is the `rect` area of
   * the full canvas, composited over `base`, a snapshot of everything below.
   */
  sub: Subregion | null
}

export interface Subregion {
  /** Placement in canvas (full image) pixels. */
  rect: Rect
  base: Uint8ClampedArray<ArrayBuffer>
  baseTiles: TileSet
  canvasW: number
  canvasH: number
}

/** A checkpoint as the project saver sees it (live references; don't mutate). */
export interface ProjectCheckpoint {
  id: number
  label: string
  w: number
  h: number
  pixels: Uint8ClampedArray<ArrayBuffer>
  sub: Subregion | null
  edits: EditField | null
  /** Parked working tiles; null for the active checkpoint, whose tiles are read live from `edits`. */
  saved: SavedWorking | null
  active: boolean
}

export interface ProjectSnapshot {
  name: string
  activeId: number
  spectrumChannel: SpectrumChannel
  checkpoints: ProjectCheckpoint[]
}

/** A checkpoint read back from a project file. */
export interface LoadedCheckpoint {
  id: number
  label: string
  w: number
  h: number
  pixels: Uint8ClampedArray<ArrayBuffer>
  sub: { rect: Rect; canvasW: number; canvasH: number; base: Uint8ClampedArray<ArrayBuffer> } | null
  mode: EditMode
  undo: UndoEntry[]
  redo: UndoEntry[]
  working: Map<number, Snap>
}

export interface LoadedProject {
  name: string
  activeId: number
  spectrumChannel: SpectrumChannel
  checkpoints: LoadedCheckpoint[]
}

export interface CheckpointInfo {
  id: number
  label: string
  thumb: string
  /** Has unbaked working edits (shown when it's not the active one). */
  pending: boolean
  /** Subregion checkpoints: the edited area in canvas pixels. */
  rect: Rect | null
}

export interface BinInfo {
  kx: number
  ky: number
  magnitude: number
  gain: number
  /** Spatial period in pixels, Infinity at DC. */
  period: number
  /** Orientation of the wave vector, degrees. */
  angle: number
}

const EMPTY_INFO: EngineInfo = {
  status: 'empty',
  message: '',
  name: '',
  w: 0,
  h: 0,
  workers: 0,
  forwardMs: 0,
  lastFullMs: 0,
  lastPreviewMs: 0,
  upToDate: true,
  refining: false,
  fastFull: true,
  canUndo: false,
  canRedo: false,
  edited: false,
  region: null,
  selection: null,
  hasLocal: false,
  checkpoints: [],
  activeCheckpoint: 0,
  switching: false,
  denoise: null,
  noise: null,
  denoisePreview: null,
  strokes: 0,
  subregion: null,
  spectrumChannel: 'l',
  editMode: null,
  editBlocked: 0,
}

interface Views {
  src: Uint8ClampedArray
  out: Uint8ClampedArray
  /** The shared multiplier, which is also the red one in per-channel mode. */
  mult: Float32Array
  /** Green and blue multipliers, allocated on the first per-channel edit. */
  gb: [Float32Array, Float32Array] | null
  ctrl: Int32Array
  preview: Uint8ClampedArray
}

export class Engine {
  private info: EngineInfo = EMPTY_INFO
  private readonly infoListeners = new Set<() => void>()
  private readonly renderListeners = new Set<(k: RenderKind) => void>()

  private pool: WorkerPool | null = null
  dims: Dims | null = null
  private buffers: SharedBuffers | null = null
  private views: Views | null = null
  private range: DisplayRange | null = null
  display: SpectrumDisplay | null = null
  private edits: EditField | null = null
  private loadToken = 0

  // Image layers the panes draw.
  result: TileSet | null = null
  preview: ImageBitmap | null = null
  heat: ImageBitmap | null = null
  local: LocalResult | null = null
  private resultPixels: Uint8ClampedArray<ArrayBuffer> | null = null

  // Versioning: each edit bumps editVersion; results record which edit they show.
  private editVersion = 0
  private resultVersion = 0
  private previewVersion = 0
  private gen = 0
  private fullRunning = false
  private fullPending = false
  private previewRunning = false
  private previewPending = false
  private refineTimer = 0
  private fullWaiters: (() => void)[] = []
  private heatRunning = false
  private heatPending = false
  private localRunning = false
  private localPending = false

  private checkpoints: Checkpoint[] = []
  private active: Checkpoint | null = null
  private nextCheckpointId = 1
  private switching = false

  private denoiseGen = 0
  private denoiseBytes = 0
  private noiseKey = ''
  /** Denoised region shown over the image, until the next edit. */
  denoisePreview: { rect: Rect; bitmap: ImageBitmap; label: string } | null = null

  /** Bumped by every change a project save would capture. */
  private serial = 0

  private brush: BrushSettings | null = null
  private lastDab: [number, number] | null = null

  // ---- subscriptions -----------------------------------------------------

  subscribe = (fn: () => void): (() => void) => {
    this.infoListeners.add(fn)
    return () => this.infoListeners.delete(fn)
  }

  getInfo = (): EngineInfo => this.info

  onRender(fn: (k: RenderKind) => void): () => void {
    this.renderListeners.add(fn)
    return () => this.renderListeners.delete(fn)
  }

  private setInfo(patch: Partial<EngineInfo>): void {
    this.info = { ...this.info, ...patch }
    this.infoListeners.forEach((f) => f())
  }

  private emitRender(k: RenderKind): void {
    this.renderListeners.forEach((f) => f(k))
  }

  private syncInfo(): void {
    this.setInfo({
      upToDate: this.resultVersion === this.editVersion,
      refining: this.fullRunning,
      canUndo: this.edits?.canUndo ?? false,
      canRedo: this.edits?.canRedo ?? false,
      edited: !(this.edits?.isEmpty ?? true),
      editMode: this.edits?.lockedMode ?? null,
    })
  }

  /** Where the strongest unedited (non-DC) bin sits in the 0..1 display range. */
  get displayPeak(): number {
    return this.range?.peak ?? 0.85
  }

  /** The preview is shown instead of the full result while it is newer. */
  get showPreview(): boolean {
    return this.preview !== null && this.previewVersion > this.resultVersion
  }

  // ---- loading -------------------------------------------------------------

  async loadFile(file: Blob, name: string): Promise<void> {
    const token = ++this.loadToken
    this.setInfo({ status: 'loading', message: 'Decoding image…', name })
    try {
      const { data, w, h } = await decodeImage(file)
      if (token !== this.loadToken) return
      await this.loadPixels(data, w, h, name, token)
    } catch (e) {
      if (token === this.loadToken) this.fail(e)
    }
  }

  async loadGenerated(data: Uint8ClampedArray<ArrayBuffer>, w: number, h: number, name: string): Promise<void> {
    const token = ++this.loadToken
    try {
      await this.loadPixels(data, w, h, name, token)
    } catch (e) {
      if (token === this.loadToken) this.fail(e)
    }
  }

  private fail(e: unknown): void {
    console.error(e)
    const msg = e instanceof RangeError ? 'Not enough memory for an image this large.' : String((e as Error)?.message ?? e)
    this.setInfo({ status: 'error', message: msg })
  }

  private async loadPixels(
    data: Uint8ClampedArray<ArrayBuffer>,
    w: number,
    h: number,
    name: string,
    token: number,
  ): Promise<void> {
    if (!globalThis.crossOriginIsolated) {
      throw new Error('This page must be served cross-origin isolated (COOP/COEP headers) to use shared memory.')
    }
    this.setInfo({ status: 'loading', message: `Allocating ${w}×${h}…`, name, w, h })
    this.teardownImage()
    await this.allocate(w, h)
    const pool = this.pool!

    this.setInfo({ message: 'Forward FFT…' })
    const forwardMs = await this.transformSource(data)
    if (token !== this.loadToken) return
    this.edits = new EditField(this.dims!, this.views!.mult)
    this.resultPixels!.set(data)
    const base = await this.makeCheckpoint('Base image', data, w, h, null)
    if (token !== this.loadToken) {
      this.dropCheckpoint(base)
      return
    }
    this.checkpoints = [base]
    this.active = base
    this.result = base.tiles
    this.editVersion = this.resultVersion = this.previewVersion = 0

    this.setInfo({
      ...EMPTY_INFO,
      status: 'ready',
      name,
      w,
      h,
      workers: pool.size,
      forwardMs,
      fastFull: forwardMs < FAST_FULL_MS,
      message: '',
      // The display was just built for the chosen channel; keep it.
      spectrumChannel: this.info.spectrumChannel,
    })
    this.syncCheckpoints()
    this.estimateNoise()
    this.emitRender('image')
    this.emitRender('spectrum')
  }

  /**
   * (Re)allocate the shared buffers for a w×h working image and hand them to
   * every worker. Callers must have stopped in-flight renders first.
   */
  private async allocate(w: number, h: number): Promise<void> {
    const d = makeDims(w, h)
    const bins = d.wh * h
    const scale = Math.min(1, PREVIEW_SIZE / Math.max(w, h))
    const pw = Math.min(w, nextSmooth(Math.max(1, Math.round(w * scale))))
    const ph = Math.min(h, nextSmooth(Math.max(1, Math.round(h * scale))))
    const sab = (bytes: number) => new SharedArrayBuffer(bytes)
    const buffers: SharedBuffers = {
      w,
      h,
      pw,
      ph,
      src: sab(w * h * 4),
      out: sab(w * h * 4),
      spec: [sab(bins * 8), sab(bins * 8), sab(bins * 8)],
      mult: sab(bins * 8),
      work: sab(bins * 8),
      magY: sab(bins * 4),
      disp0: sab(w * h * 2),
      ctrl: sab(16),
      preview: sab(pw * ph * 4),
    }
    const mult = new Float32Array(buffers.mult)
    this.dims = d
    this.buffers = buffers
    this.views = {
      src: new Uint8ClampedArray(buffers.src),
      out: new Uint8ClampedArray(buffers.out),
      mult,
      gb: null,
      ctrl: new Int32Array(buffers.ctrl),
      preview: new Uint8ClampedArray(buffers.preview),
    }

    this.resultPixels = new Uint8ClampedArray(w * h * 4)
    // Anything tied to the old working image's coordinates is now invalid.
    this.region = null
    this.selection = null
    this.local = null
    this.heat?.close()
    this.heat = null
    this.preview?.close()
    this.preview = null
    this.setInfo({ region: null, selection: null, hasLocal: false })

    await this.ensurePool().broadcast({ type: 'init', buffers })
  }

  /**
   * Make `pixels` the source image: forward FFT, reset the multiplier to
   * identity and rebuild the spectrum display. Returns the FFT time.
   */
  private async transformSource(pixels: Uint8ClampedArray): Promise<number> {
    const { pool, dims: d, views, buffers } = this
    if (!pool || !d || !views || !buffers) throw new Error('No image loaded')
    views.src.set(pixels)
    views.out.set(pixels)
    const mult = views.mult
    // Every multiplier back to identity (G/B too, if allocated); the caller restores edits.
    for (const m of [mult, ...(views.gb ?? [])]) {
      for (let i = 0; i < m.length; i += 2) {
        m[i] = 1
        m[i + 1] = 0
      }
    }
    const t0 = performance.now()
    const k = pool.size * 2
    await pool.runAll(ranges(d.h, k).map(([y0, y1]) => ({ type: 'fwdRows' as const, y0, y1 })), 3)
    const cols = await pool.runAll<FwdColsResult>(
      ranges(d.wh, k, 8).map(([x0, x1]) => ({ type: 'fwdCols' as const, x0, x1 })),
      3,
    )
    const forwardMs = performance.now() - t0

    const samples = Float32Array.from(cols.flatMap((c) => Array.from(c.samples))).sort()
    const lo = samples.length ? samples[Math.floor(samples.length * 0.01)] : 0
    const hi = Math.max(...cols.map((c) => c.maxLog))
    const range = makeRange(lo, hi)
    this.range = range
    const channel = this.info.spectrumChannel
    await pool.runAll(ranges(d.h, k).map(([y0, y1]) => ({ type: 'disp0' as const, y0, y1, range, channel })), 3)
    const display = new SpectrumDisplay(
      d,
      new Uint16Array(buffers.disp0),
      new Float32Array(buffers.magY),
      buffers.spec.map((b) => new Float32Array(b)),
      this.channelMults(),
      range,
      channel,
    )
    display.buildPyramid()
    this.display = display
    return forwardMs
  }

  private async makeCheckpoint(
    label: string,
    pixels: Uint8ClampedArray<ArrayBuffer>,
    w: number,
    h: number,
    sub: Subregion | null,
  ): Promise<Checkpoint> {
    const tiles = await makeTiles(pixels, w, h)
    const thumb = sub ? await thumbnail(sub.baseTiles, sub.rect) : await thumbnail(tiles)
    return { id: this.nextCheckpointId++, label, pixels, w, h, tiles, thumb, edits: null, saved: null, sub }
  }

  private dropCheckpoint(c: Checkpoint): void {
    if (this.result === c.tiles) this.result = null
    closeTiles(c.tiles)
    if (c.sub) closeTiles(c.sub.baseTiles)
    URL.revokeObjectURL(c.thumb)
  }

  /** Tiles shown for the loaded image, and for the active checkpoint's base. */
  get originalTiles(): TileSet | null {
    return this.checkpoints[0]?.tiles ?? null
  }
  get checkpointTiles(): TileSet | null {
    return this.active?.tiles ?? null
  }

  // ---- canvas geometry (the image pane shows the full canvas) ------------------

  /** Size of the full image. Equals `dims` unless a subregion is active. */
  get canvasSize(): [number, number] | null {
    const sub = this.active?.sub
    if (sub) return [sub.canvasW, sub.canvasH]
    return this.dims ? [this.dims.w, this.dims.h] : null
  }

  /** Where the working image sits on the canvas. */
  get workOrigin(): [number, number] {
    const r = this.active?.sub?.rect
    return r ? [r.x0, r.y0] : [0, 0]
  }

  /** The snapshot drawn under a subregion's working image, if any. */
  get baseTiles(): TileSet | null {
    return this.active?.sub?.baseTiles ?? null
  }

  /**
   * Full-size canvas pixels for a working-image buffer: the working image
   * itself, or for a subregion, the base snapshot with it pasted in place.
   * Always a new buffer.
   */
  private toCanvas(work: Uint8ClampedArray<ArrayBuffer>): Uint8ClampedArray<ArrayBuffer> {
    const sub = this.active?.sub
    if (!sub) return work.slice()
    const out = sub.base.slice()
    const { x0, y0, x1, y1 } = sub.rect
    const rw = x1 - x0
    for (let y = y0; y < y1; y++) {
      out.set(work.subarray((y - y0) * rw * 4, (y - y0 + 1) * rw * 4), (y * sub.canvasW + x0) * 4)
    }
    return out
  }

  /** Close the current result tiles unless a checkpoint owns them. */
  private releaseResult(): void {
    const r = this.result
    if (r && !this.checkpoints.some((c) => c.tiles === r)) closeTiles(r)
    this.result = null
  }

  private teardownImage(): void {
    if (this.views) Atomics.store(this.views.ctrl, 0, ++this.gen)
    clearTimeout(this.refineTimer)
    this.releaseResult()
    this.checkpoints.forEach((c) => this.dropCheckpoint(c))
    this.checkpoints = []
    this.active = null
    this.preview?.close()
    this.heat?.close()
    this.preview = this.heat = null
    this.denoisePreview?.bitmap.close()
    this.denoisePreview = null
    this.local = null
    this.display = null
    this.edits = null
    this.views = null
    this.buffers = null
    this.dims = null
    this.resultPixels = null
    this.selection = null
    this.region = null
    this.fullWaiters.forEach((f) => f())
    this.fullWaiters = []
  }

  // ---- checkpoints -------------------------------------------------------------

  private syncCheckpoints(): void {
    // Checkpoints created, deleted or switched: a save would differ.
    this.serial++
    this.setInfo({
      checkpoints: this.checkpoints.map((c) => ({
        id: c.id,
        label: c.label,
        thumb: c.thumb,
        pending: c !== this.active && (c.saved?.size ?? 0) > 0,
        rect: c.sub?.rect ?? null,
      })),
      activeCheckpoint: this.active?.id ?? 0,
      subregion: this.active?.sub?.rect ?? null,
      switching: this.switching,
    })
  }

  /** Stop in-flight renders and wait until none are running. */
  private async quiesce(): Promise<void> {
    if (this.views) Atomics.store(this.views.ctrl, 0, ++this.gen)
    clearTimeout(this.refineTimer)
    while (this.fullRunning || this.previewRunning) await new Promise((r) => setTimeout(r, 4))
  }

  /**
   * Bake the current result into a new checkpoint and make it the base for
   * further edits. The previous checkpoint keeps its edits. `pixels` is a
   * working-image buffer (e.g. a denoise result); from a subregion, the bake
   * flattens it onto the snapshot below, giving a full-size checkpoint.
   */
  async createCheckpoint(pixels?: Uint8ClampedArray<ArrayBuffer>, label?: string): Promise<void> {
    if (this.switching || !this.active || !this.edits || this.brush) return
    this.switching = true
    this.syncCheckpoints()
    try {
      if (!pixels) await this.untilUpToDate()
      await this.quiesce()
      const views = this.views
      const work = pixels ?? this.resultPixels
      const size = this.canvasSize
      if (!views || !work || !size) return
      const px = this.toCanvas(work)
      const n = this.checkpoints.filter((c) => !c.sub).length
      const cp = await this.makeCheckpoint(label ?? `Checkpoint ${n}`, px, size[0], size[1], null)
      if (this.views !== views) {
        this.dropCheckpoint(cp)
        return
      }
      this.parkActive()
      this.checkpoints.push(cp)
      await this.activate(cp)
    } finally {
      this.switching = false
      this.syncInfo()
      this.syncCheckpoints()
    }
  }

  /**
   * Create a subregion checkpoint from a canvas rect: that area of the current
   * result becomes its own working image (with its own spectrum), composited
   * over a snapshot of everything else.
   */
  async createSubregion(r: Rect): Promise<void> {
    const size = this.canvasSize
    if (!size || this.switching || !this.active || !this.edits || this.brush || this.info.denoise) return
    const [cw, ch] = size
    const rect = {
      x0: Math.max(0, Math.round(Math.min(r.x0, r.x1))),
      y0: Math.max(0, Math.round(Math.min(r.y0, r.y1))),
      x1: Math.min(cw, Math.round(Math.max(r.x0, r.x1))),
      y1: Math.min(ch, Math.round(Math.max(r.y0, r.y1))),
    }
    const rw = rect.x1 - rect.x0
    const rh = rect.y1 - rect.y0
    if (rw < MIN_SUBREGION || rh < MIN_SUBREGION) return
    this.switching = true
    this.syncCheckpoints()
    try {
      await this.untilUpToDate()
      await this.quiesce()
      const views = this.views
      if (!views || !this.resultPixels) return
      const base = this.toCanvas(this.resultPixels)
      const crop = new Uint8ClampedArray(rw * rh * 4)
      for (let y = 0; y < rh; y++) {
        const o = ((rect.y0 + y) * cw + rect.x0) * 4
        crop.set(base.subarray(o, o + rw * 4), y * rw * 4)
      }
      const baseTiles = await makeTiles(base, cw, ch)
      const n = this.checkpoints.filter((c) => c.sub).length + 1
      const cp = await this.makeCheckpoint(`Subregion ${n}`, crop, rw, rh, {
        rect,
        base,
        baseTiles,
        canvasW: cw,
        canvasH: ch,
      })
      if (this.views !== views) {
        this.dropCheckpoint(cp)
        return
      }
      this.parkActive()
      this.checkpoints.push(cp)
      await this.activate(cp)
    } finally {
      this.switching = false
      this.syncInfo()
      this.syncCheckpoints()
    }
  }

  /** Make another checkpoint the base, restoring the edits it had. */
  async gotoCheckpoint(id: number): Promise<void> {
    const cp = this.checkpoints.find((c) => c.id === id)
    if (!cp || cp === this.active || this.switching || this.brush || this.info.denoise) return
    this.switching = true
    this.syncCheckpoints()
    try {
      await this.quiesce()
      this.parkActive()
      await this.activate(cp)
    } finally {
      this.switching = false
      this.syncInfo()
      this.syncCheckpoints()
    }
  }

  /**
   * Delete any checkpoint except the loaded image. Deleting the active one
   * discards its working edits and switches to the checkpoint below it.
   */
  async deleteCheckpoint(id: number): Promise<void> {
    const i = this.checkpoints.findIndex((c) => c.id === id)
    const cp = this.checkpoints[i]
    if (i <= 0 || this.switching || this.brush || this.info.denoise) return
    if (cp !== this.active) {
      this.checkpoints.splice(i, 1)
      this.dropCheckpoint(cp)
      this.syncCheckpoints()
      return
    }
    this.switching = true
    this.syncCheckpoints()
    try {
      await this.quiesce()
      this.checkpoints.splice(i, 1)
      await this.activate(this.checkpoints[i - 1])
      this.dropCheckpoint(cp)
    } finally {
      this.switching = false
      this.syncInfo()
      this.syncCheckpoints()
    }
  }

  private parkActive(): void {
    const a = this.active
    if (!a || !this.edits) return
    a.edits = this.edits
    a.saved = this.edits.saveWorking()
  }

  private async activate(cp: Checkpoint): Promise<void> {
    if (!this.dims || !this.views || !this.resultPixels) return
    this.clearDenoisePreview()
    // A subregion (or leaving one) changes the working image size.
    if (cp.w !== this.dims.w || cp.h !== this.dims.h) await this.allocate(cp.w, cp.h)
    const d = this.dims
    const views = this.views!
    await this.transformSource(cp.pixels)
    this.active = cp
    // Per-channel checkpoints need the G/B multipliers; attach the edits to this image's buffers.
    if (cp.edits?.mode === 'rgb') cp.edits.rebind([views.mult, ...this.ensureGB()])
    else cp.edits?.rebind([views.mult])
    this.edits = cp.edits ?? new EditField(d, views.mult)
    await this.syncEditMode()
    const pending = (cp.saved?.size ?? 0) > 0
    this.edits.restoreWorking(cp.saved)
    cp.saved = null
    this.resultPixels!.set(cp.pixels)
    this.releaseResult()
    this.result = cp.tiles
    this.preview?.close()
    this.preview = null
    this.editVersion++
    this.resultVersion = this.previewVersion = this.editVersion
    if (pending) {
      // Parked edits: redraw their spectrum and render them on the new base.
      await this.pool!.runAll(
        ranges(d.h, this.pool!.size * 2).map(([y0, y1]) => ({
          type: 'disp0' as const,
          y0,
          y1,
          range: this.range!,
          channel: this.info.spectrumChannel,
        })),
        3,
      )
      this.display!.buildPyramid()
      this.editVersion++
      this.requestFull()
    }
    this.estimateNoise()
    this.emitRender('image')
    this.emitRender('spectrum')
    this.requestHeat()
    this.requestLocal()
  }

  /** Resolve once the full-resolution result reflects every edit. */
  private async untilUpToDate(): Promise<void> {
    if (this.resultVersion === this.editVersion) return
    const done = new Promise<void>((r) => this.fullWaiters.push(r))
    clearTimeout(this.refineTimer)
    this.requestFull()
    await done
  }

  // ---- projects ----------------------------------------------------------------

  /** Increases each time a new image or project starts loading. */
  get loadGeneration(): number {
    return this.loadToken
  }

  /** Increases whenever something a project save captures changes. */
  get changeSerial(): number {
    return this.serial
  }

  /** In the middle of something a save shouldn't interleave with. */
  get busy(): boolean {
    return this.info.status !== 'ready' || this.switching || this.brush !== null || this.info.denoise !== null
  }

  /** Compress an image for a project file, in a worker (the input is copied, not consumed). */
  async packPixels(rgba: Uint8ClampedArray<ArrayBuffer>, w: number, h: number): Promise<Uint8Array> {
    const pool = this.ensurePool()
    const copy = rgba.slice()
    return pool.run<Uint8Array>({ type: 'packPixels', rgba: copy, w, h }, 0, [copy.buffer])
  }

  /** Decompress an image from a project file, in a worker. */
  async unpackPixels(data: Uint8Array, w: number, h: number): Promise<Uint8ClampedArray<ArrayBuffer>> {
    const pool = this.ensurePool()
    const copy = data.slice()
    return pool.run<Uint8ClampedArray<ArrayBuffer>>({ type: 'unpackPixels', data: copy, w, h }, 2, [copy.buffer])
  }

  /** The worker pool, created on first use (opening a project needs it before any image is loaded). */
  private ensurePool(): WorkerPool {
    const n = Math.max(2, Math.min(12, (navigator.hardwareConcurrency || 4) - 1))
    this.pool ??= new WorkerPool(n)
    return this.pool
  }

  /** The project as live references, for the saver to diff against the file. Null if nothing is loaded. */
  projectSnapshot(): ProjectSnapshot | null {
    if (this.info.status !== 'ready' || !this.active) return null
    return {
      name: this.info.name,
      activeId: this.active.id,
      spectrumChannel: this.info.spectrumChannel,
      checkpoints: this.checkpoints.map((c) => ({
        id: c.id,
        label: c.label,
        w: c.w,
        h: c.h,
        pixels: c.pixels,
        sub: c.sub,
        edits: c === this.active ? this.edits : c.edits,
        saved: c === this.active ? null : c.saved,
        active: c === this.active,
      })),
    }
  }

  /** Replace everything with a project read from a file. */
  async loadProject(p: LoadedProject): Promise<void> {
    const token = ++this.loadToken
    const first = p.checkpoints[0]
    try {
      await this.loadPixels(first.pixels, first.w, first.h, p.name, token)
      if (token !== this.loadToken) return
      this.switching = true
      this.syncCheckpoints()
      const list: Checkpoint[] = []
      for (const [i, lc] of p.checkpoints.entries()) {
        let cp: Checkpoint
        if (i === 0) {
          cp = this.checkpoints[0]
          cp.label = lc.label
        } else {
          const sub = lc.sub
            ? { ...lc.sub, baseTiles: await makeTiles(lc.sub.base, lc.sub.canvasW, lc.sub.canvasH) }
            : null
          cp = await this.makeCheckpoint(lc.label, lc.pixels, lc.w, lc.h, sub)
        }
        cp.id = lc.id
        const hasEdits = lc.undo.length > 0 || lc.redo.length > 0 || lc.working.size > 0
        cp.edits = hasEdits ? EditField.detached(makeDims(lc.w, lc.h), lc.mode, lc.undo, lc.redo) : null
        cp.saved = lc.working.size ? lc.working : null
        list.push(cp)
      }
      if (token !== this.loadToken) return
      this.checkpoints = list
      this.nextCheckpointId = Math.max(...list.map((c) => c.id)) + 1
      // The base was activated by loadPixels with a fresh field; replace it wholesale.
      this.edits = null
      this.active = null
      await this.quiesce()
      await this.setSpectrumChannel(p.spectrumChannel)
      await this.activate(list.find((c) => c.id === p.activeId) ?? list[0])
    } catch (e) {
      if (token === this.loadToken) this.fail(e)
    } finally {
      this.switching = false
      this.syncInfo()
      this.syncCheckpoints()
    }
  }

  // ---- denoising -------------------------------------------------------------

  /** Noise estimate of the current full-resolution result (cached per result). */
  estimateNoise(): NoiseEstimate | null {
    const px = this.resultPixels
    const d = this.dims
    if (!px || !d) return null
    const key = `${this.active?.id}:${this.resultVersion}`
    if (key !== this.noiseKey || !this.info.noise) {
      this.noiseKey = key
      this.setInfo({ noise: estimateNoiseRGBA(px, d.w, d.h) })
    }
    return this.info.noise
  }

  /** What a denoise run would cost, for the UI. */
  planDenoise(s: DenoiseSettings, scope: 'region' | 'full'): DenoisePlan | null {
    const d = this.dims
    const noise = this.info.noise
    if (!d || !noise || !this.pool) return null
    if (s.algo === 'wiener') {
      const bins = d.wh * d.h
      return {
        sigma: [noise.luma * s.strength],
        tiles: 1,
        threads: 1,
        peakBytes: bins * 12,
        seconds: (bins * 40e-9 * [1, 2, 3][qi(s.quality)]) + 0.05,
      }
    }
    const sigma = this.sigmaFor(s, noise)
    const rect = scope === 'region' && this.region ? this.region : { x0: 0, y0: 0, x1: d.w, y1: d.h }
    const { core, threads } = memoryMode(s.memory, this.pool.size)
    const halo = this.haloFor(s, sigma)
    const rw = rect.x1 - rect.x0
    const rh = rect.y1 - rect.y0
    const tiles = Math.ceil(rw / core) * Math.ceil(rh / core)
    const tile = Math.min(core, rw) + 2 * halo
    const tileH = Math.min(core, rh) + 2 * halo
    // Working set per tile: planes + accumulators (+ basic estimate for BM3D).
    const perPx = s.algo === 'nlm' ? 56 : 84
    const busy = Math.min(threads, tiles)
    const peakBytes = busy * tile * tileH * perPx + rw * rh * 8
    const cost = COST[s.algo][qi(s.quality)] * (sigma[0] > 55 && s.algo === 'nlm' ? 1.8 : 1)
    const work = tiles * tile * tileH * cost
    return { sigma, tiles, threads: busy, peakBytes, seconds: work / busy }
  }

  private sigmaFor(s: DenoiseSettings, n: NoiseEstimate): number[] {
    const [y, u, v] = n.opponent
    return [y * s.strength, u * s.strength * s.chroma, v * s.strength * s.chroma]
  }

  private haloFor(s: DenoiseSettings, sigma: number[]): number {
    return s.algo === 'nlm'
      ? nlmHalo(nlmParams(Math.max(...sigma), s.quality))
      : bm3dHalo(bm3dParams(sigma[0], s.quality))
  }

  /**
   * Run a denoiser. Wiener applies an undoable spectrum edit; NLM and BM3D
   * either preview on the picked region or bake a new checkpoint.
   */
  async denoise(s: DenoiseSettings, scope: 'region' | 'full'): Promise<void> {
    const { pool, dims: d, edits, views } = this
    if (!pool || !d || !edits || !views || this.info.denoise || this.switching) return
    await this.untilUpToDate()
    const noise = this.estimateNoise()
    if (!noise || this.views !== views) return
    const name = `${ALGO_NAMES[s.algo]} · ${s.quality}`

    if (s.algo === 'wiener') {
      const sigma = noise.luma * s.strength
      this.setInfo({ denoise: { scope: 'full', done: 0, total: 1, label: name } })
      try {
        const gains = await pool.run<Float32Array>(
          { type: 'wiener', noisePower: d.w * d.h * sigma * sigma, alpha: 1, radius: qi(s.quality) + 1 },
          1,
        )
        if (this.views !== views || this.edits !== edits) return
        edits.begin({ tool: 'attenuate', strength: 1, gain: 1 })
        edits.fillGains(gains)
        edits.end()
        this.edited('all')
      } finally {
        this.setInfo({ denoise: null })
        this.syncInfo()
      }
      return
    }

    const plan = this.planDenoise(s, scope)
    const px = this.resultPixels
    if (!plan || !px) return
    const rect = scope === 'region' && this.region ? this.region : { x0: 0, y0: 0, x1: d.w, y1: d.h }
    const { core } = memoryMode(s.memory, pool.size)
    const halo = this.haloFor(s, plan.sigma)
    // Measured noise spectrum, scaled like the per-pixel σ.
    const psd = noise.psd.map((p, c) => p.map((v) => v * (c === 0 ? s.strength : s.strength * s.chroma)))
    const gen = ++this.denoiseGen
    Atomics.store(views.ctrl, 1, gen)
    const rw = rect.x1 - rect.x0
    const rh = rect.y1 - rect.y0
    const out = new Uint8ClampedArray(rw * rh * 4)
    for (let y = 0; y < rh; y++) {
      const src = ((rect.y0 + y) * d.w + rect.x0) * 4
      out.set(px.subarray(src, src + rw * 4), y * rw * 4)
    }
    const cores: Rect[] = []
    for (let y = rect.y0; y < rect.y1; y += core) {
      for (let x = rect.x0; x < rect.x1; x += core) {
        cores.push({ x0: x, y0: y, x1: Math.min(rect.x1, x + core), y1: Math.min(rect.y1, y + core) })
      }
    }
    const status = { scope, done: 0, total: cores.length, label: name }
    this.setInfo({ denoise: { ...status } })
    this.denoiseBytes = plan.peakBytes
    let next = 0
    let cancelled = false
    const worker = async () => {
      while (next < cores.length && !cancelled) {
        const c = cores[next++]
        // Extend by the halo, clipped to the image; the worker reflects the rest.
        const ex = { x0: Math.max(0, c.x0 - halo), y0: Math.max(0, c.y0 - halo), x1: Math.min(d.w, c.x1 + halo), y1: Math.min(d.h, c.y1 + halo) }
        const tw = ex.x1 - ex.x0
        const th = ex.y1 - ex.y0
        const rgba = new Uint8ClampedArray(tw * th * 4)
        for (let y = 0; y < th; y++) {
          const src = ((ex.y0 + y) * d.w + ex.x0) * 4
          rgba.set(px.subarray(src, src + tw * 4), y * tw * 4)
        }
        const task: Task = {
          type: 'denoise',
          algo: s.algo as 'nlm' | 'bm3d',
          quality: s.quality,
          rgba,
          tw,
          th,
          missing: [halo - (c.x0 - ex.x0), halo - (c.y0 - ex.y0), halo - (ex.x1 - c.x1), halo - (ex.y1 - c.y1)],
          halo,
          sigma: plan.sigma,
          psd: s.algo === 'bm3d' && s.model === 'measured' ? psd : null,
          gen,
        }
        const res = await pool.run<DenoiseResult>(task, 0, [rgba.buffer])
        if (!res.rgba || Atomics.load(views.ctrl, 1) !== gen) {
          cancelled = true
          return
        }
        const cw = c.x1 - c.x0
        for (let y = 0; y < c.y1 - c.y0; y++) {
          const o = ((c.y0 - rect.y0 + y) * rw + (c.x0 - rect.x0)) * 4
          for (let x = 0; x < cw; x++) {
            const i = (y * cw + x) * 4
            out[o + 4 * x] = res.rgba[i]
            out[o + 4 * x + 1] = res.rgba[i + 1]
            out[o + 4 * x + 2] = res.rgba[i + 2]
          }
        }
        status.done++
        this.setInfo({ denoise: { ...status } })
      }
    }
    try {
      await Promise.all(Array.from({ length: plan.threads }, worker))
      if (cancelled || this.views !== views) return
      if (scope === 'region') {
        const bitmap = await createImageBitmap(new ImageData(out, rw, rh))
        this.clearDenoisePreview()
        this.denoisePreview = { rect, bitmap, label: name }
        this.setInfo({ denoisePreview: name })
        this.emitRender('image')
      } else {
        this.clearDenoisePreview()
        this.setInfo({ denoise: null })
        await this.createCheckpoint(out, name)
      }
    } finally {
      this.denoiseBytes = 0
      this.setInfo({ denoise: null })
    }
  }

  cancelDenoise(): void {
    if (this.views) Atomics.store(this.views.ctrl, 1, ++this.denoiseGen)
  }

  clearDenoisePreview(): void {
    if (!this.denoisePreview) return
    this.denoisePreview.bitmap.close()
    this.denoisePreview = null
    this.setInfo({ denoisePreview: null })
    this.emitRender('image')
  }

  // ---- memory ------------------------------------------------------------------

  /** Bytes held by the app, by category (JS/GPU allocations the engine owns). */
  memory(): MemoryPart[] {
    const d = this.dims
    const b = this.buffers
    if (!d || !b) return []
    const px = d.w * d.h * 4
    const shared = [b.src, b.out, ...b.spec, b.mult, ...(b.gb ?? []), b.work, b.magY, b.disp0, b.ctrl, b.preview].reduce(
      (n, x) => n + x.byteLength,
      0,
    )
    // Pixels + GPU tiles, plus a subregion's full-size snapshot underneath.
    const checkpoints = this.checkpoints.reduce(
      (n, c) => n + 2 * c.pixels.byteLength + (c.sub ? 2 * c.sub.base.byteLength : 0),
      0,
    )
    const resultOwned = this.checkpoints.some((c) => c.tiles === this.result)
    const pyramid = this.display ? this.display.levels.slice(1).reduce((n, l) => n + l.byteLength, 0) : 0
    const view =
      (this.resultPixels?.byteLength ?? 0) +
      (this.result && !resultOwned ? px : 0) +
      pyramid +
      (this.preview ? b.pw * b.ph * 4 : 0) +
      (this.heat ? this.heat.width * this.heat.height * 4 : 0) +
      (this.denoisePreview ? this.denoisePreview.bitmap.width * this.denoisePreview.bitmap.height * 4 : 0)
    let history = this.edits?.bytes ?? 0
    for (const c of this.checkpoints) {
      if (c.edits && c.edits !== this.edits) history += c.edits.bytes
      if (c.saved) for (const t of c.saved.values()) history += t.re.byteLength + t.im.byteLength
    }
    const parts: MemoryPart[] = [
      { label: 'Spectra & buffers', bytes: shared },
      { label: 'Checkpoints', bytes: checkpoints },
      { label: 'Display', bytes: view },
      { label: 'History', bytes: history },
    ]
    if (this.denoiseBytes) parts.push({ label: 'Denoise', bytes: this.denoiseBytes })
    return parts
  }

  // ---- editing ---------------------------------------------------------------

  /**
   * Which multipliers an edit made in the current view writes to, switching
   * an unedited checkpoint into the matching mode first. Null if the view
   * doesn't match the checkpoint's committed mode (then a new checkpoint is
   * needed), in which case the refusal is signalled via `editBlocked`.
   */
  private editTargets(): number[] | null {
    const edits = this.edits
    const views = this.views
    if (!edits || !views) return null
    const ch = channelIndex(this.info.spectrumChannel)
    const want: EditMode = ch < 0 ? 'shared' : 'rgb'
    const locked = edits.lockedMode
    if (locked && locked !== want) {
      this.setInfo({ editBlocked: this.info.editBlocked + 1 })
      return null
    }
    if (edits.mode !== want) {
      if (want === 'rgb') edits.useRGB([views.mult, ...this.ensureGB()])
      else edits.useShared(views.mult)
      // Workers get the new multipliers before any render task queued after this.
      void this.syncEditMode()
    }
    return want === 'rgb' ? [ch] : [0]
  }

  /** Multiplier per colour channel for the active edits. */
  private channelMults(): Float32Array[] {
    const v = this.views!
    return this.edits?.mode === 'rgb' && v.gb ? [v.mult, ...v.gb] : [v.mult, v.mult, v.mult]
  }

  /** Allocate the G and B multipliers for this image (once), returning them. */
  private ensureGB(): [Float32Array, Float32Array] {
    const v = this.views!
    const b = this.buffers!
    if (!v.gb) {
      const bytes = b.mult.byteLength
      b.gb = [new SharedArrayBuffer(bytes), new SharedArrayBuffer(bytes)]
      v.gb = [new Float32Array(b.gb[0]), new Float32Array(b.gb[1])]
      for (const m of v.gb) for (let i = 0; i < m.length; i += 2) m[i] = 1
    }
    return v.gb
  }

  /** Tell the display and every worker which multipliers each channel uses. */
  private async syncEditMode(): Promise<void> {
    const rgb = this.edits?.mode === 'rgb'
    this.display?.setMults(this.channelMults())
    this.setInfo({ editMode: this.edits?.lockedMode ?? null })
    await this.pool?.broadcast({ type: 'mults', gb: rgb && this.buffers?.gb ? this.buffers.gb : null })
  }

  beginStroke(settings: BrushSettings): void {
    if (!this.edits || this.switching) return
    const targets = this.editTargets()
    if (!targets) return
    this.brush = settings
    this.lastDab = null
    this.edits.begin(settings, targets)
  }

  /** Extend the current stroke to display point (x, y), dabbing along the way. */
  strokeTo(x: number, y: number): void {
    const { edits, brush, dims } = this
    if (!edits || !brush || !dims) return
    const spacing = Math.max(0.35, brush.radius * 0.2)
    const pts: [number, number][] = []
    if (!this.lastDab) {
      pts.push([x, y])
      this.lastDab = [x, y]
    } else {
      const [lx, ly] = this.lastDab
      const dist = Math.hypot(x - lx, y - ly)
      const steps = Math.floor(dist / spacing)
      for (let i = 1; i <= steps; i++) pts.push([lx + ((x - lx) * i * spacing) / dist, ly + ((y - ly) * i * spacing) / dist])
      if (steps > 0) this.lastDab = pts[pts.length - 1]
    }
    let box: Rect | null = null
    for (const [px, py] of pts) {
      const r = edits.dab(px, py, brush.radius, brush.hardness)
      if (r) box = box ? union(box, r) : r
    }
    if (box) this.edited([box, ...mirrorRects(dims, box)])
  }

  endStroke(): void {
    if (!this.edits) return
    this.brush = null
    this.lastDab = null
    if (this.edits.end()) this.setInfo({ strokes: this.info.strokes + 1 })
    this.syncInfo()
  }

  /** Abandon the current stroke (e.g. it turned into a two-finger pinch), leaving no trace in the spectrum or history. */
  cancelStroke(): void {
    if (!this.edits) return
    this.brush = null
    this.lastDab = null
    const dirty = this.edits.cancel()
    if (dirty) this.edited(dirty)
    this.syncInfo()
  }

  // ---- spectrum channel ----------------------------------------------------------

  /** Show the luminance spectrum or one colour channel's. Display only: edits still apply to all channels. */
  async setSpectrumChannel(channel: SpectrumChannel): Promise<void> {
    const { pool, dims, range, display } = this
    if (channel === this.info.spectrumChannel) return
    this.setInfo({ spectrumChannel: channel })
    if (!pool || !dims || !range || !display) return
    display.setChannel(channel)
    await pool.runAll(
      ranges(dims.h, pool.size * 2).map(([y0, y1]) => ({ type: 'disp0' as const, y0, y1, range, channel })),
      2,
    )
    if (this.display !== display) return
    display.buildPyramid()
    this.emitRender('spectrum')
    this.requestLocal()
  }

  // ---- hints -------------------------------------------------------------------

  /** Display-space points marked over the spectrum (e.g. by the tutorial). */
  hints: { x: number; y: number }[] | null = null

  /**
   * Mark the strongest periodic spikes in the spectrum (the region spectrum
   * when `local`, else the whole image). Returns how many were found.
   */
  showSpikeHints(local: boolean, count = 6): number {
    const d = this.dims
    const disp = this.display
    if (!d || !disp) return 0
    const MIN_SCORE = 250
    let pts: { x: number; y: number }[]
    if (local && this.local) {
      const { map, pw, ph } = this.local
      pts = findSpikes(map, pw, ph, count, MIN_SCORE).map((p) => ({
        x: d.cx + 0.5 + ((p.x - (pw >> 1)) * d.w) / pw,
        y: d.cy + 0.5 + ((p.y - (ph >> 1)) * d.h) / ph,
      }))
    } else {
      // Max-pooled pyramid level of at most ~1200 px: spikes survive pooling.
      let L = 0
      while (L < disp.levels.length - 1 && disp.lw[L] > 1200) L++
      const k = 2 ** L
      pts = findSpikes(disp.levels[L], disp.lw[L], disp.lh[L], count, MIN_SCORE).map((p) => ({
        x: (p.x + 0.5) * k,
        y: (p.y + 0.5) * k,
      }))
    }
    this.hints = pts
    this.emitRender('overlay')
    return pts.length
  }

  /**
   * Drop hints whose spike has been erased: the strongest original bin near
   * the hint now has gain below 0.5. Never adds hints. Returns how many remain.
   */
  pruneErasedHints(): number {
    const d = this.dims
    const b = this.buffers
    const disp = this.display
    if (!this.hints || !d || !b || !disp) return this.hints?.length ?? 0
    // Region-spectrum hints are placed on a coarser grid: search a matching window.
    const r = this.local ? Math.ceil((1.5 * d.w) / this.local.pw) : 2
    const kept = this.hints.filter((h) => {
      const hx = Math.floor(h.x)
      const hy = Math.floor(h.y)
      let best = -1
      let bin = 0
      for (let y = hy - r; y <= hy + r; y++) {
        for (let x = hx - r; x <= hx + r; x++) {
          if (x < 0 || y < 0 || x >= d.w || y >= d.h) continue
          const k = binOf(d, x - d.cx, y - d.cy)
          const i = k < 0 ? ~k : k
          const v = disp.magAt(i)
          if (v > best) {
            best = v
            bin = i
          }
        }
      }
      return best < 0 || disp.gainAt(bin) >= 0.5
    })
    if (kept.length !== this.hints.length) {
      this.hints = kept
      this.emitRender('overlay')
    }
    return kept.length
  }

  /** Image-space areas greyed out over the image (e.g. by the tutorial). */
  imageZones: Rect[] | null = null

  setImageZones(zones: Rect[] | null): void {
    if (zones === this.imageZones) return
    this.imageZones = zones
    this.emitRender('image')
  }

  clearHints(): void {
    if (!this.hints) return
    this.hints = null
    this.emitRender('overlay')
  }

  /** Apply an edit inside (or outside) the spectrum selection. */
  applyToSelection(params: EditParams, where: 'inside' | 'outside'): void {
    const { edits, selection, dims } = this
    if (!edits || !selection || !dims || this.switching) return
    const targets = this.editTargets()
    if (!targets) return
    edits.begin(params, targets)
    const dirty =
      where === 'inside'
        ? edits.fillShape(selection)
        : edits.fillAll((dx, dy) => 1 - shapeWeight(selection, dx, dy), true)
    if (edits.end()) this.setInfo({ strokes: this.info.strokes + 1 })
    this.edited(dirty)
    this.syncInfo()
  }

  resetEdits(): void {
    const { edits } = this
    if (!edits || edits.isEmpty || this.switching) return
    edits.begin({ tool: 'restore', strength: 1, gain: 1 })
    edits.fillAll(() => 1, false)
    edits.end()
    this.edited('all')
    this.syncInfo()
  }

  undo(): void {
    if (this.switching) return
    const dirty = this.edits?.undo()
    if (dirty) this.edited(dirty)
    this.syncInfo()
  }

  redo(): void {
    if (this.switching) return
    const dirty = this.edits?.redo()
    if (dirty) this.edited(dirty)
    this.syncInfo()
  }

  private edited(dirty: Dirty): void {
    const { display, pool, dims, range } = this
    if (!display || !pool || !dims || !range) return
    this.clearDenoisePreview()
    this.serial++
    this.editVersion++
    if (dirty === 'all') {
      const token = this.loadToken
      void pool
        .runAll(
          ranges(dims.h, pool.size * 2).map(([y0, y1]) => ({
            type: 'disp0' as const,
            y0,
            y1,
            range,
            channel: this.info.spectrumChannel,
          })),
          1,
        )
        .then(() => {
          if (token !== this.loadToken || this.display !== display) return
          display.buildPyramid()
          this.emitRender('spectrum')
        })
    } else {
      display.refresh(dirty)
      this.emitRender('spectrum')
    }
    if (this.info.fastFull) {
      this.requestFull()
    } else {
      if (this.fullRunning && this.views) Atomics.store(this.views.ctrl, 0, ++this.gen)
      this.requestPreview()
      clearTimeout(this.refineTimer)
      this.refineTimer = window.setTimeout(() => this.requestFull(), REFINE_DELAY_MS)
    }
    this.requestHeat()
    this.syncInfo()
  }

  // ---- rendering the result -------------------------------------------------

  private requestFull(): void {
    if (this.fullRunning) {
      this.fullPending = true
      return
    }
    void this.runFull()
  }

  private async runFull(): Promise<void> {
    const { pool, dims, views } = this
    if (!pool || !dims || !views) return
    this.fullRunning = true
    this.fullPending = false
    this.syncInfo()
    const v = this.editVersion
    const gen = ++this.gen
    Atomics.store(views.ctrl, 0, gen)
    const t0 = performance.now()
    const k = pool.size
    let ok = true
    try {
      for (let c = 0; c < 3 && ok; c++) {
        const a = await pool.runAll<boolean>(
          ranges(dims.wh, k, 8).map(([x0, x1]) => ({ type: 'invCols' as const, c, x0, x1, gen })),
          1,
        )
        ok = a.every(Boolean)
        if (!ok) break
        const b = await pool.runAll<boolean>(
          ranges(dims.h, k).map(([y0, y1]) => ({ type: 'invRows' as const, c, y0, y1, gen })),
          1,
        )
        ok = b.every(Boolean)
      }
      if (ok && this.views === views && this.resultPixels) {
        this.resultPixels.set(views.out)
        const tiles = await makeTiles(this.resultPixels, dims.w, dims.h)
        if (this.views !== views) {
          closeTiles(tiles)
          return
        }
        this.releaseResult()
        this.result = tiles
        this.resultVersion = v
        this.setInfo({ lastFullMs: performance.now() - t0 })
        this.estimateNoise()
        this.emitRender('image')
        this.requestLocal()
        if (v === this.editVersion) {
          this.fullWaiters.forEach((f) => f())
          this.fullWaiters = []
        }
      }
    } finally {
      this.fullRunning = false
      if (this.views === views && (this.fullPending || (this.info.fastFull && this.editVersion !== this.resultVersion))) {
        void this.runFull()
      } else {
        this.syncInfo()
      }
    }
  }

  private requestPreview(): void {
    if (this.previewRunning) {
      this.previewPending = true
      return
    }
    void this.runPreview()
  }

  private async runPreview(): Promise<void> {
    const { pool, buffers, views } = this
    if (!pool || !buffers || !views) return
    this.previewRunning = true
    this.previewPending = false
    const v = this.editVersion
    const t0 = performance.now()
    try {
      await pool.runAll([0, 1, 2].map((c) => ({ type: 'preview' as const, c })), 2)
      if (this.views !== views) return
      const px = new Uint8ClampedArray(views.preview)
      const bmp = await createImageBitmap(new ImageData(px, buffers.pw, buffers.ph))
      if (this.views !== views) {
        bmp.close()
        return
      }
      this.preview?.close()
      this.preview = bmp
      this.previewVersion = v
      this.setInfo({ lastPreviewMs: performance.now() - t0 })
      this.emitRender('image')
    } finally {
      this.previewRunning = false
      if (this.previewPending && this.views === views) void this.runPreview()
    }
  }

  // ---- isolation: spectrum selection → where in the image --------------------

  selection: Shape | null = null

  setSelection(shape: Shape | null): void {
    this.selection = shape ? normShape(shape) : null
    if (!this.selection) {
      this.heat?.close()
      this.heat = null
    }
    this.emitRender('image')
    this.setInfo({ selection: this.selection })
    this.requestHeat()
  }

  private requestHeat(): void {
    if (!this.selection) return
    if (this.heatRunning) {
      this.heatPending = true
      return
    }
    void this.runHeat()
  }

  private async runHeat(): Promise<void> {
    const { pool, dims, selection, views } = this
    if (!pool || !dims || !selection || !views) return
    const bb = shapeBounds(dims, selection)
    if (!bb) return
    this.heatRunning = true
    this.heatPending = false
    try {
      const aspect = dims.w / dims.h
      const tw = aspect >= 1 ? HEAT_SIZE : Math.round(HEAT_SIZE * aspect)
      const th = aspect >= 1 ? Math.round(HEAT_SIZE / aspect) : HEAT_SIZE
      const gw = Math.min(HEAT_MAX, nextSmooth(Math.max(bb.x1 - bb.x0, Math.min(dims.w, tw))))
      const gh = Math.min(HEAT_MAX, nextSmooth(Math.max(bb.y1 - bb.y0, Math.min(dims.h, th))))
      const r = await pool.run<EnvelopeResult>({ type: 'envelope', shape: selection, gw, gh }, 2)
      if (this.views !== views || this.selection !== selection) return
      const bmp = await heatBitmap(r)
      if (this.views !== views || this.selection !== selection) {
        bmp.close()
        return
      }
      this.heat?.close()
      this.heat = bmp
      this.emitRender('image')
    } finally {
      this.heatRunning = false
      if (this.heatPending) this.requestHeat()
    }
  }

  // ---- isolation: image region → local spectrum -------------------------------

  region: Rect | null = null

  setRegion(r: Rect | null): void {
    this.clearDenoisePreview()
    const d = this.dims
    const clipped = r && d ? clipRect(d, r) : null
    this.region = clipped && clipped.x1 - clipped.x0 >= 4 && clipped.y1 - clipped.y0 >= 4 ? clipped : null
    if (!this.region) this.local = null
    this.emitRender('image')
    this.emitRender('spectrum')
    this.setInfo({ region: this.region, hasLocal: this.local !== null })
    this.requestLocal()
  }

  private requestLocal(): void {
    if (!this.region) return
    if (this.localRunning) {
      this.localPending = true
      return
    }
    void this.runLocal()
  }

  private async runLocal(): Promise<void> {
    const { pool, dims, region, resultPixels, views } = this
    if (!pool || !dims || !region || !resultPixels) return
    this.localRunning = true
    this.localPending = false
    try {
      const x0 = region.x0
      const y0 = region.y0
      const pw = Math.min(LOCAL_MAX, region.x1 - x0)
      const ph = Math.min(LOCAL_MAX, region.y1 - y0)
      // The shown spectrum's channel (luminance by default).
      const ch = channelIndex(this.info.spectrumChannel)
      const lum = new Float32Array(pw * ph)
      for (let y = 0; y < ph; y++) {
        let s = ((y0 + y) * dims.w + x0) * 4
        for (let x = 0; x < pw; x++, s += 4) {
          lum[y * pw + x] = ch < 0 ? 0.299 * resultPixels[s] + 0.587 * resultPixels[s + 1] + 0.114 * resultPixels[s + 2] : resultPixels[s + ch]
        }
      }
      const r = await pool.run<LocalResult>({ type: 'local', lum, pw, ph }, 2, [lum.buffer])
      if (this.views !== views || this.region !== region) return
      this.local = r
      this.setInfo({ hasLocal: true })
      this.emitRender('spectrum')
    } finally {
      this.localRunning = false
      if (this.localPending) this.requestLocal()
    }
  }

  // ---- queries & export ---------------------------------------------------------

  binInfo(dx: number, dy: number): BinInfo | null {
    const d = this.dims
    if (!d || !this.buffers || !this.views) return null
    if (dx < 0 || dy < 0 || dx >= d.w || dy >= d.h) return null
    const kx = dx - d.cx
    const ky = dy - d.cy
    const b = binOf(d, kx, ky)
    const i = b < 0 ? ~b : b
    const mag = this.display?.magAt(i) ?? new Float32Array(this.buffers.magY)[i]
    const fx = kx / d.w
    const fy = ky / d.h
    const f = Math.hypot(fx, fy)
    return {
      kx,
      ky,
      magnitude: mag,
      gain: this.display?.gainAt(i) ?? 1,
      period: f === 0 ? Infinity : 1 / f,
      angle: (Math.atan2(-fy, fx) * 180) / Math.PI,
    }
  }

  /** Full-resolution PNG of the current result (waits for a pending refine). */
  async exportPng(): Promise<Blob> {
    const { pool, dims } = this
    if (!pool || !dims) throw new Error('No image loaded')
    if (this.resultVersion !== this.editVersion) {
      const done = new Promise<void>((r) => this.fullWaiters.push(r))
      clearTimeout(this.refineTimer)
      this.requestFull()
      await done
    }
    const px = this.resultPixels
    const size = this.canvasSize
    if (!px || !size) throw new Error('No image loaded')
    // Always the full image: a subregion is composited over its snapshot.
    const copy = this.toCanvas(px)
    return pool.run<Blob>({ type: 'png', rgba: copy, w: size[0], h: size[1] }, 3, [copy.buffer])
  }
}

function union(a: Rect, b: Rect): Rect {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  }
}

/**
 * Spotlight mask from an envelope: transparent where the selected
 * frequencies are strong, dark where they are weak. A pattern that fills
 * the frame leaves the image visible rather than washing it out.
 */
async function heatBitmap({ env, gw, gh }: EnvelopeResult): Promise<ImageBitmap> {
  let max = 0
  for (let i = 0; i < env.length; i++) if (env[i] > max) max = env[i]
  const px = new Uint8ClampedArray(gw * gh * 4)
  const inv = max > 0 ? 1 / max : 0
  for (let i = 0; i < env.length; i++) {
    const t = Math.min(1, env[i] * inv * 1.25)
    // A faint warm glow marks the strongest areas.
    const [r, g, b] = sample('inferno', 0.15 + 0.7 * t)
    const dark = (1 - t) ** 1.4
    px[4 * i] = r * (1 - dark) * 0.35
    px[4 * i + 1] = g * (1 - dark) * 0.35
    px[4 * i + 2] = b * (1 - dark) * 0.35
    px[4 * i + 3] = 255 * Math.max(dark * 0.92, 0.12 * t)
  }
  return createImageBitmap(new ImageData(px, gw, gh))
}

/** Small preview of a tile set, as an object URL. */
async function thumbnail(set: TileSet, outline?: Rect): Promise<string> {
  const s = 120 / Math.max(set.w, set.h)
  const c = new OffscreenCanvas(Math.max(1, Math.round(set.w * s)), Math.max(1, Math.round(set.h * s)))
  const g = c.getContext('2d')!
  g.imageSmoothingQuality = 'high'
  for (const t of set.tiles) g.drawImage(t.bmp, t.x * s, t.y * s, t.w * s, t.h * s)
  if (outline) {
    // Subregion thumbnails: dim the rest and outline the area.
    const { x0, y0, x1, y1 } = outline
    g.fillStyle = 'rgba(0, 0, 0, 0.45)'
    g.beginPath()
    g.rect(0, 0, c.width, c.height)
    g.rect(x0 * s, y0 * s, (x1 - x0) * s, (y1 - y0) * s)
    g.fill('evenodd')
    g.strokeStyle = '#5ee0ff'
    g.lineWidth = 2
    g.strokeRect(x0 * s, y0 * s, (x1 - x0) * s, (y1 - y0) * s)
  }
  return URL.createObjectURL(await c.convertToBlob({ type: 'image/png' }))
}

const ALGO_NAMES: Record<DenoiseAlgo, string> = { wiener: 'Wiener', nlm: 'NL-means', bm3d: 'BM3D' }

const qi = (q: Quality) => (q === 'fast' ? 0 : q === 'balanced' ? 1 : 2)

/** Single-thread seconds per padded tile pixel, measured on NIND crops (fast, balanced, best). */
const COST: Record<'nlm' | 'bm3d', number[]> = {
  nlm: [3e-6, 9e-6, 22e-6],
  bm3d: [6e-6, 44e-6, 70e-6],
}

/** Tile core size and parallelism for each memory mode. */
function memoryMode(m: MemoryMode, poolSize: number): { core: number; threads: number } {
  if (m === 'low') return { core: 128, threads: Math.min(2, poolSize) }
  if (m === 'balanced') return { core: 256, threads: poolSize }
  return { core: 512, threads: poolSize }
}
