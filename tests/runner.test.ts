import { describe, expect, it } from 'vitest'
import { createRunner, FRAME_CAP_MS, type Runner } from '../src/runner/runner.ts'
import { subBucketMsFor, type Scenario } from '../src/runner/scenario.ts'
import { createEngine } from '../src/sim/engine.ts'
import { createLimiter } from '../src/sim/limiter.ts'
import { createStreams } from '../src/sim/rng.ts'
import { createTrafficSource, type ControlChange } from '../src/sim/traffic-source.ts'

/**
 * Three Variants on traffic that keeps every path busy: 200 rps against Limiters allowing 120
 * per second, in front of a Backend with a ceiling of 4 x (1000 / 40) = 100 rps, with a
 * scripted demand step, a burst and an Edge Burst.
 */
const scenario: Scenario = {
  id: 'runner-test',
  title: 'Runner test',
  lesson: 'None: a test fixture.',
  models: 'Three Limiters in front of one small Backend.',
  leavesOut: 'Everything a lesson would need.',
  seed: 11,
  traffic: {
    shape: 'poisson',
    demandRps: 200,
    clients: ['a', 'b', 'c'],
    greedy: { clientId: 'a', multiplier: 2 },
  },
  controls: [
    { atMs: 2000, change: { kind: 'demand', demandRps: 150 } },
    { atMs: 4000, change: { kind: 'burst', multiplier: 2, durationMs: 1000 } },
  ],
  scriptedArrivals: [{ atMs: 990, count: 30, clientId: 'b' }],
  backend: { slots: 4, queueLimit: 20, meanMs: 40, cv: 1 },
  variants: [
    {
      label: 'Fixed window',
      limiter: { algo: 'fixed-window', keyBy: 'global', limit: 60, windowMs: 500 },
      retry: { timeoutMs: 150, maxAttempts: 3, retry: 'immediate' },
    },
    {
      label: 'Token bucket',
      limiter: { algo: 'token-bucket', keyBy: 'client', capacity: 20, refillPerSec: 40 },
      retry: { timeoutMs: 150, maxAttempts: 3, retry: 'backoff-jitter', baseDelayMs: 50 },
    },
    {
      label: 'Sliding counter',
      limiter: { algo: 'sliding-counter', keyBy: 'global', limit: 60, windowMs: 500 },
      retry: { timeoutMs: 150, maxAttempts: 3, retry: 'retry-after', baseDelayMs: 50 },
    },
  ],
}

/** A budget no frame here reaches, so these tests see the runner without it. */
const UNLIMITED = { eventBudget: Number.POSITIVE_INFINITY }

/** Ticks at speed 1 with wall times cycling through `frameMs` until simulated time is `untilMs`. */
function tickTo(runner: Runner, untilMs: number, frameMs: readonly number[] = [16]): void {
  for (let i = 0; runner.view().simMs < untilMs; i++) {
    const frame = frameMs[i % frameMs.length] as number
    runner.tick(Math.min(frame, untilMs - runner.view().simMs))
  }
}

/** What a Variant reports, without its label, to compare runs. */
function results(runner: Runner) {
  return runner.view().variants.map(({ snapshots, totals, allowedSubBuckets }) => ({
    snapshots: [...snapshots],
    totals,
    allowedSubBuckets: { ...allowedSubBuckets, counts: [...allowedSubBuckets.counts] },
  }))
}

/** The same Scenario built by hand from src/sim, advanced to `untilMs` in one step. */
function runDirectly(s: Scenario, untilMs: number) {
  const source = createTrafficSource({
    spec: s.traffic,
    stream: createStreams(s.seed).traffic,
    controls: s.controls ?? [],
    scriptedArrivals: s.scriptedArrivals ?? [],
  })
  const engines = s.variants.map((variant) =>
    createEngine({
      traffic: source.reader(),
      limiter: createLimiter(variant.limiter),
      retry: variant.retry,
      backend: s.backend,
      streams: createStreams(s.seed),
      subBucketMs: subBucketMsFor(variant.limiter),
    }),
  )
  source.advanceTo(untilMs)
  return engines.map((engine) => {
    engine.advanceTo(untilMs)
    return {
      snapshots: [...engine.snapshots()],
      totals: engine.totals(),
      allowedSubBuckets: engine.allowedSubBuckets(),
      eventsHandled: engine.eventsHandled(),
    }
  })
}

