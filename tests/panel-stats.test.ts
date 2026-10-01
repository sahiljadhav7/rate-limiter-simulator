import { describe, expect, it } from 'vitest'
import {
  DASH,
  formatRate,
  formatShare,
  limiterCapacity,
  panelStats,
} from '../src/ui/panel/stats.ts'
import type { LimiterSpec, Snapshot } from '../src/sim/index.ts'

/** A Snapshot ending at `t` with every count 0, plus `fields`. */
function snapshot(t: number, fields: Partial<Snapshot> = {}): Snapshot {
  return {
    t,
    warmUp: t <= 5000,
    demand: 0,
    offeredLoad: 0,
    allowed: 0,
    rejected: 0,
    delayed: 0,
    goodput: 0,
    failed: { rejected: 0, timedOut: 0, shed: 0 },
    wastedWorkMs: 0,
    backendUtil: 0,
    queueDepth: 0,
    shed: 0,
    p50: null,
    p95: null,
    p99: null,
    e2eP50: null,
    e2eP95: null,
    e2eP99: null,
    perClient: {},
    ...fields,
  }
}

const fixedWindow: LimiterSpec = {
  algo: 'fixed-window',
  keyBy: 'global',
  limit: 10,
  windowMs: 1000,
}

describe('panelStats', () => {
  // Seven seconds; only the last five count. The first two would pull every average off.
  const snapshots = [
    snapshot(1000, { offeredLoad: 900, goodput: 900, demand: 900, allowed: 900, rejected: 900 }),
    snapshot(2000, { offeredLoad: 900, goodput: 900, demand: 900, allowed: 900, rejected: 900 }),
    snapshot(3000, { demand: 10, offeredLoad: 12, allowed: 10, rejected: 2, goodput: 9 }),
    snapshot(4000, { demand: 10, offeredLoad: 14, allowed: 10, rejected: 4, goodput: 10 }),
    snapshot(5000, { demand: 12, offeredLoad: 16, allowed: 10, rejected: 6, goodput: 10 }),
    snapshot(6000, { demand: 8, offeredLoad: 8, allowed: 8, rejected: 0, goodput: 8 }),
    snapshot(7000, {
      demand: 10,
      offeredLoad: 10,
      allowed: 7,
      rejected: 3,
      goodput: 5,
      p99: 151,
      backendUtil: 0.25,
      queueDepth: 3,
    }),
  ]

  it('averages the rates over the last 5 Snapshots, and reads the rest from the newest', () => {
    expect(panelStats(snapshots, fixedWindow, 3)).toEqual({
      demand: 10, // (10 + 10 + 12 + 8 + 10) / 5
      offeredLoad: 12, // (12 + 14 + 16 + 8 + 10) / 5
      goodput: 8.4, // (9 + 10 + 10 + 8 + 5) / 5
      allowed: 9, // (10 + 10 + 10 + 8 + 7) / 5
      rejectedShare: 0.25, // 15 rejected of 60 offered
      p99: 151,
      busy: 0.25,
      waiting: 3,
      limiterMeter: 0.9, // 9 allowed per second against a limit of 10 per second
      backendMeter: 0.25,
    })
  })

  it('averages over the Snapshots there are when there are fewer than 5', () => {
    const stats = panelStats(snapshots.slice(2, 5), fixedWindow, 3)
    expect(stats.offeredLoad).toBe(14) // (12 + 14 + 16) / 3
    expect(stats.rejectedShare).toBeCloseTo(0.2857, 4) // (2 + 4 + 6) / (12 + 14 + 16) = 12 / 42
  })

  it('gives null for everything before the first Snapshot, never 0', () => {
    expect(Object.values(panelStats([], fixedWindow, 3)).every((v) => v === null)).toBe(true)
  })

  it('gives null Rejected share when nothing was offered, rather than 0% or NaN', () => {
    const quiet = panelStats([snapshot(1000), snapshot(2000)], fixedWindow, 3)
    expect(quiet.rejectedShare).toBeNull()
    expect(quiet.offeredLoad).toBe(0)
    expect(quiet.p99).toBeNull()
  })

  it('clamps the meters to 0 to 1', () => {
    const over = panelStats([snapshot(1000, { allowed: 25, backendUtil: 1 })], fixedWindow, 3)
    expect(over.limiterMeter).toBe(1)
    expect(over.backendMeter).toBe(1)
  })
})

describe('limiterCapacity', () => {
  it('is the long-run rate per key, times the Clients when each Client has its own key', () => {
    expect(limiterCapacity(fixedWindow, 3)).toBe(10)
    expect(limiterCapacity({ ...fixedWindow, keyBy: 'client' }, 3)).toBe(30)
    expect(
      limiterCapacity({ algo: 'token-bucket', keyBy: 'client', capacity: 20, refillPerSec: 4 }, 3),
    ).toBe(12)
  })
})

describe('formatting', () => {
  it.each([
    [0, '0'],
    [0.4, '0.4'],
    [12.5, '12.5'],
    [99.96, '100'],
    [151.3, '151'],
    [1204, '1,204'],
    [null, DASH],
  ])('a rate or a time of %s reads %s', (value, text) => {
    expect(formatRate(value)).toBe(text)
  })

  it.each([
    [0, '0'],
    [0.005, '0.5'],
    [0.0999, '10'],
    [0.58, '58'],
    [1, '100'],
    [null, DASH],
  ])('a share of %s reads %s percent', (value, text) => {
    expect(formatShare(value)).toBe(text)
  })
})
