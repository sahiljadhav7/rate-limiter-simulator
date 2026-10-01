import { describe, expect, it } from 'vitest'
import type { BackendSpec } from '../src/sim/backend.ts'
import { createEngine } from '../src/sim/engine.ts'
import { createLimiter, type Limiter } from '../src/sim/limiter.ts'
import { createStreams } from '../src/sim/rng.ts'
import type { RetryPolicy } from '../src/sim/retry-policy.ts'
import {
  createTrafficSource,
  type ControlEvent,
  type ScriptedArrivals,
} from '../src/sim/traffic-source.ts'

/**
 * Retries during an overload, end to end (RS-12). Two lessons, measured rather than assumed:
 * after a short burst into a Limiter, backing off with jitter turns failed Requests into
 * Succeeded ones where immediate retries waste every Attempt; and once a Backend's queue holds
 * more waiting time than the timeout, retrying at all keeps it collapsed after the overload
 * ends, with or without backoff. See `.scratch/retry/spec.md` decisions 9 and 10.
 */

interface Overload {
  demandRps: number
  limiter: () => Limiter
  backend: BackendSpec
  scripted?: ScriptedArrivals[]
  controls?: ControlEvent[]
  untilMs: number
}

function runOverload(overload: Overload, retry: RetryPolicy, seed: number) {
  const source = createTrafficSource({
    spec: { shape: 'poisson', demandRps: overload.demandRps, clients: ['a'] },
    stream: createStreams(seed).traffic,
    scriptedArrivals: overload.scripted ?? [],
    controls: overload.controls ?? [],
  })
  const engine = createEngine({
    traffic: source.reader(),
    limiter: overload.limiter(),
    retry,
    backend: overload.backend,
    streams: createStreams(seed),
  })
  source.advanceTo(overload.untilMs)
  engine.advanceTo(overload.untilMs)
  const snapshots = engine.snapshots()
  const sum = (from: number, to: number, pick: (s: (typeof snapshots)[number]) => number) =>
    snapshots.filter((s) => s.t > from && s.t <= to).reduce((total, s) => total + pick(s), 0)
  return {
    totals: engine.totals(),
    /** Offered Load / Demand over the Snapshots ending in (from, to]. */
    amplification: (from: number, to: number) =>
      sum(from, to, (s) => s.offeredLoad) / sum(from, to, (s) => s.demand),
    /** Backend slot time spent on abandoned Attempts over the Snapshots ending in (from, to]. */
    wastedWorkMs: (from: number, to: number) => sum(from, to, (s) => s.wastedWorkMs),
    /** Succeeded Requests per second over the Snapshots ending in (from, to]. */
    goodputRps: (from: number, to: number) =>
      (sum(from, to, (s) => s.goodput) * 1000) / (to - from),
  }
}

const SEEDS = [1, 2, 3, 4, 5]

describe('after a burst into a Limiter', () => {
  // The arithmetic. The Backend (20 slots, 20 ms each: a ceiling of 1000 rps) is never the
  // limit here; the token bucket is: 100 tokens per second, at most 10 saved up. Demand is
  // 50 rps, so half the tokens are spare. At 10 s, 60 Requests arrive at once: about 10 find
  // a token and about 50 are rejected. Their next Attempts need about 50 spare tokens, which
  // take about 1 s to come back.
  const burst: Overload = {
    demandRps: 50,
    limiter: () =>
      createLimiter({ algo: 'token-bucket', keyBy: 'global', capacity: 10, refillPerSec: 100 }),
    backend: { slots: 20, queueLimit: 50, meanMs: 20, cv: 1 },
    scripted: [{ atMs: 10_000, count: 60 }],
    untilMs: 20_000,
  }
  const immediate: RetryPolicy = { timeoutMs: 1000, maxAttempts: 4, retry: 'immediate' }
  // Backoff waits are up to 500, 1000 and 2000 ms: spread over the second the tokens need.
  const backoffJitter: RetryPolicy = {
    timeoutMs: 1000,
    maxAttempts: 4,
    retry: 'backoff-jitter',
    baseDelayMs: 500,
  }

  it.each(SEEDS)(
    'immediate retries are rejected every time, backing off with jitter lets them succeed (seed %i)',
    (seed) => {
      const now = runOverload(burst, immediate, seed)
      const later = runOverload(burst, backoffJitter, seed)
      // Immediate: a retry comes at the same moment, before any token is back, so every
      // Request rejected by the burst uses all 4 Attempts and ends Rejected. Measured on seeds
      // 1 to 5: 50 or 51 Rejected immediate, 0 or 1 backing off, and 49 or 50 more Succeeded.
      expect(now.totals.requests.rejected).toBeGreaterThan(35)
      // Backing off: the next Attempts wait for tokens, and almost all of them get one.
      expect(later.totals.requests.rejected).toBeLessThan(5)
      expect(later.totals.requests.succeeded).toBeGreaterThan(now.totals.requests.succeeded + 30)
    },
  )

  it.each(SEEDS)(
    'both policies add traffic: backoff spreads the retries out, it does not remove them (seed %i)',
    (seed) => {
      // Over the 5 s from 9 s to 14 s: about 250 Requests from Demand and 60 from the burst.
      // Every one of the about 50 rejected Requests retries at least once, whatever the policy,
      // so Retry Amplification is at least 1 + 50 / 310 = 1.16 for both. Measured on seeds 1
      // to 5: 1.48 to 1.52 immediate, 1.26 to 1.35 backing off.
      for (const policy of [immediate, backoffJitter]) {
        expect(runOverload(burst, policy, seed).amplification(9000, 14_000)).toBeGreaterThan(1.1)
      }
    },
  )
})

