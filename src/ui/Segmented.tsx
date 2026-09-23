import type { LucideIcon } from 'lucide-react'

export interface SegmentedOption<T extends string> {
  id: T
  label: string
  icon?: LucideIcon
  title?: string
  className?: string
}

/** A row of mutually exclusive options (a radio group styled as joined buttons). */
export function Segmented<T extends string>(p: {
  value: T
  options: SegmentedOption<T>[]
  onChange: (v: T) => void
  disabled?: boolean
  className?: string
  'aria-label'?: string
}) {
  return (
    <div className={`segmented ${p.className ?? ''}`} role="radiogroup" aria-label={p['aria-label']}>
      {p.options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={o.id === p.value}
          disabled={p.disabled}
          title={o.title}
          className={`${o.className ?? ''} ${o.id === p.value ? 'on' : ''}`}
          onClick={() => p.onChange(o.id)}
        >
          {o.icon && <o.icon size={14} aria-hidden />}
          <span className="text-trim">{o.label}</span>
        </button>
      ))}
    </div>
  )
}
