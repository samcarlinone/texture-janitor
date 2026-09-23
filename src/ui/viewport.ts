/** Pan/zoom state of a pane. zoom = CSS pixels per content pixel. */
export interface ViewState {
  zoom: number
  /** Content coordinate at the pane center. */
  cx: number
  cy: number
}

export const MIN_ZOOM = 1 / 64
export const MAX_ZOOM = 64

export function fitView(cw: number, ch: number, pw: number, ph: number): ViewState {
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(pw / cw, ph / ch) * 0.96))
  return { zoom, cx: cw / 2, cy: ch / 2 }
}

export function toContent(v: ViewState, sx: number, sy: number, pw: number, ph: number): [number, number] {
  return [(sx - pw / 2) / v.zoom + v.cx, (sy - ph / 2) / v.zoom + v.cy]
}

export function toScreen(v: ViewState, x: number, y: number, pw: number, ph: number): [number, number] {
  return [(x - v.cx) * v.zoom + pw / 2, (y - v.cy) * v.zoom + ph / 2]
}

/** Zoom by `factor`, keeping the content point under (sx, sy) fixed. */
export function zoomAt(v: ViewState, sx: number, sy: number, pw: number, ph: number, factor: number): ViewState {
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.zoom * factor))
  const [x, y] = toContent(v, sx, sy, pw, ph)
  return { zoom, cx: x - (sx - pw / 2) / zoom, cy: y - (sy - ph / 2) / zoom }
}

export function panBy(v: ViewState, dsx: number, dsy: number): ViewState {
  return { ...v, cx: v.cx - dsx / v.zoom, cy: v.cy - dsy / v.zoom }
}

/** Wheel delta → zoom factor (handles line/page modes and trackpad pinch). */
export function wheelFactor(e: WheelEvent): number {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
  const k = e.ctrlKey ? 0.01 : 0.0015
  return Math.exp(-e.deltaY * unit * k)
}
