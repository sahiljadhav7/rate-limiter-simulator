import { describe, expect, it } from 'vitest'
import type { BackendSpec } from '../src/sim/backend.ts'
import { createEngine, type Engine, type Totals } from '../src/sim/engine.ts'
import { createLimiter, type Limiter, type LimiterSpec } from '../src/sim/limiter.ts'
import type { Snapshot } from '../src/sim/metrics.ts'
import { createRandomStream, createStreams } from '../src/sim/rng.ts'
import type { RetryPolicy } from '../src/sim/retry-policy.ts'
import type { TrafficShape, TrafficSpec } from '../src/sim/traffic.ts'
import {
  createTrafficSource,
  type ControlChange,
  type ControlEvent,
} from '../src/sim/traffic-source.ts'

/**
 * What must hold in every run (RS-14, `.scratch/invariants/spec.md`), checked for every Limiter,
 * Retry Policy and traffic shape together, so a bug that shows only in one pairing cannot hide.
 *
 * The arithmetic behind the shared configuration. The Backend has 4 slots of 40 ms on average,
 * a ceiling of 100 rps, and a queue of 20: a full queue waits about 20 / 100 s = 200 ms, longer
 * than the 150 ms timeout. Every Limiter allows 120 per second in the long run. Demand is
 * 150 rps from three Clients, one with twice the share, and doubles for 2 s from 8 s. So the
 * Limiters reject (150 or 300 offered against 120), the Backend fills (120 allowed against a
 * ceiling of 100), Attempts time out in its queue and it sheds when the queue is full.
 */

const UNTIL_MS = 20_000
/**
 * The largest number below 20,000 that a double can hold, so no event time lies between it and
 * the end. Events at exactly 20,000 ms belong to the second that starts there, which has no
 * Snapshot yet, and they are common: under retry-after every Attempt a window rejected retries
 * exactly at the next edge. So the Snapshots add up exactly to the totals at this stop.
 */
const JUST_BEFORE_END = UNTIL_MS - (UNTIL_MS * Number.EPSILON) / 2
const CLIENTS = ['a', 'b', 'c']
const BACKEND: BackendSpec = { slots: 4, queueLimit: 20, meanMs: 40, cv: 1 }
const BURST: ControlEvent[] = [
  { atMs: 8000, change: { kind: 'burst', multiplier: 2, durationMs: 2000 } },
]

const traffic = (shape: TrafficShape, demandRps = 150): TrafficSpec => ({
  shape,
  demandRps,
  clients: CLIENTS,
  greedy: { clientId: 'a', multiplier: 2 },
  bursty: { onMs: 300, offMs: 300 },
})

/** The same long-run rate, 120 per second, for every algorithm. */
const LIMITERS: Record<string, LimiterSpec> = {
  'fixed window': { algo: 'fixed-window', keyBy: 'global', limit: 60, windowMs: 500 },
  'token bucket': { algo: 'token-bucket', keyBy: 'global', capacity: 60, refillPerSec: 120 },
  'sliding counter': { algo: 'sliding-counter', keyBy: 'global', limit: 60, windowMs: 500 },
}

const RETRIES: Record<string, RetryPolicy> = {
  none: { timeoutMs: 150, maxAttempts: 1, retry: 'none' },
  immediate: { timeoutMs: 150, maxAttempts: 3, retry: 'immediate' },
  backoff: { timeoutMs: 150, maxAttempts: 3, retry: 'backoff', baseDelayMs: 50 },
  'backoff-jitter': { timeoutMs: 150, maxAttempts: 3, retry: 'backoff-jitter', baseDelayMs: 50 },
  'retry-after': { timeoutMs: 150, maxAttempts: 3, retry: 'retry-after', baseDelayMs: 50 },
}

const SHAPES: TrafficShape[] = ['constant', 'poisson', 'bursty']

const allowAll = (): Limiter => ({ decide: () => ({ kind: 'allow' }), reset() {} })

interface Config {
  traffic: TrafficSpec
  limiter: () => Limiter
  retry: RetryPolicy
  controls: ControlEvent[]
  seed: number
}

