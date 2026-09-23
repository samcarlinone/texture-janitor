/**
 * Find isolated bright peaks ("spikes") in a centered log-magnitude
 * spectrum image: the signature of periodic texture.
 *
 * A bin's score is its value minus the mean of the ring around it (a 7×7
 * window without the central 3×3), so broad low-frequency energy and the
 * border-induced axis cross score low while point-like peaks score high.
 * Bins near DC are ignored, and non-maximum suppression keeps peaks at
 * least `minDist` apart. Both members of each ±k pair are returned.
 *
 * Peaks must also reach `relative` × the strongest peak's score, so faint
 * harmonics aren't marked alongside a dominant pattern (they show up once
 * the dominant one has been removed).
 */
export function findSpikes(
  v: Uint16Array,
  w: number,
  h: number,
  count: number,
  minScore: number,
  relative = 0.45,
): { x: number; y: number; score: number }[] {
  const cx = w >> 1
  const cy = h >> 1
  const dcR = Math.max(4, 0.03 * Math.min(w, h))
  const cands: { x: number; y: number; score: number }[] = []
  for (let y = 3; y < h - 3; y++) {
    for (let x = 3; x < w - 3; x++) {
      if (Math.hypot(x - cx, y - cy) < dcR) continue
      const c = v[y * w + x]
      let ring = 0
      let max3 = 0
      for (let j = -3; j <= 3; j++) {
        for (let i = -3; i <= 3; i++) {
          const q = v[(y + j) * w + x + i]
          if (Math.abs(i) <= 1 && Math.abs(j) <= 1) {
            if (q > max3) max3 = q
          } else {
            ring += q
          }
        }
      }
      if (c < max3) continue // not a local maximum
      const score = c - ring / 40
      if (score >= minScore) cands.push({ x, y, score })
    }
  }
  cands.sort((a, b) => b.score - a.score)
  const floor = (cands[0]?.score ?? 0) * relative
  const minDist = Math.max(6, 0.02 * Math.min(w, h))
  const out: typeof cands = []
  for (const p of cands) {
    if (p.score < floor) break
    if (out.every((q) => Math.hypot(q.x - p.x, q.y - p.y) >= minDist)) out.push(p)
    if (out.length >= count) break
  }
  return out
}
