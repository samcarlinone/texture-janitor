// Per-browser UI preferences. Storage can be unavailable (private mode,
// blocked site data): reads then return null and writes are dropped, so the
// preference just lasts for this visit.

export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // See above.
  }
}
