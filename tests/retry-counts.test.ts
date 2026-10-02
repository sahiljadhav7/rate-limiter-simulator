import { describe, expect, it } from 'vitest'
import { createRunner } from '../src/runner/runner.ts'
import type { Scenario } from '../src/runner/scenario.ts'
import { QUICK_RETRY_MS, type Snapshot } from '../src/sim/metrics.ts'
import type { RetryPolicy } from '../src/sim/retry-policy.ts'

/** 200/s against a sliding window counter of 60 per 500 ms: plenty of Rejects to retry. */
const scenario = (retry: RetryPolicy): Scenario => ({
  id: 'retry-counts',
  title: 'Retry counts',
  lesson: 'None: a test fixture.',
  why: 'It only exists to be run.',
  models: 'One Limiter that rejects most Attempts.',
  leavesOut: 'Everything a lesson would need.',
  seed: 3,
  traffic: { shape: 'poisson', demandRps: 200, clients: ['a', 'b'] },
  backend: { slots: 4, queueLimit: 20, meanMs: 20, cv: 1 },
  variants: [
    {
      label: 'Sliding window counter',
      limiter: { algo: 'sliding-counter', keyBy: 'global', limit: 60, windowMs: 500 },
      retry,
    },
  ],
})

function totals(retry: RetryPolicy) {
  const runner = createRunner(scenario(retry), { eventBudget: Infinity })
  while (runner.view().simMs < 20_000) runner.tick(100)
  const snapshots = runner.view().variants[0]?.snapshots ?? []
  const sum = (pick: (s: Snapshot) => number) => snapshots.reduce((n, s) => n + pick(s), 0)
  return { retryAttempts: sum((s) => s.retryAttempts), quick: sum((s) => s.quickRetryAttempts) }
}

describe('retries and quick retries per Snapshot', () => {
  it(`counts a retry as quick when it started under ${QUICK_RETRY_MS} ms after its failure`, () => {
    const immediate = totals({ timeoutMs: 500, maxAttempts: 3, retry: 'immediate' })
    expect(immediate.retryAttempts).toBeGreaterThan(1000)
    expect(immediate.quick).toBe(immediate.retryAttempts)
  })

  it('counts no retry as quick when every one waits at least the base delay', () => {
    const backoff = totals({ timeoutMs: 500, maxAttempts: 3, retry: 'backoff', baseDelayMs: 100 })
    expect(backoff.retryAttempts).toBeGreaterThan(1000)
    expect(backoff.quick).toBe(0)
  })

  it('counts nothing with no retry', () => {
    expect(totals({ timeoutMs: 500, maxAttempts: 1, retry: 'none' })).toEqual({
      retryAttempts: 0,
      quick: 0,
    })
  })

  it('counts a jittered retry as quick only when its draw came under the threshold', () => {
    // Full jitter up to 100 ms for a second Attempt and 200 ms for a third: a few are quick.
    const jitter = totals({
      timeoutMs: 500,
      maxAttempts: 3,
      retry: 'backoff-jitter',
      baseDelayMs: 100,
    })
    expect(jitter.quick).toBeGreaterThan(0)
    expect(jitter.quick / jitter.retryAttempts).toBeLessThan(0.2)
  })
})
