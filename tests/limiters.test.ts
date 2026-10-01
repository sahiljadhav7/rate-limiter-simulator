import { describe, expect, it } from 'vitest'
import { createEngine } from '../src/sim/engine.ts'
import {
  allowedPerSecond,
  limiterWindow,
  createLimiter,
  type FixedWindowSpec,
  type LimiterSpec,
  type SlidingCounterSpec,
  type TokenBucketSpec,
} from '../src/sim/limiter.ts'
import { createRandomStream, createStreams } from '../src/sim/rng.ts'
import { createTrafficSource } from '../src/sim/traffic-source.ts'

const allow = { kind: 'allow' }
const reject = (retryAfterMs: number) => ({ kind: 'reject', retryAfterMs })

describe('fixed window', () => {
  const spec: FixedWindowSpec = { algo: 'fixed-window', keyBy: 'global', limit: 3, windowMs: 1000 }

  it('allows the limit in a window, rejects the rest until the window resets, then allows again', () => {
    const limiter = createLimiter(spec)
    expect(limiter.decide('a', 0)).toEqual(allow)
    expect(limiter.decide('a', 400)).toEqual(allow)
    expect(limiter.decide('a', 999)).toEqual(allow)
    expect(limiter.decide('a', 999)).toEqual(reject(1))
    // Windows are [0, 1000), [1000, 2000), ...: 1000 is the first moment of the next one.
    expect(limiter.decide('a', 1000)).toEqual(allow)
    expect(limiter.decide('a', 1500)).toEqual(allow)
    expect(limiter.decide('a', 1600)).toEqual(allow)
    expect(limiter.decide('a', 1750)).toEqual(reject(250))
    expect(limiter.decide('a', 1999.5)).toEqual(reject(0.5))
  })

  it('shares one count between Clients when keyed globally', () => {
    const limiter = createLimiter(spec)
    expect(limiter.decide('a', 0)).toEqual(allow)
    expect(limiter.decide('b', 10)).toEqual(allow)
    expect(limiter.decide('c', 20)).toEqual(allow)
    expect(limiter.decide('d', 30)).toEqual(reject(970))
  })

  it('counts each Client on its own when keyed by client', () => {
    const limiter = createLimiter({ ...spec, keyBy: 'client' })
    for (const t of [0, 10, 20]) expect(limiter.decide('a', t)).toEqual(allow)
    expect(limiter.decide('a', 30)).toEqual(reject(970))
    // b has its own count, and a being full does not touch it.
    for (const t of [40, 50, 60]) expect(limiter.decide('b', t)).toEqual(allow)
    expect(limiter.decide('b', 70)).toEqual(reject(930))
    // a reset of the window resets every key.
    expect(limiter.decide('a', 1000)).toEqual(allow)
    expect(limiter.decide('b', 1000)).toEqual(allow)
  })

  it('forgets every count on reset', () => {
    const limiter = createLimiter({ ...spec, keyBy: 'client' })
    for (const t of [0, 10, 20]) limiter.decide('a', t)
    expect(limiter.decide('a', 30)).toEqual(reject(970))
    limiter.reset()
    expect(limiter.decide('a', 30)).toEqual(allow)
  })

  it.each(['global', 'client'] as const)(
    'allows exactly min(limit, Attempts) per key in every window, keyed %s',
    (keyBy) => {
      // Attempts come on average every 3.5 ms: about 71 per 250 ms window in all, and about 24
      // from each of the three Clients. Each limit is near its key's mean, so about half the
      // windows fill up and half do not.
      const windowMs = 250
      const limit = keyBy === 'global' ? 71 : 24
      const limiter = createLimiter({ algo: 'fixed-window', keyBy, limit, windowMs })
      const random = createRandomStream(5)
      const clients = ['a', 'b', 'c']
      /** Per key and window: Attempts seen, and those allowed. */
      const seen = new Map<string, { offered: number; allowed: number }>()
      /** Per key: when each allowed Attempt was decided. */
      const allowedAt = new Map<string, number[]>()
      let t = 0
      for (let i = 0; i < 20_000; i++) {
        t += random.next() * 7
        const clientId = clients[Math.floor(random.next() * clients.length)] ?? 'a'
        const key = keyBy === 'client' ? clientId : 'all'
        const cell = `${key}/${Math.floor(t / windowMs)}`
        const entry = seen.get(cell) ?? { offered: 0, allowed: 0 }
        seen.set(cell, entry)
        entry.offered++
        if (limiter.decide(clientId, t).kind === 'allow') {
          entry.allowed++
          const times = allowedAt.get(key) ?? []
          allowedAt.set(key, times)
          times.push(t)
        }
      }
      let full = 0
      for (const { offered, allowed } of seen.values()) {
        expect(allowed).toBe(Math.min(limit, offered))
        if (offered > limit) full++
      }
      // Across an edge a key can get up to 2 x limit within one window-length, never more:
      // the window-length ending at each allowed Attempt holds at most 2 x limit of them.
      let most = 0
      for (const times of allowedAt.values()) {
        let from = 0
        times.forEach((t, i) => {
          while ((times[from] ?? t) <= t - windowMs) from++
          most = Math.max(most, i - from + 1)
        })
      }
      expect(most).toBeLessThanOrEqual(2 * limit)
      expect(most).toBeGreaterThan(limit)
      // Both cases really happen: many windows were full, many were not.
      expect(full).toBeGreaterThan(seen.size / 4)
      expect(full).toBeLessThan((seen.size * 3) / 4)
    },
  )

  it('puts a time on the edge of a window in the window that starts there, when the length is not whole', () => {
    // 2100 / (100 / 3) rounds to just under 63, so dividing puts 2100 in window 62, which
    // ends at 63 x (100 / 3) = 2100: a Reject there would say "retry after 0 ms".
    const windowMs = 100 / 3
    for (let k = 1; k <= 3000; k++) {
      const limiter = createLimiter({ algo: 'fixed-window', keyBy: 'global', limit: 1, windowMs })
      const edge = k * windowMs
      limiter.decide('a', edge)
      const decision = limiter.decide('a', edge)
      expect(decision.kind).toBe('reject')
      if (decision.kind === 'reject') expect(decision.retryAfterMs).toBeGreaterThan(0)
    }
  })

  it.each<[string, Partial<FixedWindowSpec>]>([
    ['a limit of 0', { limit: 0 }],
    ['a fractional limit', { limit: 2.5 }],
    ['an infinite limit', { limit: Infinity }],
    ['a window of 0 ms', { windowMs: 0 }],
    ['a NaN window', { windowMs: NaN }],
    ['an infinite window', { windowMs: Infinity }],
  ])('throws a RangeError for %s', (_, change) => {
    expect(() => createLimiter({ ...spec, ...change })).toThrow(RangeError)
  })
})

