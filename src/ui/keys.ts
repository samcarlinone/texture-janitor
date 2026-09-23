/** Modifier-like keys held down, shared by both panes. */
export const held = {
  /** While held: show the active checkpoint's base, or the loaded image, instead of the result. */
  compare: null as 'checkpoint' | 'original' | null,
  /** Alt / Option is down (shows the image loupe). */
  alt: false,
}

const nav = globalThis.navigator as (Navigator & { userAgentData?: { platform: string } }) | undefined

/** macOS / iOS / iPadOS (which reports itself as a Mac): shortcuts use ⌘. The handlers accept ⌘ or Ctrl everywhere. */
export const isApple = /mac|iphone|ipad|ipod/i.test(nav?.userAgentData?.platform || nav?.platform || '')

/**
 * A shortcut label for this platform, from `Mod` (⌘ or Ctrl) and `Shift`
 * plus a key: shortcut('Shift+Mod+Z') is ⇧⌘Z on Apple, Ctrl+Shift+Z elsewhere.
 */
export function shortcut(keys: string): string {
  const parts = keys.split('+')
  const key = parts.pop()!
  const shift = parts.includes('Shift')
  const mod = parts.includes('Mod')
  if (isApple) return `${shift ? '⇧' : ''}${mod ? '⌘' : ''}${key}`
  return [mod && 'Ctrl', shift && 'Shift', key].filter(Boolean).join('+')
}