interface Checked {
  engine: Engine
  /** Every invariant that failed, as a readable line. Empty when the run is sound. */
  violations: string[]
}

/**
 * Runs `config` in random chunks, checking the counts at every stop, then the Snapshots and the
 * sums at the end. Violations are collected and asserted once: one expect per stop costs seconds.
 */
function runChecked(config: Config): Checked {
  const violations: string[] = []
  const fail = (what: string) => violations.push(what)
  const source = createTrafficSource({
    spec: config.traffic,
    stream: createStreams(config.seed).traffic,
    controls: config.controls,
  })
  const engine = createEngine({
    traffic: source.reader(),
    limiter: config.limiter(),
    retry: config.retry,
    backend: BACKEND,
    streams: createStreams(config.seed),
  })
  const stops = createRandomStream(config.seed + 1000)
  const advance = (t: number) => {
    source.advanceTo(t)
    engine.advanceTo(t)
    checkCounts(engine, config.retry, (what) => fail(`at ${t.toFixed(1)} ms: ${what}`))
  }
  for (let t = 0; t < JUST_BEFORE_END;) {
    t = Math.min(JUST_BEFORE_END, t + stops.next() * 300)
    advance(t)
  }
  const beforeEnd = engine.totals()
  advance(UNTIL_MS)
  checkSnapshots(engine.snapshots(), config.retry, fail)
  checkSums(engine, beforeEnd, fail)
  return { engine, violations }
}

/** Conservation, the failure breakdown and Attempts per Request (spec decisions 1 and 4). */
function checkCounts(engine: Engine, retry: RetryPolicy, fail: (what: string) => void): void {
  const { requests, attempts } = engine.totals()
  const r = requests
  const a = attempts
  const equal = (what: string, left: number, right: number) => {
    if (left !== right) fail(`${what}: ${left} against ${right}`)
  }
  equal(
    'offered = allowed + rejected + delayed + awaiting a decision',
    a.offered,
    a.allowed + a.rejected + a.delayed + a.awaitingDecision,
  )
  // No Limiter delays yet (leaky bucket, RS-9, will), so this one holds as 0 = 0 for now.
  equal(
    'delayed = released + dropped at release + awaiting release',
    a.delayed,
    a.released + a.droppedAtRelease + a.awaitingRelease,
  )
  equal(
    'allowed + released = shed + served + in the Backend',
    a.allowed + a.released,
    a.shed + a.served + a.inBackend,
  )
  // Failed is derived from three separately kept counts: arrivals, successes, open Requests.
  equal(
    'rejected + timed out + shed = created - succeeded - in flight',
    r.rejected + r.timedOut + r.shed,
    r.created - r.succeeded - r.inFlight,
  )
  // Requests and Attempts share some names (rejected, shed), so each is checked on its own.
  for (const [kind, counts] of [
    ['Requests', requests],
    ['Attempts', attempts],
  ] as const) {
    for (const [name, value] of Object.entries(counts)) {
      if (!(value >= 0)) fail(`${kind} ${name} is ${value}`)
    }
  }
  if (a.offered > r.created * retry.maxAttempts) {
    fail(`${a.offered} Attempts from ${r.created} Requests, at most ${retry.maxAttempts} each`)
  }
  if (retry.retry === 'none') equal('offered = created with no retry', a.offered, r.created)
}

