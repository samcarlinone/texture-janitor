/** Read any browser-decodable image at full resolution, as straight RGBA8. */
export async function decodeImage(blob: Blob): Promise<{ data: Uint8ClampedArray<ArrayBuffer>; w: number; h: number }> {
  const bmp = await createImageBitmap(blob, {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'default',
    imageOrientation: 'from-image',
  })
  const { width: w, height: h } = bmp
  const data = new Uint8ClampedArray(w * h * 4)
  // Read in tiles: a single canvas can't exceed ~16.7 MP in some browsers.
  const T = 2048
  const canvas = new OffscreenCanvas(Math.min(T, w), Math.min(T, h))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  for (let ty = 0; ty < h; ty += T) {
    for (let tx = 0; tx < w; tx += T) {
      const tw = Math.min(T, w - tx)
      const th = Math.min(T, h - ty)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(bmp, tx, ty, tw, th, 0, 0, tw, th)
      const px = ctx.getImageData(0, 0, tw, th).data
      for (let y = 0; y < th; y++) {
        data.set(px.subarray(y * tw * 4, (y + 1) * tw * 4), ((ty + y) * w + tx) * 4)
      }
    }
  }
  bmp.close()
  return { data, w, h }
}

export interface Tile {
  x: number
  y: number
  w: number
  h: number
  bmp: ImageBitmap
}

export interface TileSet {
  w: number
  h: number
  tiles: Tile[]
}

const TILE = 2048

/** GPU-backed bitmap tiles of an RGBA image, drawable at any zoom without canvas size limits. */
export async function makeTiles(pixels: Uint8ClampedArray<ArrayBuffer>, w: number, h: number): Promise<TileSet> {
  const img = new ImageData(pixels, w, h)
  const jobs: Promise<Tile>[] = []
  for (let y = 0; y < h; y += TILE) {
    for (let x = 0; x < w; x += TILE) {
      const tw = Math.min(TILE, w - x)
      const th = Math.min(TILE, h - y)
      jobs.push(createImageBitmap(img, x, y, tw, th).then((bmp) => ({ x, y, w: tw, h: th, bmp })))
    }
  }
  return { w, h, tiles: await Promise.all(jobs) }
}

export function closeTiles(t: TileSet | null): void {
  t?.tiles.forEach((tile) => tile.bmp.close())
}
