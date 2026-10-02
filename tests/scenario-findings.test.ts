import { describe, expect, it } from 'vitest'
import { createRunner } from '../src/runner/runner.ts'
import type { Scenario } from '../src/runner/scenario.ts'
import { backendOverloadScenario } from '../src/ui/scenarios/backend-overload.ts'
import { noisyNeighborScenario } from '../src/ui/scenarios/noisy-neighbor.ts'
import { withRetryMode, type RetryMode } from '../src/ui/controls/retry-options.ts'

/** Run length for each row: long enough for many window edges and a settled 5 s loss share. */
const RUN_MS = 120_000

/**
 * Runs `scenario` at `demandRps` for RUN_MS, with every Variant on the Retry Policy `retry` if
 * given, and gives each Variant's worst Finding at any second, every Failure Mode it showed,
 * and its Root Cause then: what a student would have seen go red.
 */
function worstFindings(scenario: Scenario, demandRps: number, retry?: RetryMode) {
  const variants = scenario.variants.map((variant) =>
    retry === undefined ? variant : { ...variant, retry: withRetryMode(variant.retry, retry) },
  )
  const runner = createRunner(
    { ...scenario, variants, traffic: { ...scenario.traffic, demandRps } },
    { eventBudget: Infinity },
  )
  const worst = scenario.variants.map(() => 'none' as 'none' | 'warn' | 'broken')
  const modes = scenario.variants.map(() => new Map<string, string>())
  const rootCauses = scenario.variants.map(() => new Set<string>())
  while (runner.view().simMs < RUN_MS) {
    runner.tick(100)
    runner.view().variants.forEach(({ findings }, i) => {
      for (const finding of findings) {
        if (finding.severity === 'broken' || worst[i] === 'none') worst[i] = finding.severity
        if (modes[i]?.get(finding.id) !== 'broken') modes[i]?.set(finding.id, finding.severity)
        if (finding.role === 'root-cause') rootCauses[i]?.add(finding.id)
      }
    })
  }
  return scenario.variants.map((variant, i) => ({
    label: variant.label,
    worst: worst[i],
    modeSeverities: Object.fromEntries(modes[i] ?? []),
    rootCauses: [...(rootCauses[i] ?? [])],
  }))
}

type Row = readonly [
  name: string,
  scenario: Scenario,
  demandRps: number,
  retry: RetryMode | undefined,
  /** Per Variant, in order: each Failure Mode it showed with its worst severity, and its Root Causes. */
  expected: readonly {
    readonly modes: Readonly<Record<string, string>>
    readonly roots: readonly string[]
  }[],
]

const none = { modes: {}, roots: [] }
const overflow = { modes: { 'queue-overflow': 'broken' }, roots: ['queue-overflow'] }
const storm = { modes: { 'retry-storm': 'broken' }, roots: ['retry-storm'] }
const noisy = { modes: { 'noisy-neighbor': 'broken' }, roots: ['noisy-neighbor'] }
const stormAndNoisy = {
  modes: { 'retry-storm': 'warn', 'noisy-neighbor': 'broken' },
  roots: ['retry-storm'],
}
const stormAndOverflow = {
  modes: { 'retry-storm': 'broken', 'queue-overflow': 'broken' },
  roots: ['retry-storm'],
}

/**
 * Every Scenario at its default Demand and at 3x, as is and with each Retry Policy on every
 * Variant (seed as shipped, 120 s; .scratch/diagnosis/table-probe.ts,
 * .scratch/new-scenarios/noisy-retry.ts; Noisy neighbor's 2x to 4x tests,
 * .scratch/new-scenarios/noisy-probe.ts).
 * Saturation fires in none of them: Backend overload's bursty traffic keeps the Backend under 26%
 * busy over 5 s, and Noisy neighbor's stays under 67%. So limit too loose, which needs a
 * saturated Backend, fires in none of them either, nor goodput collapse, which needs it at least
 * 80% busy. In Backend overload limit too tight and noisy neighbor fire in none: the bursts fill
 * at most 2 of every 10 seconds, so neither the Demand nor any one Client is over the limit
 * steadily. In Noisy neighbor limit too tight stays quiet as the Backend is about 50% busy, over
 * the 40% it needs; noisy neighbor fires only behind the limit shared by all.
 */
