import { describe, expect, it } from 'vitest'
import {
  chartLayout,
  formatRatio,
  gridValues,
  hoverAt,
  linearScale,
  niceMax,
  peakRatio,
  rollingWindowCounts,
  timeDomain,
  toAreas,
  toPolylines,
  visibleSnapshots,
  VISIBLE_MS,
} from '../src/ui/chart/geometry.ts'
import { createRunner } from '../src/runner/runner.ts'
import type { Scenario } from '../src/runner/scenario.ts'

describe('linearScale', () => {
  it('maps the domain onto the range, either way round', () => {
    const x = linearScale([0, 60_000], [0, 600])
    expect([x(0), x(30_000), x(60_000)]).toEqual([0, 300, 600])
    // SVG y grows downwards: 0 at the bottom of a 100 px plot, the maximum at the top.
    const y = linearScale([0, 20], [100, 0])
    expect([y(0), y(5), y(20)]).toEqual([100, 75, 0])
  })

  it('maps everything to the start of the range for an empty domain, rather than NaN', () => {
    expect(linearScale([5, 5], [0, 100])(5)).toBe(0)
  })
})

describe('niceMax', () => {
  it.each([
    [0, 1],
    [7, 10],
    [12, 20],
    [99, 100],
    [1000, 1000],
    [0.3, 0.5],
    [250, 500],
  ])('rounds %s up to %s', (value, nice) => {
    expect(niceMax(value)).toBe(nice)
  })
})

describe('gridValues', () => {
  it.each([
    [10, [0, 2, 4, 6, 8, 10]],
    [20, [0, 5, 10, 15, 20]],
    [50, [0, 10, 20, 30, 40, 50]],
    [1, [0, 0.2, 0.4, 0.6, 0.8, 1]],
  ])('gives evenly spaced round values up to %s', (max, values) => {
    expect(gridValues(max)).toEqual(values)
  })
})

describe('toPolylines', () => {
  const x = linearScale([0, 3000], [0, 300])
  const y = linearScale([0, 10], [100, 0])

  it('maps a 3-point series to known coordinates', () => {
    const points = [
      { t: 1000, v: 0 },
      { t: 2000, v: 5 },
      { t: 3000, v: 10 },
    ]
    expect(toPolylines(points, x, y)).toEqual(['100,100 200,50 300,0'])
  })

  it('breaks the line at a null: two runs, and no point drawn at 0', () => {
    const points = [
      { t: 1000, v: 4 },
      { t: 2000, v: null },
      { t: 3000, v: 6 },
    ]
    expect(toPolylines(points, x, y)).toEqual(['100,60', '300,40'])
  })

  it('leaves out leading, trailing and repeated nulls, and gives nothing for no values', () => {
    const points = [
      { t: 0, v: null },
      { t: 1000, v: 2 },
      { t: 1500, v: 3 },
      { t: 2000, v: null },
      { t: 2500, v: null },
      { t: 3000, v: null },
    ]
    expect(toPolylines(points, x, y)).toEqual(['100,80 150,70'])
    expect(toPolylines([{ t: 1, v: null }], x, y)).toEqual([])
  })

  it('rounds coordinates to one decimal place, which is finer than a pixel', () => {
    const third = linearScale([0, 3], [0, 100])
    expect(toPolylines([{ t: 1, v: 1 }], third, third)).toEqual(['33.3,33.3'])
  })
})

describe('toAreas', () => {
  it('closes each run of values down to the baseline, so a gap stays a gap', () => {
    const x = linearScale([0, 3000], [0, 300])
    const y = linearScale([0, 10], [100, 0])
    const points = [
      { t: 1000, v: 4 },
      { t: 1500, v: 8 },
      { t: 2000, v: null },
      { t: 3000, v: 6 },
    ]
    expect(toAreas(points, x, y, 100)).toEqual([
      '100,100 100,60 150,20 150,100',
      '300,100 300,40 300,100',
    ])
  })
})

describe('the visible window', () => {
  const snapshots = Array.from({ length: 90 }, (_, i) => ({ t: (i + 1) * 1000 }))

  it(`keeps the Snapshots of the last ${VISIBLE_MS / 1000} s, the one at the window's start included`, () => {
    const visible = visibleSnapshots(snapshots, 90_000)
    expect(visible[0]?.t).toBe(30_000)
    expect(visible.at(-1)?.t).toBe(90_000)
    expect(visible).toHaveLength(61)
  })

  it('keeps everything before the window is full', () => {
    expect(visibleSnapshots(snapshots.slice(0, 20), 20_500)).toHaveLength(20)
  })

  it('shows the first 60 s until the run passes them, then scrolls left', () => {
    expect(timeDomain(20_000)).toEqual([0, 60_000])
    expect(timeDomain(60_000)).toEqual([0, 60_000])
    expect(timeDomain(90_500)).toEqual([30_500, 90_500])
  })
})

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

describe('peak ratio', () => {
  it('is the largest value over the limit, formatted as DESIGN.md shows', () => {
    expect(peakRatio([3, 20, 7], 10)).toBe(2)
    expect(formatRatio(2)).toBe('2.0×')
    expect(formatRatio(1.25)).toBe('1.3×')
    expect(peakRatio([], 10)).toBeNull()
  })
})

describe('hoverAt', () => {
  const series = [
    {
      label: 'p50',
      points: [
        { t: 1000, v: 10 },
        { t: 2000, v: null },
        { t: 3000, v: 30 },
      ],
    },
    {
      label: 'p99',
      points: [
        { t: 1000, v: 50 },
        { t: 2000, v: null },
        { t: 3000, v: 90 },
      ],
    },
  ]

  it('picks the point nearest the pointer and lists every series there', () => {
    expect(hoverAt(series, 2700)).toEqual({
      t: 3000,
      values: [
        { label: 'p50', v: 30 },
        { label: 'p99', v: 90 },
      ],
    })
    expect(hoverAt(series, 1400)?.t).toBe(1000)
    // Before the first point and after the last, the nearest is the end.
    expect(hoverAt(series, -500)?.t).toBe(1000)
    expect(hoverAt(series, 99_000)?.t).toBe(3000)
  })

  it('keeps a missing value as null, so the tooltip shows a dash rather than 0', () => {
    expect(hoverAt(series, 2100)).toEqual({
      t: 2000,
      values: [
        { label: 'p50', v: null },
        { label: 'p99', v: null },
      ],
    })
  })

  it('gives null for a series that has no point at that time, and nothing for no points', () => {
    const short = [...series, { label: 'p95', points: [{ t: 1000, v: 20 }] }]
    expect(hoverAt(short, 3000)?.values.at(-1)).toEqual({ label: 'p95', v: null })
    expect(hoverAt([{ label: 'p50', points: [] }], 1000)).toBeNull()
  })
})

describe('chartLayout', () => {
  it('leaves 40 px for the axis labels, and moves the crosshair a simulated second per key', () => {
    // 60 s across 480 px of plot: 8 px a second.
    expect(chartLayout(520)).toEqual({ width: 520, plotRight: 480, keyStepPx: 8 })
    expect(chartLayout(280)).toEqual({ width: 280, plotRight: 240, keyStepPx: 4 })
  })

  it('rounds a fractional measured width down to a whole pixel, so the chart never overflows', () => {
    expect(chartLayout(520.7)?.width).toBe(520)
  })

  it('gives null until there is room for a plot, so nothing is drawn at a width of 0', () => {
    expect(chartLayout(0)).toBeNull()
    expect(chartLayout(40)).toBeNull()
  })
})
