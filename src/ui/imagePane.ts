import type { Engine } from '../engine/engine.ts'
import type { TileSet } from '../engine/image.ts'
import type { Rect } from '../engine/layout.ts'
import { held } from './keys.ts'
import { PaneController } from './pane.ts'
import { toScreen } from './viewport.ts'

/** Left-drag picks a region (for the local spectrum), or a new subregion. */
export type ImagePaneTool = 'region' | 'subregion'

export interface ImagePaneProps {
  tool: ImagePaneTool
  heatOpacity: number
}

const BG = '#0d0e11'

/** Loupe: diameter (CSS px), image pixels magnified to this size, and gap from the cursor. */
const LOUPE = { size: 168, pixel: 10, gap: 22 }
/**
 * The loupe appears during a drag once the pointer has moved slower than
 * `speed` (CSS px per second, measured over `window` ms) for `hold` ms.
 */
const SLOW = { speed: 4, window: 500, hold: 2000 }
/** Width of the region outline, CSS px (must match --ring in .region-ring). */
const RING = 3

export class ImagePaneController extends PaneController {
  props: ImagePaneProps = { tool: 'region', heatOpacity: 0.75 }
  onHoverText: (text: string) => void = () => {}
  /** Called with a canvas rect when a subregion pick finishes. */
  onSubregionPicked: (r: Rect) => void = () => {}
  private drag: { x0: number; y0: number; x1: number; y1: number } | null = null
  /** Recent pointer positions during a drag (performance.now() ms, client px). */
  private trail: { t: number; x: number; y: number }[] = []
  /** When the pointer last became slow, or null while it's moving. */
  private slowSince: number | null = null
  private slowDrag = false
  /** Re-checks slowness while dragging, since a still pointer sends no events. */
  private slowTimer = 0
  private readonly ctx: CanvasRenderingContext2D
  /**
   * The region outline: an element over the canvas whose CSS backdrop
   * filter inverts the pixels under its border, so it reads on any image
   * without dimming the rest.
   */
  private readonly ring: HTMLElement

  constructor(root: HTMLElement, canvas: HTMLCanvasElement, ring: HTMLElement, engine: Engine) {
    super(root, [canvas], engine)
    this.ctx = canvas.getContext('2d')!
    this.ring = ring
  }

  destroy(): void {
    clearInterval(this.slowTimer)
    super.destroy()
  }

  private placeRing(r: { x0: number; y0: number; x1: number; y1: number } | null): void {
    const s = this.ring.style
    if (!r || !this.view) {
      s.display = 'none'
      return
    }
    const [sx0, sy0] = toScreen(this.view, r.x0, r.y0, this.cssW, this.cssH)
    const [sx1, sy1] = toScreen(this.view, r.x1, r.y1, this.cssW, this.cssH)
    // The ring sits just outside the region, so the selected pixels stay untouched.
    s.display = 'block'
    s.left = `${sx0 - RING}px`
    s.top = `${sy0 - RING}px`
    s.width = `${sx1 - sx0 + 2 * RING}px`
    s.height = `${sy1 - sy0 + 2 * RING}px`
  }

  setProps(p: ImagePaneProps): void {
    this.props = p
    this.setCursor('crosshair')
    this.invalidate(0)
  }

  /** The pane shows the full canvas; a subregion's working image sits inside it. */
  protected contentSize(): [number, number] | null {
    return this.engine.canvasSize
  }

  protected toolDown(e: PointerEvent, x: number, y: number): boolean {
    if (!this.engine.dims) return false
    this.drag = { x0: x, y0: y, x1: x, y1: y }
    this.trail = [{ t: performance.now(), x: e.clientX, y: e.clientY }]
    this.slowSince = null
    this.slowDrag = false
    clearInterval(this.slowTimer)
    this.slowTimer = window.setInterval(() => this.checkSlow(), 100)
    return true
  }

