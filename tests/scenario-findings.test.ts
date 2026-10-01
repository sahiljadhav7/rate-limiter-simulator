import { describe, expect, it } from 'vitest'
import { createRunner } from '../src/runner/runner.ts'
import type { Scenario } from '../src/runner/scenario.ts'
import { backendOverloadScenario } from '../src/ui/scenarios/backend-overload.ts'
import { edgeBurstScenario } from '../src/ui/scenarios/edge-burst.ts'

/** Run length for each row: long enough for many window edges and a settled 5 s loss share. */
const RUN_MS = 120_000

/**
 * Runs `scenario` at `demandRps` for RUN_MS and gives each Variant's worst Finding at any
 * second, and its Root Cause then: what a student would have seen go red.
 */
function worstFindings(scenario: Scenario, demandRps: number) {
  const runner = createRunner(
    { ...scenario, traffic: { ...scenario.traffic, demandRps } },
    { eventBudget: Infinity },
  )
  const worst = scenario.variants.map(() => 'none' as 'none' | 'warn' | 'broken')
  const rootCauses = scenario.variants.map(() => new Set<string>())
  while (runner.view().simMs < RUN_MS) {
    runner.tick(100)
    runner.view().variants.forEach(({ findings }, i) => {
      for (const finding of findings) {
        if (finding.severity === 'broken' || worst[i] === 'none') worst[i] = finding.severity
        if (finding.role === 'root-cause') rootCauses[i]?.add(finding.id)
      }
    })
  }
  return scenario.variants.map((variant, i) => ({
    label: variant.label,
    worst: worst[i],
    rootCauses: [...(rootCauses[i] ?? [])],
  }))
}

/**
 * The Scenario Findings table (CLAUDE.md "Adding a scenario", "Adding a diagnosis rule"): for
 * each Scenario and Demand, which Findings each Variant produces and which is the Root Cause.
 * A new rule can fire in Scenarios written for other rules, so every row runs every rule.
 */
describe('Scenario Findings table', () => {
  it('Backend overload at its default 10/s: stable, neither Variant goes amber or red', () => {
    expect(worstFindings(backendOverloadScenario, 10).map((row) => row.worst)).toEqual([
      'none',
      'none',
    ])
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

  it('Edge burst at its default 4/s: the Backend copes with every burst, no Finding', () => {
    expect(worstFindings(edgeBurstScenario, 4).map((row) => row.worst)).toEqual(['none', 'none'])
  })
})
