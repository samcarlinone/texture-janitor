import { SlidersHorizontal } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import './App.css'
import { makeLut } from './engine/colormap.ts'
import { denoiseDefaults } from './denoise/index.ts'
import { Engine, type DenoiseSettings } from './engine/engine.ts'
import { Controls, type ControlActions, type ControlState } from './ui/Controls.tsx'
import { Button } from './ui/Button.tsx'
import { Segmented } from './ui/Segmented.tsx'
import { DenoisePanel } from './ui/DenoisePanel.tsx'
import { MemoryMeter } from './ui/MemoryMeter.tsx'
import type { ImagePaneController } from './ui/imagePane.ts'
import { held } from './ui/keys.ts'
import { ImagePaneView, SpectrumPaneView } from './ui/Panes.tsx'
import type { SpectrumPaneController } from './ui/spectrumPane.ts'
import { TOOLS } from './ui/tools.ts'
import { readPref, writePref } from './ui/storage.ts'
import { answerTourPrompt, tourPromptAnswered } from './ui/tourPrompt.ts'
import { TourToast } from './ui/TourToast.tsx'
import { ProjectStore } from './project/store.ts'
import { ProjectPanel } from './ui/ProjectPanel.tsx'

const INITIAL: ControlState = {
  tool: 'attenuate',
  radius: 6,
  hardness: 0.4,
  strength: 1,
  gain: 3,
  selShape: 'ellipse',
  feather: 1.5,
  colormap: 'inferno',
  black: 0.25,
  white: 1,
  gamma: 1,
  overlay: true,
  viewMode: 'local',
  heatOpacity: 0.8,
}

// Only needed once asked for, so kept out of the initial bundle.
const Tutorial = lazy(() => import('./ui/Tutorial.tsx').then((m) => ({ default: m.Tutorial })))

const COMPACT_KEY = 'tj.compactPanes'

/** Input types that take typed text (so they keep their keys). Sliders, checkboxes etc. don't. */
const TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
])

/**
 * True when the key belongs to a field the user is typing into. Everything
 * else (sliders, checkboxes, buttons) lets shortcuts through; none of the
 * shortcuts use the arrow keys those controls need.
 */
function isTextEntry(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true
  return t instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(t.type)
}

