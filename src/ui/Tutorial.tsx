import { ArrowRight, Check, GraduationCap, X } from 'lucide-react'
import { useEffect, useEffectEvent, useState, type ReactNode } from 'react'
import type { Engine, EngineInfo } from '../engine/engine.ts'
import { Button } from './Button.tsx'
import type { ControlState } from './Controls.tsx'
import { DEMO_NOT_SKY, demoOffSky } from './demo.ts'

interface Ctx {
  engine: Engine
  info: EngineInfo
  controls: ControlState
  set: (patch: Partial<ControlState>) => void
  loadDemo: () => void
  /** Increments whenever a compare (C / B, or the hold buttons) starts. */
  compares: number
}

/** Counters captured when a step starts, so steps can wait for "one more". */
interface Base {
  strokes: number
  checkpoints: number
  compares: number
}

interface Step {
  title: string
  body: (c: Ctx, spikes: number) => ReactNode
  /** CSS selector of the element to highlight. */
  target?: string
  /** Put the card inside the target (for the big panes) instead of beside it. */
  inside?: boolean
  onEnter?: (c: Ctx) => void
  /** Advance automatically once this holds. */
  done?: (c: Ctx, base: Base) => boolean
  /** Label for a manual continue button. */
  next?: string
  /** Show spike markers during this step. */
  hints?: boolean
  /** Grey out the demo's no-go areas once a picked region fails the sky check. */
  zonesOnFail?: boolean
  /** Jump to this step if every marked spike gets erased during this one. */
  skipWhenCleared?: number
}

/** On the demo, the picked region may overlap non-sky areas by less than this. */
const MAX_OFF_SKY = 0.05

const isDemo = (c: Ctx) => c.info.name === 'demo.png'

/** How much of the picked region isn't sky (demo only; null otherwise). */
function skyCheck(c: Ctx): { fraction: number; parts: string[] } | null {
  return isDemo(c) && c.info.region ? demoOffSky(c.info.region) : null
}


const STEPS: Step[] = [
  {
    title: 'Remove a repeating texture',
    body: (c) => (
      <>
        <p>
          This tour takes about a minute. You&apos;ll pick a patch of image that shows an unwanted repeating
          pattern, find that pattern in the spectrum, and paint it away.
        </p>
        <p>
          {c.info.status === 'ready' && c.info.name !== 'demo.png'
            ? 'You can follow along on your own image, or use the demo, which has diagonal and vertical stripe noise to remove.'
            : 'The demo image has diagonal and vertical stripe noise to remove.'}
        </p>
      </>
    ),
  },
  {
    title: 'Pick a region with the texture',
    target: '[data-tour="image"]',
    inside: true,
    onEnter: (c) => {
      c.engine.setRegion(null)
      c.set({ viewMode: 'local' })
    },
    body: (c) => (
      <p>
        Drag a box over an area where the texture is visible.{' '}
        {isDemo(c)
          ? 'In the demo, fine diagonal stripes cover the sky, so box an area of plain sky, clear of both suns and the mountains.'
          : 'Pick a patch where the pattern is clear and the scene is fairly plain.'}
      </p>
    ),
    zonesOnFail: true,
    done: (c) => {
      if (c.info.region === null || !c.info.hasLocal) return false
      const off = skyCheck(c)
      return !off || off.fraction < MAX_OFF_SKY
    },
  },
  {
    title: 'Find the texture in the spectrum',
    target: '[data-tour="spectrum"]',
    inside: true,
    hints: true,
    onEnter: (c) => c.set({ viewMode: 'local' }),
    body: (_c, spikes) =>
      spikes > 0 ? (
        <>
          <p>
            The spectrum now shows just that patch. A repeating pattern concentrates into bright points away from
            the centre: the strongest are circled.
          </p>
          <p>Points always come in mirrored pairs through the centre. Editing one edits its twin.</p>
        </>
      ) : (
        <p>
          No sharp spikes stand out in this patch, so the texture may not be strictly periodic. Look for bright
          points or streaks away from the centre, or go back and pick a different area.
        </p>
      ),
    next: 'Next',
    // Painted them all out already? Skip the single-spike step.
    skipWhenCleared: 4,
  },
  {
    title: 'Paint over a spike',
    target: '[data-tour="spectrum"]',
    inside: true,
    hints: true,
    onEnter: (c) => c.set({ tool: 'attenuate', strength: 1 }),
    body: () => (
      <>
        <p>
          The <b>Attenuate</b> brush (E) is selected. Paint over one of the circled spikes. The image updates as
          you paint.
        </p>
        <p className="tour-dim">Scroll to zoom in for precision. Use [ and ] to change the brush size.</p>
      </>
    ),
    done: (c, b) => c.info.strokes > b.strokes,
    skipWhenCleared: 4,
  },
  {
    title: 'Clean up the rest',
    target: '[data-tour="spectrum"]',
    inside: true,
    hints: true,
    body: (_c, spikes) => (
      <>
        <p>
          {spikes > 0
            ? 'That spike\u2019s pattern is gone from the image. Paint the other circled spikes the same way.'
            : 'All the circled spikes are gone, and so is their pattern in the image.'}
        </p>
        <p className="tour-dim">
          Removed too much? Undo with ⌘Z, or switch to the <b>Restore</b> brush (R) and paint it back.
        </p>
      </>
    ),
    next: 'Done painting',
  },
  {
    title: 'Compare with the original',
    target: '[data-tour="compare"]',
    onEnter: (c) => c.engine.clearHints(),
    body: () => (
      <p>
        Hold <kbd>C</kbd>, or press and hold <b>Checkpoint</b>, to flip back to the image before your edits.
        Release to see the result again.
      </p>
    ),
    done: (c, b) => c.compares > b.compares,
    next: 'Skip',
  },
  {
    title: 'Save it as a checkpoint',
    target: '[data-tour="checkpoint"]',
    body: () => (
      <p>
        Happy with it? <b>New checkpoint</b> (K) bakes the result into a new base image. You can switch back to
        earlier checkpoints any time.
      </p>
    ),
    done: (c, b) => c.info.checkpoints.length > b.checkpoints,
    next: 'Skip',
  },
  {
    title: 'That’s it',
    body: () => (
      <>
        <p>You found a texture&apos;s frequencies and removed them.</p>
        <p className="tour-dim">
          Next, try <b>Select</b> (S) on the spectrum to spotlight where any frequency lives in the image, or the{' '}
          <b>Denoise</b> section for random noise. You can restart this tour from <b>Help</b> at the bottom.
        </p>
      </>
    ),
  },
]