describe('token bucket', () => {
  // 5 tokens, one back every 100 ms.
  const spec: TokenBucketSpec = {
    algo: 'token-bucket',
    keyBy: 'global',
    capacity: 5,
    refillPerSec: 10,
  }

  it('starts full, so it allows a burst up to its capacity at once, then rejects', () => {
    const limiter = createLimiter(spec)
    for (let i = 0; i < 5; i++) expect(limiter.decide('a', 1000)).toEqual(allow)
    expect(limiter.decide('a', 1000)).toEqual(reject(100))
  })

  it('refills at its rate from the last decision, never above its capacity', () => {
    const limiter = createLimiter(spec)
    for (let i = 0; i < 5; i++) limiter.decide('a', 0)
    // 250 ms later two whole tokens are back, and half of the third.
    expect(limiter.decide('a', 250)).toEqual(allow)
    expect(limiter.decide('a', 250)).toEqual(allow)
    expect(limiter.decide('a', 250)).toEqual(reject(50))
    expect(limiter.decide('a', 300)).toEqual(allow)
    expect(limiter.decide('a', 300)).toEqual(reject(100))
    // A long quiet spell fills the bucket, and no more: still a burst of 5.
    for (let i = 0; i < 5; i++) expect(limiter.decide('a', 60_000)).toEqual(allow)
    expect(limiter.decide('a', 60_000)).toEqual(reject(100))
  })

  it('shares one bucket between Clients when keyed globally, and has one per Client when keyed by client', () => {
    const global = createLimiter(spec)
    for (const clientId of ['a', 'b', 'c', 'd', 'e'])
      expect(global.decide(clientId, 0)).toEqual(allow)
    expect(global.decide('f', 0)).toEqual(reject(100))

    const perClient = createLimiter({ ...spec, keyBy: 'client' })
    for (let i = 0; i < 5; i++) perClient.decide('a', 0)
    expect(perClient.decide('a', 0)).toEqual(reject(100))
    // b's bucket is its own, and still full.
    for (let i = 0; i < 5; i++) expect(perClient.decide('b', 0)).toEqual(allow)
    expect(perClient.decide('b', 0)).toEqual(reject(100))
  })

  it('refills every bucket on reset', () => {
    const limiter = createLimiter({ ...spec, keyBy: 'client' })
    for (let i = 0; i < 5; i++) limiter.decide('a', 0)
    limiter.reset()
    for (let i = 0; i < 5; i++) expect(limiter.decide('a', 0)).toEqual(allow)
  })

  it.each(['global', 'client'] as const)(
    'rejects exactly until its retry time and never allows more than capacity + rate x span, keyed %s',
    (keyBy) => {
      // 12 tokens, 40 per second. Attempts come on average every 10 ms from three Clients:
      // 100 per second in all, about 33 from each, so buckets empty and refill all the time.
      const capacity = 12
      const refillPerSec = 40
      const limiter = createLimiter({ algo: 'token-bucket', keyBy, capacity, refillPerSec })
      const random = createRandomStream(6)
      const clients = ['a', 'b', 'c']
      /** Per key: when each allowed Attempt came, and the earliest retry time after a Reject. */
      const allowedAt = new Map<string, number[]>()
      const retryAt = new Map<string, number>()
      let t = 0
      for (let i = 0; i < 30_000; i++) {
        // Now and then a quiet spell, so buckets fill and a burst can use them.
        t += random.next() < 0.002 ? 1000 : random.next() * 20
        const clientId = clients[Math.floor(random.next() * clients.length)] ?? 'a'
        const key = keyBy === 'client' ? clientId : 'all'
        const decision = limiter.decide(clientId, t)
        // After a Reject, the next Attempt is rejected before the retry time it was given and
        // allowed at or after it. (After an Allow, either can come next.)
        const earliest = retryAt.get(key)
        if (earliest !== undefined) expect(decision.kind).toBe(t < earliest ? 'reject' : 'allow')
        if (decision.kind === 'reject') {
          retryAt.set(key, t + (decision.retryAfterMs ?? Number.NaN))
        } else {
          retryAt.delete(key)
          const times = allowedAt.get(key) ?? []
          allowedAt.set(key, times)
          times.push(t)
        }
      }
      // Any run of allowed Attempts, from the i-th to the j-th, took at least as long as it
      // takes to refill all but the capacity: j - i + 1 <= capacity + span x rate. `most` is
      // the largest j - i + 1 - span x rate over every run. With a_k = k - rate x t_k that is
      // a_j - a_i + 1, so a running minimum of a_i finds it in one pass over each key.
      let most = 0
      for (const times of allowedAt.values()) {
        let lowest = Infinity
        times.forEach((t, k) => {
          const a = k - (t * refillPerSec) / 1000
          lowest = Math.min(lowest, a)
          most = Math.max(most, a - lowest + 1)
        })
      }
      // The slack of 1e-9 tokens absorbs rounding in span x rate.
      expect(most).toBeLessThanOrEqual(capacity + 1e-9)
      // After the quiet spells a full bucket was spent in a burst, so the bound was nearly
      // reached and the check above was not vacuous.
      expect(most).toBeGreaterThan(capacity - 1)
    },
  )

  it.each<[string, Partial<TokenBucketSpec>]>([
    ['a capacity of 0', { capacity: 0 }],
    ['a fractional capacity', { capacity: 1.5 }],
    ['an infinite capacity', { capacity: Infinity }],
    ['a refill rate of 0', { refillPerSec: 0 }],
    ['a NaN refill rate', { refillPerSec: NaN }],
    ['an infinite refill rate', { refillPerSec: Infinity }],
  ])('throws a RangeError for %s', (_, change) => {
    expect(() => createLimiter({ ...spec, ...change })).toThrow(RangeError)
  })
})

