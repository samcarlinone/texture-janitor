import {
  canonicalBin,
  clipRect,
  displayRectsForStored,
  mirrorBin,
  mirrorRects,
  shapeBounds,
  shapeWeight,
  type Dims,
  type Rect,
  type Shape,
} from './layout.ts'

export type EditTool = 'attenuate' | 'amplify' | 'restore'

export interface EditParams {
  tool: EditTool
  /** 0..1, scales the brush coverage. */
  strength: number
  /** Amplify target multiplier at full strength. */
  gain: number
}

/** Tile edge, in stored bins. Undo snapshots are taken per tile. */
export const TS = 64
const UNDO_LIMIT = 60
/** Undo history memory budget, in bytes. */
const UNDO_BUDGET = 768 * 1024 * 1024

export interface Snap {
  re: Float32Array
  im: Float32Array
}

interface StrokeSnap extends Snap {
  /** Max coverage reached this stroke, per bin. */
  a: Float32Array
}

interface Stroke {
  params: EditParams
  /** Indices into `mults` this stroke writes to. */
  targets: number[]
  tiles: Map<number, StrokeSnap>
}

/**
 * 'shared': one multiplier applied to R, G and B alike (luminance editing,
 * the default). 'rgb': one multiplier per colour channel.
 */
export type EditMode = 'shared' | 'rgb'

export interface UndoEntry {
  /** Stable id, and a revision bumped whenever undo/redo swaps its contents (for saving only what changed). */
  id: number
  rev: number
  tiles: Map<number, Snap>
  bytes: number
}

let nextEntryId = 1

/** Keep newly created history entries' ids above any loaded from a project. */
export function reserveEntryIds(maxId: number): void {
  nextEntryId = Math.max(nextEntryId, maxId + 1)
}

export type Dirty = Rect[] | 'all'

/** A field's working multiplier, parked while another checkpoint is active. */
export type SavedWorking = Map<number, Snap>

function falloff(t: number, hardness: number): number {
  if (t >= 1) return 0
  if (t <= hardness) return 1
  const s = (t - hardness) / (1 - hardness)
  return 1 - s * s * (3 - 2 * s)
}

/**
 * The per-bin complex multiplier(s) applied to the original spectra, and the
 * stroke / undo machinery that edits them. In 'shared' mode there is one
 * multiplier for all colour channels; in 'rgb' mode, one per channel.
 * Undo tiles are keyed by channel and tile.
 *
 * Edits are written to one canonical bin per frequency pair {k, -k}, which
 * keeps the edited spectrum Hermitian (a real image). Within a stroke each
 * bin records its max coverage, and its value is always recomputed from the
 * pre-stroke value, so overlapping dabs never compound.
 */
export class EditField {
  readonly d: Dims
  mults: Float32Array[]
  private readonly tilesX: number
  private readonly tilesY: number
  /** Tiles per channel; undo keys are channel * nTiles + tile. */
  private readonly nTiles: number
  private stroke: Stroke | null = null
  private undoStack: UndoEntry[] = []
  private redoStack: UndoEntry[] = []
  /**
   * Tile keys whose working values changed since the last `takeDirty`, or
   * 'all' after a wholesale change. Lets a project save write only those tiles.
   */
  private dirty: Set<number> | 'all' = new Set()

  constructor(d: Dims, shared: Float32Array) {
    this.d = d
    this.mults = [shared]
    this.tilesX = Math.ceil(d.wh / TS)
    this.tilesY = Math.ceil(d.h / TS)
    this.nTiles = this.tilesX * this.tilesY
  }

  /**
   * A field restored from a project, not yet attached to buffers: `rebind`
   * attaches it when its checkpoint is activated.
   */
  static detached(d: Dims, mode: EditMode, undo: UndoEntry[], redo: UndoEntry[]): EditField {
    const f = new EditField(d, new Float32Array(0))
    if (mode === 'rgb') f.mults = [new Float32Array(0), new Float32Array(0), new Float32Array(0)]
    f.undoStack = undo
    f.redoStack = redo
    reserveEntryIds(Math.max(0, ...undo.map((e) => e.id), ...redo.map((e) => e.id)))
    return f
  }

  /** The undo and redo stacks, oldest first (read-only view for saving). */
  get history(): { undo: readonly UndoEntry[]; redo: readonly UndoEntry[] } {
    return { undo: this.undoStack, redo: this.redoStack }
  }