describe('after an overload that fills the Backend queue', () => {
  // The arithmetic. The Backend has 10 slots of 50 ms on average: a ceiling of 200 rps.
  // Demand is 160 rps (80 percent), doubled to 320 rps for 2 s from 10 s, so the queue grows
  // by about 120 per second and fills (100 places). A full queue drains in 100 / 200 = 500 ms,
  // longer than the 300 ms timeout, so the Attempts at the back time out while waiting, and
  // every timeout is a new Attempt. With 4 Attempts a failing Request offers up to
  // 4 x 160 = 640 rps, three times the ceiling, so the queue never drains again.
  const fill: Overload = {
    demandRps: 160,
    limiter: () => ({ decide: () => ({ kind: 'allow' }), reset() {} }),
    backend: { slots: 10, queueLimit: 100, meanMs: 50, cv: 1 },
    controls: [{ atMs: 10_000, change: { kind: 'burst', multiplier: 2, durationMs: 2000 } }],
    untilMs: 40_000,
  }
  const policies: [string, RetryPolicy][] = [
    ['immediate', { timeoutMs: 300, maxAttempts: 4, retry: 'immediate' }],
    [
      'backoff with jitter',
      { timeoutMs: 300, maxAttempts: 4, retry: 'backoff-jitter', baseDelayMs: 500 },
    ],
  ]

  it.each(SEEDS)('recovers without retries once the overload ends (seed %i)', (seed) => {
    const none: RetryPolicy = { timeoutMs: 300, maxAttempts: 1, retry: 'none' }
    // The last 10 s, long after the burst: Goodput is back to about Demand, 160 rps (measured
    // 155 to 165 on seeds 1 to 5). Collapsed runs below read 0, so 120 leaves a wide margin.
    const run = runOverload(fill, none, seed)
    expect(run.goodputRps(30_000, 40_000)).toBeGreaterThan(120)
    expect(run.wastedWorkMs(30_000, 40_000)).toBeLessThan(1000)
  })

  it.each(SEEDS.flatMap((seed) => policies.map(([name, policy]) => [name, seed, policy] as const)))(
    'stays collapsed with %s retries, long after the overload ends (seed %i)',
    (_, seed, policy) => {
      const run = runOverload(fill, policy, seed)
      // Nothing Succeeds: the Backend's slots serve Attempts that already timed out. Over
      // these 10 s its 10 slots have 100,000 ms of time in all; more than half of it is Wasted
      // Work. Measured on seeds 1 to 5: Goodput 0 and Retry Amplification 3.97 to 4.08, for
      // both policies.
      expect(run.goodputRps(30_000, 40_000)).toBeLessThan(10)
      expect(run.amplification(30_000, 40_000)).toBeGreaterThan(3)
      expect(run.wastedWorkMs(30_000, 40_000)).toBeGreaterThan(50_000)
    },
  )
})
