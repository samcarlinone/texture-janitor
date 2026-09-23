import type { Engine, LoadedCheckpoint, LoadedProject, ProjectSnapshot } from '../engine/engine.ts'
import { TS, type EditField, type Snap, type UndoEntry } from '../engine/edits.ts'
import type { Rect, SpectrumChannel } from '../engine/layout.ts'
import { deflate, inflate, packTiles, unpackTiles } from './codec.ts'
import { FOOTER_SIZE, HEADER, RecordKind, checkHeader, footer, frameRecord, parseFooter, type Ref } from './format.ts'
import { idbDelete, idbGet, idbSet } from './idb.ts'

/** Autosave interval. */
const AUTOSAVE_MS = 30_000
/** After this many incremental patches, a checkpoint's working edits are rewritten in full. */
const MAX_PATCHES = 12
/** Compact (rewrite) the file once dead space passes this share of it, and this many bytes. */
const COMPACT_SHARE = 0.5
const COMPACT_MIN = 32 * 1024 * 1024
const HANDLE_KEY = 'project-handle'
const FILE_TYPES = [{ description: 'Texture Janitor project', accept: { 'application/x-texture-janitor': ['.tj'] } }]

interface ManifestEntry {
  id: number
  rev: number
  key: string
}

interface ManifestCheckpoint {
  id: number
  label: string
  w: number
  h: number
  pixels: string
  sub: { rect: Rect; canvasW: number; canvasH: number; base: string } | null
  mode: 'shared' | 'rgb'
  undo: ManifestEntry[]
  redo: ManifestEntry[]
  /** Tile records for the working edits: a full set first, then patches, applied in order. */
  working: string[]
}

interface Manifest {
  app: 'texture-janitor'
  format: 1
  name: string
  activeId: number
  spectrumChannel: SpectrumChannel
  saveSeq: number
  checkpoints: ManifestCheckpoint[]
  /** Byte range of every record the project uses. */
  objects: Record<string, Ref>
}

interface PendingRecord {
  key: string
  kind: RecordKind
  bytes: Promise<Uint8Array>
}

export interface ProjectStatus {
  /** The File System Access API is available (save to a chosen file, autosave). */
  supported: boolean
  fileName: string | null
  autosave: boolean
  saving: boolean
  lastSaved: number | null
  error: string | null
  /** Changes since the last save (or since the image was opened). */
  unsaved: boolean
  /** A file from an earlier visit that can be reopened (needs a click to regain permission). */
  reopenable: string | null
}

const identityTile = (): Snap => {
  const re = new Float32Array(TS * TS).fill(1)
  return { re, im: new Float32Array(TS * TS) }
}

const entryKey = (cp: number, e: { id: number; rev: number }) => `h:${cp}:${e.id}:${e.rev}`

async function readRef(file: Blob, ref: Ref): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(ref.off, ref.off + ref.len).arrayBuffer())
}

/**
 * Saving and opening .tj projects.
 *
 * A save appends only what the file doesn't have yet: a checkpoint's image
 * is written once; history entries are keyed by id and revision (undo/redo
 * swap their contents); working edits go as patches of the tiles changed
 * since the last save. Then a new manifest and footer. With the File System
 * Access API the chosen file is reused and autosaved; otherwise Save
 * downloads a complete file.
 */
export class ProjectStore {
  private readonly engine: Engine
  private handle: FileSystemFileHandle | null = null
  /** Records present in the attached file. */
  private written = new Map<string, Ref>()
  /** Working-edit tile records per checkpoint, as in the attached file. */
  private chains = new Map<number, string[]>()
  private fileSize = 0
  private saveSeq = 0
  /** engine.changeSerial as of the last save / load. */
  private savedSerial = 0
  /** engine.loadGeneration the store last saw; a change means a new image was opened. */
  private generation = 0
  private reopenHandle: FileSystemFileHandle | null = null
  private timer = 0
  private status: ProjectStatus = {
    supported: typeof window !== 'undefined' && !!window.showSaveFilePicker,
    fileName: null,
    autosave: true,
    saving: false,
    lastSaved: null,
    error: null,
    unsaved: false,
    reopenable: null,
  }
  private readonly listeners = new Set<() => void>()
  /** Dead-space threshold (bytes) before a save compacts the file; tunable, e.g. for tests. */
  compactMin = COMPACT_MIN

