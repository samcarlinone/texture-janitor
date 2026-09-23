import type { Engine } from '../engine/engine.ts'
import { fitView, panBy, toContent, wheelFactor, zoomAt, type ViewState } from './viewport.ts'

/**
 * Imperative core of a zoomable pane: sizes its canvases to the container,
 * handles pan/zoom, and batches redraws into animation frames. Subclasses
 * draw content and handle their own tool gestures.
 */
export abstract class PaneController {
  protected readonly root: HTMLElement
  protected readonly canvases: HTMLCanvasElement[]
  protected readonly engine: Engine
  protected view: ViewState | null = null
  protected cssW = 1
  protected cssH = 1
  protected dpr = 1
  /** Last pointer position in CSS px, or null when outside. */
  protected pointer: [number, number] | null = null
  /** Alt / Option was down on the last pointer event. */
  protected pointerAlt = false
  private dirty = new Set<number>()
  private raf = 0
  /**
   * The gesture in progress (pan, or the active tool's drag), bound to one
   * pointer. The pane holds pointer capture for it, so moves and the
   * release arrive even outside the pane or the window.
   */
  private gesture: { id: number; kind: 'pan' | 'tool'; x: number; y: number } | null = null
  /** Cursor for the current tool, restored after a pan. */
  private toolCursor = ''
  private readonly ro: ResizeObserver
  private readonly cleanup: (() => void)[] = []

