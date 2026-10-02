import { describe, expect, it } from 'vitest'
import { applyFix } from '../src/runner/apply-fix.ts'
import { createRunner } from '../src/runner/runner.ts'
import type { Scenario } from '../src/runner/scenario.ts'
import type { FailureMode, Fix } from '../src/sim/diagnosis.ts'
import { withRetryMode } from '../src/ui/controls/retry-options.ts'
import { backendOverloadScenario } from '../src/ui/scenarios/backend-overload.ts'
import { edgeBurstScenario } from '../src/ui/scenarios/edge-burst.ts'

/**
 * Each existing rule's fixes, applied with their patches on the setup that triggers the rule
 * (seed 1; every band holds for seeds 1 to 8, .scratch/apply-fix/patch-probe.ts). A patch is
 * kept only if the Finding clears or softens, and Goodput moves the way the fix's text says.
 */

const RUN_MS = 120_000

const at = (sc: Scenario, demandRps: number): Scenario => ({
  ...sc,
  traffic: { ...sc.traffic, demandRps },
})
const retryAtOnce = (sc: Scenario): Scenario => ({
  ...sc,
  variants: sc.variants.map((v) => ({ ...v, retry: withRetryMode(v.retry, 'immediate') })),
})

/** Poisson 100/s into 4 slots of 50 ms (80/s) through a Limiter that lets everything through. */
const saturationFixture: Scenario = {
  id: 'saturation-fixture',
  title: 'Saturation fixture',
  lesson: 'None: a test fixture.',
  why: 'It only exists to be run.',
  models: 'One Backend with nothing in front of it.',
  leavesOut: 'Everything a lesson would need.',
  seed: 1,
  traffic: { shape: 'poisson', demandRps: 100, clients: ['a', 'b', 'c'] },
  backend: { slots: 4, queueLimit: 40, meanMs: 50, cv: 1 },
  variants: [
    {
      label: 'Lets all through',
      limiter: { algo: 'token-bucket', keyBy: 'global', capacity: 10_000, refillPerSec: 10_000 },
      retry: { timeoutMs: 2000, maxAttempts: 1, retry: 'none' },
    },
  ],
}

/** Seconds from 10 s with `mode` broken and warn in Variant `index`, and its mean Goodput. */
function measure(sc: Scenario, index: number, mode: FailureMode) {
  const runner = createRunner(sc, { eventBudget: Infinity })
  let broken = 0
  let warn = 0
  for (let second = 10; second <= RUN_MS / 1000; second++) {
    while (runner.view().simMs < second * 1000) runner.tick(100)
    const finding = runner.view().variants[index]?.findings.find((f) => f.id === mode)
    if (finding?.severity === 'broken') broken++
    if (finding?.severity === 'warn') warn++
  }
  const snapshots = runner.view().variants[index]?.snapshots.filter((s) => s.t > 10_000) ?? []
  const goodput = snapshots.reduce((t, s) => t + s.goodput, 0) / snapshots.length
  return { broken, warn, goodput }
}

/** The fixes of `mode`'s Finding in Variant `index` once it shows, 30 s into the run. */
function fixesOf(sc: Scenario, index: number, mode: FailureMode): readonly Fix[] {
  const runner = createRunner(sc, { eventBudget: Infinity })
  while (runner.view().simMs < 30_000) runner.tick(100)
  const finding = runner.view().variants[index]?.findings.find((f) => f.id === mode)
  if (finding === undefined) throw new Error(`No ${mode} Finding to take fixes from`)
  return finding.fixes
}

type Expected = {
  readonly broken: number
  readonly warn: number
  readonly goodput: [number, number]
}

