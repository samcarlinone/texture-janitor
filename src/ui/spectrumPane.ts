import { pack } from '../engine/colormap.ts'
import type { BrushSettings, Engine } from '../engine/engine.ts'
import type { Shape } from '../engine/layout.ts'
import { PaneController } from './pane.ts'
import { TONE_COLOR, TOOLS } from './tools.ts'
import { toScreen } from './viewport.ts'

export type SpectrumTool = BrushSettings['tool'] | 'select'

export interface SpectrumPaneProps {
  tool: SpectrumTool
  brush: BrushSettings
  selShape: Shape['kind']
  feather: number
  lut: Uint32Array
  overlay: boolean
  localView: boolean
  /** Edits aren't allowed in this view (edit-mode mismatch). */
  blocked: boolean
}

const BG = pack(13, 14, 17)
const ACCENT = '#5ee0ff'

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '∞'
  const a = Math.abs(n)
  if (a >= 1e5 || (a > 0 && a < 1e-2)) return n.toExponential(2)
  return n.toFixed(a >= 100 ? 0 : a >= 10 ? 1 : 2)
}

export class SpectrumPaneController extends PaneController {
  props: SpectrumPaneProps | null = null
  onHoverText: (text: string) => void = () => {}
  private readonly base: CanvasRenderingContext2D
  private readonly over: CanvasRenderingContext2D
  private image: ImageData | null = null
  private stroking = false
  private drag: { x0: number; y0: number; x1: number; y1: number } | null = null

  constructor(root: HTMLElement, base: HTMLCanvasElement, over: HTMLCanvasElement, engine: Engine) {
    super(root, [base, over], engine)
    this.base = base.getContext('2d')!
    this.over = over.getContext('2d')!
  }

  setProps(p: SpectrumPaneProps): void {
    const prev = this.props
    this.props = p
    this.setCursor(p.blocked && p.tool !== 'select' ? 'not-allowed' : p.tool === 'select' ? 'crosshair' : 'none')
    if (!prev || prev.lut !== p.lut || prev.overlay !== p.overlay || prev.localView !== p.localView) this.invalidate(0)
    this.invalidate(1)
  }

  protected contentSize(): [number, number] | null {
    const d = this.engine.dims
    return d ? [d.w, d.h] : null
  }

  protected toolDown(e: PointerEvent, x: number, y: number): boolean {
    const p = this.props
    if (!p || !this.engine.dims) return false
    if (p.tool === 'select') {
      this.drag = { x0: x, y0: y, x1: x, y1: y }
      return true
    }
    this.stroking = true
    this.engine.beginStroke({ ...p.brush, tool: p.tool })
    this.engine.strokeTo(x, y)
    e.preventDefault()
    return true
  }

  protected toolMove(e: PointerEvent, x: number, y: number): void {
    if (this.stroking) {
      this.engine.strokeTo(x, y)
    } else if (this.drag) {
      if (e.shiftKey) {
        // Constrain to a square / circle.
        const s = Math.max(Math.abs(x - this.drag.x0), Math.abs(y - this.drag.y0))
        x = this.drag.x0 + Math.sign(x - this.drag.x0 || 1) * s
        y = this.drag.y0 + Math.sign(y - this.drag.y0 || 1) * s
      }
      this.drag.x1 = x
      this.drag.y1 = y
    }
  }

  protected toolCancel(): void {
    if (this.stroking) {
      this.stroking = false
      this.engine.cancelStroke()
    }
    this.drag = null
  }

  protected toolUp(): void {
    if (this.stroking) {
      this.stroking = false
      this.engine.endStroke()
    }
    const g = this.drag
    if (g && this.props) {
      this.drag = null
      const small = Math.abs(g.x1 - g.x0) < 1 && Math.abs(g.y1 - g.y0) < 1
      this.engine.setSelection(small ? null : { kind: this.props.selShape, ...g, feather: this.props.feather })
    }
  }

  protected onHover(p: [number, number] | null): void {
    if (!this.props) return
    const b = p ? this.engine.binInfo(Math.floor(p[0]), Math.floor(p[1])) : null
    if (!b) return this.onHoverText('')
    const parts = [
      `k (${b.kx}, ${-b.ky})`,
      b.period === Infinity ? 'DC' : `period ${fmt(b.period)} px @ ${b.angle.toFixed(0)}°`,
      `|Y| ${fmt(b.magnitude)}`,
    ]
    if (Math.abs(b.gain - 1) > 1e-3) parts.push(`gain ${fmt(b.gain)}`)
    this.onHoverText(parts.join('  ·  '))
  }

  protected draw(i: number): void {
    if (i === 0) this.drawBase()
    else this.drawOverlay()
  }

