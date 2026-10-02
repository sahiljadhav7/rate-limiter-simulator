import { describe, expect, it } from 'vitest'
import { createRunner } from '../src/runner/runner.ts'
import type { Scenario } from '../src/runner/scenario.ts'
import { backendOverloadScenario } from '../src/ui/scenarios/backend-overload.ts'
import { edgeBurstScenario } from '../src/ui/scenarios/edge-burst.ts'
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
const burst = { modes: { 'boundary-burst': 'broken' }, roots: ['boundary-burst'] }
const storm = { modes: { 'retry-storm': 'broken' }, roots: ['retry-storm'] }
const stormAndOverflow = {
  modes: { 'retry-storm': 'broken', 'queue-overflow': 'broken' },
  roots: ['retry-storm'],
}
// The first burst's rejected half retries at once, inside the first full window, so the storm
// starts a second before the boundary burst and is the earlier Cause (D6).
const stormAndBurst = {
  modes: { 'retry-storm': 'broken', 'boundary-burst': 'broken' },
  roots: ['retry-storm'],
}
// Edge burst at 3x: background Demand of 12/s is over the limit of 10/s in nearly every second,
// so limit too tight fires from 15 s (.scratch/more-rules/spec.md "Measured"). It starts after
// the boundary burst and the retry storm, so they keep Root Cause; behind the sliding window
// counter, with nothing else wrong, it is the Root Cause.
const tight = { modes: { 'limit-too-tight': 'broken' }, roots: ['limit-too-tight'] }
const burstAndTight = {
  modes: { 'boundary-burst': 'broken', 'limit-too-tight': 'broken' },
  roots: ['boundary-burst'],
}
const stormBurstAndTight = {
  modes: { 'retry-storm': 'broken', 'boundary-burst': 'broken', 'limit-too-tight': 'broken' },
  roots: ['retry-storm'],
}
const stormAndTight = {
  modes: { 'retry-storm': 'broken', 'limit-too-tight': 'broken' },
  roots: ['retry-storm'],
}

/**
 * Every Scenario at its default Demand and at 3x, as is and with "Retry at once" and "Back off
 * with jitter" on every Variant (seed as shipped, 120 s; .scratch/diagnosis/table-probe.ts).
 * Saturation fires in none of them: bursty traffic keeps the Backend under 26% busy over 5 s.
 * So limit too loose, which needs a saturated Backend, fires in none of them either, nor goodput
 * collapse, which needs it at least 80% busy. Noisy neighbor fires in none: Edge burst's bursts
 * all come from one Client, but it is never over its fair share for 10 seconds running.
 */
const TABLE: readonly Row[] = [
  ['Backend overload', backendOverloadScenario, 10, undefined, [none, none]],
  ['Backend overload', backendOverloadScenario, 10, 'immediate', [none, none]],
  ['Backend overload', backendOverloadScenario, 10, 'backoff-jitter', [none, none]],
  ['Backend overload', backendOverloadScenario, 30, undefined, [overflow, none]],
  // Retries at once: a storm in both, the Root Cause; the token bucket's Backend copes.
  ['Backend overload', backendOverloadScenario, 30, 'immediate', [stormAndOverflow, storm]],
  ['Backend overload', backendOverloadScenario, 30, 'backoff-jitter', [overflow, none]],
  // Fixed window first: a boundary burst at every Edge Burst, the Root Cause. The sliding
  // window counter has no window edge reset, and the Backend copes with what it allows.
  ['Edge burst', edgeBurstScenario, 4, undefined, [burst, none]],
  ['Edge burst', edgeBurstScenario, 4, 'immediate', [stormAndBurst, storm]],
  ['Edge burst', edgeBurstScenario, 4, 'backoff-jitter', [burst, none]],
  ['Edge burst', edgeBurstScenario, 12, undefined, [burstAndTight, tight]],
  ['Edge burst', edgeBurstScenario, 12, 'immediate', [stormBurstAndTight, stormAndTight]],
  ['Edge burst', edgeBurstScenario, 12, 'backoff-jitter', [burstAndTight, tight]],
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
})
