/**
 * The Backend and the engine against textbook queueing results (RS-14b). Each test uses one
 * fixed seed and a band about twice the worst error over seeds 1 to 8, measured with
 * .scratch/queueing/probe.ts and engine-probe.ts (table in .scratch/queueing/spec.md).
 */
import { describe, expect, it } from 'vitest'
import type { BackendSpec } from '../src/sim/backend.ts'
import { baselineP99Ms } from '../src/sim/baseline.ts'
import { createEngine } from '../src/sim/engine.ts'
import type { Snapshot } from '../src/sim/metrics.ts'
import { createStreams } from '../src/sim/rng.ts'
import {
  busyShare,
  mg1MeanInSystemMs,
  mmcMeanInSystemMs,
  poissonSource,
  runQueue,
} from './queueing.ts'

/** A queue no test here can fill, so nothing is shed and every Request is served. */
const UNFILLABLE_QUEUE = 100_000
const HOUR_MS = 3_600_000

/** 4 slots of 50 ms with exponential service times (cv 1): 80 a second at most. */
const fourSlots: BackendSpec = { slots: 4, queueLimit: UNFILLABLE_QUEUE, meanMs: 50, cv: 1 }
/** 40 slots of 50 ms: at 80 a second they are 10% busy, which is low load. */
const fortySlots: BackendSpec = { ...fourSlots, slots: 40 }

/** How far `measured` is from `expected`, as a share of `expected`. */
const relativeError = (measured: number, expected: number) =>
  Math.abs(measured - expected) / expected

const mean = (values: readonly number[]) => values.reduce((a, b) => a + b, 0) / values.length

describe('the Backend against queueing theory', () => {
  it.each([1, 0.5])(
    'at low load, the mean time in the system is the mean service time (cv %s)',
    (cv) => {
      // 4 slots of 50 ms at 8 a second are busy 10% of the time; a wait is rare and short
      // (Erlang C puts the mean wait at 0.01 ms), so time in the system is service time.
      const run = runQueue({ ...fourSlots, cv }, 8, HOUR_MS, 1)
      expect(run.shed).toBe(0)
      expect(relativeError(run.meanInSystemMs, 50)).toBeLessThan(0.03)
    },
  )

  it('is busy for Demand x mean service time / slots of its slot time', () => {
    const run = runQueue(fourSlots, 64, HOUR_MS, 1)
    expect(run.shed).toBe(0)
    // Busy time over the whole run, drain included, against the time Requests were arriving.
    const util = run.busySlotMs / (fourSlots.slots * HOUR_MS)
    expect(relativeError(util, busyShare(fourSlots, 64))).toBeLessThan(0.03)
  })

  it("counts the Requests in it consistently with their times (Little's law, exactly)", () => {
    // The run starts and ends empty, so Requests present x time is exactly the sum of every
    // Request's time in the system, and only rounding separates the two sides. This catches
    // slot or queue counts that disagree with the Requests' timings, not wrong timings.
    const run = runQueue(fourSlots, 64, HOUR_MS, 1)
    expect(run.shed).toBe(0)
    const ratePerMs = run.requests / run.endMs
    expect(relativeError(run.meanRequestsInSystem, ratePerMs * run.meanInSystemMs)).toBeLessThan(
      1e-9,
    )
  })

  it("holds as many Requests as Little's law and Erlang C predict at 80% busy", () => {
    // Little's law: mean Requests in the system = Demand x mean time in it. Against the
    // theory's time, 64 / s x 87.28 ms = 5.59 Requests, this does catch wrong timings.
    const run = runQueue(fourSlots, 64, HOUR_MS, 1)
    expect(run.shed).toBe(0)
    const predicted = (64 / 1000) * mmcMeanInSystemMs(fourSlots, 64)
    expect(relativeError(run.meanRequestsInSystem, predicted)).toBeLessThan(0.05)
  })

  it('waits as long as Erlang C predicts with 4 slots at 80% busy (M/M/4)', () => {
    const theory = mmcMeanInSystemMs(fourSlots, 64)
    expect(theory).toBeCloseTo(87.28, 2)
    const run = runQueue(fourSlots, 64, HOUR_MS, 1)
    expect(run.shed).toBe(0)
    expect(relativeError(run.meanInSystemMs, theory)).toBeLessThan(0.05)
  })

  it.each([
    { cv: 0, theoryMs: 150 },
    { cv: 0.5, theoryMs: 175 },
  ])(
    'waits as long as Pollaczek-Khinchine predicts for one slot at 80% busy (cv $cv: $theoryMs ms)',
    ({ cv, theoryMs }) => {
      // The same load with more varied service times waits longer: the formula's
      // (1 + cv^2) term, which a student sees as a higher p99 at the same Demand.
      const spec: BackendSpec = { ...fourSlots, slots: 1, cv }
      expect(mg1MeanInSystemMs(spec, 16)).toBeCloseTo(theoryMs, 9)
      // One slot at 80% busy settles slowly; 10,000 s keeps the worst seed under 3%.
      const run = runQueue(spec, 16, 10_000_000, 1)
      expect(run.shed).toBe(0)
      expect(relativeError(run.meanInSystemMs, theoryMs)).toBeLessThan(0.05)
    },
  )
})