const cases: readonly (readonly [
  setup: string,
  scenario: Scenario,
  index: number,
  mode: FailureMode,
  asIs: Expected,
  patched: readonly (readonly [name: string, expected: Expected])[],
])[] = [
  [
    'queue overflow, Backend overload at 30/s, sliding window counter',
    at(backendOverloadScenario, 30),
    0,
    'queue-overflow',
    // As is: broken 96 to 111 of 111 seconds, Goodput 11.3 to 11.7/s.
    { broken: 111, warn: 10, goodput: [11.2, 11.8] },
    [
      // Clears; Goodput 15.6 to 15.7/s.
      ['token bucket', { broken: 0, warn: 0, goodput: [15.5, 15.8] }],
      // Clears to warn for at most 5 s; Goodput 14.0/s.
      ['more slots', { broken: 0, warn: 5, goodput: [13.9, 14.1] }],
      // Softens: broken 5 to 35 s; Goodput 13.5 to 13.8/s, paid for in waiting (p99 450 to 484 ms).
      ['bigger queue', { broken: 35, warn: 36, goodput: [13.4, 13.9] }],
    ],
  ],
  [
    'saturation, the fixture at 100/s',
    saturationFixture,
    0,
    'saturation',
    { broken: 111, warn: 5, goodput: [78, 81.1] },
    [
      // Clears; Goodput 98.6 to 101.2/s.
      ['more slots', { broken: 0, warn: 0, goodput: [98.5, 101.3] }],
      // Clears; the same Goodput, p99 120 to 129 ms.
      ['cheaper Attempts', { broken: 0, warn: 0, goodput: [98.5, 101.3] }],
      // Clears, and turns away what is over the limit as its text says: Goodput held at 60/s.
      ['lower limit', { broken: 0, warn: 0, goodput: [59.8, 60.1] }],
    ],
  ],
  [
    'boundary burst, Edge burst at 4/s, fixed window',
    edgeBurstScenario,
    0,
    'boundary-burst',
    { broken: 110, warn: 0, goodput: [4.7, 5.5] },
    [
      // Both clear. Goodput 4.1 to 4.8/s: a limit really kept lets less of each burst through.
      ['sliding window counter', { broken: 0, warn: 0, goodput: [4.0, 4.9] }],
      ['token bucket', { broken: 0, warn: 0, goodput: [4.0, 4.9] }],
    ],
  ],
  [
    'retry storm, Backend overload at 30/s with "Retry at once", sliding window counter',
    retryAtOnce(at(backendOverloadScenario, 30)),
    0,
    'retry-storm',
    { broken: 111, warn: 1, goodput: [9.9, 10.7] },
    [
      // Clears; Goodput 12.8 to 13.4/s.
      ['back off with jitter', { broken: 0, warn: 0, goodput: [12.7, 13.5] }],
      // Clears; Goodput 10.9 to 11.5/s.
      ['wait for Retry-After', { broken: 0, warn: 0, goodput: [10.8, 11.6] }],
      // Softens to warn throughout; Goodput 10.5 to 10.9/s.
      ['fewer Attempts', { broken: 0, warn: 111, goodput: [10.4, 11.0] }],
    ],
  ],
]

const within = (value: number, [low, high]: [number, number]) =>
  expect(value).toSatisfy((v: number) => v >= low && v <= high, `${value} in [${low}, ${high}]`)

describe.each(cases)('the fixes for %s', (_, scenario, index, mode, asIs, patched) => {
  const fixes = fixesOf(scenario, index, mode)

  it('each have a patch, listed in the order of the rule', () => {
    expect(fixes.map((fix) => fix.patch?.name)).toEqual(patched.map(([name]) => name))
  })

  it('fire as expected before any fix', () => {
    const seen = measure(scenario, index, mode)
    expect(seen.broken).toBeGreaterThan(0)
    expect(seen.broken).toBeLessThanOrEqual(asIs.broken)
    within(seen.goodput, asIs.goodput)
  })

  it.each(patched.map(([name, expected], i) => [name, expected, i] as const))(
    '"%s" clears or softens it, with the Goodput its text implies',
    (_name, expected, i) => {
      const fix = fixes[i]
      if (fix === undefined) throw new Error('Missing fix')
      const fixed = applyFix(scenario, index, fix)
      const seen = measure(fixed, index + 1, mode)
      expect(seen.broken).toBeLessThanOrEqual(expected.broken)
      expect(seen.warn).toBeLessThanOrEqual(expected.warn)
      within(seen.goodput, expected.goodput)
    },
  )
})

describe('the lower-limit fix for saturation', () => {
  const withLimiter = (limiter: Scenario['variants'][number]['limiter']): Scenario => ({
    ...saturationFixture,
    variants: [{ ...saturationFixture.variants[0]!, limiter }],
  })

  it('keeps a sliding window counter, at 0.75 of the 80/s ceiling, and clears saturation', () => {
    const sc = withLimiter({
      algo: 'sliding-counter',
      keyBy: 'global',
      limit: 1000,
      windowMs: 1000,
    })
    const lower = fixesOf(sc, 0, 'saturation')[2]
    expect(lower?.patch?.limiter).toEqual({
      algo: 'sliding-counter',
      keyBy: 'global',
      limit: 60,
      windowMs: 1000,
    })
    if (lower === undefined) throw new Error('Missing fix')
    // Seeds 1 to 8: never saturated, Goodput 58.3 to 58.6/s.
    const seen = measure(applyFix(sc, 0, lower), 1, 'saturation')
    expect(seen).toMatchObject({ broken: 0, warn: 0 })
    within(seen.goodput, [58.2, 58.7])
  })

  it('stays text for a Limiter keyed per Client, whose rate depends on how many Clients there are', () => {
    const sc = withLimiter({
      algo: 'token-bucket',
      keyBy: 'client',
      capacity: 10_000,
      refillPerSec: 10_000,
    })
    const fixes = fixesOf(sc, 0, 'saturation')
    expect(fixes.map((fix) => fix.patch?.name)).toEqual([
      'more slots',
      'cheaper Attempts',
      undefined,
    ])
  })
})
