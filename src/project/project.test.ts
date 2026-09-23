// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflate, filterPixels, inflate, packTiles, unfilterPixels, unpackTiles } from './codec.ts'
import { FOOTER_SIZE, RecordKind, checkHeader, footer, frameRecord, parseFooter, HEADER } from './format.ts'

test('Paeth filter round-trips an RGBA image exactly', () => {
  const w = 37
  const h = 23
  const rgba = new Uint8ClampedArray(w * h * 4)
  let s = 7
  for (let i = 0; i < rgba.length; i++) {
    s = (s * 1103515245 + 12345) >>> 0
    rgba[i] = (i % 4 === 3 ? 255 : (Math.floor(i / 4) % w) * 3 + (s >>> 28))
  }
  const back = unfilterPixels(filterPixels(rgba, w, h), w, h)
  assert.deepEqual(Array.from(back), Array.from(rgba))
})

test('filtering makes smooth images much more compressible', async () => {
  const w = 256
  const h = 256
  const rgba = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = 4 * (y * w + x)
    rgba[i] = x
    rgba[i + 1] = y
    rgba[i + 2] = (x + y) >> 1
    rgba[i + 3] = 255
  }
  const raw = (await deflate(new Uint8Array(rgba.buffer))).length
  const filtered = (await deflate(filterPixels(rgba, w, h))).length
  assert.ok(filtered < raw / 3, `raw ${raw} vs filtered ${filtered}`)
})

test('deflate / inflate round trip', async () => {
  const data = new TextEncoder().encode('texture janitor '.repeat(1000))
  const z = await deflate(data)
  assert.ok(z.length < data.length / 10)
  assert.deepEqual(await inflate(z), data)
})

test('tile packing round trip', () => {
  const tiles = new Map([
    [5, { re: Float32Array.from([1, 2, 3, 4]), im: Float32Array.from([0, -1, 0.5, 0]) }],
    [900, { re: Float32Array.from([0, 0, 0, 1]), im: Float32Array.from([9, 8, 7, 6]) }],
  ])
  const back = unpackTiles(packTiles(tiles))
  assert.deepEqual([...back.keys()], [5, 900])
  for (const [k, t] of tiles) {
    assert.deepEqual(Array.from(back.get(k)!.re), Array.from(t.re))
    assert.deepEqual(Array.from(back.get(k)!.im), Array.from(t.im))
  }
  assert.equal(unpackTiles(packTiles(new Map())).size, 0)
})

test('record framing, header and footer', () => {
  const payload = Uint8Array.from([1, 2, 3])
  const f = frameRecord(RecordKind.Tiles, payload)
  assert.equal(f.bytes.length, 8 + 3)
  assert.deepEqual(Array.from(f.bytes.subarray(f.payloadOffset)), [1, 2, 3])
  // Offsets past 4 GiB survive the split 32-bit encoding.
  const ref = { off: 5 * 2 ** 32 + 123, len: 456 }
  const ft = footer(ref)
  assert.equal(ft.length, FOOTER_SIZE)
  assert.deepEqual(parseFooter(ft), ref)
  checkHeader(HEADER)
  assert.throws(() => checkHeader(new Uint8Array(8)))
  assert.throws(() => parseFooter(new Uint8Array(FOOTER_SIZE)))
})
