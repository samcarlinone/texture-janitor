/**
 * Extend a w×h plane by (l, t, r, b) pixels using mirror reflection
 * (without repeating the edge pixel), so filters can read past the image
 * edge.
 */
export function padReflect(p: Float32Array, w: number, h: number, l: number, t: number, r: number, b: number): Float32Array {
  const pw = w + l + r
  const ph = h + t + b
  const out = new Float32Array(pw * ph)
  const refl = (i: number, n: number) => {
    if (n === 1) return 0
    const period = 2 * (n - 1)
    let k = ((i % period) + period) % period
    if (k >= n) k = period - k
    return k
  }
  const xs = Int32Array.from({ length: pw }, (_, x) => refl(x - l, w))
  for (let y = 0; y < ph; y++) {
    const sy = refl(y - t, h) * w
    const o = y * pw
    for (let x = 0; x < pw; x++) out[o + x] = p[sy + xs[x]]
  }
  return out
}

/** Copy the (x0, y0, w, h) window out of a plane of width pw. */
export function crop(p: Float32Array, pw: number, x0: number, y0: number, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) out.set(p.subarray((y0 + y) * pw + x0, (y0 + y) * pw + x0 + w), y * w)
  return out
}