  private drawBase(): void {
    const ctx = this.base
    const { width, height } = ctx.canvas
    const disp = this.engine.display
    const p = this.props
    if (!disp || !this.view || !p) {
      ctx.fillStyle = '#0d0e11'
      ctx.fillRect(0, 0, width, height)
      return
    }
    if (!this.image || this.image.width !== width || this.image.height !== height) {
      this.image = new ImageData(width, height)
    }
    const out = new Uint32Array(this.image.data.buffer)
    const local = p.localView ? this.engine.local : null
    disp.render(
      out,
      width,
      height,
      { zoom: this.view.zoom * this.dpr, cx: this.view.cx, cy: this.view.cy },
      { lut: p.lut, background: BG, overlay: p.overlay, local },
    )
    ctx.putImageData(this.image, 0, 0)
  }

  private drawOverlay(): void {
    const ctx = this.over
    const { dpr, cssW, cssH, view } = this
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
    const d = this.engine.dims
    const p = this.props
    if (!view || !d || !p) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const S = (x: number, y: number) => toScreen(view, x, y, cssW, cssH)
    // Mirror of a continuous display point through DC.
    const M = (x: number, y: number): [number, number] => [2 * d.cx + 1 - x, 2 * d.cy + 1 - y]

    // DC marker.
    const [dcx, dcy] = S(d.cx + 0.5, d.cy + 0.5)
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(dcx - 6, dcy)
    ctx.lineTo(dcx + 6, dcy)
    ctx.moveTo(dcx, dcy - 6)
    ctx.lineTo(dcx, dcy + 6)
    ctx.stroke()

    const sel = this.drag
      ? { kind: p.selShape, ...this.drag, feather: p.feather }
      : this.engine.selection
    if (sel) {
      const x0 = Math.min(sel.x0, sel.x1)
      const x1 = Math.max(sel.x0, sel.x1)
      const y0 = Math.min(sel.y0, sel.y1)
      const y1 = Math.max(sel.y0, sel.y1)
      const shape = (a: [number, number], b: [number, number], dash: number[], color: string) => {
        const [ax, ay] = S(...a)
        const [bx, by] = S(...b)
        ctx.setLineDash(dash)
        ctx.strokeStyle = color
        ctx.lineWidth = 1.5
        ctx.beginPath()
        if (sel.kind === 'rect') ctx.rect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay))
        else
          ctx.ellipse((ax + bx) / 2, (ay + by) / 2, Math.abs(bx - ax) / 2, Math.abs(by - ay) / 2, 0, 0, 2 * Math.PI)
        ctx.stroke()
      }
      shape([x0, y0], [x1, y1], this.drag ? [5, 4] : [], ACCENT)
      shape(M(x0, y0), M(x1, y1), [3, 4], 'rgba(94,224,255,0.45)')
      ctx.setLineDash([])
    }

    const hints = this.engine.hints
    if (hints?.length) {
      // Pulsing rings; keep animating while hints are shown.
      const t = (performance.now() % 1400) / 1400
      for (const h of hints) {
        const [hx, hy] = S(h.x, h.y)
        const base = Math.max(9, 4 * view.zoom)
        ctx.lineWidth = 2
        ctx.strokeStyle = `rgba(255, 214, 10, ${0.9 - 0.6 * t})`
        ctx.beginPath()
        ctx.arc(hx, hy, base + 10 * t, 0, 2 * Math.PI)
        ctx.stroke()
        ctx.strokeStyle = 'rgba(255, 214, 10, 0.95)'
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.arc(hx, hy, base, 0, 2 * Math.PI)
        ctx.stroke()
      }
      requestAnimationFrame(() => this.invalidate(1))
    }

    const isBrush = p.tool !== 'select'
    if (isBrush && this.pointer && !p.blocked && !this.panning) {
      const [px, py] = this.pointer
      const [x, y] = this.toContent(px, py)
      const r = Math.max(0.5, p.brush.radius) * view.zoom
      const tone = TONE_COLOR[TOOLS.find((t) => t.id === p.tool)?.tone ?? 'accent']
      const ring = (sx: number, sy: number, alpha: number, dash: number[]) => {
        ctx.setLineDash(dash)
        ctx.lineWidth = 1
        ctx.strokeStyle = `rgba(0,0,0,${alpha})`
        ctx.beginPath()
        ctx.arc(sx, sy, r + 1, 0, 2 * Math.PI)
        ctx.stroke()
        ctx.globalAlpha = alpha
        ctx.strokeStyle = tone
        ctx.beginPath()
        ctx.arc(sx, sy, r, 0, 2 * Math.PI)
        ctx.stroke()
        ctx.globalAlpha = 1
        if (p.brush.hardness > 0.02 && p.brush.hardness < 0.98) {
          ctx.strokeStyle = `rgba(255,255,255,${alpha * 0.4})`
          ctx.beginPath()
          ctx.arc(sx, sy, r * p.brush.hardness, 0, 2 * Math.PI)
          ctx.stroke()
        }
      }
      ring(px, py, 0.95, [])
      const [mx, my] = S(...M(x, y))
      ring(mx, my, 0.5, [3, 3])
      ctx.setLineDash([])
      ctx.fillStyle = '#fff'
      ctx.fillRect(px - 0.5, py - 0.5, 1, 1)
    }
  }
}
