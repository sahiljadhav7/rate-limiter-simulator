import { describe, expect, it } from 'vitest'
import { createBackend, type BackendSpec } from '../src/sim/backend.ts'
import { createEventQueue } from '../src/sim/event-queue.ts'
import { createRandomStream } from '../src/sim/rng.ts'

/** A Backend whose every service takes exactly `meanMs` (cv 0 makes no draw). */
function fixed(spec: Omit<BackendSpec, 'cv'>) {
  return createBackend<string>({ ...spec, cv: 0 }, createRandomStream(1))
}

describe('createBackend', () => {
  it('starts up to `slots` jobs, queues the rest in order, and sheds when the queue is full', () => {
    const backend = fixed({ slots: 2, queueLimit: 1, meanMs: 50 })
    expect(backend.submit('a', 0)).toEqual({ kind: 'started', endsAtMs: 50 })
    expect(backend.submit('b', 10)).toEqual({ kind: 'started', endsAtMs: 60 })
    expect(backend.submit('c', 20)).toEqual({ kind: 'queued' })
    expect(backend.submit('d', 30)).toEqual({ kind: 'shed' })
    expect(backend.busySlots()).toBe(2)
    expect(backend.queueDepth()).toBe(1)
  })

  it('frees the slot when a job finishes and starts the next queued job, oldest first', () => {
    const backend = fixed({ slots: 1, queueLimit: 2, meanMs: 50 })
    backend.submit('a', 0)
    backend.submit('b', 10)
    backend.submit('c', 20)
    expect(backend.finish('a', 50)).toEqual({ job: 'b', endsAtMs: 100 })
    expect(backend.finish('b', 100)).toEqual({ job: 'c', endsAtMs: 150 })
    expect(backend.finish('c', 150)).toBeNull()
    expect(backend.busySlots()).toBe(0)
    expect(backend.submit('d', 170)).toEqual({ kind: 'started', endsAtMs: 220 })
  })

  it('measures busy slot time, one slot for 1 ms counting 1', () => {
    const backend = fixed({ slots: 2, queueLimit: 0, meanMs: 50 })
    expect(backend.measure(0).busySlotMs).toBe(0)
    backend.submit('a', 0)
    backend.submit('b', 20)
    expect(backend.measure(30)).toEqual({ busySlotMs: 40, wastedSlotMs: 0 })
    backend.finish('a', 50)
    backend.finish('b', 70)
    // a: 0 to 50, b: 20 to 70, then idle.
    expect(backend.measure(100).busySlotMs).toBe(100)
  })

  it('keeps an abandoned job in its slot or queue place and counts its service after that as wasted', () => {
    const backend = fixed({ slots: 1, queueLimit: 1, meanMs: 50 })
    backend.submit('a', 0)
    backend.submit('b', 10)
    backend.abandon('a', 30)
    backend.abandon('b', 40)
    // Abandoning frees nothing: the slot is still busy and the queue still full.
    expect(backend.busySlots()).toBe(1)
    expect(backend.submit('c', 45)).toEqual({ kind: 'shed' })
    expect(backend.measure(45)).toEqual({ busySlotMs: 45, wastedSlotMs: 15 })
    expect(backend.finish('a', 50)).toEqual({ job: 'b', endsAtMs: 100 })
    backend.finish('b', 100)
    backend.submit('d', 100)
    backend.finish('d', 150)
    // a wasted 30 to 50, b (queued when abandoned) all of 50 to 100; d is not abandoned.
    expect(backend.measure(200)).toEqual({ busySlotMs: 150, wastedSlotMs: 70 })
  })

  it('ignores abandoning a job it does not hold', () => {
    const backend = fixed({ slots: 1, queueLimit: 0, meanMs: 50 })
    backend.submit('a', 0)
    backend.finish('a', 50)
    backend.abandon('a', 60)
    backend.submit('a', 70)
    backend.finish('a', 120)
    expect(backend.measure(120)).toEqual({ busySlotMs: 100, wastedSlotMs: 0 })
  })

  describe('service times', () => {
    /** `n` service times, served one after another on a single slot. */
    function serviceTimes(meanMs: number, cv: number, seed: number, n: number): number[] {
      const backend = createBackend<number>(
        { slots: 1, queueLimit: 0, meanMs, cv },
        createRandomStream(seed),
      )
      const times: number[] = []
      let t = 0
      for (let i = 0; i < n; i++) {
        const result = backend.submit(i, t)
        if (result.kind !== 'started') throw new Error('the slot should be free')
        times.push(result.endsAtMs - t)
        backend.finish(i, result.endsAtMs)
        t = result.endsAtMs
      }
      return times
    }

    it('takes exactly the mean when cv is 0', () => {
      expect(new Set(serviceTimes(40, 0, 1, 1000))).toEqual(new Set([40]))
    })

    // 200,000 draws. The mean's standard error is cv / sqrt(n) of the mean: 0.45 percent at
    // cv 2, so a 2 percent band is 4.5 standard errors. The sample cv's standard error is about
    // sqrt((6 cv^2 + 2) / n) / 2 (gamma's excess kurtosis is 6 cv^2): 0.57 percent at cv 2, so
    // a 3 percent band is 5.3 standard errors. Smaller cvs are tighter still.
    it.each([0.5, 1, 2])('has the asked mean and cv (cv %s)', (cv) => {
      const times = serviceTimes(80, cv, 2026, 200_000)
      const mean = times.reduce((sum, x) => sum + x, 0) / times.length
      const variance = times.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (times.length - 1)
      expect(Math.abs(mean / 80 - 1)).toBeLessThan(0.02)
      expect(Math.abs(Math.sqrt(variance) / mean / cv - 1)).toBeLessThan(0.03)
      // Gamma is never negative. At cv 2 some draws are so small that added to a clock of
      // millions of ms they round to a length of 0, so 0 is allowed.
      expect(times.every((x) => x >= 0 && Number.isFinite(x))).toBe(true)
    })

    it('draws the same times from the same seed', () => {
      expect(serviceTimes(80, 1, 7, 50)).toEqual(serviceTimes(80, 1, 7, 50))
    })
  })

  it.each([
    { slots: 1, queueLimit: 0 },
    { slots: 3, queueLimit: 5 },
    { slots: 8, queueLimit: 40 },
  ])(
    'never has more than $slots busy slots or $queueLimit queued, and utilization stays at most 1',
    ({ slots, queueLimit }) => {
      const spec = { slots, queueLimit, meanMs: 30, cv: 1.5 }
      const backend = createBackend<number>(spec, createRandomStream(11))
      const ops = createRandomStream(12)
      const ends = createEventQueue<number>()
      const held: number[] = []
      let t = 0
      for (let job = 0; job < 20_000; job++) {
        // Arrivals about twice as fast as the Backend can serve, so it overloads and sheds.
        t += (ops.next() * 30) / slots
        while ((ends.peek()?.timeMs ?? Infinity) <= t) {
          const end = ends.pop()
          if (end === undefined) break
          const next = backend.finish(end.event, end.timeMs)
          if (next !== null) ends.push(next.endsAtMs, next.job)
        }
        const result = backend.submit(job, t)
        if (result.kind === 'started') ends.push(result.endsAtMs, job)
        if (result.kind !== 'shed') held.push(job)
        if (ops.next() < 0.2) backend.abandon(held[Math.floor(ops.next() * held.length)] ?? 0, t)
        expect(backend.busySlots()).toBeLessThanOrEqual(slots)
        expect(backend.queueDepth()).toBeLessThanOrEqual(queueLimit)
      }
      const { busySlotMs, wastedSlotMs } = backend.measure(t)
      expect(busySlotMs).toBeLessThanOrEqual(slots * t)
      // Busy most of the time, so the bound is really tested. With no queue it is an Erlang loss
      // system at offered load 2, busy 2/3 of the time (0.72 measured on this fixed seed);
      // with a queue it is above 0.95. 0.6 is a floor, not a tolerance band.
      expect(busySlotMs).toBeGreaterThan(0.6 * slots * t)
      expect(wastedSlotMs).toBeGreaterThan(0)
      expect(wastedSlotMs).toBeLessThanOrEqual(busySlotMs)
    },
  )

  it.each<[string, Partial<BackendSpec>]>([
    ['no slots', { slots: 0 }],
    ['fractional slots', { slots: 1.5 }],
    ['a negative queue limit', { queueLimit: -1 }],
    ['an infinite queue limit', { queueLimit: Infinity }],
    ['a mean of 0', { meanMs: 0 }],
    ['a NaN mean', { meanMs: NaN }],
    ['a negative cv', { cv: -0.1 }],
  ])('throws a RangeError for %s', (_, change) => {
    const spec = { slots: 2, queueLimit: 4, meanMs: 50, cv: 1, ...change }
    expect(() => createBackend(spec, createRandomStream(1))).toThrow(RangeError)
  })

  it('throws if time goes backwards', () => {
    const backend = fixed({ slots: 1, queueLimit: 1, meanMs: 50 })
    backend.submit('a', 20)
    expect(() => backend.submit('b', 10)).toThrow(RangeError)
  })

  it('throws if a job is finished that is not in service', () => {
    const backend = fixed({ slots: 1, queueLimit: 1, meanMs: 50 })
    backend.submit('a', 0)
    backend.submit('b', 0)
    expect(() => backend.finish('b', 50)).toThrow(RangeError)
  })
})