const CARD_W = 320
const GAP = 14

function useTargetRect(selector: string | undefined): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null)
  useEffect(() => {
    if (!selector) return
    let raf = 0
    let last = ''
    // Bring targets in the scrolling controls column into view.
    document.querySelector(selector)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    // Track the target every frame: panes resize and sections scroll.
    const tick = () => {
      const el = document.querySelector(selector)
      const r = el?.getBoundingClientRect() ?? null
      const key = r ? `${r.x},${r.y},${r.width},${r.height}` : ''
      if (key !== last) {
        last = key
        setRect(r)
      }
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [selector])
  return selector ? rect : null
}

function cardPosition(r: DOMRect | null, inside: boolean, cardH: number): { left: number; top: number } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const clamp = (left: number, top: number) => ({
    left: Math.max(GAP, Math.min(vw - CARD_W - GAP, left)),
    top: Math.max(GAP, Math.min(vh - cardH - GAP, top)),
  })
  if (!r) return clamp((vw - CARD_W) / 2, vh / 2 - cardH / 2)
  if (inside) return clamp(r.left + GAP, r.bottom - cardH - GAP)
  if (r.right + GAP + CARD_W < vw) return clamp(r.right + GAP, r.top)
  if (r.left - GAP - CARD_W > 0) return clamp(r.left - GAP - CARD_W, r.top)
  return clamp(r.left, r.bottom + GAP)
}

/** The highlight ring: 4 px outside the target, kept on screen. */
function ringStyle(r: DOMRect): { left: number; top: number; width: number; height: number } {
  const left = Math.max(2, r.left - 4)
  const top = Math.max(2, r.top - 4)
  const right = Math.min(window.innerWidth - 2, r.right + 4)
  const bottom = Math.min(window.innerHeight - 2, r.bottom + 4)
  return { left, top, width: right - left, height: bottom - top }
}

interface TutorialProps extends Ctx {
  onClose: () => void
}

/**
 * Guided walkthrough: pick a textured region, find its spikes in the
 * spectrum, paint them out, compare, checkpoint. Steps advance on the
 * user's real actions; a card next to a highlighted target explains each.
 */