  private unsubscribe: (() => void) | null = null

  constructor(engine: Engine) {
    this.engine = engine
    this.generation = engine.loadGeneration
    this.savedSerial = engine.changeSerial
  }

  /** Begin watching the engine and autosaving (call from an effect; pair with dispose). */
  start(): void {
    this.unsubscribe = this.engine.subscribe(() => this.onEngineChange())
    this.timer = window.setInterval(() => void this.autosaveTick(), AUTOSAVE_MS)
    void this.loadRememberedHandle()
  }

  dispose(): void {
    clearInterval(this.timer)
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getStatus = (): ProjectStatus => this.status

  private set(patch: Partial<ProjectStatus>): void {
    this.status = { ...this.status, ...patch }
    this.listeners.forEach((f) => f())
  }

  /** Is work at risk: an image is open and it isn't autosaving to a file. */
  get notSaving(): boolean {
    const s = this.status
    return this.engine.getInfo().status === 'ready' && !(s.fileName && s.autosave && !s.error)
  }

  private onEngineChange(): void {
    const gen = this.engine.loadGeneration
    if (gen !== this.generation) {
      // A new image was opened (not via openProject): it isn't the attached project.
      this.generation = gen
      this.detach()
      this.savedSerial = this.engine.changeSerial
    }
    const unsaved = this.engine.getInfo().status === 'ready' && this.engine.changeSerial !== this.savedSerial
    if (unsaved !== this.status.unsaved) this.set({ unsaved })
  }

  private detach(): void {
    this.handle = null
    this.written.clear()
    this.chains.clear()
    this.fileSize = 0
    this.saveSeq = 0
    this.set({ fileName: null, lastSaved: null, error: null })
  }

  setAutosave(on: boolean): void {
    this.set({ autosave: on })
  }

  // ---- saving ------------------------------------------------------------------

  /** Save: to the attached file, or pick one (FS Access), or download a copy. */
  async save(): Promise<void> {
    if (!this.handle && this.status.supported) return this.saveAs()
    await this.write()
  }

  /** Choose a new file and save everything to it. */
  async saveAs(): Promise<void> {
    if (!window.showSaveFilePicker) return this.write()
    const snap = this.engine.projectSnapshot()
    if (!snap) return
    let handle: FileSystemFileHandle
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: `${snap.name.replace(/\.[^.]+$/, '') || 'project'}.tj`,
        types: FILE_TYPES,
        id: 'texture-janitor-project',
      })
    } catch {
      return // cancelled
    }
    await this.attach(handle, false)
    await this.write()
  }

  /** Attach a file handle (e.g. an OPFS file in tests). `existing`: it already holds this project. */
  async attach(handle: FileSystemFileHandle, existing: boolean): Promise<void> {
    this.handle = handle
    if (!existing) {
      this.written.clear()
      this.chains.clear()
      this.fileSize = 0
    }
    this.set({ fileName: handle.name, error: null, reopenable: null })
    this.reopenHandle = null
    try {
      // Remember user-chosen files only. Origin-private (OPFS) handles aren't
      // useful to reopen, and reading one back from IndexedDB crashes some
      // Chrome builds (seen in Chrome 153).
      const opfs = await navigator.storage?.getDirectory?.()
      const inOpfs = opfs ? await opfs.resolve(handle).catch(() => null) : null
      if (!inOpfs) await idbSet(HANDLE_KEY, handle)
    } catch {
      // Remembering the file is a convenience only.
    }
  }

  private async autosaveTick(): Promise<void> {
    const s = this.status
    if (!this.handle || !s.autosave || s.saving || !s.unsaved || this.engine.busy) return
    await this.write()
  }

  /** Write the project: incrementally to the attached file, or as a full download. */
  private async write(): Promise<void> {
    if (this.status.saving) return
    const snap = this.engine.projectSnapshot()
    if (!snap || this.engine.busy) return
    const serial = this.engine.changeSerial
    const full = !this.handle
    const pending: PendingRecord[] = []
    const need = (key: string, kind: RecordKind, bytes: () => Promise<Uint8Array>) => {
      if ((full || !this.written.has(key)) && !pending.some((p) => p.key === key)) pending.push({ key, kind, bytes: bytes() })
    }
    const taken: { edits: EditField; keys: number[] | 'all' }[] = []
    const chains = new Map<number, string[]>()
    const seq = ++this.saveSeq
    this.set({ saving: true, error: null })
    try {
      const checkpoints = snap.checkpoints.map((cp): ManifestCheckpoint => {
        const pixels = `px:${cp.id}`
        need(pixels, RecordKind.Pixels, () => this.engine.packPixels(cp.pixels, cp.w, cp.h))
        let sub: ManifestCheckpoint['sub'] = null
        if (cp.sub) {
          const base = `base:${cp.id}`
          const s = cp.sub
          need(base, RecordKind.Pixels, () => this.engine.packPixels(s.base, s.canvasW, s.canvasH))
          sub = { rect: s.rect, canvasW: s.canvasW, canvasH: s.canvasH, base }
        }
        const edits = cp.edits
        const entries = (list: readonly UndoEntry[]) =>
          list.map((e) => {
            const key = entryKey(cp.id, e)
            // packTiles copies now: undo/redo swap tile contents in place.
            const packed = packTiles(e.tiles)
            need(key, RecordKind.Tiles, () => deflate(packed))
            return { id: e.id, rev: e.rev, key }
          })
        const undo = edits ? entries(edits.history.undo) : []
        const redo = edits ? entries(edits.history.redo) : []
        chains.set(cp.id, this.workingChain(cp, seq, full, need, taken))
        return { id: cp.id, label: cp.label, w: cp.w, h: cp.h, pixels, sub, mode: edits?.mode ?? 'shared', undo, redo, working: chains.get(cp.id)! }
      })
      const manifest: Manifest = {
        app: 'texture-janitor',
        format: 1,
        name: snap.name,
        activeId: snap.activeId,
        spectrumChannel: snap.spectrumChannel,
        saveSeq: seq,
        checkpoints,
        objects: {},
      }
      const encoded = await Promise.all(pending.map(async (p) => ({ ...p, data: await p.bytes })))
      if (this.handle) await this.writeToFile(this.handle, manifest, encoded)
      else await this.download(manifest, encoded)
      this.chains = chains
      this.savedSerial = serial
      this.set({ saving: false, lastSaved: Date.now(), unsaved: this.engine.changeSerial !== serial })
    } catch (e) {
      // Put the changed tiles back so the next save retries them.
      for (const t of taken) t.edits.restoreDirty(t.keys)
      console.error(e)
      this.set({ saving: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  /**
   * Record keys for a checkpoint's working edits: the existing chain plus a
   * patch of changed tiles, or a fresh full set (first save, a wholesale
   * change, or a long chain).
   */
  private workingChain(
    cp: ProjectSnapshot['checkpoints'][number],
    seq: number,
    full: boolean,
    need: (key: string, kind: RecordKind, bytes: () => Promise<Uint8Array>) => void,
    taken: { edits: EditField; keys: number[] | 'all' }[],
  ): string[] {
    const edits = cp.edits
    if (!edits) return []
    const dirty = edits.takeDirty()
    taken.push({ edits, keys: dirty })
    const chain = full ? [] : (this.chains.get(cp.id) ?? [])
    const tile = (k: number): Snap => (cp.active ? edits.readTile(k) : (cp.saved?.get(k) ?? identityTile()))
    const key = `w:${cp.id}:${seq}`
    if (dirty === 'all' || chain.length === 0 || chain.length >= MAX_PATCHES) {
      // All non-identity tiles.
      const tiles = cp.active ? edits.saveWorking() : new Map(cp.saved ?? [])
      if (tiles.size === 0 && chain.length === 0 && dirty !== 'all') return []
      const packed = packTiles(tiles)
      need(key, RecordKind.Tiles, () => deflate(packed))
      return [key]
    }
    if (dirty.length === 0) return chain
    const packed = packTiles(new Map(dirty.map((k) => [k, tile(k)])))
    need(key, RecordKind.Tiles, () => deflate(packed))
    return [...chain, key]
  }

  /** Append new records (or rewrite the file when compacting), then the manifest and footer. */
  private async writeToFile(
    handle: FileSystemFileHandle,
    manifest: Manifest,
    records: (PendingRecord & { data: Uint8Array })[],
  ): Promise<void> {
    if ((await handle.queryPermission?.({ mode: 'readwrite' })) === 'prompt') {
      // Autosave can't prompt; a manual save (a click) can.
      if ((await handle.requestPermission?.({ mode: 'readwrite' })) !== 'granted') throw new Error('No permission to write the project file')
    }
    const live = liveKeys(manifest)
    const kept = [...live].filter((k) => this.written.has(k) && !records.some((r) => r.key === k))
    const keptBytes = kept.reduce((n, k) => n + this.written.get(k)!.len + 8, 0)
    const dead = this.fileSize - keptBytes
    const compact = this.fileSize > 0 && dead > this.compactMin && dead > COMPACT_SHARE * this.fileSize
    const fresh = this.fileSize === 0 || compact
    // Compaction copies the live records' bytes from the current file; nothing is re-encoded.
    const old = compact ? await handle.getFile() : null
    const w = await handle.createWritable({ keepExistingData: !fresh })
    let pos = fresh ? 0 : this.fileSize
    const put = async (bytes: Uint8Array): Promise<number> => {
      await w.write({ type: 'write', position: pos, data: bytes as Uint8Array<ArrayBuffer> })
      const at = pos
      pos += bytes.length
      return at
    }
    const written = new Map<string, Ref>()
    try {
      if (fresh) await put(HEADER)
      for (const k of kept) {
        const ref = this.written.get(k)!
        if (old) {
          const at = await put(new Uint8Array(await old.slice(ref.off - 8, ref.off + ref.len).arrayBuffer()))
          written.set(k, { off: at + 8, len: ref.len })
        } else {
          written.set(k, ref)
        }
      }
      for (const r of records) {
        const f = frameRecord(r.kind, r.data)
        written.set(r.key, { off: (await put(f.bytes)) + f.payloadOffset, len: r.data.length })
      }
      manifest.objects = Object.fromEntries([...live].map((k) => [k, written.get(k)!]))
      const m = await deflate(new TextEncoder().encode(JSON.stringify(manifest)))
      const f = frameRecord(RecordKind.Manifest, m)
      const mref = { off: (await put(f.bytes)) + f.payloadOffset, len: m.length }
      await put(footer(mref))
      await w.truncate(pos)
      await w.close()
    } catch (e) {
      await w.abort().catch(() => {})
      throw e
    }
    this.written = written
    this.fileSize = pos
  }

  /** No File System Access: build a complete file and download it. */
  private async download(manifest: Manifest, records: (PendingRecord & { data: Uint8Array })[]): Promise<void> {
    const parts: BlobPart[] = [HEADER as Uint8Array<ArrayBuffer>]
    let pos = HEADER.length
    const objects: Record<string, Ref> = {}
    for (const r of records) {
      const f = frameRecord(r.kind, r.data)
      objects[r.key] = { off: pos + f.payloadOffset, len: r.data.length }
      parts.push(f.bytes as Uint8Array<ArrayBuffer>)
      pos += f.bytes.length
    }
    manifest.objects = objects
    const m = await deflate(new TextEncoder().encode(JSON.stringify(manifest)))
    const f = frameRecord(RecordKind.Manifest, m)
    parts.push(f.bytes as Uint8Array<ArrayBuffer>, footer({ off: pos + f.payloadOffset, len: m.length }) as Uint8Array<ArrayBuffer>)
    const url = URL.createObjectURL(new Blob(parts, { type: 'application/x-texture-janitor' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${manifest.name.replace(/\.[^.]+$/, '') || 'project'}.tj`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  // ---- opening -----------------------------------------------------------------

  /** Pick a .tj (FS Access) and open it, keeping the file attached for saving. */
  async openPicker(): Promise<boolean> {
    if (!window.showOpenFilePicker) return false
    let handle: FileSystemFileHandle
    try {
      ;[handle] = await window.showOpenFilePicker({ types: FILE_TYPES, id: 'texture-janitor-project' })
    } catch {
      return true // cancelled
    }
    await this.openHandle(handle)
    return true
  }

  /** Reopen the file remembered from an earlier visit (must run from a click). */
  async reopen(): Promise<void> {
    const h = this.reopenHandle
    if (!h) return
    if ((await h.requestPermission?.({ mode: 'readwrite' })) === 'denied') return
    let file: File
    try {
      file = await h.getFile()
    } catch {
      // Moved or deleted since the last visit.
      await this.forgetRemembered()
      this.set({ error: `Couldn't find ${h.name} any more` })
      return
    }
    await this.open(file, h)
  }

  async openHandle(handle: FileSystemFileHandle): Promise<void> {
    await this.open(await handle.getFile(), handle)
  }

  /** Open a project from a file; with a handle, keep saving to it. */
  async open(file: File, handle?: FileSystemFileHandle): Promise<void> {
    this.set({ error: null })
    try {
      checkHeader(new Uint8Array(await file.slice(0, HEADER.length).arrayBuffer()))
      const mref = parseFooter(new Uint8Array(await file.slice(file.size - FOOTER_SIZE).arrayBuffer()))
      const manifest = JSON.parse(new TextDecoder().decode(await inflate(await readRef(file, mref)))) as Manifest
      if (manifest.app !== 'texture-janitor' || manifest.format !== 1) throw new Error('Unsupported project file version')
      const obj = (k: string) => {
        const ref = manifest.objects[k]
        if (!ref) throw new Error(`Project file is missing ${k}`)
        return readRef(file, ref)
      }
      const entries = (list: ManifestEntry[]) =>
        Promise.all(
          list.map(async (e): Promise<UndoEntry> => {
            const tiles = unpackTiles(await inflate(await obj(e.key)))
            return { id: e.id, rev: e.rev, tiles, bytes: tiles.size * TS * TS * 8 }
          }),
        )
      const checkpoints = await Promise.all(
        manifest.checkpoints.map(async (c): Promise<LoadedCheckpoint> => {
          const working = new Map<number, Snap>()
          for (const k of c.working) {
            for (const [key, t] of unpackTiles(await inflate(await obj(k)))) {
              // Identity tiles in a patch mean "back to unedited".
              if (t.re.every((v) => v === 1) && t.im.every((v) => v === 0)) working.delete(key)
              else working.set(key, t)
            }
          }
          return {
            id: c.id,
            label: c.label,
            w: c.w,
            h: c.h,
            pixels: await this.engine.unpackPixels(await obj(c.pixels), c.w, c.h),
            sub: c.sub
              ? {
                  rect: c.sub.rect,
                  canvasW: c.sub.canvasW,
                  canvasH: c.sub.canvasH,
                  base: await this.engine.unpackPixels(await obj(c.sub.base), c.sub.canvasW, c.sub.canvasH),
                }
              : null,
            mode: c.mode,
            undo: await entries(c.undo),
            redo: await entries(c.redo),
            working,
          }
        }),
      )
      const project: LoadedProject = {
        name: manifest.name,
        activeId: manifest.activeId,
        spectrumChannel: manifest.spectrumChannel,
        checkpoints,
      }
      // Loading bumps the engine's load generation: expect it, so the file stays attached.
      this.generation = this.engine.loadGeneration + 1
      await this.engine.loadProject(project)
      this.generation = this.engine.loadGeneration
      if (handle) {
        await this.attach(handle, true)
        this.written = new Map(Object.entries(manifest.objects))
        this.chains = new Map(manifest.checkpoints.map((c) => [c.id, c.working]))
        this.fileSize = file.size
        this.saveSeq = manifest.saveSeq
      } else {
        this.detach()
      }
      this.savedSerial = this.engine.changeSerial
      this.set({ unsaved: false, lastSaved: handle ? file.lastModified : null })
    } catch (e) {
      console.error(e)
      this.set({ error: e instanceof Error ? e.message : String(e) })
    }
  }

  private async loadRememberedHandle(): Promise<void> {
    try {
      const h = await idbGet<FileSystemFileHandle>(HANDLE_KEY)
      if (h && !this.handle) {
        this.reopenHandle = h
        this.set({ reopenable: h.name })
      }
    } catch {
      // No IndexedDB (private mode): nothing to reopen.
    }
  }

  /** Forget the remembered file (e.g. after it was deleted). */
  async forgetRemembered(): Promise<void> {
    this.reopenHandle = null
    this.set({ reopenable: null })
    await idbDelete(HANDLE_KEY).catch(() => {})
  }
}

function liveKeys(m: Manifest): Set<string> {
  const keys = new Set<string>()
  for (const c of m.checkpoints) {
    keys.add(c.pixels)
    if (c.sub) keys.add(c.sub.base)
    for (const e of [...c.undo, ...c.redo]) keys.add(e.key)
    for (const k of c.working) keys.add(k)
  }
  return keys
}
