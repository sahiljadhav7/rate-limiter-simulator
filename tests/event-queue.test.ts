import { describe, expect, it } from 'vitest'
import { createEventQueue, type ScheduledEvent } from '../src/sim/event-queue.ts'
import { createRandomStream } from '../src/sim/rng.ts'

describe('createEventQueue', () => {
  it('is empty at the start: pop and peek return undefined and size is 0', () => {
    const queue = createEventQueue<string>()
    expect(queue.size()).toBe(0)
    expect(queue.peek()).toBeUndefined()
    expect(queue.pop()).toBeUndefined()
  })
  it('returns a single pushed event from peek, then from pop, then is empty again', () => {
    const queue = createEventQueue<string>()
    queue.push(40, 'arrival')
    expect(queue.size()).toBe(1)
    expect(queue.peek()).toEqual({ timeMs: 40, seq: 0, event: 'arrival' })
    expect(queue.size()).toBe(1)
    expect(queue.pop()).toEqual({ timeMs: 40, seq: 0, event: 'arrival' })
    expect(queue.size()).toBe(0)
    expect(queue.pop()).toBeUndefined()
  })

  it('pops the earliest time first, whatever order events were pushed in', () => {
    const queue = createEventQueue<string>()
    for (const [timeMs, name] of [
      [30, 'c'],
      [10, 'a'],
      [50, 'e'],
      [20, 'b'],
      [40, 'd'],
    ] as const) {
      queue.push(timeMs, name)
    }
    expect(queue.peek()?.event).toBe('a')
    const popped: string[] = []
    for (let entry = queue.pop(); entry !== undefined; entry = queue.pop()) popped.push(entry.event)
    expect(popped).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
  // Equal timestamps are common (a burst of arrivals, a timeout at the same ms as a service
  // end). Popping them in the order they were pushed is what makes a run replay identically.
  it('pops events with equal times in the order they were pushed', () => {
    const queue = createEventQueue<number>()
    queue.push(5, -1)
    for (let i = 0; i < 12; i++) queue.push(100, i)
    queue.push(1, -2)
    const popped: number[] = []
    for (let entry = queue.pop(); entry !== undefined; entry = queue.pop()) popped.push(entry.event)
    expect(popped).toEqual([-2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })
  // NaN compares false with everything, so it would sit anywhere in the heap and break the
  // ordering silently; an infinite time would never be reached. Both are caller bugs.
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects pushing an event at %s and leaves the queue unchanged',
    (timeMs) => {
      const queue = createEventQueue<string>()
      queue.push(10, 'kept')
      expect(() => queue.push(timeMs, 'bad')).toThrow(RangeError)
      expect(queue.size()).toBe(1)
      expect(queue.pop()).toEqual({ timeMs: 10, seq: 0, event: 'kept' })
    },
  )
})

/**
 * Random interleavings of pushes and pops, checked against a plain array. The engine pushes
 * and pops as it goes (a service end schedules the next event), so pops are mixed in with
 * pushes rather than all coming at the end. Times come from a range of only 20 whole
 * numbers, so most pushes share a timestamp with something already queued.
 */
describe('createEventQueue property: random pushes and pops', () => {
  const SEEDS = Array.from({ length: 50 }, (_, i) => 1000 + i)
  const OPERATIONS = 2_000
  const TIME_RANGE = 20
  const PUSH_CHANCE = 0.55

  /**
   * The reference: entries in push order. Its pop takes the first entry with the smallest
   * time, which is exactly what a stable sort by time would put first.
   */
  function referencePop(entries: ScheduledEvent<number>[]): ScheduledEvent<number> | undefined {
    let best = -1
    let bestTime = Number.POSITIVE_INFINITY
    entries.forEach((entry, i) => {
      if (entry.timeMs < bestTime) {
        best = i
        bestTime = entry.timeMs
      }
    })
    return best === -1 ? undefined : entries.splice(best, 1)[0]
  }

  it(`matches a stable-sorted reference for ${SEEDS.length} seeds x ${OPERATIONS} operations`, () => {
    for (const seed of SEEDS) {
      const rng = createRandomStream(seed)
      const queue = createEventQueue<number>()
      const reference: ScheduledEvent<number>[] = []
      let pushes = 0
      let pops = 0
      let lastPopped: ScheduledEvent<number> | undefined
      // The earliest time pushed since the last pop: a pop may go back to it, but no earlier.
      let earliestPushSincePop = Number.POSITIVE_INFINITY

      // After the random operations, drain the queue so every pushed event is checked.
      for (let op = 0; op < OPERATIONS || reference.length > 0; op++) {
        const where = `seed ${seed}, operation ${op}`
        if (op < OPERATIONS && rng.next() < PUSH_CHANCE) {
          const timeMs = Math.floor(rng.next() * TIME_RANGE)
          queue.push(timeMs, pushes)
          reference.push({ timeMs, seq: pushes, event: pushes })
          pushes++
          earliestPushSincePop = Math.min(earliestPushSincePop, timeMs)
        } else {
          const expected = referencePop(reference)
          expect(queue.peek(), `${where}: peek`).toEqual(expected)
          const actual = queue.pop()
          expect(actual, `${where}: pop`).toEqual(expected)
          if (actual !== undefined) {
            pops++
            if (lastPopped !== undefined) {
              const floor = Math.min(lastPopped.timeMs, earliestPushSincePop)
              expect(actual.timeMs, `${where}: popped time went backwards`).toBeGreaterThanOrEqual(
                floor,
              )
              if (actual.timeMs === lastPopped.timeMs) {
                expect(actual.seq, `${where}: equal times out of insertion order`).toBeGreaterThan(
                  lastPopped.seq,
                )
              }
            }
            lastPopped = actual
            earliestPushSincePop = Number.POSITIVE_INFINITY
          }
        }
        expect(queue.size(), `${where}: size`).toBe(reference.length)
      }
      // Guards against a generator bug that makes the run trivially pass.
      expect(pops, `seed ${seed}: pops`).toBe(pushes)
      expect(pushes, `seed ${seed}: pushes`).toBeGreaterThan(OPERATIONS / 3)
    }
  })
})
