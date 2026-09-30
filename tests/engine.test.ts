import { describe, expect, it } from 'vitest'
import type { BackendSpec } from '../src/sim/backend.ts'
import { createEngine, type Engine, type EngineOptions } from '../src/sim/engine.ts'
import type { Snapshot } from '../src/sim/metrics.ts'
import type { Limiter, LimiterDecision } from '../src/sim/limiter.ts'
import { createRandomStream, createStreams } from '../src/sim/rng.ts'
import type { RetryPolicy } from '../src/sim/retry-policy.ts'
import type { TrafficSpec } from '../src/sim/traffic.ts'
import { createTrafficSource, type ScriptedArrivals } from '../src/sim/traffic-source.ts'

/** A Limiter that asks `decide` for every Attempt, in order, and remembers what it was asked. */
function stubLimiter(decide: (clientId: string, nowMs: number) => LimiterDecision) {
  const asked: { clientId: string; nowMs: number }[] = []
  const limiter: Limiter = {
    decide(clientId, nowMs) {
      asked.push({ clientId, nowMs })
      return decide(clientId, nowMs)
    },
    reset() {},
  }
  return { limiter, asked }
}

const allowAll = () => stubLimiter(() => ({ kind: 'allow' })).limiter

interface Setup {
  traffic: TrafficSpec
  scripted?: ScriptedArrivals[]
  limiter?: Limiter
  retry?: RetryPolicy
  backend?: BackendSpec
  decisionDelayMs?: number
  subBucketMs?: number
  seed?: number
}

const noRetry: RetryPolicy = { timeoutMs: 1000, retry: 'none', maxAttempts: 1 }
const quickBackend: BackendSpec = { slots: 1, queueLimit: 10, meanMs: 20, cv: 0 }

/**
 * Builds a traffic source and one engine on it, then advances both to each time in `stops`,
 * the source first, as the runner will.
 */
function run(setup: Setup, stops: number[]): Engine {
  const seed = setup.seed ?? 1
  const source = createTrafficSource({
    spec: setup.traffic,
    stream: createStreams(seed).traffic,
    ...(setup.scripted === undefined ? {} : { scriptedArrivals: setup.scripted }),
  })
  const options: EngineOptions = {
    traffic: source.reader(),
    limiter: setup.limiter ?? allowAll(),
    retry: setup.retry ?? noRetry,
    backend: setup.backend ?? quickBackend,
    streams: createStreams(seed),
    ...(setup.decisionDelayMs === undefined ? {} : { decisionDelayMs: setup.decisionDelayMs }),
    ...(setup.subBucketMs === undefined ? {} : { subBucketMs: setup.subBucketMs }),
  }
  const engine = createEngine(options)
  for (const stop of stops) {
    source.advanceTo(stop)
    engine.advanceTo(stop)
  }
  return engine
}

const tenPerSecond: TrafficSpec = { shape: 'constant', demandRps: 10, clients: ['a'] }
/** No generated traffic: only the scripted Requests. */
const scriptedOnly: TrafficSpec = { shape: 'constant', demandRps: 0, clients: ['a'] }

