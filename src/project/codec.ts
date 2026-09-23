/**
 * Encoding for project records. Everything is deflated with the browser's
 * CompressionStream; images are Paeth-filtered per row first (as PNG does),
 * which roughly halves their size again for photographic content.
 */

export async function deflate(data: Uint8Array): Promise<Uint8Array> {
  return pipe(data, new CompressionStream('deflate'))
}

export async function inflate(data: Uint8Array): Promise<Uint8Array> {
  return pipe(data, new DecompressionStream('deflate'))
}

async function pipe(data: Uint8Array, t: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(t)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** RGBA8 image → Paeth-filtered bytes (same length). */
export function filterPixels(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const out = new Uint8Array(rgba.length)
  const stride = w * 4
  for (let y = 0; y < h; y++) {
    const o = y * stride
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? rgba[o + i - 4] : 0
      const b = y > 0 ? rgba[o + i - stride] : 0
      const c = i >= 4 && y > 0 ? rgba[o + i - stride - 4] : 0
      out[o + i] = rgba[o + i] - paeth(a, b, c)
    }
  }
  return out
}

/** Inverse of filterPixels. */
export function unfilterPixels(f: Uint8Array, w: number, h: number): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(f.length)
  const stride = w * 4
  for (let y = 0; y < h; y++) {
    const o = y * stride
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? out[o + i - 4] : 0
      const b = y > 0 ? out[o + i - stride] : 0
      const c = i >= 4 && y > 0 ? out[o + i - stride - 4] : 0
      out[o + i] = (f[o + i] + paeth(a, b, c)) & 255
    }
  }
  return out
}

export interface TileData {
  re: Float32Array
  im: Float32Array
}

/** Tiles (key → re/im of equal length) → [u32 count][u32 len][u32 keys…][f32 re…][f32 im…]. */
export function packTiles(tiles: Map<number, TileData>): Uint8Array {
  const keys = [...tiles.keys()]
  const len = keys.length ? tiles.get(keys[0])!.re.length : 0
  const buf = new ArrayBuffer(8 + 4 * keys.length + 8 * len * keys.length)
  const u32 = new Uint32Array(buf, 0, 2 + keys.length)
  u32[0] = keys.length
  u32[1] = len
  u32.set(keys, 2)
  const f32 = new Float32Array(buf, 8 + 4 * keys.length)
  keys.forEach((k, i) => {
    const t = tiles.get(k)!
    f32.set(t.re, 2 * i * len)
    f32.set(t.im, (2 * i + 1) * len)
  })
  return new Uint8Array(buf)
}

export function unpackTiles(bytes: Uint8Array): Map<number, TileData> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const head = new Uint32Array(buf, 0, 2)
  const n = head[0]
  const len = head[1]
  const keys = new Uint32Array(buf, 8, n)
  const f32 = new Float32Array(buf, 8 + 4 * n)
  const out = new Map<number, TileData>()
  for (let i = 0; i < n; i++) {
    out.set(keys[i], { re: f32.slice(2 * i * len, (2 * i + 1) * len), im: f32.slice((2 * i + 1) * len, (2 * i + 2) * len) })
  }
  return out
}