const TABLE: readonly Row[] = [
  ['Backend overload', backendOverloadScenario, 10, undefined, [none, none]],
  ['Backend overload', backendOverloadScenario, 10, 'immediate', [none, none]],
  ['Backend overload', backendOverloadScenario, 10, 'backoff', [none, none]],
  ['Backend overload', backendOverloadScenario, 10, 'backoff-jitter', [none, none]],
  ['Backend overload', backendOverloadScenario, 10, 'retry-after', [none, none]],
  ['Backend overload', backendOverloadScenario, 30, undefined, [overflow, none]],
  // Retries at once: a storm in both, the Root Cause; the token bucket's Backend copes.
  ['Backend overload', backendOverloadScenario, 30, 'immediate', [stormAndOverflow, storm]],
  ['Backend overload', backendOverloadScenario, 30, 'backoff', [overflow, none]],
  ['Backend overload', backendOverloadScenario, 30, 'backoff-jitter', [overflow, none]],
  ['Backend overload', backendOverloadScenario, 30, 'retry-after', [overflow, none]],
  ['Noisy neighbor', noisyNeighborScenario, 20, undefined, [none, none]],
  ['Noisy neighbor', noisyNeighborScenario, 20, 'immediate', [none, none]],
  ['Noisy neighbor', noisyNeighborScenario, 20, 'backoff', [none, none]],
  ['Noisy neighbor', noisyNeighborScenario, 20, 'backoff-jitter', [none, none]],
  ['Noisy neighbor', noisyNeighborScenario, 20, 'retry-after', [none, none]],
  ['Noisy neighbor', noisyNeighborScenario, 60, undefined, [noisy, none]],
  // Retries at once: the rejected Requests come straight back, a storm and the Root Cause; the
  // greedy Client still crowds the others out of the shared limit. Per Client only a's are
  // rejected, and its storm reaches amber on some seeds (0 to 11 s of 106 over seeds 1 to 8); this
  // row runs seed 1, where it does not.
  ['Noisy neighbor', noisyNeighborScenario, 60, 'immediate', [stormAndNoisy, none]],
  ['Noisy neighbor', noisyNeighborScenario, 60, 'backoff', [noisy, none]],
  ['Noisy neighbor', noisyNeighborScenario, 60, 'backoff-jitter', [noisy, none]],
  ['Noisy neighbor', noisyNeighborScenario, 60, 'retry-after', [noisy, none]],
]

describe('Scenario Findings table', () => {
  it.each(TABLE)('%s at %s/s with Retry Policy %s', (_, scenario, demandRps, retry, expected) => {
    const rows = worstFindings(scenario, demandRps, retry)
    expect(rows.map((row) => ({ modes: row.modeSeverities, roots: row.rootCauses }))).toEqual(
      expected,
    )
  })

  it('Backend overload at 20/s (2x): sliding window counter is already losing work', () => {
    const [sliding, token] = worstFindings(backendOverloadScenario, 20)
    expect(sliding?.worst).not.toBe('none')
    expect(token?.worst).toBe('none')
  })

  it.each([30, 40])(
    'Backend overload at %s/s (3x, 4x): sliding window counter fails, with queue overflow as the Root Cause',
    (demandRps) => {
      const [sliding, token] = worstFindings(backendOverloadScenario, demandRps)
      expect(sliding).toMatchObject({ worst: 'broken', rootCauses: ['queue-overflow'] })
      expect(token?.worst).toBe('none')
    },
  )

  it('Backend overload jumped from 10/s to 40/s: sliding window counter fails from then on, token bucket never', () => {
    // As a student drags the slider: 20 s at the default, then four times it.
    const runner = createRunner(backendOverloadScenario, { eventBudget: Infinity })
    while (runner.view().simMs < 20_000) runner.tick(100)
    runner.applyControl({ kind: 'demand', demandRps: 40 })
    const brokenSeconds = [0, 0]
    // One look per simulated second (a tick moves at most FRAME_CAP_MS, so ten ticks).
    for (let second = 21; second <= 80; second++) {
      while (runner.view().simMs < second * 1000) runner.tick(100)
      runner.view().variants.forEach(({ findings }, i) => {
        if (findings.some((f) => f.severity === 'broken')) {
          brokenSeconds[i] = (brokenSeconds[i] ?? 0) + 1
        }
      })
    }
    const [sliding, token] = brokenSeconds
    expect(sliding).toBeGreaterThanOrEqual(55)
    expect(token).toBe(0)
  })

  it('Noisy neighbor at 40/s (2x): the shared limit is starting to crowd the others out', () => {
    const [shared, perClient] = worstFindings(noisyNeighborScenario, 40)
    expect(shared).toMatchObject({ worst: 'warn', rootCauses: ['noisy-neighbor'] })
    expect(perClient?.worst).toBe('none')
  })

  it.each([60, 80])(
    'Noisy neighbor at %s/s (3x, 4x): the shared limit fails with noisy neighbor as the Root Cause, a limit per Client never',
    (demandRps) => {
      const [shared, perClient] = worstFindings(noisyNeighborScenario, demandRps)
      expect(shared).toMatchObject({ worst: 'broken', rootCauses: ['noisy-neighbor'] })
      expect(perClient?.worst).toBe('none')
    },
  )
})
