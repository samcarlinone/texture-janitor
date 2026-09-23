/** A labelled range input with its current value shown on the right. */
export function Slider(p: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  /** Move on a log scale (value, min and max stay in linear units; min must be > 0). */
  log?: boolean
  display: string
  onChange: (v: number) => void
  title?: string
}) {
  const to = p.log ? Math.log : (v: number) => v
  return (
    <label className="slider" title={p.title}>
      <span className="slider-label">{p.label}</span>
      <span className="slider-value">{p.display}</span>
      <input
        type="range"
        min={to(p.min)}
        max={to(p.max)}
        step={p.step ?? 'any'}
        value={to(p.value)}
        onChange={(e) => {
          const v = Number(e.target.value)
          p.onChange(p.log ? Math.exp(v) : v)
        }}
      />
    </label>
  )
}