describe('sliding window counter', () => {
  // 4 per window-length, windows of 1000 ms: every weight below is a whole number of quarters.
  const spec: SlidingCounterSpec = {
    algo: 'sliding-counter',
    keyBy: 'global',
    limit: 4,
    windowMs: 1000,
  }

  it('allows the limit in a window, then waits until the estimate has room', () => {
    const limiter = createLimiter(spec)
    for (const t of [0, 100, 200, 300]) expect(limiter.decide('a', t)).toEqual(allow)
    // Window 0 is full. In window 1 its 4 count for 4 x (1 - e / 1000), so the next Attempt
    // fits once that is 3 or less: 250 ms into window 1.
    expect(limiter.decide('a', 300)).toEqual(reject(950))
    expect(limiter.decide('a', 1249)).toEqual(reject(1))
    expect(limiter.decide('a', 1250)).toEqual(allow)
    // Now 1 is allowed in window 1, so the previous window must weigh 2 or less: at 500 ms.
    expect(limiter.decide('a', 1250)).toEqual(reject(250))
    expect(limiter.decide('a', 1500)).toEqual(allow)
    expect(limiter.decide('a', 1750)).toEqual(allow)
    // With 3 allowed, the previous window must weigh nothing: the end of window 1.
    expect(limiter.decide('a', 1750)).toEqual(reject(250))
    expect(limiter.decide('a', 2000)).toEqual(allow)
  })

  it('weighs the previous window by how much of it still overlaps the last window-length', () => {
    const limiter = createLimiter({ ...spec, limit: 10 })
    for (let i = 0; i < 10; i++) expect(limiter.decide('a', 50)).toEqual(allow)
    // Halfway through window 1 the 10 from window 0 count as 5, so 5 more fit and a sixth
    // waits until 600 ms in. All 10 came at 50 ms, more than a window-length ago, but the
    // counter cannot tell: it assumes they were spread evenly over window 0.
    for (let i = 0; i < 5; i++) expect(limiter.decide('a', 1500)).toEqual(allow)
    expect(limiter.decide('a', 1500)).toEqual(reject(100))
  })

  it('forgets a window once a whole window has passed without an Attempt', () => {
    const limiter = createLimiter(spec)
    for (const t of [0, 100, 200, 300]) limiter.decide('a', t)
    // Window 1 had no Attempts, so in window 2 the previous window counts 0: the full limit fits.
    for (let i = 0; i < 4; i++) expect(limiter.decide('a', 2000)).toEqual(allow)
    expect(limiter.decide('a', 2000)).toEqual(reject(1250))
  })

  it('shares one count between Clients when keyed globally, and has one per Client when keyed by client', () => {
    const global = createLimiter(spec)
    for (const clientId of ['a', 'b', 'c', 'd']) expect(global.decide(clientId, 0)).toEqual(allow)
    expect(global.decide('e', 0)).toEqual(reject(1250))

    const perClient = createLimiter({ ...spec, keyBy: 'client' })
    for (let i = 0; i < 4; i++) perClient.decide('a', 0)
    expect(perClient.decide('a', 0)).toEqual(reject(1250))
    // b's count is its own, and still empty.
    for (let i = 0; i < 4; i++) expect(perClient.decide('b', 0)).toEqual(allow)
    expect(perClient.decide('b', 0)).toEqual(reject(1250))
  })

  it('forgets every count on reset', () => {
    const limiter = createLimiter({ ...spec, keyBy: 'client' })
    for (let i = 0; i < 4; i++) limiter.decide('a', 0)
    limiter.reset()
    // Without the reset, window 0's 4 would still weigh 3 at 1250 ms and leave room for 1.
    for (let i = 0; i < 4; i++) expect(limiter.decide('a', 1250)).toEqual(allow)
  })

  it.each(['global', 'client'] as const)(
    'allows exactly when the estimate has room, and never more than limit x (1 + time into the window / window length), keyed %s',
    (keyBy) => {
      // Attempts come on average every 3.5 ms from three Clients, about 71 per 250 ms window in
      // all and 24 from each, with a quiet spell now and then. Each limit is near its key's
      // mean, so windows fill up often and the previous window's weight matters.
      const windowMs = 250
      const limit = keyBy === 'global' ? 71 : 24
      const limiter = createLimiter({ algo: 'sliding-counter', keyBy, limit, windowMs })
      const random = createRandomStream(9)
      const clients = ['a', 'b', 'c']
      /** Per key: when each allowed Attempt was decided, in order, and how many per window. */
      const allowedAt = new Map<string, number[]>()
      const perWindow = new Map<string, Map<number, number>>()
      let rejects = 0
      let wrong = 0
      /**
       * Window k is [k x 250, (k + 1) x 250). Worked out here by plain division, not with
       * bucketAt, so the test does not borrow the code it checks; with a whole-number window
       * the division does not round across an edge.
       */
      const windowOf = (time: number) => Math.floor(time / windowMs)
      let t = 0
      for (let i = 0; i < 20_000; i++) {
        t += random.next() < 0.002 ? 600 : random.next() * 7
        const clientId = clients[Math.floor(random.next() * clients.length)] ?? 'a'
        const key = keyBy === 'client' ? clientId : 'all'
        const counts = perWindow.get(key) ?? new Map<number, number>()
        perWindow.set(key, counts)
        // The estimate, from the test's own record.
        const k = windowOf(t)
        const prev = counts.get(k - 1) ?? 0
        const curr = counts.get(k) ?? 0
        const estimate = prev * (1 - (t - k * windowMs) / windowMs) + curr
        const decision = limiter.decide(clientId, t)
        // One expect per decision costs seconds; count disagreements and assert once.
        if (decision.kind !== (estimate + 1 <= limit ? 'allow' : 'reject')) wrong++
        if (decision.kind === 'allow') {
          counts.set(k, curr + 1)
          const times = allowedAt.get(key) ?? []
          allowedAt.set(key, times)
          times.push(t)
        } else {
          rejects++
        }
      }
      expect(wrong).toBe(0)
      // Each window on its own allows at most the limit.
      for (const counts of perWindow.values()) {
        expect(Math.max(...counts.values())).toBeLessThanOrEqual(limit)
      }
      // Across an edge, the window-length ending at each allowed Attempt holds at most
      // limit x (1 + time into its window / window length): near the limit just after an edge,
      // where fixed window allows 2x.
      let mostOverBound = 0
      let mostOverLimit = 0
      for (const times of allowedAt.values()) {
        let from = 0
        times.forEach((at, i) => {
          while ((times[from] ?? at) <= at - windowMs) from++
          const inSpan = i - from + 1
          const intoWindowMs = at - windowOf(at) * windowMs
          const bound = limit * (1 + intoWindowMs / windowMs)
          mostOverBound = Math.max(mostOverBound, inSpan / bound)
          mostOverLimit = Math.max(mostOverLimit, inSpan / limit)
        })
      }
      expect(mostOverBound).toBeLessThanOrEqual(1 + 1e-9)
      // The bound was nearly reached, so the check is not vacuous, and the counter did go over
      // the limit within a window-length: it is an estimate, not an exact sliding limit.
      expect(mostOverBound).toBeGreaterThan(0.95)
      expect(mostOverLimit).toBeGreaterThan(1)
      // Many were rejected (seed 9: 1,001 global, 2,239 per client), so "allows exactly when"
      // was tested on both outcomes. The threshold sits well below both counts.
      expect(rejects).toBeGreaterThan(500)
    },
  )

  it.each<[string, Partial<SlidingCounterSpec>]>([
    ['a limit of 0', { limit: 0 }],
    ['a fractional limit', { limit: 2.5 }],
    ['an infinite limit', { limit: Infinity }],
    ['a window of 0 ms', { windowMs: 0 }],
    ['a NaN window', { windowMs: NaN }],
    ['an infinite window', { windowMs: Infinity }],
  ])('throws a RangeError for %s', (_, change) => {
    expect(() => createLimiter({ ...spec, ...change })).toThrow(RangeError)
  })
})