/** Everything each Snapshot must satisfy on its own (spec decision 4). */
function checkSnapshots(
  snapshots: readonly Snapshot[],
  retry: RetryPolicy,
  fail: (what: string) => void,
): void {
  for (const s of snapshots) {
    const at = (what: string) => fail(`Snapshot ${s.t}: ${what}`)
    const counts: Record<string, number> = {
      demand: s.demand,
      offeredLoad: s.offeredLoad,
      retryAttempts: s.retryAttempts,
      quickRetryAttempts: s.quickRetryAttempts,
      allowed: s.allowed,
      rejected: s.rejected,
      delayed: s.delayed,
      goodput: s.goodput,
      failedRejected: s.failed.rejected,
      failedTimedOut: s.failed.timedOut,
      failedShed: s.failed.shed,
      queueDepth: s.queueDepth,
      shed: s.shed,
    }
    for (const [id, c] of Object.entries(s.perClient)) {
      counts[`${id} offered`] = c.offeredLoad
      counts[`${id} allowed`] = c.allowed
    }
    for (const [name, value] of Object.entries(counts)) {
      if (!(Number.isSafeInteger(value) && value >= 0)) at(`${name} is ${value}`)
    }
    const clients = Object.values(s.perClient)
    const clientOffered = clients.reduce((n, c) => n + c.offeredLoad, 0)
    const clientAllowed = clients.reduce((n, c) => n + c.allowed, 0)
    if (clientOffered !== s.offeredLoad)
      at(`Clients offered ${clientOffered}, in all ${s.offeredLoad}`)
    if (clientAllowed !== s.allowed) at(`Clients allowed ${clientAllowed}, in all ${s.allowed}`)
    // A Request's first Attempt starts the moment it arrives, so in the same second.
    if (s.retryAttempts !== s.offeredLoad - s.demand) {
      at(`retries ${s.retryAttempts}, but Offered Load ${s.offeredLoad} minus Demand ${s.demand}`)
    }
    if (s.quickRetryAttempts > s.retryAttempts)
      at(`quick retries ${s.quickRetryAttempts} over retries ${s.retryAttempts}`)
    if (retry.retry === 'none' && s.retryAttempts !== 0)
      at(`${s.retryAttempts} retries with no retry`)
    if (!(Number.isFinite(s.backendUtil) && s.backendUtil >= 0 && s.backendUtil <= 1)) {
      at(`utilization is ${s.backendUtil}`)
    }
    if (s.queueDepth > BACKEND.queueLimit) at(`queue depth ${s.queueDepth} over its limit`)
    const slotMs = BACKEND.slots * 1000
    if (!(Number.isFinite(s.wastedWorkMs) && s.wastedWorkMs >= 0 && s.wastedWorkMs <= slotMs)) {
      at(`Wasted Work ${s.wastedWorkMs} ms, outside [0, ${slotMs}]`)
    }
    const attempt = [s.p50, s.p95, s.p99]
    const e2e = [s.e2eP50, s.e2eP95, s.e2eP99]
    for (const p of [...attempt, ...e2e]) {
      if (p !== null && !(Number.isFinite(p) && p >= 0)) at(`a percentile is ${p}`)
    }
    for (const ps of [attempt, e2e]) {
      const [p50, p95, p99] = ps
      if (p50 != null && p95 != null && p99 != null && !(p50 <= p95 && p95 <= p99)) {
        at(`percentiles out of order: ${ps.join(', ')}`)
      }
    }
    // A timed-out Attempt is left out of Attempt latency, so none recorded exceeds the timeout.
    if (s.p99 !== null && s.p99 > retry.timeoutMs) at(`p99 ${s.p99} ms over the timeout`)
    // Each Succeeded Request records both latencies at once, its end-to-end at least its last
    // Attempt's, so every end-to-end percentile is at least the matching Attempt percentile.
    attempt.forEach((p, i) => {
      const q = e2e[i]
      if ((p === null) !== (q === null)) at(`Attempt and end-to-end percentiles disagree on null`)
      if (p != null && q != null && q < p) at(`end-to-end ${q} ms below Attempt ${p} ms`)
    })
  }
}

/**
 * Snapshots add up exactly to the totals just before the end (everything until then is in a
 * Snapshot, and nothing can happen between then and the end), and sub-buckets add up to the
 * allowed total.
 */
