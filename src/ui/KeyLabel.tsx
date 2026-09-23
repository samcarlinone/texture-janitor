import { ArrowBigUp, Command, type LucideIcon } from 'lucide-react'

/** Apple modifier glyphs drawn as icons: fonts render them inconsistently (tiny on iOS). */
const GLYPHS: Record<string, [LucideIcon, string]> = {
  '⌘': [Command, 'Command'],
  '⇧': [ArrowBigUp, 'Shift'],
}

/**
 * A formatted shortcut label (see shortcut() in keys.ts) with ⌘ and ⇧ as
 * icons and the rest as text spans. Renders siblings, for a kbd or dt to hold.
 */
export function KeyLabel({ label, size = 10 }: { label: string; size?: number }) {
  return label.split(/([⌘⇧])/).map((part, i) => {
    const glyph = GLYPHS[part]
    if (!glyph) return part && <span key={i}>{part}</span>
    const [Icon, name] = glyph
    return <Icon key={i} size={size} strokeWidth={2.25} role="img" aria-label={name} />
  })
}
