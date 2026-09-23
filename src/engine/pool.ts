import type { Reply, Task } from './protocol.ts'

interface Job {
  task: Task
  transfer: Transferable[]
  priority: number
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

interface Slot {
  worker: Worker
  busy: boolean
}

/**
 * Fixed set of workers pulling from one priority queue. Higher priority
 * runs first; equal priorities run in FIFO order.
 */
export class WorkerPool {
  readonly size: number
  private readonly slots: Slot[] = []
  private readonly queue: Job[] = []
  private readonly pending = new Map<number, Job>()
  private nextId = 1

  constructor(size: number) {
    this.size = size
    for (let i = 0; i < size; i++) {
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: `fft-${i}` })
      const slot: Slot = { worker, busy: false }
      worker.onmessage = (e: MessageEvent<Reply>) => this.onReply(slot, e.data)
      worker.onerror = (e) => {
        console.error('worker error', e)
      }
      this.slots.push(slot)
    }
  }

  run<T>(task: Task, priority = 0, transfer: Transferable[] = []): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: Job = { task, transfer, priority, resolve: resolve as (v: unknown) => void, reject }
      let i = this.queue.length
      while (i > 0 && this.queue[i - 1].priority < priority) i--
      this.queue.splice(i, 0, job)
      this.pump()
    })
  }

  runAll<T>(tasks: Task[], priority = 0): Promise<T[]> {
    return Promise.all(tasks.map((t) => this.run<T>(t, priority)))
  }

  /** Send a task to every worker directly (e.g. init), bypassing the queue. */
  broadcast(task: Task): Promise<unknown[]> {
    return Promise.all(
      this.slots.map(
        (slot) =>
          new Promise((resolve, reject) => {
            const id = this.nextId++
            this.pending.set(id, { task, transfer: [], priority: Infinity, resolve, reject })
            slot.worker.postMessage({ id, task })
          }),
      ),
    )
  }

  terminate(): void {
    for (const s of this.slots) s.worker.terminate()
    for (const j of this.queue) j.reject(new Error('pool terminated'))
    for (const j of this.pending.values()) j.reject(new Error('pool terminated'))
    this.queue.length = 0
    this.pending.clear()
  }

  private pump(): void {
    for (const slot of this.slots) {
      if (slot.busy) continue
      const job = this.queue.shift()
      if (!job) return
      const id = this.nextId++
      slot.busy = true
      this.pending.set(id, job)
      slot.worker.postMessage({ id, task: job.task }, job.transfer)
    }
  }

  private onReply(slot: Slot, r: Reply): void {
    const job = this.pending.get(r.id)
    this.pending.delete(r.id)
    if (job && job.priority !== Infinity) slot.busy = false
    if (job) {
      if (r.ok) job.resolve(r.result)
      else job.reject(new Error(r.error))
    }
    this.pump()
  }
}

/** Split [0, n) into k contiguous ranges of near-equal size (empty ones dropped). */
export function ranges(n: number, k: number, align = 1): [number, number][] {
  const out: [number, number][] = []
  let prev = 0
  for (let i = 1; i <= k; i++) {
    let e = i === k ? n : Math.round((n * i) / k / align) * align
    e = Math.min(n, Math.max(prev, e))
    if (e > prev) out.push([prev, e])
    prev = e
  }
  return out
}