/**
 * Runs scripted arrivals from one Client through one engine with `spec`'s Limiter. Returns the
 * most allowed within any one-second window-length (as the boundary-burst chart plots them,
 * from 100 ms sub-buckets), the allowed count of each of the first two one-second windows,
 * and the totals.
 */
function allowedThroughEngine(
  spec: LimiterSpec,
  scriptedArrivals: readonly { readonly atMs: number; readonly count: number }[],
) {
  const source = createTrafficSource({
    spec: { shape: 'constant', demandRps: 0, clients: ['a'] },
    stream: createStreams(1).traffic,
    scriptedArrivals,
  })
  const engine = createEngine({
    traffic: source.reader(),
    limiter: createLimiter(spec),
    retry: { timeoutMs: 1000, retry: 'none', maxAttempts: 1 },
    backend: { slots: 20, queueLimit: 100, meanMs: 20, cv: 0 },
    streams: createStreams(1),
    subBucketMs: 100,
  })
  source.advanceTo(3000)
  engine.advanceTo(3000)
  const { counts } = engine.allowedSubBuckets()
  const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0)
  const lastWindow = counts.map((_, i) => sum(counts.slice(Math.max(0, i - 9), i + 1)))
  return {
    mostInAWindowLength: Math.max(...lastWindow),
    firstWindow: sum(counts.slice(0, 10)),
    secondWindow: sum(counts.slice(10, 20)),
    totals: engine.totals(),
  }
}