  /** Show the loupe once the drag has been slow (see SLOW) for long enough. */
  private checkSlow(): void {
    const now = performance.now()
    const tr = this.trail
    const last = tr[tr.length - 1]
    if (!last) return
    // Where the pointer was `window` ms ago (it hasn't moved since `last` if no newer sample).
    let ref = tr[0]
    for (const p of tr) if (p.t <= now - SLOW.window) ref = p
    const dt = Math.max(SLOW.window, now - ref.t) / 1000
    const slow = Math.hypot(last.x - ref.x, last.y - ref.y) / dt < SLOW.speed
    if (!slow) this.slowSince = null
    else this.slowSince ??= now
    const show = this.slowSince !== null && now - this.slowSince >= SLOW.hold
    if (show !== this.slowDrag) {
      this.slowDrag = show
      this.invalidate(0)
    }
  }

  protected toolMove(e: PointerEvent, x: number, y: number): void {
    if (!this.drag) return
    this.drag.x1 = x
    this.drag.y1 = y
    const now = performance.now()
    this.trail.push({ t: now, x: e.clientX, y: e.clientY })
    // Keep a little more history than the speed window needs.
    while (this.trail.length > 2 && this.trail[1].t < now - 2 * SLOW.window) this.trail.shift()
    this.checkSlow()
    this.invalidate(0)
  }

  protected toolCancel(): void {
    this.drag = null
    this.slowDrag = false
    clearInterval(this.slowTimer)
    this.invalidate(0)
  }

  protected toolUp(): void {
    const g = this.drag
    if (!g) return
    this.drag = null
    this.slowDrag = false
    clearInterval(this.slowTimer)
    const r = snappedRect(g)
    if (this.props.tool === 'subregion') {
      this.onSubregionPicked(r)
    } else {
      // Regions live in working-image coordinates. A click (no drag) clears.
      const [wx, wy] = this.engine.workOrigin
      const small = r.x1 - r.x0 < 4 || r.y1 - r.y0 < 4
      this.engine.setRegion(small ? null : { x0: r.x0 - wx, y0: r.y0 - wy, x1: r.x1 - wx, y1: r.y1 - wy })
    }
    this.invalidate(0)
  }

  protected onHover(p: [number, number] | null): void {
    const c = this.engine.canvasSize
    if (!p || !c) return this.onHoverText('')
    const x = Math.floor(p[0])
    const y = Math.floor(p[1])
    this.onHoverText(x >= 0 && y >= 0 && x < c[0] && y < c[1] ? `x ${x}  y ${y}` : '')
  }

  protected draw(): void {
    const { ctx, dpr, cssW, cssH, view, engine } = this
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = BG
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
    const d = engine.dims
    const canvas = engine.canvasSize
    if (!view || !d || !canvas) {
      this.placeRing(null)
      return
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const z = view.zoom
    // Canvas origin, and the working image's origin within it (a subregion's corner).
    const [ox, oy] = toScreen(view, 0, 0, cssW, cssH)
    const [wx, wy] = engine.workOrigin
    const wox = ox + wx * z
    const woy = oy + wy * z
    const compare = held.compare
    // Nearest-neighbour when magnified so individual pixels stay crisp.
    const smooth = z * dpr < 2
    ctx.imageSmoothingEnabled = smooth
    ctx.imageSmoothingQuality = 'high'

    // Checkerboard under transparent images.
    ctx.fillStyle = '#1a1b20'
    ctx.fillRect(ox, oy, canvas[0] * z, canvas[1] * z)

    this.drawLayers(ox, oy, z, compare, smooth)

    const zones = engine.imageZones
    if (zones && !compare) {
      ctx.fillStyle = 'rgba(22, 23, 28, 0.8)'
      for (const r of zones) {
        const [zx0, zy0] = toScreen(view, r.x0, r.y0, cssW, cssH)
        const [zx1, zy1] = toScreen(view, r.x1, r.y1, cssW, cssH)
        ctx.fillRect(zx0, zy0, zx1 - zx0, zy1 - zy0)
      }
    }

    const dp = engine.denoisePreview
    if (dp && !compare) {
      ctx.drawImage(dp.bitmap, wox + dp.rect.x0 * z, woy + dp.rect.y0 * z, (dp.rect.x1 - dp.rect.x0) * z, (dp.rect.y1 - dp.rect.y0) * z)
    }

    if (engine.heat && engine.selection && this.props.heatOpacity > 0 && !compare) {
      ctx.imageSmoothingEnabled = true
      ctx.globalAlpha = this.props.heatOpacity
      ctx.drawImage(engine.heat, wox, woy, d.w * z, d.h * z)
      ctx.globalAlpha = 1
    }

    // The editable area of a subregion.
    const sub = engine.getInfo().subregion
    if (sub && compare !== 'original') {
      const [sx0, sy0] = toScreen(view, sub.x0, sub.y0, cssW, cssH)
      const [sx1, sy1] = toScreen(view, sub.x1, sub.y1, cssW, cssH)
      ctx.save()
      ctx.lineWidth = 1.5
      ctx.setLineDash([6, 4])
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)'
      ctx.strokeRect(sx0 - 1, sy0 - 1, sx1 - sx0 + 2, sy1 - sy0 + 2)
      ctx.strokeStyle = '#ffb547'
      ctx.lineDashOffset = 5
      ctx.strokeRect(sx0 - 1, sy0 - 1, sx1 - sx0 + 2, sy1 - sy0 + 2)
      ctx.restore()
    }

    // The ring: the drag in progress (canvas coords), or the picked region (working coords).
    const g = this.drag
    const reg = engine.region
    this.placeRing(
      g
        ? { x0: Math.min(g.x0, g.x1), y0: Math.min(g.y0, g.y1), x1: Math.max(g.x0, g.x1), y1: Math.max(g.y0, g.y1) }
        : reg
          ? { x0: reg.x0 + wx, y0: reg.y0 + wy, x1: reg.x1 + wx, y1: reg.y1 + wy }
          : null,
    )
    if (this.pointer && (this.slowDrag || this.pointerAlt || held.alt)) this.drawLoupe(compare)

    if (compare) {
      const label = compare === 'original' ? 'BASE IMAGE' : 'CHECKPOINT'
      ctx.font = '600 11px system-ui, sans-serif'
      const w = ctx.measureText(label).width + 16
      ctx.fillStyle = 'rgba(0,0,0,0.6)'
      ctx.fillRect(10, 10, w, 20)
      ctx.fillStyle = '#fff'
      ctx.fillText(label, 18, 24)
    }
  }

