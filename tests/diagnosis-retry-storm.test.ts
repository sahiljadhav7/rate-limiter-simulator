import { describe, expect, it } from 'vitest'
import { createRunner } from '../src/runner/runner.ts'
import type { Scenario } from '../src/runner/scenario.ts'
import { createDiagnoser, retryStormRule } from '../src/sim/diagnosis.ts'
import type { AllowedSubBuckets } from '../src/sim/engine.ts'
import { withRetryMode, type RetryMode } from '../src/ui/controls/retry-options.ts'
import { backendOverloadScenario } from '../src/ui/scenarios/backend-overload.ts'
import { snapshotAt } from './snapshots.ts'

const allowed: AllowedSubBuckets = { bucketMs: 100, counts: [] }
const options = {
  backend: backendOverloadScenario.backend,
  limiter: { algo: 'token-bucket', keyBy: 'global', capacity: 1, refillPerSec: 1 },
  retry: { timeoutMs: 500, maxAttempts: 3, retry: 'immediate' },
} as const

/**
 * Severity after each second of `seconds`, each [Demand, Offered Load, quick retries], fed to
 * the retry storm rule alone after the warm-up. Retries are Offered Load minus Demand.
 */
function severities(seconds: readonly (readonly [number, number, number])[]) {
  const diagnoser = createDiagnoser(options, [retryStormRule(options.retry)])
  return seconds.map(([demand, offeredLoad, quickRetryAttempts], i) => {
    const retries = offeredLoad - demand
    diagnoser.add(
      snapshotAt((6 + i) * 1000, {
        demand,
        offeredLoad,
        retryAttempts: retries,
        quickRetryAttempts,
      }),
      allowed,
    )
    return diagnoser.findings()[0]?.severity ?? 'healthy'
  })
}
const repeat = <T>(n: number, x: T): T[] => Array<T>(n).fill(x)

/** Backend overload at `demandRps` with every Variant on `retry`, run to 120 s. */
function backendOverload(demandRps: number, retry: RetryMode) {
  const scenario: Scenario = {
    ...backendOverloadScenario,
    traffic: { ...backendOverloadScenario.traffic, demandRps },
    variants: backendOverloadScenario.variants.map((v) => ({
      ...v,
      retry: withRetryMode(v.retry, retry),
    })),
  }
  const runner = createRunner(scenario, { eventBudget: Infinity })
  const storms = scenario.variants.map(() => 0)
  while (runner.view().simMs < 120_000) {
    runner.tick(100)
    runner.view().variants.forEach((v, i) => {
      if (v.findings.some((f) => f.id === 'retry-storm')) storms[i] = (storms[i] ?? 0) + 1
    })
  }
  return { view: runner.view(), storms }
}

describe('the retry storm rule', () => {
  it.each([
    [10, 24, 14, 'broken'], // 2.4x Demand, every retry quick
    [10, 17, 7, 'warn'], // 1.7x
    [10, 24, 2, 'healthy'], // 2.4x, but most retries waited: backing off, not a storm
    [10, 12, 2, 'healthy'], // 1.2x: few retries
    [0, 0, 0, 'healthy'], // no Demand: no amplification to judge
  ] as const)(
    'Demand %s, Offered Load %s, %s quick retries a second is %s',
    (demand, offered, quick, severity) => {
      expect(severities(repeat(5, [demand, offered, quick] as const)).at(-1)).toBe(severity)
    },
  )

  it('names the evidence and says why from the numbers', () => {
    const diagnoser = createDiagnoser(options, [retryStormRule(options.retry)])
    for (let i = 0; i < 5; i++) {
      const s = snapshotAt((6 + i) * 1000, {
        demand: 10,
        offeredLoad: 24,
        retryAttempts: 14,
        quickRetryAttempts: 10,
      })
      diagnoser.add(s, allowed)
    }
    const [finding] = diagnoser.findings()
    expect(finding).toMatchObject({
      id: 'retry-storm',
      label: 'Retry storm',
      kind: 'cause',
      severity: 'broken',
      evidence: [
        { metric: 'Offered Load', value: '24.0/s' },
        { metric: 'Demand', value: '10.0/s' },
        { metric: 'Retry Amplification', value: '2.4×' },
        { metric: 'Retry Attempts within 10 ms', value: '71%' },
        { metric: 'When', value: '5 to 10 s' },
      ],
    })
    expect(finding?.why).toBe(
      'Offered Load reached 2.4× Demand because 71% of retry Attempts came within 10 ms of the ' +
        'failure that caused them, too soon for anything to have changed.',
    )
    expect(finding?.fixes.map((fix) => fix.text)).toEqual([
      'Try backing off with jitter, so each new Attempt waits a random, growing time',
      'Try waiting for Retry-After, so new Attempts come when the Limiter says there is room',
      'Try fewer Attempts per Request, so each failure adds less traffic',
    ])
  })

  it('holds between bursts rather than starting again each time (hysteresis)', () => {
    // Five storm seconds, then calm. From the 10th second on the 5 s window is calm, and the
    // Finding holds through 10 calm windows before it clears.
    const storm = [10, 50, 40] as const
    const calm = [10, 10, 0] as const
    const result = severities([...repeat(5, storm), ...repeat(14, calm)])
    expect(result.slice(4, 18).every((s) => s !== 'healthy')).toBe(true)
    expect(result.at(-1)).toBe('healthy')
  })

  it('fires in Backend overload at 30/s with "Retry at once": Root Cause, queue overflow Contributing', () => {
    const { view, storms } = backendOverload(30, 'immediate')
    const [sliding, token] = view.variants
    expect(sliding?.findings.map((f) => [f.id, f.role])).toEqual([
      ['retry-storm', 'root-cause'],
      ['queue-overflow', 'contributing'],
    ])
    // The token bucket's Backend is fine, but its Rejects come straight back: a storm of its own.
    expect(token?.findings.map((f) => [f.id, f.role])).toEqual([['retry-storm', 'root-cause']])
    expect(storms.every((n) => n > 0)).toBe(true)
  })

  it.each(['backoff-jitter', 'none'] as const)(
    'finds no retry storm in Backend overload at 30/s with %s',
    (retry) => {
      expect(backendOverload(30, retry).storms).toEqual([0, 0])
    },
  )
})