/** The same long-run rate, 10 per second, for each algorithm. */
const tenPerSecond = {
  fixedWindow: { algo: 'fixed-window', keyBy: 'global', limit: 10, windowMs: 1000 },
  tokenBucket: { algo: 'token-bucket', keyBy: 'global', capacity: 10, refillPerSec: 10 },
  slidingCounter: { algo: 'sliding-counter', keyBy: 'global', limit: 10, windowMs: 1000 },
} satisfies Record<string, LimiterSpec>

describe('at a window edge', () => {
  /** Edge Burst: 30 Requests just before the edge at 1000 ms and 30 just after. */
  const edgeBurst = (spec: LimiterSpec) =>
    allowedThroughEngine(spec, [
      { atMs: 950, count: 30 },
      { atMs: 1050, count: 30 },
    ])

  it('fixed window lets through about 2x its limit within one window-length', () => {
    // 10 per 1000 ms window, and the window resets between the two halves of the burst.
    const run = edgeBurst(tenPerSecond.fixedWindow)
    expect(run.mostInAWindowLength).toBe(20)
    // Each fixed window on its own stayed within the limit.
    expect(run.firstWindow).toBe(10)
    expect(run.secondWindow).toBe(10)
    expect(run.totals.attempts).toMatchObject({ offered: 60, allowed: 20, rejected: 40 })
    // All 20 allowed Attempts reach the Backend within 100 ms, and are served.
    expect(run.totals.requests).toMatchObject({ succeeded: 20, rejected: 40 })
  })

  it('token bucket with the same long-run rate does not: the second half finds the bucket empty', () => {
    // 10 tokens, 10 per second: the same 10 per second as the fixed window above. The first
    // half spends the full bucket at 950 ms; by 1050 ms one token has come back.
    const run = edgeBurst(tenPerSecond.tokenBucket)
    expect(run.mostInAWindowLength).toBe(11)
    expect(run.totals.attempts).toMatchObject({ offered: 60, allowed: 11, rejected: 49 })
  })

  it('sliding window counter does not either: just after the edge the full window before still counts', () => {
    // 50 ms into window 1, window 0's 10 still weigh 9.5, so nothing more fits until 100 ms in.
    const run = edgeBurst(tenPerSecond.slidingCounter)
    expect(run.mostInAWindowLength).toBe(10)
    expect(run.totals.attempts).toMatchObject({ offered: 60, allowed: 10, rejected: 50 })
  })
})