/**
 * `seconds` of Poisson Demand at `demandRps` through an engine whose Limiter allows everything
 * and whose callers wait a minute: the Snapshots after the warm-up, and how many Attempts were
 * shed or timed out, which every test here expects to be none.
 */
function runEngine(
  backend: BackendSpec,
  demandRps: number,
  seconds: number,
  seed: number,
): { readonly snapshots: Snapshot[]; readonly shedOrTimedOut: number } {
  const source = poissonSource(demandRps, createStreams(seed))
  const engine = createEngine({
    traffic: source.reader(),
    limiter: { decide: () => ({ kind: 'allow' }), reset() {} },
    retry: { timeoutMs: 60_000, retry: 'none', maxAttempts: 1 },
    backend,
    streams: createStreams(seed),
  })
  source.advanceTo(seconds * 1000)
  engine.advanceTo(seconds * 1000)
  const { shed, timedOut } = engine.totals().attempts
  return {
    snapshots: engine.snapshots().filter((snapshot) => !snapshot.warmUp),
    shedOrTimedOut: shed + timedOut,
  }
}

describe('the engine Snapshots against queueing theory', () => {
  it.each([
    [1, 40],
    [1, 64],
    [0, 64],
  ])(
    'report utilization = Demand x mean service time / slots (cv %s, %s a second)',
    (cv, demandRps) => {
      const backend: BackendSpec = { ...fourSlots, cv }
      const run = runEngine(backend, demandRps, 600, 1)
      expect(run.shedOrTimedOut).toBe(0)
      const util = mean(run.snapshots.map((snapshot) => snapshot.backendUtil))
      expect(relativeError(util, busyShare(backend, demandRps))).toBeLessThan(0.03)
    },
  )

  it('report latency at low load as the service time itself: 50 ms when it never varies', () => {
    // 40 slots at 80 a second are 10% busy; with cv 0 no Attempt waited in 600 s.
    const { snapshots, shedOrTimedOut } = runEngine({ ...fortySlots, cv: 0 }, 80, 600, 1)
    expect(shedOrTimedOut).toBe(0)
    expect(snapshots.every((s) => s.peakQueueDepth === 0)).toBe(true)
    // Up to rounding: a latency is (arrival + 50) - arrival, which is 50.000000000000114 late
    // in a run.
    for (const latency of snapshots.flatMap((s) => [s.p50, s.p99])) {
      expect(Math.abs((latency as number) - 50)).toBeLessThan(1e-9)
    }
  })

  it("report low-load p50 and p99 at the service time distribution's own percentiles (cv 1)", () => {
    // Exponential service: median 50 x ln 2 = 34.66 ms, p99 50 x ln 100 = 230.26 ms. Each
    // Snapshot's percentiles cover about 400 latencies, so they are averaged over 595 seconds.
    const { snapshots, shedOrTimedOut } = runEngine(fortySlots, 80, 600, 1)
    expect(shedOrTimedOut).toBe(0)
    const p50 = mean(snapshots.map((s) => s.p50 as number))
    const p99 = mean(snapshots.map((s) => s.p99 as number))
    expect(relativeError(p50, 50 * Math.LN2)).toBeLessThan(0.04)
    expect(relativeError(p99, baselineP99Ms(fortySlots))).toBeLessThan(0.04)
  })
})