  /**
   * The image layers at canvas origin (ox, oy) and scale z: the loaded or
   * checkpoint image when comparing, otherwise the subregion snapshot (if
   * any) under the working result or its preview.
   */
  private drawLayers(ox: number, oy: number, z: number, compare: typeof held.compare, smooth: boolean): void {
    const { ctx, engine } = this
    const d = engine.dims!
    const [wx, wy] = engine.workOrigin
    const wox = ox + wx * z
    const woy = oy + wy * z
    if (compare === 'original') {
      this.drawTiles(engine.originalTiles, ox, oy, z)
      return
    }
    this.drawTiles(engine.baseTiles, ox, oy, z)
    if (compare === 'checkpoint') {
      this.drawTiles(engine.checkpointTiles, wox, woy, z)
    } else if (engine.showPreview && engine.preview) {
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(engine.preview, wox, woy, d.w * z, d.h * z)
      ctx.imageSmoothingEnabled = smooth
    } else {
      this.drawTiles(engine.result, wox, woy, z)
    }
  }

  /**
   * Magnifier near the cursor: the image at LOUPE.pixel CSS px per image
   * pixel (never smoothed), a pixel grid, the pixel under the cursor, and
   * during a drag, the selection edges exactly where the release will put them.
   */
  private drawLoupe(compare: typeof held.compare): void {
    const { ctx, view, cssW, cssH, engine } = this
    const canvas = engine.canvasSize
    if (!view || !canvas || !this.pointer) return
    const [px, py] = this.pointer
    const [cx, cy] = this.toContent(px, py)
    if (cx < 0 || cy < 0 || cx >= canvas[0] || cy >= canvas[1]) return
    // Magnify well beyond the current view; if already zoomed in, go further still.
    const m = Math.max(LOUPE.pixel, view.zoom * 3)
    const R = LOUPE.size / 2
    // Up and to the right of the cursor, flipped to stay inside the pane.
    let lx = px + LOUPE.gap + R
    let ly = py - LOUPE.gap - R
    if (lx + R > cssW - 4) lx = px - LOUPE.gap - R
    if (ly - R < 4) ly = py + LOUPE.gap + R
    // Keep the loupe and its readout (26 px) inside the pane.
    ly = Math.min(ly, cssH - R - 30)
    const ox = lx - cx * m
    const oy = ly - cy * m
    const toL = (x: number, y: number): [number, number] => [ox + x * m, oy + y * m]

    ctx.save()
    ctx.beginPath()
    ctx.arc(lx, ly, R, 0, 2 * Math.PI)
    ctx.fillStyle = BG
    ctx.fill()
    ctx.clip()
    ctx.imageSmoothingEnabled = false
    this.drawLayers(ox, oy, m, compare, false)
    // Pixel grid.
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.28)'
    ctx.lineWidth = 1
    ctx.beginPath()
    const x0 = Math.floor(cx - R / m) - 1
    const y0 = Math.floor(cy - R / m) - 1
    for (let x = x0; x <= cx + R / m + 1; x++) {
      const [gx] = toL(x, 0)
      ctx.moveTo(gx, ly - R)
      ctx.lineTo(gx, ly + R)
    }
    for (let y = y0; y <= cy + R / m + 1; y++) {
      const [, gy] = toL(0, y)
      ctx.moveTo(lx - R, gy)
      ctx.lineTo(lx + R, gy)
    }
    ctx.stroke()
    // The pixel under the cursor.
    const [hx, hy] = toL(Math.floor(cx), Math.floor(cy))
    ctx.lineWidth = 1.5
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)'
    ctx.strokeRect(hx - 0.75, hy - 0.75, m + 1.5, m + 1.5)
    ctx.strokeStyle = '#fff'
    ctx.strokeRect(hx + 0.75, hy + 0.75, m - 1.5, m - 1.5)
    // Selection edges on pixel boundaries, as they'll be committed.
    const g = this.drag
    if (g) {
      const r = snappedRect(g)
      const [ax, ay] = toL(r.x0, r.y0)
      const [bx, by] = toL(r.x1, r.y1)
      ctx.lineWidth = 3
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)'
      ctx.strokeRect(ax, ay, bx - ax, by - ay)
      ctx.lineWidth = 1.5
      ctx.strokeStyle = '#5ee0ff'
      ctx.strokeRect(ax, ay, bx - ax, by - ay)
    }
    ctx.restore()
    // Rim and readout.
    ctx.beginPath()
    ctx.arc(lx, ly, R, 0, 2 * Math.PI)
    ctx.lineWidth = 2
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)'
    ctx.stroke()
    const label = g
      ? `x ${Math.floor(cx)}  y ${Math.floor(cy)}  ·  ${Math.abs(Math.round(g.x1) - Math.round(g.x0))}×${Math.abs(Math.round(g.y1) - Math.round(g.y0))}`
      : `x ${Math.floor(cx)}  y ${Math.floor(cy)}`
    ctx.font = '600 11px ui-monospace, Menlo, monospace'
    const tw = ctx.measureText(label).width + 14
    ctx.fillStyle = 'rgba(0, 0, 0, 0.72)'
    ctx.fillRect(lx - tw / 2, ly + R + 6, tw, 19)
    ctx.fillStyle = '#fff'
    ctx.textAlign = 'center'
    ctx.fillText(label, lx, ly + R + 19)
    ctx.textAlign = 'start'
  }

  private drawTiles(set: TileSet | null, ox: number, oy: number, z: number): void {
    if (!set) return
    const { ctx, cssW, cssH, dpr } = this
    // Snap tile edges to device pixels so neighbouring tiles meet without seams.
    const snap = (v: number) => Math.round(v * dpr) / dpr
    for (const t of set.tiles) {
      const x = snap(ox + t.x * z)
      const y = snap(oy + t.y * z)
      const x1 = snap(ox + (t.x + t.w) * z)
      const y1 = snap(oy + (t.y + t.h) * z)
      if (x > cssW || y > cssH || x1 < 0 || y1 < 0) continue
      ctx.drawImage(t.bmp, x, y, x1 - x, y1 - y)
    }
  }
}

/** A drag rectangle with its corners on whole image pixels, as committed on release. */
function snappedRect(g: { x0: number; y0: number; x1: number; y1: number }): Rect {
  return {
    x0: Math.round(Math.min(g.x0, g.x1)),
    y0: Math.round(Math.min(g.y0, g.y1)),
    x1: Math.round(Math.max(g.x0, g.x1)),
    y1: Math.round(Math.max(g.y0, g.y1)),
  }
}
