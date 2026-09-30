import { describe, expect, it } from 'vitest'
import { createEngine } from '../src/sim/engine.ts'
import { createLimiter, type LimiterSpec } from '../src/sim/limiter.ts'
import { createRandomStream, createStreams } from '../src/sim/rng.ts'
import { createTrafficSource } from '../src/sim/traffic-source.ts'

const allow = { kind: 'allow' }
const reject = (retryAfterMs: number) => ({ kind: 'reject', retryAfterMs })

describe('fixed window', () => {
  const spec: LimiterSpec = { algo: 'fixed-window', keyBy: 'global', limit: 3, windowMs: 1000 }

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

  it.each<[string, Partial<LimiterSpec>]>([
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

describe('fixed window at a window edge', () => {
  it('lets through about 2x its limit within one window-length when a burst straddles the edge', () => {
    // Edge Burst: 30 Requests just before the edge at 1000 ms and 30 just after. The limit is
    // 10 per 1000 ms window, and the window resets between the two halves.
    const source = createTrafficSource({
      spec: { shape: 'constant', demandRps: 0, clients: ['a'] },
      stream: createStreams(1).traffic,
      scriptedArrivals: [
        { atMs: 950, count: 30 },
        { atMs: 1050, count: 30 },
      ],
    })
    const engine = createEngine({
      traffic: source.reader(),
      limiter: createLimiter({ algo: 'fixed-window', keyBy: 'global', limit: 10, windowMs: 1000 }),
      retry: { timeoutMs: 1000, retry: 'none', maxAttempts: 1 },
      backend: { slots: 20, queueLimit: 100, meanMs: 20, cv: 0 },
      streams: createStreams(1),
      subBucketMs: 100,
    })
    source.advanceTo(3000)
    engine.advanceTo(3000)

    const { counts } = engine.allowedSubBuckets()
    // Allowed Attempts in the window-length ending at each sub-bucket edge, as the boundary
    // burst chart plots them.
    const lastWindow = counts.map((_, i) =>
      counts.slice(Math.max(0, i - 9), i + 1).reduce((a, b) => a + b, 0),
    )
    expect(Math.max(...lastWindow)).toBe(20)
    // Each fixed window on its own stayed within the limit.
    expect(counts.slice(0, 10).reduce((a, b) => a + b, 0)).toBe(10)
    expect(counts.slice(10, 20).reduce((a, b) => a + b, 0)).toBe(10)
    expect(engine.totals().attempts).toMatchObject({ offered: 60, allowed: 20, rejected: 40 })
    // All 20 allowed Attempts reach the Backend within 100 ms, and are served.
    expect(engine.totals().requests).toMatchObject({ succeeded: 20, rejected: 40 })
  })
})
