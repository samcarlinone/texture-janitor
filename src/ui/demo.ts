/**
 * Procedural test scene: a landscape with textured regions, corrupted by
 * two periodic noise patterns (a scan-line-like diagonal and a fine
 * vertical interference). The noise shows up as crisp symmetric spikes in
 * the spectrum, ready to be notched out.
 *
 * 1600×1067 is deliberately awkward: 1067 = 11·97, so the column transform
 * runs through Bluestein's algorithm.
 */
const W = 1600
const H = 1067

const ridge = (x: number, a: number[], base: number) =>
  base + a[0] * Math.sin(x * 0.004 + 1.3) + a[1] * Math.sin(x * 0.011 + 0.4) + a[2] * Math.sin(x * 0.031 + 2.1)
const NEAR_RIDGE = { amp: [60, 25, 8], base: H * 0.52 }
const SUN = { x: W * 0.68, y: H * 0.3, r: H * 0.09 }
/** The disc of fine concentric rings. */
const DISC = { x: W * 0.2, y: H * 0.28, r: H * 0.14 }

interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * Areas of the demo that aren't plain sky, as boxes: the ringed disc, the
 * sun, and everything from the highest mountain peak down. The tutorial
 * uses these to check that a picked region is sky.
 */
export const DEMO_NOT_SKY: { label: string; rect: Rect }[] = (() => {
  let peak = H
  for (let x = 0; x < W; x++) peak = Math.min(peak, ridge(x, NEAR_RIDGE.amp, NEAR_RIDGE.base))
  const box = (c: { x: number; y: number; r: number }) => ({ x0: c.x - c.r, y0: c.y - c.r, x1: c.x + c.r, y1: c.y + c.r })
  return [
    { label: 'the ringed disc', rect: box(DISC) },
    { label: 'the sun', rect: box(SUN) },
    { label: 'the mountains', rect: { x0: 0, y0: Math.floor(peak), x1: W, y1: H } },
  ]
})()

/**
 * Share of a region (image pixels) that falls inside any DEMO_NOT_SKY box,
 * and which boxes it touches. Sampled on a grid, so overlapping boxes
 * count once.
 */
export function demoOffSky(r: Rect): { fraction: number; parts: string[] } {
  const N = 64
  const touched = new Set<string>()
  let off = 0
  for (let j = 0; j < N; j++) {
    const y = r.y0 + ((j + 0.5) * (r.y1 - r.y0)) / N
    for (let i = 0; i < N; i++) {
      const x = r.x0 + ((i + 0.5) * (r.x1 - r.x0)) / N
      const hit = DEMO_NOT_SKY.find((b) => x >= b.rect.x0 && x < b.rect.x1 && y >= b.rect.y0 && y < b.rect.y1)
      if (hit) {
        off++
        touched.add(hit.label)
      }
    }
  }
  return { fraction: off / (N * N), parts: DEMO_NOT_SKY.map((b) => b.label).filter((l) => touched.has(l)) }
}

export function makeDemo(): { data: Uint8ClampedArray<ArrayBuffer>; w: number; h: number } {
  const w = W
  const h = H
  const data = new Uint8ClampedArray(w * h * 4)
  let seed = 12345
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
  const { x: sunX, y: sunY, r: sunR } = SUN

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = y / h
      // Sky gradient.
      let r = 40 + 200 * t
      let g = 70 + 110 * t
      let b = 150 - 20 * t
      // Sun with a soft halo.
      const ds = Math.hypot(x - sunX, y - sunY)
      const glow = Math.exp(-((ds / (sunR * 3)) ** 2))
      r += 90 * glow
      g += 60 * glow
      b += 20 * glow
      if (ds < sunR) {
        const e = Math.min(1, (sunR - ds) / 2)
        r += (255 - r) * e
        g += (236 - g) * e
        b += (190 - b) * e
      }
      // Two mountain ranges.
      if (y > ridge(x, NEAR_RIDGE.amp, NEAR_RIDGE.base)) {
        const shade = 0.55 + 0.25 * Math.sin(x * 0.02 + y * 0.01)
        r = 70 * shade
        g = 80 * shade
        b = 110 * shade
      }
      if (y > ridge(x + 900, [40, 30, 12], h * 0.64)) {
        r = 40
        g = 55
        b = 45
      }
      // Foreground: brick wall (left) and woven fabric (right).
      if (y > h * 0.76) {
        if (x < w * 0.5) {
          const bh = 22
          const bw = 56
          const row = Math.floor(y / bh)
          const off = row % 2 ? bw / 2 : 0
          const mortar = y % bh < 3 || (x + off) % bw < 3
          const tone = 0.85 + 0.3 * Math.sin(row * 12.9898 + Math.floor((x + off) / bw) * 78.233)
          r = mortar ? 190 : 150 * tone
          g = mortar ? 180 : 70 * tone
          b = mortar ? 170 : 50 * tone
        } else {
          const wv = Math.sin(x * 0.9) * Math.sin(y * 0.9)
          const warp = Math.sin((x + y) * 0.35)
          r = 120 + 50 * wv + 20 * warp
          g = 90 + 40 * wv
          b = 150 + 30 * wv - 20 * warp
        }
      }
      // A disc with fine concentric rings (a chirp: all orientations).
      const dc = Math.hypot(x - DISC.x, y - DISC.y)
      if (dc < DISC.r) {
        const v = 128 + 100 * Math.cos(dc * dc * 0.004)
        r = g = b = v
      }
      // Periodic corruption with whole-number cycles across the frame → crisp spikes.
      const n1 = 22 * Math.sin((2 * Math.PI * (97 * x)) / w + (2 * Math.PI * (61 * y)) / h)
      const n2 = 14 * Math.sin((2 * Math.PI * (331 * x)) / w)
      const grain = (rand() - 0.5) * 10
      const o = 4 * (y * w + x)
      data[o] = r + n1 + n2 + grain
      data[o + 1] = g + n1 + n2 + grain
      data[o + 2] = b + n1 + n2 + grain
      data[o + 3] = 255
    }
  }
  return { data, w, h }
}
