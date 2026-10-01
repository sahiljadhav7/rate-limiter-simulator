import { describe, expect, it } from 'vitest'
import { createRunner } from '../src/runner/runner.ts'
import type { Scenario } from '../src/runner/scenario.ts'
import { rollingWindowCounts } from '../src/sim/window-counts.ts'

describe('rollingWindowCounts', () => {
  it('sums the sub-buckets of the window ending at each sub-bucket', () => {
    // A 400 ms window of four 100 ms sub-buckets.
    const counts = [1, 0, 2, 3, 4, 0, 0, 0, 5]
    expect(rollingWindowCounts({ bucketMs: 100, counts }, 400, 900)).toEqual([
      { t: 100, v: 1 },
      { t: 200, v: 1 },
      { t: 300, v: 3 },
      { t: 400, v: 6 },
      { t: 500, v: 9 },
      { t: 600, v: 9 },
      { t: 700, v: 7 },
      { t: 800, v: 4 },
      { t: 900, v: 5 },
    ])
  })

  it('places the last, unfinished sub-bucket at the current time', () => {
    expect(rollingWindowCounts({ bucketMs: 100, counts: [2, 3] }, 200, 150)).toEqual([
      { t: 100, v: 2 },
      { t: 150, v: 5 },
    ])
  })

  it('works for a sub-bucket width that is not a whole number of ms', () => {
    // A 333 ms window: ten sub-buckets of 33.3 ms.
    const counts = Array.from({ length: 20 }, () => 1)
    const points = rollingWindowCounts({ bucketMs: 33.3, counts }, 333, 666)
    expect(points.map((p) => p.v)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, ...Array(10).fill(10)])
  })

  it('from a start time, gives exactly the points of the full run from there on', () => {
    const counts = Array.from({ length: 200 }, (_, i) => (i * 7) % 5)
    const full = rollingWindowCounts({ bucketMs: 100, counts }, 1000, 20_000)
    for (const fromMs of [0, 50, 100, 950, 1000, 12_345, 19_950, 25_000]) {
      expect(rollingWindowCounts({ bucketMs: 100, counts }, 1000, 20_000, fromMs)).toEqual(
        full.filter((p) => p.t >= fromMs),
      )
    }
  })

  // The Edge Burst from tests/limiters.test.ts, through the runner: 30 Requests at 950 ms and
  // 30 at 1050 ms, a limit of 10 per 1000 ms window, no other traffic.
  const edgeBurst = (algo: 'fixed-window' | 'sliding-counter'): Scenario => ({
    id: 'edge',
    title: 'Edge Burst',
    lesson: '',
    why: '',
    models: '',
    leavesOut: '',
    seed: 1,
    traffic: { shape: 'constant', demandRps: 0, clients: ['a'] },
    scriptedArrivals: [
      { atMs: 950, count: 30 },
      { atMs: 1050, count: 30 },
    ],
    backend: { slots: 10, queueLimit: 100, meanMs: 10, cv: 0 },
    variants: [
      {
        label: algo,
        limiter: { algo, keyBy: 'global', limit: 10, windowMs: 1000 },
        retry: { timeoutMs: 1000, maxAttempts: 1, retry: 'none' },
      },
    ],
  })

  it.each([
    ['fixed-window', 20],
    ['sliding-counter', 10],
  ] as const)('peaks at the Edge Burst count for %s: %s', (algo, peak) => {
    const runner = createRunner(edgeBurst(algo))
    for (let i = 0; i < 30; i++) runner.tick(100)
    const subBuckets = runner.view().variants[0]?.allowedSubBuckets
    if (subBuckets === undefined) throw new Error('no Variant')
    const points = rollingWindowCounts(subBuckets, 1000, runner.view().simMs)
    expect(Math.max(...points.map((p) => p.v))).toBe(peak)
  })
})
