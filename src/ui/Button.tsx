import { LoaderCircle, type LucideIcon } from 'lucide-react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  /** Leading icon. */
  icon?: LucideIcon
  /** Replaces the icon while an action is running. */
  busy?: boolean
  /** Keyboard shortcut hint, shown after the label. */
  kbd?: string
  variant?: 'default' | 'primary'
  /** Toggled-on state (e.g. a mode that's waiting for input). */
  active?: boolean
  /** Full width, with the shortcut hint pushed to the right edge. */
  block?: boolean
  children?: ReactNode
}

/**
 * The standard action button. It sets its own typography, so it looks the
 * same wherever it's placed (including inside section headings).
 */
export function Button({ icon: Icon, busy, kbd, variant = 'default', active, block, className, children, ...rest }: ButtonProps) {
  const cls = ['btn', variant === 'primary' && 'btn-primary', active && 'btn-on', block && 'btn-block', className]
    .filter(Boolean)
    .join(' ')
  return (
    <button type="button" className={cls} aria-pressed={active} {...rest}>
      {busy ? <LoaderCircle size={14} className="spin" aria-hidden /> : Icon && <Icon size={14} aria-hidden />}
      {children !== undefined && <span className="btn-label">{children}</span>}
      {kbd && (
        <kbd>
          <span>{kbd}</span>
        </kbd>
      )}
    </button>
  )
}
