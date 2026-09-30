/**
 * A first-in, first-out queue for long runs. Taking from the front moves a head index instead
 * of shifting the array, and the array is compacted once more than half of it is taken, so
 * both ends cost O(1) on average and an hour-long run does not keep every item it ever held.
 */
export interface Fifo<T> {
  push(item: T): void
  /** The oldest item, or undefined when empty. */
  peek(): T | undefined
  /** Removes and returns the oldest item, or undefined when empty. */
  shift(): T | undefined
  size(): number
  /** The items, oldest first, as a new array. */
  toArray(): T[]
}

/** Compacting is skipped below this many taken items, where it would cost more than it saves. */
const COMPACT_AFTER = 1024

export function createFifo<T>(): Fifo<T> {
  let items: T[] = []
  let head = 0
  return {
    push(item) {
      items.push(item)
    },
    peek() {
      return head < items.length ? items[head] : undefined
    },
    shift() {
      if (head === items.length) return undefined
      const item = items[head++]
      if (head > COMPACT_AFTER && head * 2 > items.length) {
        items = items.slice(head)
        head = 0
      }
      return item
    },
    size() {
      return items.length - head
    },
    toArray() {
      return items.slice(head)
    },
  }
}
