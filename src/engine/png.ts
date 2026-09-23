// Minimal PNG encoder. The browser's canvas encoders cap the canvas area
// (about 16.7 MP in Safari), so full-resolution export has to bypass them.
// Deflate comes from CompressionStream('deflate'), which emits the zlib
// stream PNG's IDAT expects.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  const tag = new TextEncoder().encode(type)
  out.set(tag, 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32([tag, data]))
  return out
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

export async function encodePng(rgba: Uint8ClampedArray, w: number, h: number): Promise<Blob> {
  let hasAlpha = false
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) {
      hasAlpha = true
      break
    }
  }
  const ch = hasAlpha ? 4 : 3
  const stride = w * ch
  const raw = new Uint8Array((stride + 1) * h)
  let prev = new Uint8Array(stride)
  let cur = new Uint8Array(stride)
  for (let y = 0; y < h; y++) {
    const s = y * w * 4
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < ch; c++) cur[x * ch + c] = rgba[s + 4 * x + c]
    }
    const o = y * (stride + 1)
    raw[o] = 4 // Paeth
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0
      const c = i >= ch ? prev[i - ch] : 0
      raw[o + 1 + i] = cur[i] - paeth(a, prev[i], c)
    }
    const t = prev
    prev = cur
    cur = t
  }

  const ihdr = new Uint8Array(13)
  const v = new DataView(ihdr.buffer)
  v.setUint32(0, w)
  v.setUint32(4, h)
  ihdr[8] = 8 // bit depth
  ihdr[9] = hasAlpha ? 6 : 2 // RGBA : RGB
  const parts: BlobPart[] = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)]

  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value.length) parts.push(chunk('IDAT', value))
  }
  parts.push(chunk('IEND', new Uint8Array(0)))
  return new Blob(parts, { type: 'image/png' })
}
