/**
 * The priority queue that orders simulated events: a binary min-heap keyed by time, then by
 * sequence number. The engine defines its own event types and stores them as the payload.
 */
import { checkNumber } from './checks.ts'

/** An event waiting in the queue, with the time it happens and its place in push order. */
export interface ScheduledEvent<T> {
  /** When the event happens, in ms of simulated time. */
  readonly timeMs: number
  /**
   * The push order: 0 for the first event pushed to this queue, then 1, 2 and so on. Events
   * at the same time pop in this order, which is what makes a run replay identically.
   */
  readonly seq: number
  /** The engine's own event data. */
  readonly event: T
}

/** Simulated events ordered by time, with ties broken by push order. */
export interface EventQueue<T> {
  /**
   * Adds `event` at `timeMs` and returns the queued entry with its sequence number. Throws a
   * RangeError if `timeMs` is NaN or infinite, leaving the queue unchanged: NaN compares
   * false with everything, so it would break the ordering silently.
   */
  push(timeMs: number, event: T): ScheduledEvent<T>
  /** Removes and returns the earliest event, or undefined when the queue is empty. */
  pop(): ScheduledEvent<T> | undefined
  /** Returns the event `pop` would return, without removing it. */
  peek(): ScheduledEvent<T> | undefined
  /** How many events are waiting. */
  size(): number
}

/** True if `a` should pop before `b`: earlier time first, then earlier push. */
function before<T>(a: ScheduledEvent<T>, b: ScheduledEvent<T>): boolean {
  return a.timeMs < b.timeMs || (a.timeMs === b.timeMs && a.seq < b.seq)
}

/** Creates an empty event queue. Push and pop both take O(log n) time. */
export function createEventQueue<T>(): EventQueue<T> {
  const heap: ScheduledEvent<T>[] = []
  let nextSeq = 0

  /** The entry at heap index `i`. Callers only pass indices inside the heap. */
  function at(i: number): ScheduledEvent<T> {
    const entry = heap[i]
    if (entry === undefined) throw new RangeError(`Event queue index ${i} is out of range`)
    return entry
  }

  /** Moves `entry` up from index `start` until its parent pops before it. */
  function siftUp(start: number, entry: ScheduledEvent<T>): void {
    let i = start
    while (i > 0) {
      const parentIndex = (i - 1) >> 1
      const parent = at(parentIndex)
      if (!before(entry, parent)) break
      heap[i] = parent
      i = parentIndex
    }
    heap[i] = entry
  }

  /** Moves `entry` down from index `start` until both children pop after it. */
  function siftDown(start: number, entry: ScheduledEvent<T>): void {
    let i = start
    for (;;) {
      const leftIndex = 2 * i + 1
      if (leftIndex >= heap.length) break
      const rightIndex = leftIndex + 1
      let childIndex = leftIndex
      let child = at(leftIndex)
      if (rightIndex < heap.length) {
        const right = at(rightIndex)
        if (before(right, child)) {
          childIndex = rightIndex
          child = right
        }
      }
      if (!before(child, entry)) break
      heap[i] = child
      i = childIndex
    }
    heap[i] = entry
  }

  return {
    push(timeMs, event) {
      checkNumber(timeMs, () => true, 'Event time must be a finite number of ms')
      const entry: ScheduledEvent<T> = { timeMs, seq: nextSeq++, event }
      heap.push(entry)
      siftUp(heap.length - 1, entry)
      return entry
    },
    pop() {
      const top = heap[0]
      const last = heap.pop()
      if (top === undefined || last === undefined) return undefined
      if (heap.length > 0) siftDown(0, last)
      return top
    },
    peek() {
      return heap[0]
    },
    size() {
      return heap.length
    },
  }
}