/** `runDirectly` without the per-Variant event counts, which the runner's view only reports summed. */
const resultsDirectly = (s: Scenario, untilMs: number) =>
  runDirectly(s, untilMs).map(({ snapshots, totals, allowedSubBuckets }) => ({
    snapshots,
    totals,
    allowedSubBuckets,
  }))

describe('createRunner', () => {
  it('starts at 0, running at speed 1, with one entry per Variant', () => {
    const view = createRunner(scenario, UNLIMITED).view()
    expect(view).toMatchObject({ simMs: 0, paused: false, speed: 1, behind: false })
    expect(view.variants.map((variant) => variant.label)).toEqual([
      'Fixed window',
      'Token bucket',
      'Sliding counter',
    ])
    expect(view.variants.map((variant) => variant.allowedSubBuckets.bucketMs)).toEqual([
      50, 100, 50,
    ])
  })

  it('throws a RangeError for an invalid Scenario', () => {
    expect(() => createRunner({ ...scenario, variants: [] })).toThrow(RangeError)
  })
})

describe('eventsHandled', () => {
  it('is 0 at the start, and the sum over every Variant of the same run done directly', () => {
    const runner = createRunner(scenario, UNLIMITED)
    expect(runner.view().eventsHandled).toBe(0)
    tickTo(runner, 6000)
    const direct = runDirectly(scenario, 6000).map((v) => v.eventsHandled)
    // Each Variant handles a different number, so a total from one Variant would not match.
    expect(new Set(direct).size).toBeGreaterThan(1)
    expect(runner.view().eventsHandled).toBe(direct.reduce((sum, n) => sum + n, 0))
  })

  it('goes back to 0 on reset', () => {
    const runner = createRunner(scenario, UNLIMITED)
    tickTo(runner, 2000)
    expect(runner.view().eventsHandled).toBeGreaterThan(0)
    runner.reset()
    expect(runner.view().eventsHandled).toBe(0)
  })
})

describe('tick', () => {
  it.each([
    [0.5, 50],
    [1, 100],
    [10, 1000],
  ] as const)('at speed %s advances %s ms of simulated time per 100 ms frame', (speed, step) => {
    const runner = createRunner(scenario, UNLIMITED)
    runner.setSpeed(speed)
    for (let i = 1; i <= 10; i++) {
      runner.tick(100)
      expect(runner.view().simMs).toBe(i * step)
    }
  })

  it(`caps a frame at ${FRAME_CAP_MS} ms of wall time, so a long frame never jumps the run ahead`, () => {
    const runner = createRunner(scenario, UNLIMITED)
    runner.tick(5000)
    expect(runner.view().simMs).toBe(FRAME_CAP_MS)
    runner.setSpeed(10)
    runner.tick(60_000)
    expect(runner.view().simMs).toBe(FRAME_CAP_MS + FRAME_CAP_MS * 10)
  })

  it('throws a RangeError for a negative or non-finite frame time', () => {
    const runner = createRunner(scenario, UNLIMITED)
    for (const wallMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => runner.tick(wallMs)).toThrow(RangeError)
    }
  })

  it('throws a RangeError for a speed it does not offer', () => {
    const runner = createRunner(scenario, UNLIMITED)
    expect(() => runner.setSpeed(2 as 1)).toThrow(RangeError)
    expect(runner.view().speed).toBe(1)
  })
})

describe('pause and resume', () => {
  it('changes nothing while paused, and resumes from the same time', () => {
    const runner = createRunner(scenario, UNLIMITED)
    tickTo(runner, 3000)
    const before = results(runner)
    runner.pause()
    expect(runner.view().paused).toBe(true)
    for (let i = 0; i < 100; i++) runner.tick(16)
    expect(runner.view().simMs).toBe(3000)
    expect(results(runner)).toEqual(before)
    runner.resume()
    expect(runner.view().paused).toBe(false)
    runner.tick(16)
    expect(runner.view().simMs).toBe(3016)
  })
})