  constructor(root: HTMLElement, canvases: HTMLCanvasElement[], engine: Engine) {
    this.root = root
    this.canvases = canvases
    this.engine = engine
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(root)
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      root.addEventListener(type, fn, opts)
      this.cleanup.push(() => root.removeEventListener(type, fn, opts))
    }
    on('pointerdown', (e) => this.down(e))
    on('pointermove', (e) => this.move(e))
    on('pointerup', (e) => this.release(e))
    on('pointercancel', (e) => this.release(e))
    // Capture can also be lost without a pointerup (window blur, the
    // element going away): that ends the gesture too.
    on('lostpointercapture', (e) => this.end(e))
    on('pointerleave', () => {
      this.pointer = null
      this.onHover(null)
      this.invalidate(this.canvases.length - 1)
    })
    on('wheel', (e) => this.wheel(e), { passive: false })
    on('contextmenu', (e) => e.preventDefault())
    this.resize()
  }

  destroy(): void {
    const g = this.gesture
    if (g && this.root.hasPointerCapture(g.id)) this.root.releasePointerCapture(g.id)
    this.gesture = null
    this.ro.disconnect()
    this.cleanup.forEach((f) => f())
    cancelAnimationFrame(this.raf)
  }

  /** Size of the content in content pixels, or null when there is none. */
  protected abstract contentSize(): [number, number] | null
  /** Redraw canvas `i`. */
  protected abstract draw(i: number): void
  /** A primary-button gesture for the active tool. Return false to ignore it. */
  protected abstract toolDown(e: PointerEvent, x: number, y: number): boolean
  protected abstract toolMove(e: PointerEvent, x: number, y: number): void
  protected abstract toolUp(e: PointerEvent): void
  /** Pointer moved over content point (x, y), or left the pane. */
  protected abstract onHover(p: [number, number] | null): void

  fit(): void {
    const s = this.contentSize()
    this.view = s ? fitView(s[0], s[1], this.cssW, this.cssH) : null
    this.invalidateAll()
  }

  /** Reset to fit when content appears or changes size. */
  contentChanged(): void {
    const s = this.contentSize()
    const key = s ? `${s[0]}x${s[1]}` : ''
    if (key !== this.contentKey) {
      this.contentKey = key
      this.fit()
    } else {
      this.invalidateAll()
    }
  }
  private contentKey = ''

  invalidate(i: number): void {
    this.dirty.add(i)
    if (!this.raf) {
      this.raf = requestAnimationFrame(() => {
        this.raf = 0
        const d = [...this.dirty].sort()
        this.dirty.clear()
        for (const k of d) this.draw(k)
      })
    }
  }

  invalidateAll(): void {
    this.canvases.forEach((_, i) => this.invalidate(i))
  }

  protected setView(v: ViewState): void {
    this.view = v
    this.invalidateAll()
  }

  protected toContent(sx: number, sy: number): [number, number] {
    return this.view ? toContent(this.view, sx, sy, this.cssW, this.cssH) : [0, 0]
  }

  private resize(): void {
    const r = this.root.getBoundingClientRect()
    const w = Math.max(1, Math.round(r.width))
    const h = Math.max(1, Math.round(r.height))
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    if (w === this.cssW && h === this.cssH && dpr === this.dpr) return
    const first = this.cssW <= 1
    this.cssW = w
    this.cssH = h
    this.dpr = dpr
    for (const c of this.canvases) {
      c.width = Math.round(w * dpr)
      c.height = Math.round(h * dpr)
      c.style.width = `${w}px`
      c.style.height = `${h}px`
    }
    if (first || !this.view) this.fit()
    else this.invalidateAll()
  }

  private local(e: PointerEvent | WheelEvent): [number, number] {
    const r = this.root.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }

  /** Set the cursor for the active tool (kept while not panning). */
  protected setCursor(c: string): void {
    this.toolCursor = c
    if (this.gesture?.kind !== 'pan') this.root.style.cursor = c
  }

  private down(e: PointerEvent): void {
    // One gesture at a time; extra pointers (a second finger, pen + mouse) are ignored.
    if (!this.view || this.gesture) return
    if (e.button !== 0 && e.button !== 1 && e.button !== 2) return
    const [sx, sy] = this.local(e)
    // Middle or right drag pans; the left button belongs to the active tool.
    let kind: 'pan' | 'tool' = 'pan'
    if (e.button === 0) {
      const [x, y] = this.toContent(sx, sy)
      if (!this.toolDown(e, x, y)) return
      kind = 'tool'
    }
    this.gesture = { id: e.pointerId, kind, x: sx, y: sy }
    this.root.setPointerCapture(e.pointerId)
    if (kind === 'pan') this.root.style.cursor = 'grabbing'
    e.preventDefault()
  }

  private move(e: PointerEvent): void {
    const g = this.gesture
    if (g && g.id !== e.pointerId) return
    // A mouse gesture whose buttons are all up missed its release (it can
    // happen when focus changes mid-drag): finish it now.
    if (g && e.pointerType === 'mouse' && e.buttons === 0) {
      this.release(e)
      return
    }
    const [sx, sy] = this.local(e)
    this.pointer = [sx, sy]
    this.pointerAlt = e.altKey
    if (g?.kind === 'pan' && this.view) {
      this.setView(panBy(this.view, sx - g.x, sy - g.y))
      g.x = sx
      g.y = sy
      return
    }
    const [x, y] = this.toContent(sx, sy)
    this.onHover([x, y])
    if (g?.kind === 'tool') {
      // Coalesced events keep fast brush strokes smooth.
      const events = e.getCoalescedEvents?.() ?? []
      if (events.length > 1) {
        for (const ce of events) {
          const [cx, cy] = this.local(ce)
          const [px, py] = this.toContent(cx, cy)
          this.toolMove(ce, px, py)
        }
      } else {
        this.toolMove(e, x, y)
      }
    }
    this.invalidate(this.canvases.length - 1)
  }

  /** pointerup / pointercancel: drop capture and finish the gesture. */
  private release(e: PointerEvent): void {
    if (this.gesture?.id !== e.pointerId) return
    if (this.root.hasPointerCapture(e.pointerId)) this.root.releasePointerCapture(e.pointerId)
    this.end(e)
  }

  /** Finish the gesture for this pointer. Safe to call more than once. */
  private end(e: PointerEvent): void {
    const g = this.gesture
    if (!g || g.id !== e.pointerId) return
    this.gesture = null
    if (g.kind === 'pan') this.root.style.cursor = this.toolCursor
    else this.toolUp(e)
    this.invalidate(this.canvases.length - 1)
  }

  private wheel(e: WheelEvent): void {
    if (!this.view) return
    e.preventDefault()
    const [sx, sy] = this.local(e)
    this.setView(zoomAt(this.view, sx, sy, this.cssW, this.cssH, wheelFactor(e)))
  }

  /** Zoom around the pane center (toolbar buttons). */
  zoomBy(factor: number): void {
    if (!this.view) return
    this.setView(zoomAt(this.view, this.cssW / 2, this.cssH / 2, this.cssW, this.cssH, factor))
  }

  /** Set an absolute zoom (1 = one content pixel per device pixel). */
  zoomTo(devicePixels: number): void {
    if (!this.view) return
    this.setView({ ...this.view, zoom: devicePixels / this.dpr })
  }
}
