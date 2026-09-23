/** Modifier-like keys held down, shared by both panes. */
export const held = {
  /** While held: show the active checkpoint's base, or the loaded image, instead of the result. */
  compare: null as 'checkpoint' | 'original' | null,
  /** Alt / Option is down (shows the image loupe). */
  alt: false,
}
