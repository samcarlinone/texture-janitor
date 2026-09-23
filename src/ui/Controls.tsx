import {
  BookmarkPlus,
  Bug,
  SquareDashedMousePointer,
  TriangleAlert,
  ChevronRight,
  GraduationCap,
  Minimize2,
  Circle,
  Download,
  ExternalLink,
  Eraser,
  FlaskConical,
  FolderOpen,
  Focus,
  Paintbrush,
  Redo2,
  RotateCcw,
  Square,
  Trash2,
  Undo2,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { ColormapName } from '../engine/colormap.ts'
import type { EngineInfo } from '../engine/engine.ts'
import type { Shape } from '../engine/layout.ts'
import type { SpectrumTool } from './spectrumPane.ts'
import { Button } from './Button.tsx'
import { formatMs } from './format.ts'
import { GithubIcon } from './GithubIcon.tsx'
import { KeyLabel } from './KeyLabel.tsx'
import { shortcut } from './keys.ts'
import { Segmented } from './Segmented.tsx'
import { Slider } from './Slider.tsx'
import { readPref, writePref } from './storage.ts'
import { TOOLS } from './tools.ts'

export interface ControlState {
  tool: SpectrumTool
  radius: number
  hardness: number
  strength: number
  gain: number
  selShape: Shape['kind']
  feather: number
  colormap: ColormapName
  black: number
  white: number
  gamma: number
  overlay: boolean
  viewMode: 'global' | 'local'
  heatOpacity: number
}

export interface ControlActions {
  open: () => void
  demo: () => void
  exportPng: () => void
  undo: () => void
  redo: () => void
  reset: () => void
  removeSelected: () => void
  keepSelected: () => void
  applyInside: () => void
  clearSelection: () => void
  clearRegion: () => void
  checkpoint: () => void
  gotoCheckpoint: (id: number) => void
  deleteCheckpoint: (id: number) => void
  /** Start (or, with null, stop) a hold-to-compare. */
  compare: (target: 'checkpoint' | 'original' | null) => void
  startTour: () => void
  /** Start (or cancel) picking a subregion on the image. */
  subregion: () => void
}

interface Props {
  info: EngineInfo
  state: ControlState
  set: (patch: Partial<ControlState>) => void
  actions: ControlActions
  exporting: boolean
  maxRadius: number
  /** Waiting for the user to drag out a new subregion on the image. */
  pickingSubregion: boolean
  /** Denoise section body. */
  denoise: ReactNode
  /** Bottom status bar content. */
  footer: ReactNode
  /** Project section body, and whether work is currently not being saved (header warning). */
  project: ReactNode
  projectWarning: boolean
  /** Phone layout only: hide pane headers/zoom controls and coordinate footers. */
  compactPanes: boolean
  setCompactPanes: (on: boolean) => void
  /** Phone layout only: hide this panel (a floating button on the image brings it back). */
  hide: () => void
}


function Section({
  title,
  children,
  aside,
  collapsible = false,
  storageKey,
  className,
}: {
  title: string
  children: ReactNode
  aside?: ReactNode
  collapsible?: boolean
  /** Remembers the open state (per browser) under this localStorage key. */
  storageKey?: string
  className?: string
}) {
  const [open, setOpen] = useState(() => !collapsible || (!!storageKey && readPref(storageKey) === '1'))
  const toggle = () => {
    const next = !open
    setOpen(next)
    if (storageKey) writePref(storageKey, next ? '1' : '0')
  }
  return (
    <section className={`ctl-section ${collapsible && !open ? 'collapsed' : ''} ${className ?? ''}`}>
      <h3>
        {collapsible ? (
          <button type="button" className="section-toggle" aria-expanded={open} onClick={toggle}>
            <ChevronRight size={13} className="chevron" aria-hidden />
            {title}
          </button>
        ) : (
          <span>{title}</span>
        )}
        {aside}
      </h3>
      {open && children}
    </section>
  )
}

export function Controls({
  info,
  state: s,
  set,
  actions: a,
  exporting,
  maxRadius,
  pickingSubregion,
  denoise,
  footer,
  compactPanes,
  setCompactPanes,
  hide,
  project,
  projectWarning,
}: Props) {
  const ready = info.status === 'ready'
  const isBrush = s.tool !== 'select'
  const sel = info.selection

  return (
    <aside className="controls">
      {/* Outside .brand so it can stick while the column scrolls. */}
      <div className="hide-controls mobile-only">
        <Button icon={Minimize2} onClick={hide} title="Hide controls" aria-label="Hide controls" />
      </div>
      <div className="brand">
        <div>
          <h1>Texture Janitor</h1>
          <p>Fourier-domain image editor</p>
        </div>
      </div>
      {info.subregion && (
        <div className="subregion-banner" role="status">
          <TriangleAlert size={15} aria-hidden />
          <span>
            <b>Editing a subregion only.</b> The spectrum and every tool now apply to the{' '}
            {info.subregion.x1 - info.subregion.x0}×{info.subregion.y1 - info.subregion.y0} px area at (
            {info.subregion.x0}, {info.subregion.y0}); the rest of the image is the checkpoint below.
          </span>
        </div>
      )}
      <div className="controls-scroll">

      <Section title="Image">
        <div className="row">
          <Button variant="primary" icon={FolderOpen} onClick={a.open}>
            Open…
          </Button>
          <Button icon={FlaskConical} onClick={a.demo}>
            Demo
          </Button>
          <Button icon={Download} busy={exporting} disabled={!ready || exporting} onClick={a.exportPng}>
            {exporting ? 'Exporting…' : 'Export'}
          </Button>
        </div>
        {info.status === 'ready' && (
          <div className="stats">
            <div className="stats-name" title={info.name}>
              {info.name}
            </div>
            <div>
              {info.w} × {info.h} px · {info.workers} threads
            </div>
            <div>
              FFT {formatMs(info.forwardMs)} · full {info.lastFullMs ? formatMs(info.lastFullMs) : '—'}
              {!info.fastFull && <> · preview {info.lastPreviewMs ? formatMs(info.lastPreviewMs) : '—'}</>}
            </div>
            <div className={`state ${info.upToDate ? 'ok' : 'busy'}`}>
              <i />
              {info.upToDate ? 'Full resolution, up to date' : info.refining ? 'Rendering full resolution…' : 'Preview (refines when you pause)'}
            </div>
          </div>
        )}
        {info.status === 'loading' && <div className="stats">{info.message}</div>}
        {info.status === 'error' && <div className="stats error">{info.message}</div>}
      </Section>

      <Section
        title="Project"
        collapsible
        storageKey="tj.project.open"
        aside={
          projectWarning ? (
            <span className="section-warning" title="This work isn't being saved to a file">
              <TriangleAlert size={13} aria-label="Not being saved" />
            </span>
          ) : null
        }
      >
        {project}
      </Section>

      <Section title="Spectrum tool">
        <div className="tool-grid">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              data-tour={`tool-${t.id}`}
              title={`${t.hint} (${t.key})`}
              className={`tool tone-${t.tone} ${s.tool === t.id ? 'on' : ''}`}
              onClick={() => set({ tool: t.id })}
            >
              <t.icon size={18} strokeWidth={1.75} aria-hidden />
              <span>{t.label}</span>
              <kbd>
                <span>{t.key}</span>
              </kbd>
            </button>
          ))}
        </div>
        {isBrush && (
          <>
            <Slider
              label="Size"
              title="Brush radius in frequency bins ( [ and ] )"
              log
              value={s.radius}
              min={0.5}
              max={maxRadius}
              display={`${s.radius < 10 ? s.radius.toFixed(1) : Math.round(s.radius)} bins`}
              onChange={(v) => set({ radius: v })}
            />
            <Slider
              label="Hardness"
              value={s.hardness}
              min={0}
              max={1}
              display={`${Math.round(s.hardness * 100)}%`}
              onChange={(v) => set({ hardness: v })}
            />
            <Slider
              label="Strength"
              value={s.strength}
              min={0}
              max={1}
              display={`${Math.round(s.strength * 100)}%`}
              onChange={(v) => set({ strength: v })}
            />
            {s.tool === 'amplify' && (
              <Slider
                label="Gain"
                log
                value={s.gain}
                min={1}
                max={20}
                display={`${s.gain.toFixed(2)}×`}
                onChange={(v) => set({ gain: v })}
              />
            )}
            {sel && (
              <Button
                icon={Paintbrush}
                onClick={a.applyInside}
                title="Apply the current brush tool and strength to the whole selection"
              >
                Apply to selection
              </Button>
            )}
            <p className="hint">Edits mirror through the centre automatically, so the image stays real-valued.</p>
          </>
        )}
        {s.tool === 'select' && (
          <>
            <Segmented
              value={s.selShape}
              options={[
                { id: 'ellipse', label: 'Ellipse', icon: Circle },
                { id: 'rect', label: 'Rectangle', icon: Square },
              ]}
              onChange={(v) => set({ selShape: v })}
            />
            {sel && (
              <>
                <Slider
                  label="Spotlight"
                  title="Darkens the image where the selected frequencies are weak"
                  value={s.heatOpacity}
                  min={0}
                  max={1}
                  display={`${Math.round(s.heatOpacity * 100)}%`}
                  onChange={(v) => set({ heatOpacity: v })}
                />
                <div className="row wrap">
                  <Button icon={Eraser} onClick={a.removeSelected} title="Notch out the selected frequencies (Delete)">
                    Remove
                  </Button>
                  <Button icon={Focus} onClick={a.keepSelected} title="Remove everything except the selection (DC is kept)">
                    Keep only
                  </Button>
                </div>
              </>
            )}
            <Slider
              label="Feather"
              value={s.feather}
              min={0}
              max={32}
              display={`${s.feather.toFixed(1)} bins`}
              onChange={(v) => set({ feather: v })}
            />
            {sel && (
              <div className="row">
                <Button icon={Trash2} kbd="Esc" title="Clear the spectrum selection (Esc)" onClick={a.clearSelection}>
                  Clear selection
                </Button>
              </div>
            )}
            <p className="hint">Drag on the spectrum; Shift for a circle or square. The image shows where those frequencies live.</p>
          </>
        )}
      </Section>

      <Section
        title="Isolate"
        aside={
          info.region ? (
            <Button icon={Trash2} kbd="Esc" title="Clear the picked image region (Esc)" onClick={a.clearRegion}>
              Clear
            </Button>
          ) : null
        }
      >
        {info.region ? (
          <>
            <Segmented
              value={s.viewMode}
              options={[
                { id: 'local', label: 'Region spectrum' },
                { id: 'global', label: 'Whole image' },
              ]}
              onChange={(v) => set({ viewMode: v })}
            />
            <p className="hint">
              Region {info.region.x1 - info.region.x0}×{info.region.y1 - info.region.y0} px, Hann-windowed and drawn
              on the global frequency axes, so its peaks line up with the full spectrum.
            </p>
          </>
        ) : (
          <p className="hint">Drag a box on the image to see that patch's spectrum.</p>
        )}
      </Section>

      <Section title="History">
        <div className="row">
          <Button icon={Undo2} disabled={!info.canUndo} onClick={a.undo} title={`Undo (${shortcut('Mod+Z')})`}>
            Undo
          </Button>
          <Button icon={Redo2} disabled={!info.canRedo} onClick={a.redo} title={`Redo (${shortcut('Shift+Mod+Z')})`}>
            Redo
          </Button>
          <Button icon={RotateCcw} disabled={!info.edited} onClick={a.reset} title="Restore every bin (undoable)">
            Reset
          </Button>
        </div>
        <Button
          block
          icon={BookmarkPlus}
          busy={info.switching}
          kbd="K"
          data-tour="checkpoint"
          disabled={!ready || info.switching}
          onClick={a.checkpoint}
          title="Bake the current result into a new base image (K)"
        >
          New checkpoint
        </Button>
        <Button
          block
          icon={SquareDashedMousePointer}
          active={pickingSubregion}
          kbd={pickingSubregion ? 'Esc' : undefined}
          data-tour="subregion"
          disabled={!ready || info.switching}
          onClick={a.subregion}
          title="Pick an area of the image to edit on its own, with its own spectrum"
        >
          {pickingSubregion ? 'Drag on the image…' : 'New subregion'}
        </Button>
        <ol className="checkpoints">
          {[...info.checkpoints].reverse().map((c, i, all) => {
            const active = c.id === info.activeCheckpoint
            const base = i === all.length - 1
            return (
              <li key={c.id} className={active ? 'active' : ''}>
                <button
                  type="button"
                  className="checkpoint"
                  disabled={info.switching}
                  onClick={() => a.gotoCheckpoint(c.id)}
                  title={active ? 'Current base for edits' : `Switch to ${c.label}`}
                >
                  <img src={c.thumb} alt="" />
                  <span className="checkpoint-text">
                    <span className="checkpoint-label">
                      {c.rect && <SquareDashedMousePointer size={11} className="checkpoint-kind" aria-hidden />}
                      {c.label}
                    </span>
                    <span className="checkpoint-sub">
                      {[
                        active ? (info.edited ? 'Active · with edits' : 'Active') : c.pending ? 'Has edits' : null,
                        c.rect ? `${c.rect.x1 - c.rect.x0}×${c.rect.y1 - c.rect.y0} area` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ') || '\u00a0'}
                    </span>
                  </span>
                </button>
                {!base && (
                  <Button
                    variant="ghost"
                    icon={Trash2}
                    disabled={info.switching}
                    onClick={() => a.deleteCheckpoint(c.id)}
                    title={active ? `Delete ${c.label} and its edits, and switch to the one below` : `Delete ${c.label}`}
                  />
                )}
              </li>
            )
          })}
        </ol>
        <div className="sub">Hold to compare</div>
        <div className="row" data-tour="compare">
          {(
            [
              ['checkpoint', 'Checkpoint', 'C'],
              ['original', 'Base image', 'B'],
            ] as const
          ).map(([target, label, key]) => (
            <Button
              key={target}
              className="hold"
              kbd={key}
              disabled={!ready}
              // A long press would otherwise open the context menu (Android) or callout (iOS).
              onContextMenu={(e) => e.preventDefault()}
              onPointerDown={(e) => {
                // Capture, so the release ends the compare wherever it happens.
                e.currentTarget.setPointerCapture(e.pointerId)
                a.compare(target)
              }}
              onLostPointerCapture={() => a.compare(null)}
            >
              {label}
            </Button>
          ))}
        </div>
      </Section>

      <Section title="Denoise" collapsible storageKey="tj.denoise.open">
        {denoise}
      </Section>

      <Section title="Spectrum display" collapsible storageKey="tj.display.open">
        <Segmented
          value={s.colormap}
          options={[
            { id: 'inferno', label: 'Inferno' },
            { id: 'viridis', label: 'Viridis' },
            { id: 'ice', label: 'Ice' },
            { id: 'gray', label: 'Gray' },
          ]}
          onChange={(v) => set({ colormap: v })}
        />
        <Slider
          label="Black"
          value={s.black}
          min={0}
          max={0.9}
          display={s.black.toFixed(2)}
          onChange={(v) => set({ black: Math.min(v, s.white - 0.05) })}
        />
        <Slider
          label="White"
          value={s.white}
          min={0.2}
          max={1.6}
          display={s.white.toFixed(2)}
          title="1.00 = strongest unedited peak; raise it to see amplified bins"
          onChange={(v) => set({ white: Math.max(v, s.black + 0.05) })}
        />
        <Slider
          label="Gamma"
          log
          value={s.gamma}
          min={0.3}
          max={3}
          display={s.gamma.toFixed(2)}
          onChange={(v) => set({ gamma: v })}
        />
        <label className="check">
          <input type="checkbox" checked={s.overlay} onChange={(e) => set({ overlay: e.target.checked })} />
          Tint edited bins <span className="swatch cut" /> cut <span className="swatch boost" /> boost
        </label>
      </Section>

      <Section title="Shortcuts" className="desktop-only" collapsible storageKey="tj.shortcuts.open">
        <dl className="shortcuts">
          <dt>Wheel / pinch</dt>
          <dd>Zoom at cursor</dd>
          <dt>Right or middle drag</dt>
          <dd>Pan</dd>
          <dt>[ ]</dt>
          <dd>Brush size</dd>
          <dt>F</dt>
          <dd>Fit both views</dd>
          <dt>K</dt>
          <dd>New checkpoint</dd>
          <dt>C (hold)</dt>
          <dd>Compare with active checkpoint</dd>
          <dt>B (hold)</dt>
          <dd>Compare with base image</dd>
          <dt>Alt (hold)</dt>
          <dd>Magnifier over the image (also after a slow, steady drag)</dd>
          <dt>Delete</dt>
          <dd>Remove selected frequencies</dd>
          <dt>
            <KeyLabel label={shortcut('Mod+Z')} size={11} /> / <KeyLabel label={shortcut('Shift+Mod+Z')} size={11} />
          </dt>
          <dd>Undo / redo</dd>
        </dl>
      </Section>

      <Section title="Help">
        <p className="hint">New here? A guided tour walks through removing a repeating texture in about a minute.</p>
        <Button icon={GraduationCap} onClick={a.startTour}>
          Start interactive tutorial
        </Button>
        <a className="help-link" href="https://github.com/samcarlinone/texture-janitor/issues" target="_blank" rel="noreferrer">
          <Bug size={13} aria-hidden />
          Report an issue
          <ExternalLink size={11} aria-hidden />
        </a>
      </Section>

      <Section title="Source">
        <a className="help-link" href="https://github.com/samcarlinone/texture-janitor" target="_blank" rel="noreferrer">
          <GithubIcon size={13} />
          Source on GitHub
          <ExternalLink size={11} aria-hidden />
        </a>
      </Section>
      </div>
      <label className="check check-wrap mobile-only compact-toggle">
        <input type="checkbox" checked={compactPanes} onChange={(e) => setCompactPanes(e.target.checked)} />
        <span>Compact panes: hide the image header, zoom buttons and coordinates</span>
      </label>
      <footer className="controls-foot">{footer}</footer>
    </aside>
  )
}