describe('createEngine', () => {
  it('sends every new Request through the Limiter to the Backend and counts it', () => {
    // Arrivals at 100, 200, ..., 10000 ms; each is served in exactly 20 ms.
    const engine = run({ traffic: tenPerSecond }, [10_000])
    expect(engine.totals()).toEqual({
      requests: { created: 100, succeeded: 99, rejected: 0, timedOut: 0, shed: 0, inFlight: 1 },
      attempts: {
        offered: 100,
        allowed: 100,
        rejected: 0,
        delayed: 0,
        awaitingRelease: 0,
        released: 0,
        droppedAtRelease: 0,
        awaitingDecision: 0,
        shed: 0,
        served: 99,
        inBackend: 1,
        timedOut: 0,
      },
      wastedWorkMs: 0,
    })
  })

  describe('retries', () => {
    const immediate = (maxAttempts: number): RetryPolicy => ({
      timeoutMs: 1000,
      retry: 'immediate',
      maxAttempts,
    })

    it('retries a rejected Attempt at once until one is allowed', () => {
      let calls = 0
      const { limiter, asked } = stubLimiter(() =>
        calls++ < 2 ? { kind: 'reject' } : { kind: 'allow' },
      )
      const engine = run(
        {
          traffic: scriptedOnly,
          scripted: [{ atMs: 100, count: 1 }],
          limiter,
          retry: immediate(3),
        },
        [1000],
      )
      expect(asked).toEqual([
        { clientId: 'a', nowMs: 100 },
        { clientId: 'a', nowMs: 100 },
        { clientId: 'a', nowMs: 100 },
      ])
      expect(engine.totals().attempts).toMatchObject({ offered: 3, rejected: 2, allowed: 1 })
      expect(engine.totals().requests).toMatchObject({ created: 1, succeeded: 1, rejected: 0 })
    })

    it('ends a Request as Rejected when its last Attempt is rejected', () => {
      const { limiter } = stubLimiter(() => ({ kind: 'reject', retryAfterMs: 50 }))
      const engine = run(
        {
          traffic: scriptedOnly,
          scripted: [{ atMs: 100, count: 1 }],
          limiter,
          retry: immediate(2),
        },
        [1000],
      )
      expect(engine.totals().attempts).toMatchObject({ offered: 2, rejected: 2, allowed: 0 })
      expect(engine.totals().requests).toMatchObject({ rejected: 1, inFlight: 0 })
    })

    it('never retries when the policy is none', () => {
      const { limiter } = stubLimiter(() => ({ kind: 'reject' }))
      const engine = run(
        { traffic: scriptedOnly, scripted: [{ atMs: 100, count: 1 }], limiter },
        [1000],
      )
      expect(engine.totals().attempts).toMatchObject({ offered: 1, rejected: 1 })
      expect(engine.totals().requests).toMatchObject({ rejected: 1, inFlight: 0 })
    })

    it('retries a shed Attempt, and ends the Request as Shed when the last one is shed', () => {
      const engine = run(
        {
          traffic: scriptedOnly,
          scripted: [{ atMs: 100, count: 2 }],
          backend: { slots: 1, queueLimit: 0, meanMs: 50, cv: 0 },
          retry: immediate(2),
        },
        [1000],
      )
      expect(engine.totals().attempts).toMatchObject({ offered: 3, allowed: 3, shed: 2, served: 1 })
      expect(engine.totals().requests).toMatchObject({ succeeded: 1, shed: 1, inFlight: 0 })
    })
  })

  describe('timeouts', () => {
    // One slot, 100 ms each: three Requests at 100 ms are served 100-200, 200-300 and 300-400.
    const slowBackend: BackendSpec = { slots: 1, queueLimit: 5, meanMs: 100, cv: 0 }

    it('keeps serving a timed-out Attempt, counts it as Wasted Work and discards its response', () => {
      const engine = run(
        {
          traffic: scriptedOnly,
          scripted: [{ atMs: 100, count: 3 }],
          backend: slowBackend,
          retry: { timeoutMs: 150, retry: 'none', maxAttempts: 1 },
        },
        [1000],
      )
      // The first finishes at 200, before its timeout at 250. The second times out at 250,
      // halfway through its service (50 ms wasted); the third times out at 250 while queued
      // and is still served, 300 to 400 (100 ms wasted).
      expect(engine.totals()).toEqual({
        requests: { created: 3, succeeded: 1, rejected: 0, timedOut: 2, shed: 0, inFlight: 0 },
        attempts: {
          offered: 3,
          allowed: 3,
          rejected: 0,
          delayed: 0,
          awaitingRelease: 0,
          released: 0,
          droppedAtRelease: 0,
          awaitingDecision: 0,
          shed: 0,
          served: 3,
          inBackend: 0,
          timedOut: 2,
        },
        wastedWorkMs: 150,
      })
    })

    it('retries an Attempt that timed out while queued', () => {
      const engine = run(
        {
          traffic: scriptedOnly,
          scripted: [{ atMs: 100, count: 3 }],
          backend: slowBackend,
          retry: { timeoutMs: 160, retry: 'immediate', maxAttempts: 2 },
        },
        [1000],
      )
      // At 260 the second Request's Attempt times out in service and the third's while
      // queued; both retry and queue behind the third's abandoned Attempt (served 300 to
      // 400). The retries time out at 420, one in service (400 to 500), one still queued (then
      // served 500 to 600), with no Attempts left. Wasted: 40 + 100 + 80 + 100 ms.
      expect(engine.totals().requests).toMatchObject({ succeeded: 1, timedOut: 2, inFlight: 0 })
      expect(engine.totals().attempts).toMatchObject({ offered: 5, served: 5, timedOut: 4 })
      expect(engine.totals().wastedWorkMs).toBe(320)
    })

    it('retries a timed-out Attempt, which waits behind the abandoned work', () => {
      const engine = run(
        {
          traffic: scriptedOnly,
          scripted: [{ atMs: 100, count: 2 }],
          backend: slowBackend,
          retry: { timeoutMs: 160, retry: 'immediate', maxAttempts: 2 },
        },
        [1000],
      )
      // The second Request's first Attempt times out at 260 in service; its retry queues and
      // runs 300 to 400, before its own timeout at 420.
      expect(engine.totals().requests).toMatchObject({ succeeded: 2, timedOut: 0, inFlight: 0 })
      expect(engine.totals().attempts).toMatchObject({ offered: 3, served: 3, timedOut: 1 })
      expect(engine.totals().wastedWorkMs).toBe(40)
    })
  })

  describe('Limiter decisions', () => {
    const oneAt100: ScriptedArrivals[] = [{ atMs: 100, count: 1 }]

    it('asks the Limiter after the decision latency, and counts the Attempt as waiting till then', () => {
      const { limiter, asked } = stubLimiter(() => ({ kind: 'allow' }))
      const engine = run(
        { traffic: scriptedOnly, scripted: oneAt100, limiter, decisionDelayMs: 30 },
        [110],
      )
      expect(engine.totals().attempts).toMatchObject({
        offered: 1,
        awaitingDecision: 1,
        allowed: 0,
      })
      expect(asked).toEqual([])
    })

    it('makes the decision at arrival plus the latency', () => {
      const { limiter, asked } = stubLimiter(() => ({ kind: 'allow' }))
      const engine = run(
        { traffic: scriptedOnly, scripted: oneAt100, limiter, decisionDelayMs: 30 },
        [110, 1000],
      )
      expect(asked).toEqual([{ clientId: 'a', nowMs: 130 }])
      expect(engine.totals().attempts).toMatchObject({ awaitingDecision: 0, allowed: 1 })
      expect(engine.totals().requests).toMatchObject({ succeeded: 1 })
    })

    // Each Attempt waits 300 ms for its decision but times out after 200. The first times out
    // at 300 and retries; the retry times out at 500, the last allowed Attempt, so the Request
    // ends Timed out. The late decisions (400 and 600) must not retry or end it again.
    it.each<[string, LimiterDecision, object]>([
      ['allowed: it is served as Wasted Work', { kind: 'allow' }, { allowed: 2, served: 2 }],
      ['rejected: it does not retry or end the Request again', { kind: 'reject' }, { rejected: 2 }],
    ])(
      'still decides an Attempt that timed out while waiting, and when %s',
      (_, decision, attemptCounts) => {
        const { limiter } = stubLimiter(() => decision)
        const engine = run(
          {
            traffic: scriptedOnly,
            scripted: oneAt100,
            limiter,
            decisionDelayMs: 300,
            retry: { timeoutMs: 200, retry: 'immediate', maxAttempts: 2 },
            backend: { slots: 1, queueLimit: 0, meanMs: 100, cv: 0 },
          },
          [1000],
        )
        expect(engine.totals().attempts).toMatchObject({
          offered: 2,
          timedOut: 2,
          ...attemptCounts,
        })
        expect(engine.totals().requests).toEqual({
          created: 1,
          succeeded: 0,
          rejected: 0,
          timedOut: 1,
          shed: 0,
          inFlight: 0,
        })
        // Allowed: served 400 to 500 and 600 to 700, both after their timeouts.
        expect(engine.totals().wastedWorkMs).toBe(decision.kind === 'allow' ? 200 : 0)
      },
    )
  })

  describe('Delay and release', () => {
    const oneAt100: ScriptedArrivals[] = [{ atMs: 100, count: 1 }]
    const delayBy = (ms: number) =>
      stubLimiter((_, nowMs) => ({ kind: 'delay', releaseAtMs: nowMs + ms })).limiter

    it('holds a Delayed Attempt and sends it to the Backend at releaseAtMs', () => {
      const setup: Setup = { traffic: scriptedOnly, scripted: oneAt100, limiter: delayBy(300) }
      const waiting = run(setup, [399])
      expect(waiting.totals().attempts).toMatchObject({
        offered: 1,
        allowed: 0,
        delayed: 1,
        awaitingRelease: 1,
        released: 0,
        inBackend: 0,
      })
      // Released at 400 and served 400 to 420. Its latency counts from 100, when it reached
      // the Limiter, so the wait is in it (ADR 0001).
      const done = run(setup, [399, 2000])
      expect(done.totals().attempts).toMatchObject({
        delayed: 1,
        awaitingRelease: 0,
        released: 1,
        droppedAtRelease: 0,
        served: 1,
      })
      expect(done.totals().requests).toMatchObject({ succeeded: 1, inFlight: 0 })
      expect(done.snapshots()[0]).toMatchObject({ delayed: 1, allowed: 0, goodput: 1, p50: 320 })
      expect(done.allowedSubBuckets().counts.every((x) => x === 0)).toBe(true)
    })

    it('drops a Delayed Attempt that timed out before its release, so it never uses the Backend', () => {
      const engine = run(
        {
          traffic: scriptedOnly,
          scripted: oneAt100,
          limiter: delayBy(300),
          retry: { timeoutMs: 200, retry: 'none', maxAttempts: 1 },
        },
        [2000],
      )
      expect(engine.totals()).toMatchObject({
        requests: { created: 1, succeeded: 0, timedOut: 1, inFlight: 0 },
        attempts: {
          delayed: 1,
          timedOut: 1,
          awaitingRelease: 0,
          released: 0,
          droppedAtRelease: 1,
          served: 0,
          inBackend: 0,
        },
        wastedWorkMs: 0,
      })
      expect(engine.snapshots()[0]?.backendUtil).toBe(0)
    })

    it('drops an Attempt whose release comes at the same moment as its timeout', () => {
      // Reached the Limiter at 100, timeout 200: both the timeout and the release are at 300.
      // The caller has stopped waiting at 300, so nothing is offeredLoad to the Backend.
      const engine = run(
        {
          traffic: scriptedOnly,
          scripted: oneAt100,
          limiter: delayBy(200),
          retry: { timeoutMs: 200, retry: 'none', maxAttempts: 1 },
        },
        [2000],
      )
      expect(engine.totals().attempts).toMatchObject({ droppedAtRelease: 1, released: 0 })
      expect(engine.totals().requests).toMatchObject({ timedOut: 1, succeeded: 0 })
    })

    it('counts the decision latency and the hold in the Attempt latency', () => {
      // Reaches the Limiter at 100, decided at 130, held until 330, served 330 to 350.
      const engine = run(
        { traffic: scriptedOnly, scripted: oneAt100, limiter: delayBy(200), decisionDelayMs: 30 },
        [2000],
      )
      expect(engine.snapshots()[0]).toMatchObject({ goodput: 1, p50: 250 })
    })

    it('sheds a released Attempt when the Backend is full, and retries it', () => {
      // Two Attempts released together at 400 to one slot with no queue: the second is shed,
      // retries at once, is Delayed again and released at 700, when the slot is free.
      const engine = run(
        {
          traffic: scriptedOnly,
          scripted: [{ atMs: 100, count: 2 }],
          limiter: delayBy(300),
          retry: { timeoutMs: 1000, retry: 'immediate', maxAttempts: 2 },
          backend: { slots: 1, queueLimit: 0, meanMs: 100, cv: 0 },
        },
        [2000],
      )
      expect(engine.totals().attempts).toMatchObject({
        offered: 3,
        delayed: 3,
        released: 3,
        shed: 1,
        served: 2,
      })
      expect(engine.totals().requests).toMatchObject({ succeeded: 2, shed: 0 })
    })

    it('throws a RangeError if the Limiter releases an Attempt before it was decided', () => {
      const { limiter } = stubLimiter((_, nowMs) => ({ kind: 'delay', releaseAtMs: nowMs - 1 }))
      expect(() => run({ traffic: scriptedOnly, scripted: oneAt100, limiter }, [1000])).toThrow(
        RangeError,
      )
    })
  })

  describe('a mixed, overloaded run', () => {
    // Poisson at 300 rps from three Clients, a Limiter that rejects, delays (by 0 to 199 ms,
    // so some Attempts time out while held) or allows in a fixed time pattern, immediate
    // retries and a Backend that serves about 267 rps: every path gets used.
    const mixed = (): Setup => ({
      traffic: { shape: 'poisson', demandRps: 300, clients: ['a', 'b', 'c'] },
      scripted: [{ atMs: 2000, count: 200, clientId: 'b' }],
      limiter: stubLimiter((_, nowMs): LimiterDecision => {
        const phase = Math.floor(nowMs / 7) % 4
        if (phase === 0) return { kind: 'reject' }
        if (phase === 1) return { kind: 'delay', releaseAtMs: nowMs + (Math.floor(nowMs) % 200) }
        return { kind: 'allow' }
      }).limiter,
      retry: { timeoutMs: 150, retry: 'immediate', maxAttempts: 3 },
      backend: { slots: 4, queueLimit: 20, meanMs: 15, cv: 1 },
      decisionDelayMs: 2,
      seed: 99,
    })
    const UNTIL_MS = 20_000

    /** Stops at random times from a separate seeded stream, some of them zero-length steps. */
    function randomStops(seed: number): number[] {
      const stream = createRandomStream(seed)
      const stops: number[] = []
      for (let t = 0; t < UNTIL_MS;) {
        t = Math.min(UNTIL_MS, t + (stream.next() < 0.1 ? 0 : stream.next() * 120))
        stops.push(t)
      }
      return stops
    }

    it('conserves Attempts and Requests at every stop', () => {
      const setup = mixed()
      const source = createTrafficSource({
        spec: setup.traffic,
        stream: createStreams(99).traffic,
        scriptedArrivals: setup.scripted ?? [],
      })
      const engine = createEngine({
        traffic: source.reader(),
        limiter: setup.limiter ?? allowAll(),
        retry: setup.retry ?? noRetry,
        backend: setup.backend ?? quickBackend,
        streams: createStreams(99),
        decisionDelayMs: 2,
      })
      for (const stop of randomStops(5)) {
        source.advanceTo(stop)
        engine.advanceTo(stop)
        const { requests, attempts } = engine.totals()
        expect(attempts.offered).toBe(
          attempts.allowed + attempts.rejected + attempts.delayed + attempts.awaitingDecision,
        )
        expect(attempts.delayed).toBe(
          attempts.released + attempts.droppedAtRelease + attempts.awaitingRelease,
        )
        expect(attempts.allowed + attempts.released).toBe(
          attempts.shed + attempts.served + attempts.inBackend,
        )
        expect(requests.created).toBe(
          requests.succeeded +
            requests.rejected +
            requests.timedOut +
            requests.shed +
            requests.inFlight,
        )
      }
      const { requests, attempts, wastedWorkMs } = engine.totals()
      // Every path was taken, so the checks above were not vacuous.
      expect(
        Math.min(requests.succeeded, requests.rejected, requests.timedOut, requests.shed),
      ).toBeGreaterThan(0)
      expect(attempts.offered).toBeGreaterThan(requests.created)
      expect(Math.min(attempts.released, attempts.droppedAtRelease)).toBeGreaterThan(0)
      expect(wastedWorkMs).toBeGreaterThan(0)
    })

    // Random times almost never tie, so the second setup uses whole-ms arrivals (every 10 ms)
    // and fixed 20 ms services: arrivals, service ends and timeouts land on the same times
    // all the time, and the order at a tie decides between queued and shed.
    const ties = (): Setup => ({
      traffic: { shape: 'constant', demandRps: 100, clients: ['a'] },
      retry: { timeoutMs: 100, retry: 'immediate', maxAttempts: 2 },
      backend: { slots: 1, queueLimit: 5, meanMs: 20, cv: 0 },
    })

    /** Stops every `stepMs`, so with whole-ms events many stops land exactly on one. */
    const every = (stepMs: number) =>
      Array.from({ length: UNTIL_MS / stepMs }, (_, i) => (i + 1) * stepMs)

    it.each([
      ['random times', mixed],
      ['exact ties', ties],
    ])('gives identical results however the run is chunked (%s)', (_, setup) => {
      const once = run(setup(), [UNTIL_MS])
      for (const stops of [
        randomStops(1),
        randomStops(2),
        randomStops(3),
        every(10),
        every(1000),
      ]) {
        const chunked = run(setup(), stops)
        expect(chunked.totals()).toEqual(once.totals())
        expect(chunked.snapshots()).toEqual(once.snapshots())
        expect(chunked.allowedSubBuckets()).toEqual(once.allowedSubBuckets())
      }
    })

    it('has Snapshots that add up to the totals', () => {
      const engine = run(mixed(), [UNTIL_MS])
      const snapshots = engine.snapshots()
      const sum = (pick: (snapshot: Snapshot) => number) =>
        snapshots.reduce((total, snapshot) => total + pick(snapshot), 0)
      const { requests, attempts, wastedWorkMs } = engine.totals()
      expect(snapshots.map((snapshot) => snapshot.t)).toEqual(
        Array.from({ length: 20 }, (_, i) => (i + 1) * 1000),
      )
      // No event lands at exactly 20,000 ms in this run, so every event is in some Snapshot.
      expect({
        demand: sum((x) => x.demand),
        offeredLoad: sum((x) => x.offeredLoad),
        allowed: sum((x) => x.allowed),
        rejected: sum((x) => x.rejected),
        delayed: sum((x) => x.delayed),
        shed: sum((x) => x.shed),
        goodput: sum((x) => x.goodput),
        failedRejected: sum((x) => x.failed.rejected),
        failedTimedOut: sum((x) => x.failed.timedOut),
        failedShed: sum((x) => x.failed.shed),
      }).toEqual({
        demand: requests.created,
        offeredLoad: attempts.offered,
        allowed: attempts.allowed,
        rejected: attempts.rejected,
        delayed: attempts.delayed,
        shed: attempts.shed,
        goodput: requests.succeeded,
        failedRejected: requests.rejected,
        failedTimedOut: requests.timedOut,
        failedShed: requests.shed,
      })
      expect(sum((x) => x.wastedWorkMs)).toBeCloseTo(wastedWorkMs, 6)
      for (const snapshot of snapshots) {
        const perClient = Object.values(snapshot.perClient)
        expect(perClient.reduce((total, x) => total + x.offeredLoad, 0)).toBe(snapshot.offeredLoad)
        expect(perClient.reduce((total, x) => total + x.allowed, 0)).toBe(snapshot.allowed)
      }
    })

    it('counts allowed Attempts in sub-buckets that add up to the allowed total', () => {
      const engine = run({ ...mixed(), subBucketMs: 250 }, [UNTIL_MS])
      const { bucketMs, counts } = engine.allowedSubBuckets()
      expect(bucketMs).toBe(250)
      expect(counts.length).toBe(UNTIL_MS / 250)
      expect(counts.reduce((total, x) => total + x, 0)).toBe(engine.totals().attempts.allowed)
      // Each second's four sub-buckets add up to that second's allowed count.
      engine.snapshots().forEach((snapshot, i) => {
        const second = counts.slice(i * 4, i * 4 + 4).reduce((total, x) => total + x, 0)
        expect(second).toBe(snapshot.allowed)
      })
    })

    it('puts an Attempt allowed on a sub-bucket edge in the sub-bucket that starts there', () => {
      // 2100 / (100 / 3) rounds to just under 63, so dividing alone would count the Attempt
      // at 2100 ms in sub-bucket 62, which ends at 2100.
      const engine = run(
        {
          traffic: scriptedOnly,
          scripted: [{ atMs: 2100, count: 1 }],
          subBucketMs: 100 / 3,
        },
        [3000],
      )
      const { counts } = engine.allowedSubBuckets()
      expect(counts[62]).toBe(0)
      expect(counts[63]).toBe(1)
    })

    it('flags the first five seconds as warm-up', () => {
      const flags = run(mixed(), [8000])
        .snapshots()
        .map((snapshot) => snapshot.warmUp)
      expect(flags).toEqual([true, true, true, true, true, false, false, false])
    })

    it('never reports NaN or Infinity, and keeps utilization in [0, 1]', () => {
      const snapshots = run(mixed(), [UNTIL_MS]).snapshots()
      const numbers = (value: unknown): number[] =>
        typeof value === 'number'
          ? [value]
          : typeof value === 'object' && value !== null
            ? Object.values(value).flatMap(numbers)
            : []
      for (const snapshot of snapshots) {
        expect(numbers(snapshot).every(Number.isFinite)).toBe(true)
        expect(snapshot.backendUtil).toBeGreaterThanOrEqual(0)
        expect(snapshot.backendUtil).toBeLessThanOrEqual(1)
        expect(snapshot.queueDepth).toBeLessThanOrEqual(20)
      }
      // The run is overloaded, so the bound is really tested.
      expect(Math.max(...snapshots.map((x) => x.backendUtil))).toBeGreaterThan(0.95)
    })

    it('keeps utilization at most 1 in a long saturated run', () => {
      // Every slot busy all the time: the true value is exactly 1, and the busy time is a
      // running total, so rounding in the difference of two large totals must not push it over.
      const snapshots = run(
        {
          traffic: { shape: 'poisson', demandRps: 400, clients: ['a'] },
          backend: { slots: 3, queueLimit: 50, meanMs: 10, cv: 1 },
          seed: 3,
        },
        [120_000],
      ).snapshots()
      expect(snapshots.filter((x) => x.backendUtil > 1)).toEqual([])
      expect(snapshots.filter((x) => x.backendUtil === 1).length).toBeGreaterThan(50)
    })

    it('counts scripted Requests in Demand', () => {
      const snapshots = run(mixed(), [3000]).snapshots()
      // 200 scripted at exactly 2000 ms land in [2000, 3000), on top of about 300 generated.
      // 400 or more needs 200 or more generated; the generated count's standard error is
      // sqrt(300) = 17, so that floor is 5.8 standard errors below its mean.
      expect(snapshots[2]?.demand).toBeGreaterThan(snapshots[1]?.demand ?? Infinity)
      expect(snapshots[2]?.demand).toBeGreaterThanOrEqual(400)
    })
  })

  describe('snapshots', () => {
    it('takes one Snapshot per simulated second, measured from that second', () => {
      // Arrivals at 100, 200, ... ms, each served in exactly 20 ms on one slot.
      const engine = run({ traffic: tenPerSecond }, [2500])
      const quiet = {
        rejected: 0,
        delayed: 0,
        failed: { rejected: 0, timedOut: 0, shed: 0 },
        wastedWorkMs: 0,
        queueDepth: 0,
        shed: 0,
        p50: 20,
        p95: 20,
        p99: 20,
        e2eP50: 20,
        e2eP95: 20,
        e2eP99: 20,
        warmUp: true,
      }
      expect(engine.snapshots()).toEqual([
        // [0, 1000): arrivals at 100 to 900.
        {
          ...quiet,
          t: 1000,
          demand: 9,
          offeredLoad: 9,
          allowed: 9,
          goodput: 9,
          backendUtil: 0.18,
          perClient: { a: { offeredLoad: 9, allowed: 9 } },
        },
        // [1000, 2000): arrivals at 1000 to 1900. 2500 is mid-second, so no third Snapshot.
        {
          ...quiet,
          t: 2000,
          demand: 10,
          offeredLoad: 10,
          allowed: 10,
          goodput: 10,
          backendUtil: 0.2,
          perClient: { a: { offeredLoad: 10, allowed: 10 } },
        },
      ])
    })

    it('reads percentiles by nearest rank from latencies in the last 5 s, and null when there are none', () => {
      // 100 Requests at 100 ms on one 10 ms slot: the nth finishes at 100 + 10n, latency 10n.
      const engine = run(
        {
          traffic: scriptedOnly,
          scripted: [{ atMs: 100, count: 100 }],
          backend: { slots: 1, queueLimit: 100, meanMs: 10, cv: 0 },
          retry: { timeoutMs: 5000, retry: 'none', maxAttempts: 1 },
        },
        [8000],
      )
      const latencies = engine.snapshots().map(({ t, p50, p95, p99 }) => ({ t, p50, p95, p99 }))
      // One Attempt per Request, all at 100 ms, so end-to-end latency is the same here.
      expect(
        engine
          .snapshots()
          .map(({ t, e2eP50, e2eP95, e2eP99 }) => ({ t, p50: e2eP50, p95: e2eP95, p99: e2eP99 })),
      ).toEqual(latencies)
      expect(latencies).toEqual([
        // 89 latencies, 10 to 890: ranks 45, 85 and 89.
        { t: 1000, p50: 450, p95: 850, p99: 890 },
        // All 100, 10 to 1000: ranks 50, 95 and 99. They stay in the window until 5 s later.
        { t: 2000, p50: 500, p95: 950, p99: 990 },
        { t: 3000, p50: 500, p95: 950, p99: 990 },
        { t: 4000, p50: 500, p95: 950, p99: 990 },
        { t: 5000, p50: 500, p95: 950, p99: 990 },
        // [1000, 6000) holds the 11 that finished at 1000 ms or later, 900 to 1000: ranks 6, 11, 11.
        { t: 6000, p50: 950, p95: 1000, p99: 1000 },
        { t: 7000, p50: null, p95: null, p99: null },
        { t: 8000, p50: null, p95: null, p99: null },
      ])
    })

    it('measures end-to-end latency from the first Attempt, and Attempt latency from its own start', () => {
      // As in the timeout test: the second Request's retry starts at 260 and succeeds at 400.
      const engine = run(
        {
          traffic: scriptedOnly,
          scripted: [{ atMs: 100, count: 2 }],
          backend: { slots: 1, queueLimit: 5, meanMs: 100, cv: 0 },
          retry: { timeoutMs: 160, retry: 'immediate', maxAttempts: 2 },
        },
        [1000],
      )
      expect(engine.snapshots()[0]).toMatchObject({
        p50: 100,
        p99: 140,
        e2eP50: 100,
        e2eP99: 300,
        goodput: 2,
        offeredLoad: 3,
        demand: 2,
        wastedWorkMs: 40,
      })
    })
  })

  describe('invalid options', () => {
    it.each<[string, Partial<Setup>]>([
      ['a timeout of 0', { retry: { timeoutMs: 0, retry: 'none', maxAttempts: 1 } }],
      ['an infinite timeout', { retry: { timeoutMs: Infinity, retry: 'none', maxAttempts: 1 } }],
      ['0 max attempts', { retry: { timeoutMs: 100, retry: 'none', maxAttempts: 0 } }],
      ['fractional max attempts', { retry: { timeoutMs: 100, retry: 'none', maxAttempts: 1.5 } }],
      ['a negative decision latency', { decisionDelayMs: -1 }],
      ['a sub-bucket of 0 ms', { subBucketMs: 0 }],
      ['a Backend with no slots', { backend: { slots: 0, queueLimit: 0, meanMs: 10, cv: 0 } }],
    ])('throws a RangeError for %s', (_, change) => {
      expect(() => run({ traffic: tenPerSecond, ...change }, [])).toThrow(RangeError)
    })

    it('throws a RangeError if time goes backwards', () => {
      const engine = run({ traffic: tenPerSecond }, [500])
      expect(() => engine.advanceTo(400)).toThrow(RangeError)
    })
  })
})
