import { Check, ScanEye, WandSparkles, X } from 'lucide-react'
import { denoiseDefaults, type DenoiseAlgo, type NoiseModel, type Quality } from '../denoise/index.ts'
import type { DenoisePlan, DenoiseSettings, EngineInfo, MemoryMode } from '../engine/engine.ts'
import { Button } from './Button.tsx'
import { formatBytes } from './format.ts'

const ALGOS: { id: DenoiseAlgo; label: string; blurb: string }[] = [
  {
    id: 'wiener',
    label: 'Wiener',
    blurb: 'Global spectral Wiener filter. Instant, no extra memory; applied as an undoable spectrum edit.',
  },
  {
    id: 'nlm',
    label: 'NL-means',
    blurb: 'Non-local means (Buades et al.): averages similar patches. Moderate cost; bakes a checkpoint.',
  },
  {
    id: 'bm3d',
    label: 'BM3D',
    blurb: 'Colour BM3D (Dabov et al.) with correlated-noise shrinkage (Mäkinen et al. 2020). Best quality, heaviest; bakes a checkpoint.',
  },
]

function Seg<T extends string>(p: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className="segmented">
      {p.options.map((o) => (
        <button
          key={o.id}
          type="button"
          disabled={p.disabled}
          className={o.id === p.value ? 'on' : ''}
          onClick={() => p.onChange(o.id)}
        >
          <span className="text-trim">{o.label}</span>
        </button>
      ))}
    </div>
  )
}

function fmtSeconds(s: number): string {
  if (s < 1) return `${Math.max(1, Math.round(s * 1000))} ms`
  if (s < 90) return `${s.toFixed(s < 10 ? 1 : 0)} s`
  return `${Math.round(s / 60)} min`
}

interface Props {
  info: EngineInfo
  settings: DenoiseSettings
  set: (patch: Partial<DenoiseSettings>) => void
  plan: DenoisePlan | null
  regionPlan: DenoisePlan | null
  run: (scope: 'region' | 'full') => void
  cancel: () => void
  discardPreview: () => void
}

export function DenoisePanel({ info, settings: s, set, plan, regionPlan, run, cancel, discardPreview }: Props) {
  const ready = info.status === 'ready'
  const spatial = s.algo !== 'wiener'
  const busy = info.denoise
  const n = info.noise
  const algo = ALGOS.find((a) => a.id === s.algo)!
  // Switching algorithm or model resets strength to its calibrated default.
  const choose = (patch: Partial<DenoiseSettings>) => {
    const next = { ...s, ...patch }
    set({ ...patch, ...denoiseDefaults(next.algo, next.model) })
  }

  return (
    <>
      <Seg value={s.algo} options={ALGOS} onChange={(algo) => choose({ algo })} disabled={!!busy} />
      <p className="hint">{algo.blurb}</p>
      <div className="field-row">
        <span>Quality</span>
        <Seg<Quality>
          value={s.quality}
          options={[
            { id: 'fast', label: 'Fast' },
            { id: 'balanced', label: 'Balanced' },
            { id: 'best', label: 'Best' },
          ]}
          onChange={(quality) => set({ quality })}
          disabled={!!busy}
        />
      </div>
      {s.algo === 'bm3d' && (
        <div
          className="field-row"
          title="Measured: thresholds each frequency by the noise spectrum measured from the image — best for correlated noise (JPEG, heavy processing). White: one level for all frequencies — keeps a little more fine texture on clean sensor noise."
        >
          <span>Noise</span>
          <Seg<NoiseModel>
            value={s.model}
            options={[
              { id: 'measured', label: 'Measured spectrum' },
              { id: 'white', label: 'White' },
            ]}
            onChange={(model) => choose({ model })}
            disabled={!!busy}
          />
        </div>
      )}
      {spatial && (
        <div className="field-row" title="Tile size and parallel threads: lower uses less memory, higher is faster">
          <span>Memory</span>
          <Seg<MemoryMode>
            value={s.memory}
            options={[
              { id: 'low', label: 'Low' },
              { id: 'balanced', label: 'Balanced' },
              { id: 'high', label: 'High' },
            ]}
            onChange={(memory) => set({ memory })}
            disabled={!!busy}
          />
        </div>
      )}
      <label className="slider" title="Multiplies the estimated noise level (defaults are calibrated on real camera noise)">
        <span className="slider-label">Strength</span>
        <span className="slider-value">
          {s.strength.toFixed(2)}×{plan ? ` · σ ${plan.sigma[0].toFixed(1)}` : ''}
        </span>
        <input
          type="range"
          min={Math.log(0.25)}
          max={Math.log(4)}
          step="any"
          value={Math.log(s.strength)}
          onChange={(e) => set({ strength: Math.exp(Number(e.target.value)) })}
        />
      </label>
      {spatial && (
        <label className="slider" title="Extra multiplier on colour noise, which is often much stronger than luminance noise">
          <span className="slider-label">Chroma</span>
          <span className="slider-value">
            {s.chroma.toFixed(2)}×{plan ? ` · σ ${Math.max(plan.sigma[1], plan.sigma[2]).toFixed(1)}` : ''}
          </span>
          <input
            type="range"
            min={Math.log(0.5)}
            max={Math.log(4)}
            step="any"
            value={Math.log(s.chroma)}
            onChange={(e) => set({ chroma: Math.exp(Number(e.target.value)) })}
          />
        </label>
      )}
      {n && (
        <p className="hint mono">
          Estimated noise: luma {n.luma.toFixed(1)}
          {spatial && ` · chroma ${Math.max(n.opponent[1], n.opponent[2]).toFixed(1)}`}
        </p>
      )}
      {plan && !busy && (
        <p className="hint mono">
          ≈ {fmtSeconds(plan.seconds)} · {formatBytes(plan.peakBytes)} peak
          {spatial && ` · ${plan.tiles} tile${plan.tiles === 1 ? '' : 's'} · ${plan.threads} thread${plan.threads === 1 ? '' : 's'}`}
        </p>
      )}
      {busy ? (
        <div className="progress-row">
          <div className="progress">
            <div style={{ width: `${(100 * busy.done) / Math.max(1, busy.total)}%` }} />
          </div>
          <span className="mono">
            {busy.done}/{busy.total}
          </span>
          <button type="button" className="icon-button" onClick={cancel} title="Cancel">
            <X size={14} aria-hidden />
          </button>
        </div>
      ) : (
        <div className="row">
          {spatial && (
            <Button
              icon={ScanEye}
              disabled={!ready || !info.region}
              onClick={() => run('region')}
              title={
                info.region
                  ? `Preview on the picked region${regionPlan ? ` (≈ ${fmtSeconds(regionPlan.seconds)})` : ''}`
                  : 'Pick a region on the image to preview quickly'
              }
            >
              Preview
            </Button>
          )}
          <Button variant="primary" icon={WandSparkles} disabled={!ready || info.switching} onClick={() => run('full')}>
            {spatial ? 'Denoise image' : 'Apply filter'}
          </Button>
        </div>
      )}
      {info.denoisePreview && !busy && (
        <div className="preview-note">
          <span>
            Previewing <b>{info.denoisePreview}</b> in the region. Hold C to compare.
          </span>
          <button type="button" className="icon-button" onClick={discardPreview} title="Discard preview">
            <X size={13} aria-hidden />
          </button>
        </div>
      )}
      {spatial && !info.region && (
        <p className="hint">
          <Check size={11} aria-hidden /> Tip: pick a region on the image to preview settings in a fraction of the time.
        </p>
      )}
    </>
  )
}
