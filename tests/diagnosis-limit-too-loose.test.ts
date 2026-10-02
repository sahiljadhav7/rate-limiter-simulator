import { describe, expect, it } from 'vitest'
import { createRunner } from '../src/runner/runner.ts'
import type { Scenario } from '../src/runner/scenario.ts'
import type { Finding } from '../src/sim/diagnosis.ts'
import type { LimiterSpec } from '../src/sim/limiter.ts'

/**
 * Poisson 100/s into a Backend of 4 slots of 50 ms, so it can serve 80/s, behind `limiter`
 * (.scratch/more-rules/spec.md, "Measured": seeds 1 to 8, 120 s).
 */
const scenario = (limiter: LimiterSpec, seed = 1): Scenario => ({
  id: 'limit-too-loose-fixture',
  title: 'Limit too loose fixture',
  lesson: 'None: a test fixture.',
  why: 'It only exists to be run.',
  models: 'One Backend behind one Limiter.',
  leavesOut: 'Everything a lesson would need.',
  seed,
  traffic: { shape: 'poisson', demandRps: 100, clients: ['a', 'b', 'c'] },
  backend: { slots: 4, queueLimit: 40, meanMs: 50, cv: 1 },
  variants: [
    {
      label: 'Limiter',
      limiter,
      retry: { timeoutMs: 2000, maxAttempts: 1, retry: 'none' },
    },
  ],
})

const lets = (refillPerSec: number, capacity = 10): LimiterSpec => ({
  algo: 'token-bucket',
  keyBy: 'global',
  capacity,
  refillPerSec,
})

/** Every second from 10 s to 120 s: the active Findings. */
function findingsEachSecond(sc: Scenario): (readonly Finding[])[] {
  const runner = createRunner(sc, { eventBudget: Infinity })
  const seen: (readonly Finding[])[] = []
  for (let second = 10; second <= 120; second++) {
    while (runner.view().simMs < second * 1000) runner.tick(100)
    seen.push(runner.view().variants[0]?.findings ?? [])
  }
  return seen
}
const loose = (fs: readonly Finding[]) => fs.find((f) => f.id === 'limit-too-loose')

describe('the limit too loose rule', () => {
  it('fires broken behind a limit far above the Backend, as the Root Cause of its saturation', () => {
    const seen = findingsEachSecond(scenario(lets(10_000, 10_000)))
    // Saturated, with nothing rejected, in 888 of 888 windows over seeds 1 to 8.
    const broken = seen.filter((fs) => loose(fs)?.severity === 'broken').length
    expect(broken / seen.length).toBeGreaterThan(0.9)
    expect(seen.at(-1)?.map((f) => [f.id, f.role])).toEqual([
      ['limit-too-loose', 'root-cause'],
      ['saturation', 'contributing'],
      ['queue-overflow', 'contributing'],
    ])
  })

  it('fires for a limit just over what the Backend can serve, though it rejects some (85/s against 80/s)', () => {
    // Rejects 7% to 22% while the Backend stays 97% to 100% busy.
    const seen = findingsEachSecond(scenario(lets(85)))
    expect(seen.filter((fs) => loose(fs) !== undefined).length / seen.length).toBeGreaterThan(0.9)
  })

  it('stays quiet for a limit under what the Backend can serve (70/s against 80/s), on seeds 1 to 8', () => {
    for (let seed = 1; seed <= 8; seed++) {
      expect(findingsEachSecond(scenario(lets(70), seed)).filter((fs) => loose(fs))).toEqual([])
    }
  })

  it('names the evidence, says why from the numbers, and offers a lower limit', () => {
    const last = findingsEachSecond(scenario(lets(10_000, 10_000))).at(-1)
    const finding = last && loose(last)
    expect(finding?.evidence.map((e) => e.metric)).toEqual([
      'Rejected',
      'Limiter allows',
      'Backend can serve',
      'Busy',
    ])
    expect(finding?.evidence.slice(0, 3).map((e) => e.value)).toEqual(['0.0%', '10,000/s', '80/s'])
    expect(finding?.why).toMatch(
      /^The Limiter allows 10,000\/s and turned away 0\.0% of Attempts, but the Backend can serve only 80\/s, so it was busy \d+\.\d% of the time\.$/,
    )
    expect(finding?.fixes[0]?.patch?.limiter).toEqual(lets(60, 20))
  })
})
