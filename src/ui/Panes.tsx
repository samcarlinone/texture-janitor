import { Maximize, ZoomIn, ZoomOut } from 'lucide-react'
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react'
import type { Engine } from '../engine/engine.ts'
import { ImagePaneController, type ImagePaneProps } from './imagePane.ts'
import type { Rect } from '../engine/layout.ts'
import type { PaneController } from './pane.ts'
import { SpectrumPaneController, type SpectrumPaneProps } from './spectrumPane.ts'

function PaneFrame(p: {
  title: string
  tour: string
  toolbar?: ReactNode
  hover: string
  ctrl: () => PaneController | null
  children: ReactNode
}) {
  return (
    <section className="pane" data-tour={p.tour}>
      <header className="pane-head">
        <h2>{p.title}</h2>
        <div className="pane-tools">
          {p.toolbar}
          <div className="zoom-tools">
            <button type="button" title="Zoom out" onClick={() => p.ctrl()?.zoomBy(1 / 1.5)}>
              <ZoomOut size={14} aria-hidden />
            </button>
            <button type="button" title="Zoom in" onClick={() => p.ctrl()?.zoomBy(1.5)}>
              <ZoomIn size={14} aria-hidden />
            </button>
            <button type="button" title="Actual pixels" onClick={() => p.ctrl()?.zoomTo(1)}>
              <span className="text-trim">1:1</span>
            </button>
            <button type="button" title="Fit (F)" onClick={() => p.ctrl()?.fit()}>
              <Maximize size={14} aria-hidden />
            </button>
          </div>
        </div>
      </header>
      {p.children}
      <footer className="pane-foot">{p.hover || ' '}</footer>
    </section>
  )
}

interface Common {
  engine: Engine
  title: string
  toolbar?: ReactNode
  empty?: ReactNode
  /** Floating note over the pane (e.g. the edit-mode hint). */
  note?: ReactNode
  /**
   * Floating over the pane but outside its body, so clicks aren't taken by
   * the pane's pointer capture.
   */
  floating?: ReactNode
}

export function ImagePaneView(
  p: Common &
    ImagePaneProps & {
      onController: (c: ImagePaneController | null) => void
      /** A subregion was picked (canvas rect). */
      onSubregion: (r: Rect) => void
    },
) {
  const { engine, onController, tool, heatOpacity } = p
  const picked = useEffectEvent((r: Rect) => p.onSubregion(r))
  const root = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const ring = useRef<HTMLDivElement>(null)
  const ctrl = useRef<ImagePaneController | null>(null)
  const [hover, setHover] = useState('')

  useEffect(() => {
    const c = new ImagePaneController(root.current!, canvas.current!, ring.current!, engine)
    c.onHoverText = setHover
    c.onSubregionPicked = (r) => picked(r)
    ctrl.current = c
    onController(c)
    const off = engine.onRender((k) => {
      if (k === 'image') c.contentChanged()
    })
    return () => {
      off()
      c.destroy()
      ctrl.current = null
      onController(null)
    }
  }, [engine, onController])

  useEffect(() => {
    ctrl.current?.setProps({ tool, heatOpacity })
  }, [tool, heatOpacity])

  return (
    <PaneFrame title={p.title} tour="image" toolbar={p.toolbar} hover={hover} ctrl={() => ctrl.current}>
      <div className="pane-body" ref={root}>
        <canvas ref={canvas} />
        <div ref={ring} className="region-ring">
          <i />
          <i />
          <i />
          <i />
        </div>
        {p.empty}
      </div>
      {p.floating}
    </PaneFrame>
  )
}

export function SpectrumPaneView(
  p: Common & SpectrumPaneProps & { onController: (c: SpectrumPaneController | null) => void },
) {
  const { engine, onController, tool, brush, selShape, feather, lut, overlay, localView, blocked } = p
  const root = useRef<HTMLDivElement>(null)
  const base = useRef<HTMLCanvasElement>(null)
  const over = useRef<HTMLCanvasElement>(null)
  const ctrl = useRef<SpectrumPaneController | null>(null)
  const [hover, setHover] = useState('')

  useEffect(() => {
    const c = new SpectrumPaneController(root.current!, base.current!, over.current!, engine)
    c.onHoverText = setHover
    ctrl.current = c
    onController(c)
    const off = engine.onRender((k) => {
      if (k === 'spectrum') c.contentChanged()
      else c.invalidate(1)
    })
    return () => {
      off()
      c.destroy()
      ctrl.current = null
      onController(null)
    }
  }, [engine, onController])

  useEffect(() => {
    ctrl.current?.setProps({ tool, brush, selShape, feather, lut, overlay, localView, blocked })
  }, [tool, brush, selShape, feather, lut, overlay, localView, blocked])

  return (
    <PaneFrame title={p.title} tour="spectrum" toolbar={p.toolbar} hover={hover} ctrl={() => ctrl.current}>
      <div className="pane-body" ref={root}>
        <canvas ref={base} />
        <canvas ref={over} className="overlay" />
        {p.note}
        {p.empty}
      </div>
    </PaneFrame>
  )
}
