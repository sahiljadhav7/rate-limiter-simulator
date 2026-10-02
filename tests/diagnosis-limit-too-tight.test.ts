import { describe, expect, it } from 'vitest'
import { createRunner } from '../src/runner/runner.ts'
import type { Scenario } from '../src/runner/scenario.ts'
import type { Finding } from '../src/sim/diagnosis.ts'
import type { LimiterSpec } from '../src/sim/limiter.ts'
import { withRetryMode } from '../src/ui/controls/retry-options.ts'
import { backendOverloadScenario } from '../src/ui/scenarios/backend-overload.ts'

/**
 * Steady Poisson Demand in front of a Backend of 4 slots of 50 ms (80/s), behind `limiter`
 * (.scratch/more-rules/spec.md, "Measured": seeds 1 to 8, 120 s).
 */
const fixture = (limiter: LimiterSpec, demandRps = 50, seed = 1): Scenario => ({
  id: 'limit-too-tight-fixture',
  title: 'Limit too tight fixture',
  lesson: 'None: a test fixture.',
  why: 'It only exists to be run.',
  models: 'One Backend behind one Limiter.',
  leavesOut: 'Everything a lesson would need.',
  seed,
  traffic: { shape: 'poisson', demandRps, clients: ['a', 'b', 'c'] },
  backend: { slots: 4, queueLimit: 20, meanMs: 50, cv: 0.5 },
  variants: [
    { label: 'Limiter', limiter, retry: { timeoutMs: 1000, maxAttempts: 1, retry: 'none' } },
  ],
})
const tokenBucket20: LimiterSpec = {
  algo: 'token-bucket',
  keyBy: 'global',
  capacity: 20,
  refillPerSec: 20,
}
const sliding20: LimiterSpec = {
  algo: 'sliding-counter',
  keyBy: 'global',
  limit: 20,
  windowMs: 1000,
}

/** Every second from 10 s to 120 s: each Variant's active Findings. */
function findingsEachSecond(sc: Scenario): (readonly Finding[])[][] {
  const runner = createRunner(sc, { eventBudget: Infinity })
  const seen: (readonly Finding[])[][] = sc.variants.map(() => [])
  for (let second = 10; second <= 120; second++) {
    while (runner.view().simMs < second * 1000) runner.tick(100)
    runner.view().variants.forEach((v, i) => seen[i]?.push(v.findings))
  }
  return seen
}
const tight = (fs: readonly Finding[]) => fs.find((f) => f.id === 'limit-too-tight')
const withRetry = (sc: Scenario, mode: 'immediate'): Scenario => ({
  ...sc,
  variants: sc.variants.map((v) => ({ ...v, retry: withRetryMode(v.retry, mode) })),
})
const at = (sc: Scenario, demandRps: number): Scenario => ({
  ...sc,
  traffic: { ...sc.traffic, demandRps },
})

describe('the limit too tight rule', () => {
  it.each([
    ['token bucket', tokenBucket20],
    ['sliding window counter', sliding20],
  ])('fires broken for a %s of 20/s under steady Demand of 50/s, from 15 s', (_, limiter) => {
    const [seen = []] = findingsEachSecond(fixture(limiter))
    // It judges 10 s, so the first is at 15 s (seconds 10 to 14 here are quiet).
    expect(seen.slice(0, 5).filter((fs) => tight(fs))).toEqual([])
    expect(tight(seen[5] ?? [])).toBeDefined()
    // 54% to 67% rejected over every 10 s, seeds 1 to 8: broken throughout.
    const broken = seen.slice(5).filter((fs) => tight(fs)?.severity === 'broken').length
    expect(broken).toBe(seen.length - 5)
    expect(seen.at(-1)?.[0]).toMatchObject({ id: 'limit-too-tight', role: 'root-cause' })
  })

  it('stays quiet for a limit above Demand (Poisson 50/s, limit 70/s)', () => {
    const limiter: LimiterSpec = { ...tokenBucket20, capacity: 10, refillPerSec: 70 }
    const [seen = []] = findingsEachSecond(fixture(limiter))
    expect(seen.filter((fs) => tight(fs))).toEqual([])
  })

  it('names the evidence and says why from the numbers', () => {
    const [seen = []] = findingsEachSecond(fixture(tokenBucket20))
    const finding = tight(seen.at(-1) ?? [])
    expect(finding?.evidence.map((e) => e.metric)).toEqual([
      'Rejected',
      'Demand',
      'Limiter allows',
      'Seconds over the limit',
      'Busy',
    ])
    expect(finding?.why).toMatch(
      /^In (each|\d+) of the last 10 seconds more new Requests arrived than the Limiter allows \(\d+\.\d\/s against 20\/s\), so it turned away \d+\.\d% of Attempts while the Backend was busy only \d+\.\d% of the time\.$/,
    )
  })

  // Bursts above the limit with a mean under it, the Scenarios written for other rules: the
  // steady-rate condition keeps it quiet (at most 3 of 10 seconds over the limit, seeds 1 to 8).
  it.each([
    ['Backend overload at 30/s', at(backendOverloadScenario, 30)],
    [
      'Backend overload at 40/s with "Retry at once"',
      withRetry(at(backendOverloadScenario, 40), 'immediate'),
    ],
  ])('stays quiet in %s, seeds 1 to 3', (_, scenario) => {
    for (let seed = 1; seed <= 3; seed++) {
      for (const seen of findingsEachSecond({ ...scenario, seed })) {
        expect(seen.filter((fs) => tight(fs))).toEqual([])
      }
    }
  })
})
