/**
 * Orthonormal opponent colour space, as used by CBM3D:
 *   Y = (R + G + B) / √3,  U = (R − B) / √2,  V = (R − 2G + B) / √6.
 * Because the transform is orthonormal, white noise of standard deviation σ
 * in RGB stays σ in every channel, and luminance / chroma can be filtered
 * with different strengths.
 */
const A = 1 / Math.sqrt(3)
const B = 1 / Math.sqrt(2)
const C = 1 / Math.sqrt(6)

export type Planes = [Float32Array, Float32Array, Float32Array]

/** RGBA8 → [Y, U, V] planes. */
export function toOpponent(rgba: ArrayLike<number>, n: number): Planes {
  const y = new Float32Array(n)
  const u = new Float32Array(n)
  const v = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const r = rgba[4 * i]
    const g = rgba[4 * i + 1]
    const b = rgba[4 * i + 2]
    y[i] = (r + g + b) * A
    u[i] = (r - b) * B
    v[i] = (r - 2 * g + b) * C
  }
  return [y, u, v]
}

/** [Y, U, V] planes → RGB bytes of `out` (alpha untouched), over the n pixels. */
export function fromOpponent(p: Planes, out: Uint8ClampedArray, n: number): void {
  const [y, u, v] = p
  for (let i = 0; i < n; i++) {
    const ya = y[i] * A
    out[4 * i] = ya + u[i] * B + v[i] * C
    out[4 * i + 1] = ya - 2 * v[i] * C
    out[4 * i + 2] = ya - u[i] * B + v[i] * C
  }
}
