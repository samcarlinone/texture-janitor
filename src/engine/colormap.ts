import { QMAX } from './layout.ts'

export type ColormapName = 'inferno' | 'viridis' | 'gray' | 'ice'

const STOPS: Record<ColormapName, [number, number, number][]> = {
  gray: [
    [0, 0, 0],
    [255, 255, 255],
  ],
  inferno: [
    [0, 0, 4],
    [31, 12, 72],
    [85, 15, 109],
    [136, 34, 106],
    [186, 54, 85],
    [227, 89, 51],
    [249, 140, 10],
    [249, 201, 50],
    [252, 255, 164],
  ],
  viridis: [
    [68, 1, 84],
    [72, 40, 120],
    [62, 74, 137],
    [49, 104, 142],
    [38, 130, 142],
    [31, 158, 137],
    [53, 183, 121],
    [109, 205, 89],
    [180, 222, 44],
    [253, 231, 37],
  ],
  ice: [
    [4, 6, 19],
    [22, 35, 80],
    [36, 86, 145],
    [64, 142, 184],
    [132, 196, 214],
    [235, 248, 250],
  ],
}

/** RGB for t in [0,1]. */
export function sample(name: ColormapName, t: number): [number, number, number] {
  const s = STOPS[name]
  const f = Math.min(1, Math.max(0, t)) * (s.length - 1)
  const i = Math.min(s.length - 2, Math.floor(f))
  const u = f - i
  const a = s[i]
  const b = s[i + 1]
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]
}

export const pack = (r: number, g: number, b: number, a = 255): number =>
  ((a << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0

/**
 * Lookup from 12-bit display value to packed ABGR color, with black/white
 * points (fractions of the value range) and a gamma.
 */
export function makeLut(name: ColormapName, black: number, white: number, gamma: number): Uint32Array {
  const lut = new Uint32Array(QMAX + 1)
  const span = Math.max(1e-4, white - black)
  for (let q = 0; q <= QMAX; q++) {
    const t = Math.min(1, Math.max(0, (q / QMAX - black) / span)) ** gamma
    const [r, g, b] = sample(name, t)
    lut[q] = pack(r, g, b)
  }
  return lut
}
