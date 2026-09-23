/**
 * The .tj project file: an append-only log of compressed records.
 *
 *   "TJPROJ01"                       8-byte header
 *   record*                          [u32 kind][u32 length][payload]
 *   manifest record                  JSON describing the project, with byte
 *                                    ranges of every record it uses
 *   footer                           "TJEND001" [u32 manifest offset lo][hi]
 *                                    [u32 manifest length][u32 0]  (24 bytes)
 *
 * A save appends only records that aren't in the file yet, then a new
 * manifest and footer; readers use the last footer. Records no longer
 * referenced are dead space until the file is compacted.
 */

export const HEADER = new TextEncoder().encode('TJPROJ01')
const FOOTER_MAGIC = new TextEncoder().encode('TJEND001')
export const FOOTER_SIZE = 24
const RECORD_HEAD = 8

export const RecordKind = { Pixels: 1, Tiles: 2, Manifest: 3 } as const
export type RecordKind = (typeof RecordKind)[keyof typeof RecordKind]

/** A record's payload location in the file. */
export interface Ref {
  off: number
  len: number
}

/** Frame a payload as a record. Returns the bytes and where the payload sits relative to the record start. */
export function frameRecord(kind: RecordKind, payload: Uint8Array): { bytes: Uint8Array; payloadOffset: number } {
  const bytes = new Uint8Array(RECORD_HEAD + payload.length)
  const v = new DataView(bytes.buffer)
  v.setUint32(0, kind, true)
  v.setUint32(4, payload.length, true)
  bytes.set(payload, RECORD_HEAD)
  return { bytes, payloadOffset: RECORD_HEAD }
}

export function footer(manifest: Ref): Uint8Array {
  const b = new Uint8Array(FOOTER_SIZE)
  const v = new DataView(b.buffer)
  b.set(FOOTER_MAGIC, 0)
  v.setUint32(8, manifest.off % 2 ** 32, true)
  v.setUint32(12, Math.floor(manifest.off / 2 ** 32), true)
  v.setUint32(16, manifest.len, true)
  return b
}

/** Locate the manifest from the last 24 bytes of a file. */
export function parseFooter(b: Uint8Array): Ref {
  if (b.length !== FOOTER_SIZE || !FOOTER_MAGIC.every((c, i) => b[i] === c)) {
    throw new Error('Not a Texture Janitor project (missing footer)')
  }
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  return { off: v.getUint32(8, true) + v.getUint32(12, true) * 2 ** 32, len: v.getUint32(16, true) }
}

export function checkHeader(b: Uint8Array): void {
  if (!HEADER.every((c, i) => b[i] === c)) throw new Error('Not a Texture Janitor project')
}