describe('the shared traffic and lockstep', () => {
  it('gives every Variant the same Demand in every Snapshot', () => {
    const runner = createRunner(scenario, UNLIMITED)
    tickTo(runner, 10_000, [16, 33, 100])
    const demands = runner.view().variants.map((v) => v.snapshots.map((s) => s.demand))
    expect(demands[0]).toHaveLength(10)
    expect(demands[1]).toEqual(demands[0])
    expect(demands[2]).toEqual(demands[0])
    // Not vacuous: the Variants differ in what they let through.
    const allowed = runner.view().variants.map((v) => v.totals.attempts.allowed)
    expect(new Set(allowed).size).toBe(3)
  })

  it.each([
    ['60 fps frames', [16.67]],
    ['uneven frames', [16, 3, 100, 47.5, 0, 8]],
    ['whole sub-steps', [50]],
  ])(
    'equals each engine run directly to the same time, whatever the frame sizes (%s)',
    (_, frames) => {
      const runner = createRunner(scenario, UNLIMITED)
      tickTo(runner, 8000, frames)
      expect(runner.view().simMs).toBe(8000)
      expect(results(runner)).toEqual(resultsDirectly(scenario, 8000))
    },
  )
})

describe('reset', () => {
  it('goes back to 0 and replays the identical run, without the live changes', () => {
    const fresh = createRunner(scenario, UNLIMITED)
    tickTo(fresh, 6000)

    const runner = createRunner(scenario, UNLIMITED)
    tickTo(runner, 3000)
    runner.applyControl({ kind: 'demand', demandRps: 400 })
    tickTo(runner, 6000)
    expect(results(runner)).not.toEqual(results(fresh))
    runner.reset()
    expect(runner.view().simMs).toBe(0)
    expect(runner.view().variants.every((v) => v.snapshots.length === 0)).toBe(true)
    tickTo(runner, 6000)
    expect(results(runner)).toEqual(results(fresh))
    expect(runner.view().timeline).toEqual(scenario.controls)
  })

  it('keeps the speed and whether the run is paused', () => {
    const runner = createRunner(scenario, UNLIMITED)
    runner.setSpeed(10)
    runner.pause()
    runner.reset()
    expect(runner.view()).toMatchObject({ simMs: 0, speed: 10, paused: true })
  })
})

describe('live controls', () => {
  const change: ControlChange = { kind: 'demand', demandRps: 400 }

  it('changes Demand from the current time and records it in the timeline', () => {
    const runner = createRunner(scenario, UNLIMITED)
    const unchanged = createRunner(scenario, UNLIMITED)
    tickTo(runner, 6000)
    tickTo(unchanged, 10_000)
    runner.applyControl(change)
    expect(runner.view().timeline.at(-1)).toEqual({ atMs: 6000, change })
    tickTo(runner, 10_000)
    const demand = (r: Runner) => r.view().variants[0]?.snapshots.map((s) => s.demand) ?? []
    // The first 6 seconds are untouched; the last 4 run at 400 rps instead of 150.
    expect(demand(runner).slice(0, 6)).toEqual(demand(unchanged).slice(0, 6))
    for (const d of demand(runner).slice(6)) expect(d).toBeGreaterThan(330)
    for (const d of demand(unchanged).slice(6)) expect(d).toBeLessThan(220)
  })

  it('replays exactly from the seed and the recorded timeline', () => {
    const live = createRunner(scenario, UNLIMITED)
    tickTo(live, 3000, [16.67])
    live.applyControl(change)
    tickTo(live, 5500, [16.67])
    live.applyControl({ kind: 'greedyMultiplier', clientId: 'c', multiplier: 4 })
    live.applyControl({ kind: 'shape', shape: 'constant' })
    tickTo(live, 9000, [16.67])

    const replay = createRunner({ ...scenario, controls: live.view().timeline }, UNLIMITED)
    tickTo(replay, 9000, [33, 7])
    expect(results(replay)).toEqual(results(live))
    expect(replay.view().timeline).toEqual(live.view().timeline)
  })

  it('works while paused, at the paused time', () => {
    const runner = createRunner(scenario, UNLIMITED)
    tickTo(runner, 2500)
    runner.pause()
    runner.applyControl(change)
    expect(runner.view().timeline.at(-1)).toEqual({ atMs: 2500, change })
  })

  it('throws a RangeError on an invalid change, leaving the timeline alone', () => {
    const runner = createRunner(scenario, UNLIMITED)
    tickTo(runner, 2500)
    const before = runner.view().timeline
    expect(() => runner.applyControl({ kind: 'demand', demandRps: -1 })).toThrow(RangeError)
    expect(runner.view().timeline).toEqual(before)
  })
})