  /** Tiles per channel (keys are channel * nTiles + tile). */
  get tileCount(): number {
    return this.nTiles
  }

  /** Changed tile keys since the last call (and reset), or 'all'. */
  takeDirty(): number[] | 'all' {
    const d = this.dirty
    this.dirty = new Set()
    return d === 'all' ? 'all' : [...d]
  }

  /** Put dirty keys back (e.g. after a failed save). */
  restoreDirty(keys: number[] | 'all'): void {
    if (keys === 'all' || this.dirty === 'all') this.dirty = 'all'
    else for (const k of keys) this.dirty.add(k)
  }

  /** A copy of one working tile's values, read from the live multipliers. */
  readTile(key: number): Snap {
    const t = { re: new Float32Array(TS * TS), im: new Float32Array(TS * TS) }
    this.copyTile(key, t, false)
    return t
  }

  get mode(): EditMode {
    return this.mults.length === 3 ? 'rgb' : 'shared'
  }

  /** The mode this field's edits are committed to, or null while it has none. */
  get lockedMode(): EditMode | null {
    return this.isEmpty ? null : this.mode
  }

  /**
   * Switch an unedited field to per-channel editing, with `rgb` as the three
   * channel multipliers (reset to identity here).
   */
  useRGB(rgb: Float32Array[]): void {
    if (!this.isEmpty) throw new Error('EditField.useRGB: field already has edits')
    for (const m of rgb) {
      for (let i = 0; i < m.length; i += 2) {
        m[i] = 1
        m[i + 1] = 0
      }
    }
    this.mults = rgb
    this.dirty = 'all'
  }

  /** Switch an unedited field back to one multiplier shared by all channels. */
  useShared(shared: Float32Array): void {
    if (!this.isEmpty) throw new Error('EditField.useShared: field already has edits')
    this.mults = [shared]
    this.dirty = 'all'
  }

  /**
   * Point at new multiplier buffers of the same size and count (shared
   * buffers are re-allocated when switching checkpoints).
   */
  rebind(mults: Float32Array[]): void {
    const detached = this.mults[0].length === 0
    if (mults.length !== this.mults.length || (!detached && mults[0].length !== this.mults[0].length)) {
      throw new Error('EditField.rebind: shape mismatch')
    }
    this.mults = mults
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0
  }
  get isEmpty(): boolean {
    return this.undoStack.length === 0 && this.redoStack.length === 0
  }

  /** Start a stroke writing to the given multipliers (default: all of them). */
  begin(params: EditParams, targets?: number[]): void {
    this.stroke = { params, targets: targets ?? this.mults.map((_, i) => i), tiles: new Map() }
  }

  /** Finish the stroke. Returns true if it changed anything. */
  end(): boolean {
    const s = this.stroke
    this.stroke = null
    if (!s || s.tiles.size === 0) return false
    const tiles = new Map<number, Snap>()
    for (const [k, t] of s.tiles) tiles.set(k, { re: t.re, im: t.im })
    this.markDirty(tiles.keys())
    this.push(this.undoStack, { id: nextEntryId++, rev: 0, tiles, bytes: tiles.size * TS * TS * 8 })
    this.redoStack = []
    return true
  }

  /**
   * The multiplier as sparse tiles (only tiles holding a non-identity bin),
   * for parking this field's working edits while another checkpoint is active.
   */
  saveWorking(): SavedWorking {
    const out = new Map<number, Snap>()
    const { wh, h } = this.d
    for (let key = 0; key < this.nTiles * this.mults.length; key++) {
      const m = this.mults[(key / this.nTiles) | 0]
      const tile = key % this.nTiles
      const tx = tile % this.tilesX
      const ty = (tile / this.tilesX) | 0
      const x1 = Math.min(wh, tx * TS + TS)
      const y1 = Math.min(h, ty * TS + TS)
      let edited = false
      for (let y = ty * TS; y < y1 && !edited; y++) {
        for (let x = tx * TS; x < x1; x++) {
          const g = 2 * (y * wh + x)
          if (m[g] !== 1 || m[g + 1] !== 0) {
            edited = true
            break
          }
        }
      }
      if (!edited) continue
      const t = { re: new Float32Array(TS * TS), im: new Float32Array(TS * TS) }
      this.copyTile(key, t, false)
      out.set(key, t)
    }
    return out
  }

