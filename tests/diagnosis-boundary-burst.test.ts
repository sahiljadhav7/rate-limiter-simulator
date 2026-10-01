import { describe, expect, it } from 'vitest'
import { createRunner, type VariantView } from '../src/runner/runner.ts'
import type { Scenario } from '../src/runner/scenario.ts'
import type { Finding } from '../src/sim/diagnosis.ts'
import { rollingWindowCounts } from '../src/sim/window-counts.ts'
import { formatRatio, peakRatio } from '../src/ui/chart/geometry.ts'
import { edgeBurstScenario } from '../src/ui/scenarios/edge-burst.ts'

const UNLIMITED = { eventBudget: Number.POSITIVE_INFINITY }

/** Runs `scenario` to each whole second up to `untilS` and gives every Variant's boundary burst then. */
function boundaryEachSecond(scenario: Scenario, untilS = 120) {
  const runner = createRunner(scenario, UNLIMITED)
  const seen: (Finding | undefined)[][] = scenario.variants.map(() => [])
  for (let second = 1; second <= untilS; second++) {
    while (runner.view().simMs < second * 1000) runner.tick(100)
    runner.view().variants.forEach((variant, i) => {
      seen[i]?.push(variant.findings.find((f) => f.id === 'boundary-burst'))
    })
  }
  return { seen, view: runner.view() }
}

/** A Scenario with one fixed window (10 per 1000 ms, keyed by `keyBy`) on `traffic`. */
const fixedWindow = (
  traffic: Scenario['traffic'],
  keyBy: 'global' | 'client' = 'global',
  scriptedArrivals: Scenario['scriptedArrivals'] = [],
  seed = 1,
): Scenario => ({
  ...edgeBurstScenario,
  seed,
  traffic,
  scriptedArrivals,
  variants: [
    {
      label: 'Fixed window',
      limiter: { algo: 'fixed-window', keyBy, limit: 10, windowMs: 1000 },
      retry: { timeoutMs: 1000, maxAttempts: 1, retry: 'none' },
    },
  ],
})

/** 30 Requests 50 ms either side of the window edge at each of `edgesMs`, from `clientId`. */
const edgeBursts = (edgesMs: readonly number[], clientId?: string) =>
  edgesMs.flatMap((edgeMs) => [
    { atMs: edgeMs - 50, count: 30, ...(clientId === undefined ? {} : { clientId }) },
    { atMs: edgeMs + 50, count: 30, ...(clientId === undefined ? {} : { clientId }) },
  ])

describe('the boundary burst rule', () => {
  it("fires on Edge burst's fixed window as the Root Cause, broken, at the chart's own 2.0×", () => {
    const { seen, view } = boundaryEachSecond(edgeBurstScenario, 60)
    const fixed = view.variants[0] as VariantView
    const finding = fixed.findings.find((f) => f.id === 'boundary-burst')
    expect(finding).toMatchObject({ kind: 'cause', role: 'root-cause', severity: 'broken' })
    // The chart's label: the peak of the same rolling count, as the chart formats it.
    const points = rollingWindowCounts(fixed.allowedSubBuckets, 1000, view.simMs)
    const chartLabel = formatRatio(
      peakRatio(
        points.map((p) => p.v),
        10,
      ) ?? 0,
    )
    expect(chartLabel).toBe('2.0×')
    expect(finding?.evidence).toEqual([
      { metric: 'Most allowed in one window', value: '20' },
      { metric: 'Limit per window', value: '10' },
      { metric: 'Over the limit', value: chartLabel },
      { metric: 'When', value: '50.1 s' },
    ])
    // At 60 s the newest burst (at the 60 s edge) has only its first half in; the evidence is
    // still the one at 50 s that is holding the Finding.
    expect(finding?.why).toBe(
      'The fixed window starts counting from zero at each edge, so Attempts just before an ' +
        'edge and just after it both fit: 20 got through in one window-length around 50.1 s, ' +
        '2.0× the limit of 10.',
    )
    expect(finding?.fixes.map((fix) => fix.text)).toEqual([
      'Try a sliding window counter, which still counts the window before the edge',
      'Try a token bucket with a small capacity, such as half the limit, so a burst cannot spend a whole window at once',
    ])
    // First seen at 11 s, the first full window after the burst at the 10 s edge, and held
    // between bursts every 10 s: one Finding from then on, never cleared.
    expect(seen[0]?.slice(0, 10).every((f) => f === undefined)).toBe(true)
    expect(seen[0]?.slice(10).every((f) => f?.startedAt === 11_000)).toBe(true)
  })

  it('finds nothing on the sliding window counter, which peaks over its limit but has no window edge reset', () => {
    const { seen } = boundaryEachSecond(edgeBurstScenario, 60)
    expect(seen[1]?.filter(Boolean)).toEqual([])
  })

  // At 4/s, Edge burst's own background, chance never takes the rolling count past 12 on seeds
  // 1 to 8. At 5/s, half the limit, seed 1 once lets 14 through across an edge: a real 1.4x that
  // the chart draws over its limit line too, so the rule rightly shows it
  // (.scratch/diagnosis/boundary-poisson.ts).
  it('finds nothing on a fixed window with Poisson traffic at 40% of its limit, seeds 1 to 8', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const scenario = fixedWindow(
        { shape: 'poisson', demandRps: 4, clients: ['a'] },
        'global',
        [],
        seed,
      )
      expect(boundaryEachSecond(scenario).seen[0]?.filter(Boolean)).toEqual([])
    }
  })

  it('clears after a burst stops coming back, and a new burst is a new Finding', () => {
    const scenario = fixedWindow(
      { shape: 'constant', demandRps: 0, clients: ['a'] },
      'global',
      edgeBursts([10_000, 20_000, 60_000]),
    )
    const runner = createRunner(scenario, UNLIMITED)
    while (runner.view().simMs < 70_000) runner.tick(100)
    // The 20 s burst leaves the 5 s window after 25 s; ten quiet windows later, at 35 s, it clears.
    expect(runner.view().variants[0]?.pastFindings.map((f) => [f.startedAt, f.endedAt])).toEqual([
      [11_000, 35_000],
    ])
    expect(runner.view().variants[0]?.findings.map((f) => f.startedAt)).toEqual([61_000])
  })

  describe('per-Client keys, judged as a total against the limit times the Clients seen', () => {
    it('finds nothing when three Clients each use their own full limit', () => {
      // 30 per second in all, 10 per Client: three times one key's limit, and no edge effect.
      const scenario = fixedWindow(
        { shape: 'constant', demandRps: 30, clients: ['a', 'b', 'c'] },
        'client',
      )
      expect(boundaryEachSecond(scenario, 30).seen[0]?.filter(Boolean)).toEqual([])
    })

    it('fires when every Client bursts across an edge: 60 in one window-length, 2.0× of 30', () => {
      const scenario = fixedWindow(
        { shape: 'constant', demandRps: 0, clients: ['a', 'b', 'c'] },
        'client',
        ['a', 'b', 'c'].flatMap((client) => edgeBursts([10_000, 20_000], client)),
      )
      const { view } = boundaryEachSecond(scenario, 22)
      const finding = view.variants[0]?.findings.find((f) => f.id === 'boundary-burst')
      expect(finding?.evidence.slice(0, 3)).toEqual([
        { metric: 'Most allowed in one window', value: '60' },
        { metric: 'Limit per window', value: '30 (10 for each of 3 Clients)' },
        { metric: 'Over the limit', value: '2.0×' },
      ])
    })
  })
})