export function Tutorial({ onClose, ...ctx }: TutorialProps) {
  const [state, setState] = useState<{ i: number; base: Base }>(() => ({
    i: 0,
    base: { strokes: ctx.info.strokes, checkpoints: ctx.info.checkpoints.length, compares: ctx.compares },
  }))
  const [waitingForDemo, setWaitingForDemo] = useState(false)
  const [failedPick, setFailedPick] = useState(false)
  /** Markers found when they were first shown (0 if none were). */
  const [spikesFound, setSpikesFound] = useState(0)
  const [spikes, setSpikes] = useState(0)
  const [cardH, setCardH] = useState(180)
  const step = STEPS[state.i]
  const rect = useTargetRect(step.target)
  const { engine, info } = ctx

  const goto = (i: number) => {
    if (i >= STEPS.length) {
      close()
      return
    }
    STEPS[i].onEnter?.(ctx)
    setFailedPick(false)
    // Detect markers once, on entering the first step that shows them.
    if (STEPS[i].hints && !step.hints) {
      const n = engine.showSpikeHints(true, 4)
      setSpikes(n)
      setSpikesFound(n)
    }
    setState({
      i,
      base: { strokes: info.strokes, checkpoints: info.checkpoints.length, compares: ctx.compares },
    })
  }

  const close = () => {
    engine.clearHints()
    onClose()
  }

  // Auto-advance once the step's goal is met, after a beat to register it.
  // The first step's goal is the demo having loaded, if it was asked for.
  const demoReady = waitingForDemo && info.status === 'ready' && info.name === 'demo.png'
  const met = state.i === 0 ? demoReady : (step.done?.(ctx, state.base) ?? false)
  const cleared = step.skipWhenCleared !== undefined && spikesFound > 0 && spikes === 0
  const nextStep = cleared ? step.skipWhenCleared! : met ? state.i + 1 : null
  const advance = useEffectEvent((to: number) => {
    setWaitingForDemo(false)
    goto(to)
  })
  useEffect(() => {
    if (nextStep === null) return
    const id = setTimeout(() => advance(nextStep), 700)
    return () => clearTimeout(id)
  }, [nextStep, state.i])

  // Spike markers: detected once when they first appear, then kept for the
  // painting steps. Edits only remove markers whose spike was erased; no new
  // ones are found, so the goal doesn't move while the user works.
  useEffect(() => {
    if (!step.hints) return
    return engine.onRender((k) => {
      if (k === 'spectrum') setSpikes(engine.pruneErasedHints())
    })
  }, [engine, step.hints])

  // No-go areas: shown from the first failed pick until the step is left.
  const off = step.zonesOnFail ? skyCheck(ctx) : null
  if (off && off.fraction >= MAX_OFF_SKY && !failedPick) setFailedPick(true)
  const showZones = !!step.zonesOnFail && failedPick
  useEffect(() => {
    engine.setImageZones(showZones ? DEMO_NOT_SKY.map((z) => z.rect) : null)
  }, [engine, showZones])

  // Close on unmount (e.g. a new image replaces the engine state).
  useEffect(
    () => () => {
      engine.clearHints()
      engine.setImageZones(null)
    },
    [engine],
  )

  const pos = cardPosition(rect, !!step.inside, cardH)
  const first = state.i === 0
  const last = state.i === STEPS.length - 1

  return (
    <>
      {rect && <div className="tour-ring" style={ringStyle(rect)} />}
      <div
        className="tour-card"
        role="dialog"
        aria-label={step.title}
        style={{ left: pos.left, top: pos.top, width: CARD_W }}
        ref={(el) => {
          if (el && Math.abs(el.offsetHeight - cardH) > 1) setCardH(el.offsetHeight)
        }}
      >
        <div className="tour-head">
          <span className="tour-step">
            {state.i + 1} / {STEPS.length}
          </span>
          <button type="button" className="icon-button" onClick={close} title="End tour">
            <X size={14} aria-hidden />
          </button>
        </div>
        <h4>
          {nextStep !== null && <Check size={15} className="tour-check" aria-hidden />}
          {step.title}
        </h4>
        <div className="tour-body">{step.body(ctx, spikes)}</div>
        <div className="tour-actions">
          {first ? (
            <>
              {info.status === 'ready' && info.name !== 'demo.png' && (
                <Button onClick={() => goto(1)}>Use my image</Button>
              )}
              <Button
                variant="primary"
                busy={waitingForDemo}
                disabled={waitingForDemo}
                onClick={() => {
                  if (info.name !== 'demo.png' || info.status !== 'ready') ctx.loadDemo()
                  setWaitingForDemo(true)
                }}
              >
                {waitingForDemo ? 'Loading demo…' : 'Use the demo'} <ArrowRight size={14} aria-hidden />
              </Button>
            </>
          ) : last ? (
            <Button variant="primary" onClick={close}>
              Finish
            </Button>
          ) : (
            step.next && (
              <Button onClick={() => goto(state.i + 1)}>
                {step.next} <ArrowRight size={14} aria-hidden />
              </Button>
            )
          )}
        </div>
      </div>
    </>
  )
}

export function TourToast({ onStart, onDismiss }: { onStart: () => void; onDismiss: () => void }) {
  return (
    <div className="tour-toast" role="status">
      <GraduationCap size={18} className="tour-toast-icon" aria-hidden />
      <div>
        <b>New to Texture Janitor?</b>
        <p>Take a one-minute tour: pick out a repeating texture and paint it out of the spectrum.</p>
        <div className="row">
          <Button variant="primary" onClick={onStart}>
            Start tour
          </Button>
          <Button onClick={onDismiss}>Don&apos;t show again</Button>
        </div>
      </div>
    </div>
  )
}