export default function App() {
  const [engine] = useState(() => new Engine())
  useEffect(() => {
    // Handy for poking at the engine from the console / browser tests.
    if (import.meta.env.DEV) Object.assign(window, { engine })
  }, [engine])
  const info = useSyncExternalStore(engine.subscribe, engine.getInfo)
  const [store] = useState(() => new ProjectStore(engine))
  const project = useSyncExternalStore(store.subscribe, store.getStatus)
  const projectInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    store.start()
    return () => store.dispose()
  }, [store])
  useEffect(() => {
    if (import.meta.env.DEV) Object.assign(window, { projectStore: store })
  }, [store])
  // Leaving with unsaved changes: ask first.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (!store.getStatus().unsaved) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [store])
  const [s, setState] = useState(INITIAL)
  const [denoise, setDenoise] = useState<DenoiseSettings>({
    algo: 'bm3d',
    quality: 'balanced',
    memory: 'balanced',
    model: 'measured',
    ...denoiseDefaults('bm3d', 'measured'),
  })
  const [exporting, setExporting] = useState(false)
  const [touring, setTouring] = useState(false)
  const [toast, setToast] = useState(() => !tourPromptAnswered())
  const [compares, setCompares] = useState(0)
  const [pickingSub, setPickingSub] = useState(false)
  // Phone layout only; remembered per browser, on unless turned off.
  const [compactPanes, setCompactPanesState] = useState(() => readPref(COMPACT_KEY) !== '0')
  const setCompactPanes = (on: boolean) => {
    setCompactPanesState(on)
    writePref(COMPACT_KEY, on ? '1' : '0')
  }
  // Phone layout only: the controls row can be hidden to give the panes the whole screen.
  const [controlsHidden, setControlsHidden] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const imageCtrl = useRef<ImagePaneController | null>(null)
  const specCtrl = useRef<SpectrumPaneController | null>(null)
  const onImageCtrl = useCallback((c: ImagePaneController | null) => {
    imageCtrl.current = c
  }, [])
  const onSpecCtrl = useCallback((c: SpectrumPaneController | null) => {
    specCtrl.current = c
  }, [])
  const set = (patch: Partial<ControlState>) => setState((prev) => ({ ...prev, ...patch }))

  const ready = info.status === 'ready'
  const maxRadius = Math.max(4, Math.min(400, Math.max(info.w, info.h) / 2))
  const peak = engine.displayPeak
  const lut = useMemo(
    () => makeLut(s.colormap, s.black * peak, s.white * peak, s.gamma),
    [s.colormap, s.black, s.white, s.gamma, peak],
  )
  const brushTool = s.tool === 'select' ? 'attenuate' : s.tool
  const brushRadius = Math.min(s.radius, maxRadius)
  const brush = useMemo(
    () => ({
      tool: brushTool,
      radius: brushRadius,
      hardness: s.hardness,
      strength: s.strength,
      gain: s.gain,
    }),
    [brushTool, brushRadius, s.hardness, s.strength, s.gain],
  )

  const loadFile = (f: File | null | undefined) => {
    if (!f) return
    if (f.name.toLowerCase().endsWith('.tj')) void store.open(f)
    else if (f.type.startsWith('image/')) void engine.loadFile(f, f.name)
  }
  const openProject = () => {
    // With File System Access the file stays attached for saving; otherwise just read it.
    void store.openPicker().then((handled) => {
      if (!handled) projectInput.current?.click()
    })
  }

  const actions: ControlActions = {
    open: () => fileInput.current?.click(),
    demo: async () => {
      const { makeDemo } = await import('./ui/demo.ts')
      const { data, w, h } = makeDemo()
      await engine.loadGenerated(data, w, h, 'demo.png')
    },
    exportPng: async () => {
      setExporting(true)
      try {
        const blob = await engine.exportPng()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${info.name.replace(/\.[^.]+$/, '') || 'image'}-fft.png`
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 10_000)
      } catch (e) {
        alert(`Export failed: ${(e as Error).message}`)
      } finally {
        setExporting(false)
      }
    },
    undo: () => engine.undo(),
    redo: () => engine.redo(),
    reset: () => engine.resetEdits(),
    removeSelected: () => engine.applyToSelection({ tool: 'attenuate', strength: 1, gain: 1 }, 'inside'),
    keepSelected: () => engine.applyToSelection({ tool: 'attenuate', strength: 1, gain: 1 }, 'outside'),
    applyInside: () => engine.applyToSelection(brush, 'inside'),
    clearSelection: () => engine.setSelection(null),
    clearRegion: () => engine.setRegion(null),
    checkpoint: () => void engine.createCheckpoint(),
    gotoCheckpoint: (id) => void engine.gotoCheckpoint(id),
    deleteCheckpoint: (id) => void engine.deleteCheckpoint(id),
    compare: (target) => {
      if (held.compare === target) return
      held.compare = target
      if (target) setCompares((n) => n + 1)
      imageCtrl.current?.invalidate(0)
    },
    subregion: () => setPickingSub((v) => !v),
    startTour: () => {
      answerTourPrompt('started')
      setToast(false)
      setControlsHidden(false)
      setTouring(true)
    },
  }

  const onKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (isTextEntry(e.target)) return
    const mod = e.metaKey || e.ctrlKey
    const k = e.key.toLowerCase()
    if (mod && k === 'z') {
      e.preventDefault()
      if (e.shiftKey) engine.redo()
      else engine.undo()
      return
    }
    if (mod && k === 'y') {
      e.preventDefault()
      engine.redo()
      return
    }
    if (mod && k === 's') {
      e.preventDefault()
      if (e.shiftKey) void store.saveAs()
      else void store.save()
      return
    }
    if (mod && k === 'o') {
      e.preventDefault()
      actions.open()
      return
    }
    if (e.key === 'Alt') {
      held.alt = true
      imageCtrl.current?.invalidate(0)
    }
    if (mod) return
    if ((k === 'c' || k === 'b') && !e.repeat) {
      actions.compare(k === 'c' ? 'checkpoint' : 'original')
      return
    }
    if (k === 'k' && !e.repeat) {
      actions.checkpoint()
      return
    }
    const tool = TOOLS.find((t) => t.key.toLowerCase() === k)
    if (tool) return set({ tool: tool.id })
    if (e.key === '[') return set({ radius: Math.max(0.5, s.radius / 1.25) })
    if (e.key === ']') return set({ radius: Math.min(maxRadius, s.radius * 1.25) })
    if (k === 'f') {
      imageCtrl.current?.fit()
      specCtrl.current?.fit()
      return
    }
    if (e.key === 'Escape') {
      if (pickingSub) {
        setPickingSub(false)
        return
      }
      engine.setSelection(null)
      engine.setRegion(null)
      return
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && info.selection) {
      e.preventDefault()
      actions.removeSelected()
    }
  })

  const onKeyUp = useEffectEvent((e: KeyboardEvent) => {
    if (e.key === 'Alt') {
      held.alt = false
      imageCtrl.current?.invalidate(0)
    }
    const k = e.key.toLowerCase()
    if ((k === 'c' && held.compare === 'checkpoint') || (k === 'b' && held.compare === 'original')) {
      actions.compare(null)
    }
  })

  const onPaste = useEffectEvent((e: ClipboardEvent) => {
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'))
    const f = item?.getAsFile()
    if (f) loadFile(new File([f], 'pasted.png', { type: f.type }))
  })

  useEffect(() => {
    const down = (e: KeyboardEvent) => onKeyDown(e)
    const up = (e: KeyboardEvent) => onKeyUp(e)
    const paste = (e: ClipboardEvent) => onPaste(e)
    const blur = () => {
      held.compare = null
      held.alt = false
      imageCtrl.current?.invalidate(0)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('paste', paste)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('paste', paste)
      window.removeEventListener('blur', blur)
    }
  }, [])

  // Edit-mode note: luminance edits (all channels together) and per-channel
  // edits can't be mixed on one checkpoint; say which applies here.
  const CHANNEL_NAMES = { l: 'luminance', r: 'red', g: 'green', b: 'blue' } as const
  const viewCh = info.spectrumChannel
  const wantMode = viewCh === 'l' ? 'shared' : 'rgb'
  const editBlocked = info.editMode !== null && info.editMode !== wantMode
  // Shown only when this view can't be edited.
  const editNote =
    ready && editBlocked ? (
      <div key={info.editBlocked} className={`edit-note ${info.editBlocked ? 'flash' : ''}`} role="status">
        {/* Full sentence where there's room; a short one in a narrow pane (see .edit-note CSS). */}
        <span className="note-long">
          <b>View only:</b>{' '}
          {info.editMode === 'shared'
            ? `this checkpoint edits luminance. New checkpoint (K) to edit ${CHANNEL_NAMES[viewCh]} alone.`
            : 'this checkpoint edits R, G, B separately. New checkpoint (K) to edit luminance.'}
        </span>
        <span className="note-short">
          <b>View only</b> · New checkpoint (K) to edit{' '}
          {info.editMode === 'shared' ? CHANNEL_NAMES[viewCh] : 'luminance'}
        </span>
      </div>
    ) : null

  const channels = (
    <Segmented
      className="channel-switch"
      aria-label="Spectrum channel"
      value={info.spectrumChannel}
      disabled={!ready}
      options={(
        [
          ['l', 'L', 'Luminance'],
          ['r', 'R', 'Red channel'],
          ['g', 'G', 'Green channel'],
          ['b', 'B', 'Blue channel'],
        ] as const
      ).map(([id, label, name]) => ({
        id,
        label,
        className: `ch-${id}`,
        title:
          id === 'l'
            ? 'Luminance spectrum: edits apply to all channels together'
            : `${name} spectrum: edits apply to the ${name.toLowerCase().replace(' channel', '')} channel only`,
      }))}
      onChange={(id) => void engine.setSpectrumChannel(id)}
    />
  )

  const empty =
    info.status === 'ready' ? null : (
      <div className="empty">
        {info.status === 'loading' ? (
          <div className="spinner-wrap">
            <div className="spinner" />
            <p>{info.message}</p>
          </div>
        ) : (
          <div>
            <p>Drop an image here, paste one, or</p>
            <div className="row center">
              <Button variant="primary" onClick={actions.open}>
                Open image…
              </Button>
              <Button onClick={actions.demo}>Load demo</Button>
            </div>
            {info.status === 'error' && <p className="error">{info.message}</p>}
          </div>
        )}
      </div>
    )

  return (
    <div
      className={`app ${dragOver ? 'drag-over' : ''} ${compactPanes ? 'compact-panes' : ''} ${controlsHidden ? 'controls-hidden' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        loadFile(e.dataTransfer.files[0])
      }}
    >
      <input
        ref={projectInput}
        type="file"
        accept=".tj"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void store.open(f)
          e.target.value = ''
        }}
      />
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          loadFile(e.target.files?.[0])
          e.target.value = ''
        }}
      />
      <ImagePaneView
        engine={engine}
        onController={onImageCtrl}
        title="Image"
        tool={pickingSub ? 'subregion' : 'region'}
        heatOpacity={s.heatOpacity}
        onSubregion={(r) => {
          setPickingSub(false)
          void engine.createSubregion(r)
        }}
        empty={empty}
        floating={
          <Button
            className="show-controls"
            icon={SlidersHorizontal}
            onClick={() => setControlsHidden(false)}
            title="Show controls"
            aria-label="Show controls"
          />
        }
      />
      <Controls
        info={info}
        state={s}
        set={set}
        actions={actions}
        exporting={exporting}
        maxRadius={maxRadius}
        pickingSubregion={pickingSub}
        compactPanes={compactPanes}
        setCompactPanes={setCompactPanes}
        hide={() => setControlsHidden(true)}
        projectWarning={ready && store.notSaving}
        project={
          <ProjectPanel
            status={project}
            ready={ready}
            save={() => void store.save()}
            saveAs={() => void store.saveAs()}
            open={openProject}
            reopen={() => void store.reopen()}
            setAutosave={(on) => store.setAutosave(on)}
          />
        }
        denoise={
          <DenoisePanel
            info={info}
            settings={denoise}
            set={(patch) => setDenoise((d) => ({ ...d, ...patch }))}
            plan={ready ? engine.planDenoise(denoise, 'full') : null}
            regionPlan={ready && info.region ? engine.planDenoise(denoise, 'region') : null}
            run={(scope) => void engine.denoise(denoise, scope)}
            cancel={() => engine.cancelDenoise()}
            discardPreview={() => engine.clearDenoisePreview()}
          />
        }
        footer={<MemoryMeter engine={engine} />}
      />
      <SpectrumPaneView
        engine={engine}
        onController={onSpecCtrl}
        title={info.region && s.viewMode === 'local' ? 'Spectrum · region' : 'Spectrum'}
        tool={s.tool}
        brush={brush}
        selShape={s.selShape}
        feather={s.feather}
        lut={lut}
        overlay={s.overlay}
        localView={s.viewMode === 'local' && info.hasLocal}
        blocked={editBlocked}
        note={editNote}
        empty={ready ? null : <div className="empty dim" />}
        toolbar={channels}
      />
      {ready && !info.upToDate && <div className="busy-bar" />}
      {touring && (
        <Suspense>
          <Tutorial
            engine={engine}
            info={info}
            controls={s}
            set={set}
            loadDemo={actions.demo}
            compares={compares}
            onClose={() => setTouring(false)}
          />
        </Suspense>
      )}
      {toast && !touring && (
        <TourToast
          onStart={actions.startTour}
          onDismiss={() => {
            answerTourPrompt('dismissed')
            setToast(false)
          }}
        />
      )}
    </div>
  )
}