describe('after an early burst and a quiet spell', () => {
  // 30 Requests at 50 ms, then 30 halfway through the next window, at 1500 ms.
  const earlyThenMidWindow = (spec: LimiterSpec) =>
    allowedThroughEngine(spec, [
      { atMs: 50, count: 30 },
      { atMs: 1500, count: 30 },
    ])

  it('fixed window and token bucket allow a full 10 again at 1500 ms', () => {
    // The fixed window reset at 1000 ms; the token bucket has refilled since 1050 ms.
    for (const spec of [tenPerSecond.fixedWindow, tenPerSecond.tokenBucket]) {
      const run = earlyThenMidWindow(spec)
      expect(run.totals.attempts).toMatchObject({ offered: 60, allowed: 20, rejected: 40 })
    }
  })

  it('sliding window counter allows only 5: it still counts half of the earlier window', () => {
    // The counter assumes window 0's 10 were spread evenly, so halfway through window 1 they
    // weigh 5, although all of them came more than a window-length ago.
    const run = earlyThenMidWindow(tenPerSecond.slidingCounter)
    expect(run.firstWindow).toBe(10)
    expect(run.secondWindow).toBe(5)
    expect(run.totals.attempts).toMatchObject({ offered: 60, allowed: 15, rejected: 45 })
  })
})