describe('trimming the traffic log', () => {
  it('keeps no arrival every Variant has read, over a long run', () => {
    const runner = createRunner(scenario, UNLIMITED)
    let created = 0
    let mostRetained = 0
    for (let i = 0; i < 600; i++) {
      runner.tick(100)
      mostRetained = Math.max(mostRetained, runner.retainedArrivals())
    }
    created = runner.view().variants[0]?.totals.requests.created ?? 0
    // About 150 rps for 60 s. Every engine reads to the end of each frame, so a trim at the
    // end of the frame drops all of it; without the trim the log keeps every Request. That
    // trimming leaves results alone is shown above: the runner equals untrimmed engines run
    // directly.
    expect(created).toBeGreaterThan(8000)
    expect(mostRetained).toBe(0)
  })
})

describe('the event budget', () => {
  /** Events every Variant together handles in the first simulated second. */
  const firstSecond = runDirectly(scenario, 1000).map((variant) => variant.eventsHandled)
  const allTogether = firstSecond.reduce((a, b) => a + b, 0)

  it('stops a heavy frame early, with every Variant at the same time, and says it is behind', () => {
    const runner = createRunner(scenario, { eventBudget: allTogether / 4 })
    runner.setSpeed(10)
    runner.tick(100)
    const { simMs, behind } = runner.view()
    expect(simMs).toBeGreaterThan(0)
    expect(simMs).toBeLessThan(1000)
    expect(behind).toBe(true)
    // Every engine is exactly where one run straight to that time would be.
    expect(results(runner)).toEqual(resultsDirectly(scenario, simMs))
  })

  it('clears the notice on the next frame that fits', () => {
    const runner = createRunner(scenario, { eventBudget: allTogether / 4 })
    runner.setSpeed(10)
    runner.tick(100)
    expect(runner.view().behind).toBe(true)
    runner.setSpeed(1)
    runner.tick(16)
    expect(runner.view().behind).toBe(false)
  })

  it('returns from each tick whether that frame hit the budget, so no frame goes unseen', () => {
    const runner = createRunner(scenario, { eventBudget: allTogether / 4 })
    runner.setSpeed(10)
    expect(runner.tick(100)).toBe(true)
    runner.setSpeed(1)
    expect(runner.tick(16)).toBe(false)
    runner.pause()
    expect(runner.tick(16)).toBe(false)
  })

  it('counts the events of every Variant together', () => {
    // Above what any one Variant handles in the second, below what all three handle.
    const budget = (Math.max(...firstSecond) + allTogether) / 2
    expect(budget).toBeLessThan(allTogether)
    const runner = createRunner(scenario, { eventBudget: budget })
    runner.setSpeed(10)
    runner.tick(100)
    expect(runner.view().simMs).toBeLessThan(1000)
    expect(runner.view().behind).toBe(true)
  })

  it('changes how fast the run goes, never its results', () => {
    const limited = createRunner(scenario, { eventBudget: 300 })
    limited.setSpeed(10)
    let frames = 0
    while (limited.view().simMs < 8000) {
      limited.tick(Math.min(100, (8000 - limited.view().simMs) / 10))
      frames++
    }
    // 8 frames of 1,000 ms would do at full speed; the budget made it take 71.
    expect(frames).toBeGreaterThan(40)
    const unlimited = createRunner(scenario, UNLIMITED)
    tickTo(unlimited, 8000)
    expect(limited.view().simMs).toBe(8000)
    expect(results(limited)).toEqual(results(unlimited))
  })

  it('throws a RangeError for a budget that is not more than 0', () => {
    for (const eventBudget of [0, -1, Number.NaN]) {
      expect(() => createRunner(scenario, { eventBudget })).toThrow(RangeError)
    }
  })
})
