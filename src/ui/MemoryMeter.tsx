import { MemoryStick } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Engine, MemoryPart } from '../engine/engine.ts'
import { formatBytes } from './format.ts'

const COLORS = ['#5ee0ff', '#a78bfa', '#4ade80', '#fbbf24', '#ff6040']

interface MemoryBreakdown {
  bytes: number
  attribution: { scope?: string }[]
}
type MeasureMemory = () => Promise<{ bytes: number; breakdown: MemoryBreakdown[] }>

/** Device memory as the browser reports it (Chrome rounds and caps at 8 GB). */
const deviceBytes = ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4) * 1024 ** 3

/**
 * App memory by category, from the engine's own accounting (shared buffers,
 * checkpoints, display tiles, history, running denoise). Where the browser
 * supports it, a whole-page measurement including worker heaps is shown too.
 *
 * Chrome attributes a SharedArrayBuffer to every context that maps it, so
 * the raw measurement counts the shared spectra once per worker (and
 * sometimes the page). Every context entry at least as large as the shared
 * buffers holds a copy; all but one are subtracted. The browser figure
 * covers JavaScript memory only: GPU-backed image tiles are not included.
 */
export function MemoryMeter({ engine }: { engine: Engine }) {
  const [parts, setParts] = useState<MemoryPart[]>([])
  const [measured, setMeasured] = useState<number | null>(null)
  const [hovered, setHovered] = useState(0)

  useEffect(() => {
    const tick = () => setParts(engine.memory())
    tick()
    // Engine events (load, edits, checkpoints, denoise) update immediately;
    // the interval catches anything that changes between them.
    const off = engine.subscribe(tick)
    const id = setInterval(tick, 1000)
    return () => {
      off()
      clearInterval(id)
    }
  }, [engine])

  useEffect(() => {
    const measure = (performance as Performance & { measureUserAgentSpecificMemory?: MeasureMemory })
      .measureUserAgentSpecificMemory
    if (!measure || !globalThis.crossOriginIsolated) return
    let alive = true
    const run = () =>
      measure
        .call(performance)
        .then((r) => {
          const shared = engine.memory()[0]?.bytes ?? 0
          const copies = shared > 0 ? r.breakdown.filter((b) => b.bytes >= shared).length : 0
          if (alive) setMeasured(Math.max(0, r.bytes - Math.max(0, copies - 1) * shared))
        })
        .catch(() => {})
    void run()
    const id = setInterval(run, 20_000)
    return () => {
      alive = false
      clearInterval(id)
    }
    // `hovered` re-runs the measurement when the breakdown is opened.
  }, [engine, hovered])

  const total = parts.reduce((n, p) => n + p.bytes, 0)
  const scale = Math.max(deviceBytes, total, measured ?? 0)

  return (
    <div className="memory" tabIndex={0} onMouseEnter={() => setHovered((n) => n + 1)}>
      <MemoryStick size={13} aria-hidden />
      <div className="memory-bar" role="meter" aria-valuenow={total} aria-valuemin={0} aria-valuemax={scale}>
        {parts.map((p, i) => (
          <div key={p.label} style={{ width: `${(100 * p.bytes) / scale}%`, background: COLORS[i % COLORS.length] }} />
        ))}
      </div>
      <span className="memory-total">{formatBytes(total)}</span>
      <div className="memory-pop" role="tooltip">
        <div className="memory-pop-title">Memory</div>
        {parts.map((p, i) => (
          <div key={p.label} className="memory-row">
            <i style={{ background: COLORS[i % COLORS.length] }} />
            <span>{p.label}</span>
            <b>{formatBytes(p.bytes)}</b>
          </div>
        ))}
        <div className="memory-row total">
          <i />
          <span>App total</span>
          <b>{formatBytes(total)}</b>
        </div>
        {measured !== null && (
          <div className="memory-row">
            <i />
            <span>Browser-measured JS heap (page + workers, shared memory once)</span>
            <b>{formatBytes(measured)}</b>
          </div>
        )}
        <p>
          Bar scale: {formatBytes(deviceBytes)} device memory, as reported by the browser. The browser measurement
          waits for garbage collection, so it can lag by several seconds.
        </p>
      </div>
    </div>
  )
}