describe('retry after', () => {
  // Rates and windows that are not whole numbers of ms, at times with fractions, so rounding
  // in floating point has every chance to put the retry a hair too early.
  // Steps average about one window or token interval, so many Attempts are rejected.
  it.each<[string, LimiterSpec, number]>([
    ['fixed window', { algo: 'fixed-window', keyBy: 'global', limit: 1, windowMs: 100 / 3 }, 60],
    ['token bucket', { algo: 'token-bucket', keyBy: 'global', capacity: 1, refillPerSec: 7 }, 250],
    // A limit of 3 mostly waits inside a window, for the previous window's weight to fall; a
    // limit of 1 always waits for the next window.
    [
      'sliding window counter, waiting within the window',
      { algo: 'sliding-counter', keyBy: 'global', limit: 3, windowMs: 100 / 3 },
      20,
    ],
    [
      'sliding window counter, waiting for the next window',
      { algo: 'sliding-counter', keyBy: 'global', limit: 1, windowMs: 100 / 3 },
      60,
    ],
  ])(
    'is exact: an Attempt at now + retryAfterMs is allowed, and one just before is not (%s)',
    (_, spec, stepMs) => {
      const random = createRandomStream(8)
      const limiter = createLimiter(spec)
      let t = 0
      let rejects = 0
      for (let i = 0; i < 50_000; i++) {
        t += random.next() * stepMs
        const decision = limiter.decide('a', t)
        if (decision.kind !== 'reject') continue
        rejects++
        const retryAfterMs = decision.retryAfterMs ?? Number.NaN
        expect(retryAfterMs).toBeGreaterThan(0)
        // Not too late either: a moment before the retry time is still rejected. A Reject
        // changes nothing, so asking again leaves the Limiter as it was.
        expect(limiter.decide('a', t + retryAfterMs * 0.999).kind).toBe('reject')
        t += retryAfterMs
        expect(limiter.decide('a', t)).toEqual(allow)
      }
      expect(rejects).toBeGreaterThan(10_000)
    },
  )
})

describe('what the charts read from a Limiter spec', () => {
  it('gives the window a Limiter counts in, and none for token bucket', () => {
    expect(
      limiterWindow({ algo: 'fixed-window', keyBy: 'global', limit: 10, windowMs: 1000 }),
    ).toEqual({ limit: 10, windowMs: 1000 })
    expect(
      limiterWindow({ algo: 'sliding-counter', keyBy: 'client', limit: 3, windowMs: 250 }),
    ).toEqual({ limit: 3, windowMs: 250 })
    expect(
      limiterWindow({ algo: 'token-bucket', keyBy: 'global', capacity: 10, refillPerSec: 5 }),
    ).toBeNull()
  })

  it('gives the long-run Attempts allowed per second, per key', () => {
    expect(
      allowedPerSecond({ algo: 'fixed-window', keyBy: 'global', limit: 60, windowMs: 500 }),
    ).toBe(120)
    expect(
      allowedPerSecond({ algo: 'sliding-counter', keyBy: 'global', limit: 10, windowMs: 1000 }),
    ).toBe(10)
    expect(
      allowedPerSecond({ algo: 'token-bucket', keyBy: 'global', capacity: 60, refillPerSec: 40 }),
    ).toBe(40)
  })
})