function checkSums(engine: Engine, beforeEnd: Totals, fail: (what: string) => void): void {
  const snapshots = engine.snapshots()
  const sum = (pick: (s: Snapshot) => number) => snapshots.reduce((n, s) => n + pick(s), 0)
  const { requests: r, attempts } = beforeEnd
  const pairs: [string, number, number][] = [
    ['demand', sum((s) => s.demand), r.created],
    ['offered', sum((s) => s.offeredLoad), attempts.offered],
    ['retries', sum((s) => s.retryAttempts), attempts.offered - r.created],
    ['allowed', sum((s) => s.allowed), attempts.allowed],
    ['rejected', sum((s) => s.rejected), attempts.rejected],
    ['shed', sum((s) => s.shed), attempts.shed],
    ['goodput', sum((s) => s.goodput), r.succeeded],
    ['failed rejected', sum((s) => s.failed.rejected), r.rejected],
    ['failed timed out', sum((s) => s.failed.timedOut), r.timedOut],
    ['failed shed', sum((s) => s.failed.shed), r.shed],
  ]
  for (const [what, inSnapshots, total] of pairs) {
    if (inSnapshots !== total) fail(`${what}: ${inSnapshots} in Snapshots, ${total} in all`)
  }
  const a = engine.totals().attempts
  const { counts } = engine.allowedSubBuckets()
  const inSubBuckets = counts.reduce((n, x) => n + x, 0)
  if (inSubBuckets !== a.allowed) fail(`sub-buckets hold ${inSubBuckets}, allowed ${a.allowed}`)
}

/** The matrix runs, each run once and kept, so the "not vacuous" test reuses them. */
const MATRIX = Object.entries(LIMITERS).flatMap(([limiterName, limiterSpec]) =>
  Object.entries(RETRIES).flatMap(([retryName, retry]) =>
    SHAPES.map((shape) => ({
      name: `${limiterName}, ${retryName}, ${shape}`,
      config: {
        traffic: traffic(shape),
        limiter: () => createLimiter(limiterSpec),
        retry,
        controls: BURST,
        seed: 7,
      } satisfies Config,
    })),
  ),
)
const checkedRuns = new Map<string, Checked>()
const checkedRun = (entry: (typeof MATRIX)[number]): Checked => {
  const cached = checkedRuns.get(entry.name)
  if (cached !== undefined) return cached
  const checked = runChecked(entry.config)
  checkedRuns.set(entry.name, checked)
  return checked
}

describe('every Limiter, Retry Policy and traffic shape', () => {
  it.each(MATRIX.map((entry) => [entry.name, entry] as const))(
    'holds every invariant: %s',
    (_, entry) => {
      expect(checkedRun(entry).violations).toEqual([])
    },
  )

  it('is not vacuous: across the matrix every way a Request can end happened many times', () => {
    const ended = { succeeded: 0, rejected: 0, timedOut: 0, shed: 0 }
    for (const entry of MATRIX) {
      const { requests } = checkedRun(entry).engine.totals()
      for (const key of Object.keys(ended) as (keyof typeof ended)[]) ended[key] += requests[key]
    }
    // Measured (seed 7): at least 12,793 of each ending across the matrix.
    for (const count of Object.values(ended)) expect(count).toBeGreaterThan(1000)
  })

  it('is not vacuous run by run: most runs see every way a Request can end', () => {
    // Measured (seed 7): 44 of 45. The exception, fixed window with immediate retry and bursty
    // traffic, has no timeouts.
    const everyEnding = MATRIX.filter((entry) => {
      const { succeeded, rejected, timedOut, shed } = checkedRun(entry).engine.totals().requests
      return Math.min(succeeded, rejected, timedOut, shed) > 0
    })
    expect(everyEnding.length).toBeGreaterThanOrEqual(40)
  })
})

describe('at the extremes', () => {
  it('holds every invariant with no traffic at all: zeros everywhere, no percentiles', () => {
    const { engine, violations } = runChecked({
      traffic: traffic('poisson', 0),
      limiter: allowAll,
      retry: RETRIES['backoff-jitter']!,
      controls: [],
      seed: 7,
    })
    expect(violations).toEqual([])
    const snapshots = engine.snapshots()
    expect(snapshots.length).toBe(UNTIL_MS / 1000)
    for (const s of snapshots) {
      expect(s).toMatchObject({ demand: 0, offeredLoad: 0, goodput: 0, backendUtil: 0 })
      expect([s.p50, s.p99, s.e2eP50, s.e2eP99]).toEqual([null, null, null, null])
    }
  })

  it('holds every invariant far past the Backend ceiling, with every slot busy', () => {
    const { engine, violations } = runChecked({
      traffic: traffic('poisson', 1000),
      limiter: allowAll,
      retry: RETRIES.immediate!,
      controls: [],
      seed: 7,
    })
    expect(violations).toEqual([])
    // 1000 rps against a ceiling of 100: after the first second the Backend never rests.
    const busy = engine
      .snapshots()
      .slice(1)
      .map((s) => s.backendUtil)
    // Measured: the least busy second is 0.99999; 0.95 leaves room without missing a real gap.
    expect(Math.min(...busy)).toBeGreaterThan(0.95)
  })
})

