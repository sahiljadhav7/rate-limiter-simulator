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
  it('Backend overload at its default 60/s: stable, no Variant goes amber or red', () => {
    expect(worstFindings(backendOverloadScenario, 60).map((row) => row.worst)).toEqual([
      'none',
      'none',
      'none',
    ])
  })

  it('Backend overload at 120/s (2x): fixed window is already losing work', () => {
    const [fixed, sliding, token] = worstFindings(backendOverloadScenario, 120)
    expect(fixed?.worst).not.toBe('none')
    expect([sliding?.worst, token?.worst]).toEqual(['none', 'none'])
  })

  it('Backend overload at 240/s (4x): fixed window fails, with queue overflow as the Root Cause', () => {
    const [fixed, sliding, token] = worstFindings(backendOverloadScenario, 240)
    expect(fixed).toMatchObject({ worst: 'broken', rootCauses: ['queue-overflow'] })
    expect([sliding?.worst, token?.worst]).toEqual(['none', 'none'])
  })

  it('Backend overload jumped from 60/s to 240/s: token bucket spends its saved 140 at once and fails briefly', () => {
    // As a student drags the slider: 20 s at 60/s, so the token bucket is full, then 240/s.
    const runner = createRunner(backendOverloadScenario, { eventBudget: Infinity })
    while (runner.view().simMs < 20_000) runner.tick(100)
    runner.applyControl({ kind: 'demand', demandRps: 240 })
    const brokenSeconds = [0, 0, 0]
    let tokenLastBroken = 0
    // One look per simulated second (a tick moves at most FRAME_CAP_MS, so ten ticks).
    for (let second = 21; second <= 80; second++) {
      while (runner.view().simMs < second * 1000) runner.tick(100)
      runner.view().variants.forEach(({ findings }, i) => {
        if (findings.some((f) => f.severity === 'broken')) {
          brokenSeconds[i] = (brokenSeconds[i] ?? 0) + 1
          if (i === 2) tokenLastBroken = second
        }
      })
    }
    const [fixed, sliding, token] = brokenSeconds
    // Fixed window fails from the jump on; sliding counter never does.
    expect(fixed).toBeGreaterThanOrEqual(58)
    expect(sliding).toBe(0)
    // Token bucket fails for about 5 s (the 5 s window holding the burst), then recovers.
    expect(token).toBeGreaterThanOrEqual(3)
    expect(tokenLastBroken).toBeLessThanOrEqual(30)
  })

  it('Edge burst at its default 4/s: the Backend copes with every burst, no Finding', () => {
    expect(worstFindings(edgeBurstScenario, 4).map((row) => row.worst)).toEqual(['none', 'none'])
  })
})