  /** Reset the multiplier to identity, then write back tiles from `saveWorking`. */
  restoreWorking(saved: SavedWorking | null): void {
    for (const m of this.mults) {
      for (let i = 0; i < m.length; i += 2) {
        m[i] = 1
        m[i + 1] = 0
      }
    }
    if (saved) for (const [key, t] of saved) this.copyTile(key, t, true)
  }

  undo(): Dirty | null {
    return this.swap(this.undoStack, this.redoStack)
  }

  redo(): Dirty | null {
    return this.swap(this.redoStack, this.undoStack)
  }

  /** Circular brush dab centered at display (px, py). Returns the display bbox touched. */
  dab(px: number, py: number, radius: number, hardness: number): Rect | null {
    const d = this.d
    const r = Math.max(0.5, radius)
    const box = clipRect(d, {
      x0: Math.floor(px - r),
      y0: Math.floor(py - r),
      x1: Math.ceil(px + r) + 1,
      y1: Math.ceil(py + r) + 1,
    })
    if (!box) return null
    const r2 = r * r
    for (let dy = box.y0; dy < box.y1; dy++) {
      const fy = dy + 0.5 - py
      for (let dx = box.x0; dx < box.x1; dx++) {
        const fx = dx + 0.5 - px
        const dist2 = fx * fx + fy * fy
        if (dist2 >= r2) continue
        const w = falloff(Math.sqrt(dist2) / r, hardness)
        if (w <= 0) continue
        // If the mirror pixel is in the dab too, both land on the same
        // canonical bin; max coverage makes the second hit a no-op.
        this.touch(canonicalBin(d, dx - d.cx, dy - d.cy), w)
      }
    }
    return box
  }

  /** Apply the current stroke inside a selection shape. */
  fillShape(shape: Shape): Dirty {
    const d = this.d
    const box = shapeBounds(d, shape)
    if (!box) return []
    for (let dy = box.y0; dy < box.y1; dy++) {
      for (let dx = box.x0; dx < box.x1; dx++) {
        const w = shapeWeight(shape, dx, dy)
        if (w > 0) this.touch(canonicalBin(d, dx - d.cx, dy - d.cy), w)
      }
    }
    return [box, ...mirrorRects(d, box)]
  }

  /**
   * Apply the current stroke to every frequency pair, with coverage from
   * `weight(dx, dy)`, maximized over both display positions of the pair.
   */
  fillAll(weight: (dx: number, dy: number) => number, keepDC: boolean): Dirty {
    const { w, h, wh, cx, cy, nyqX } = this.d
    const half = h >> 1
    for (let y = 0; y < h; y++) {
      const ky = y <= half ? y : y - h
      const dyp = (((ky + cy) % h) + h) % h
      const dym = (((cy - ky) % h) + h) % h
      for (let x = 0; x < wh; x++) {
        if ((x === 0 || x === nyqX) && y > half) continue // not canonical
        if (keepDC && x === 0 && y === 0) continue
        const dxp = (x + cx) % w
        const dxm = (((cx - x) % w) + w) % w
        const c = Math.max(weight(dxp, dyp), weight(dxm, dym))
        if (c > 0) this.touch(y * wh + x, c)
      }
    }
    return 'all'
  }