describe('replaying a live run', () => {
  /** A random control change of any kind, drawn from `rng`. */
  function randomChange(rng: ReturnType<typeof createRandomStream>): ControlChange {
    const kind = rng.next()
    if (kind < 0.3) return { kind: 'demand', demandRps: Math.round(rng.next() * 400) }
    if (kind < 0.5)
      return { kind: 'burst', multiplier: 1 + rng.next() * 4, durationMs: 100 + rng.next() * 3000 }
    if (kind < 0.7)
      return { kind: 'greedyMultiplier', clientId: 'b', multiplier: 1 + rng.next() * 9 }
    return { kind: 'shape', shape: SHAPES[Math.floor(rng.next() * SHAPES.length)] ?? 'poisson' }
  }

  /** Two Variants on one source: retry state, and with it jitter, diverges per Variant. */
  const VARIANTS: { limiter: LimiterSpec; retry: RetryPolicy }[] = [
    { limiter: LIMITERS['sliding counter']!, retry: RETRIES['retry-after']! },
    { limiter: LIMITERS['token bucket']!, retry: RETRIES['backoff-jitter']! },
  ]

  /**
   * One source and an engine per Variant, advanced together in random chunks of up to
   * `chunks.maxMs`. Without `recorded`, it is a live run: a random control change follows some
   * chunks. With `recorded`, it is a replay of that timeline.
   */
  function runVariants(
    seed: number,
    chunking: { seed: number; maxMs: number },
    recorded?: readonly ControlEvent[],
  ) {
    const live = recorded === undefined
    const source = createTrafficSource({
      spec: traffic('poisson'),
      stream: createStreams(seed).traffic,
      controls: recorded ?? [],
    })
    const engines = VARIANTS.map((variant) =>
      createEngine({
        traffic: source.reader(),
        limiter: createLimiter(variant.limiter),
        retry: variant.retry,
        backend: BACKEND,
        streams: createStreams(seed),
      }),
    )
    const chunks = createRandomStream(chunking.seed)
    for (let t = 0; t < UNTIL_MS;) {
      t = Math.min(UNTIL_MS, t + chunks.next() * chunking.maxMs)
      source.advanceTo(t)
      for (const engine of engines) engine.advanceTo(t)
      if (live && chunks.next() < 0.3) source.applyControl(randomChange(chunks))
    }
    const outcome = (engine: Engine) => ({
      snapshots: engine.snapshots(),
      totals: engine.totals(),
      subBuckets: engine.allowedSubBuckets(),
    })
    return { timeline: source.timeline(), variants: engines.map(outcome) }
  }

  it.each([1, 2, 3])(
    'gives every Variant the identical run from the seed and the recorded timeline (seed %i)',
    (seed) => {
      const live = runVariants(seed, { seed: seed + 500, maxMs: 700 })
      // The live run really changed course: many control changes, and Demand moved with them.
      // Measured on seeds 1 to 20 (all pass): 12 to 25 changes, Demand spread 234 to 1,753.
      expect(live.timeline.length).toBeGreaterThan(5)
      const demands = live.variants[0]?.snapshots.map((s) => s.demand) ?? []
      expect(Math.max(...demands) - Math.min(...demands)).toBeGreaterThan(100)
      // The replay advances in other chunks, so no frame time lines up with the live run's.
      const replay = runVariants(seed, { seed: seed + 9000, maxMs: 2000 }, live.timeline)
      expect(replay.timeline).toEqual(live.timeline)
      expect(replay.variants).toEqual(live.variants)
    },
  )
})