  /** Scale every frequency pair by a gain in [0, 1] (one per stored bin), with the current stroke. */
  fillGains(gains: Float32Array): Dirty {
    const { h, wh, nyqX } = this.d
    const half = h >> 1
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < wh; x++) {
        if ((x === 0 || x === nyqX) && y > half) continue // not canonical
        const i = y * wh + x
        const c = 1 - gains[i]
        if (c > 0) this.touch(i, c)
      }
    }
    return 'all'
  }

  /** Bytes held by undo/redo history and parked working edits. */
  get bytes(): number {
    const sum = (s: UndoEntry[]) => s.reduce((n, e) => n + e.bytes, 0)
    return sum(this.undoStack) + sum(this.redoStack)
  }

  private touch(cb: number, w: number): void {
    const s = this.stroke
    if (!s) return
    for (const ch of s.targets) this.touchChannel(s, ch, cb, w)
  }

  private touchChannel(s: Stroke, ch: number, cb: number, w: number): void {
    const d = this.d
    // Every tool scales by a real factor, so the conjugate flag doesn't matter.
    const i = cb < 0 ? ~cb : cb
    const x = i % d.wh
    const y = (i / d.wh) | 0
    const snap = this.snapshot(s, ch, x, y)
    const li = (y % TS) * TS + (x % TS)
    if (w <= snap.a[li]) return
    snap.a[li] = w
    const p = s.params
    const a = w * p.strength
    const r0 = snap.re[li]
    const i0 = snap.im[li]
    let nr = r0
    let ni = i0
    switch (p.tool) {
      case 'attenuate':
        nr = r0 * (1 - a)
        ni = i0 * (1 - a)
        break
      case 'amplify': {
        const f = 1 + a * (p.gain - 1)
        nr = r0 * f
        ni = i0 * f
        break
      }
      case 'restore':
        nr = r0 + a * (1 - r0)
        ni = i0 - a * i0
        break
    }
    const m = this.mults[ch]
    m[2 * i] = nr
    m[2 * i + 1] = ni
    const j = mirrorBin(d, x, y)
    if (j >= 0) {
      this.snapshot(s, ch, j % d.wh, (j / d.wh) | 0)
      m[2 * j] = nr
      m[2 * j + 1] = -ni
    }
  }

  private snapshot(s: Stroke, ch: number, x: number, y: number): StrokeSnap {
    const tx = (x / TS) | 0
    const ty = (y / TS) | 0
    const key = ch * this.nTiles + ty * this.tilesX + tx
    let t = s.tiles.get(key)
    if (!t) {
      t = { re: new Float32Array(TS * TS), im: new Float32Array(TS * TS), a: new Float32Array(TS * TS) }
      this.copyTile(key, t, false)
      s.tiles.set(key, t)
    }
    return t
  }

  /** Copy between the multiplier and a tile snapshot (toField: snapshot → field). */
  private copyTile(key: number, t: Snap, toField: boolean): void {
    const { wh, h } = this.d
    const m = this.mults[(key / this.nTiles) | 0]
    const tile = key % this.nTiles
    const tx = tile % this.tilesX
    const ty = (tile / this.tilesX) | 0
    const x0 = tx * TS
    const x1 = Math.min(wh, x0 + TS)
    const y1 = Math.min(h, ty * TS + TS)
    for (let y = ty * TS; y < y1; y++) {
      const li = (y - ty * TS) * TS - x0
      for (let x = x0; x < x1; x++) {
        const g = 2 * (y * wh + x)
        if (toField) {
          m[g] = t.re[li + x]
          m[g + 1] = t.im[li + x]
        } else {
          t.re[li + x] = m[g]
          t.im[li + x] = m[g + 1]
        }
      }
    }
  }

  private swap(from: UndoEntry[], to: UndoEntry[]): Dirty | null {
    const e = from.pop()
    if (!e) return null
    const tmp: Snap = { re: new Float32Array(TS * TS), im: new Float32Array(TS * TS) }
    for (const [key, t] of e.tiles) {
      this.copyTile(key, tmp, false)
      this.copyTile(key, t, true)
      t.re.set(tmp.re)
      t.im.set(tmp.im)
    }
    e.rev++
    this.markDirty(e.tiles.keys())
    to.push(e)
    return this.dirtyFor(e)
  }

  private markDirty(keys: Iterable<number>): void {
    if (this.dirty === 'all') return
    for (const k of keys) this.dirty.add(k)
  }

  private dirtyFor(e: UndoEntry): Dirty {
    if (e.tiles.size > this.nTiles / 8) return 'all'
    const rects: Rect[] = []
    for (const key of e.tiles.keys()) {
      const tile = key % this.nTiles
      const tx = tile % this.tilesX
      const ty = (tile / this.tilesX) | 0
      const r = {
        x0: tx * TS,
        y0: ty * TS,
        x1: Math.min(this.d.wh, tx * TS + TS),
        y1: Math.min(this.d.h, ty * TS + TS),
      }
      rects.push(...displayRectsForStored(this.d, r))
    }
    return rects
  }

  private push(stack: UndoEntry[], e: UndoEntry): void {
    stack.push(e)
    let bytes = stack.reduce((n, x) => n + x.bytes, 0)
    while (stack.length > 1 && (stack.length > UNDO_LIMIT || bytes > UNDO_BUDGET)) {
      bytes -= stack.shift()!.bytes
    }
  }
}
