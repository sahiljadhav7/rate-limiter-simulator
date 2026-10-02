import { describe, expect, it } from 'vitest'
import { baselineP99Ms } from '../src/sim/baseline.ts'
import { serviceTimeMs, type BackendSpec } from '../src/sim/backend.ts'
import { createRandomStream } from '../src/sim/rng.ts'
import { backendOverloadScenario } from '../src/ui/scenarios/backend-overload.ts'

const spec = (meanMs: number, cv: number): BackendSpec => ({ slots: 4, queueLimit: 20, meanMs, cv })

describe('baselineP99Ms', () => {
  it('is the mean when every service takes exactly the mean (cv 0)', () => {
    expect(baselineP99Ms(spec(50, 0))).toBe(50)
  })

  it('is mean x ln 100 for exponential service times (cv 1)', () => {
    expect(baselineP99Ms(spec(50, 1))).toBeCloseTo(50 * Math.log(100), 2)
    expect(baselineP99Ms(spec(120, 1))).toBeCloseTo(120 * Math.log(100), 2)
  })

  // At 200,000 draws cv 2's heavy tail misses by up to 1.33% on seeds 1 to 8; at 1,000,000 the
  // worst over those seeds is 0.68% (.scratch/diagnosis/baseline-probe.ts), so 1% holds on any
  // seed, not only this one (CLAUDE.md "Statistical tests").
  it.each([0.25, 0.5, 1, 2])(
    "matches the p99 of 1,000,000 draws from the Backend's own sampler within 1%% at cv %s",
    (cv) => {
      const stream = createRandomStream(7)
      const draws = Array.from({ length: 1_000_000 }, () => serviceTimeMs(spec(50, cv), stream))
      draws.sort((a, b) => a - b)
      const empirical = draws[Math.ceil(0.99 * draws.length) - 1] ?? NaN
      const theory = baselineP99Ms(spec(50, cv))
      expect(Math.abs(empirical - theory) / theory).toBeLessThan(0.01)
    },
  )

  it("gives each Scenario's Backend its baseline, as the Why texts quote it", () => {
    // Backend overload: 50 ms, cv 0.5 (gamma with shape 4 and scale 12.5; the chi-square table gives 20.09 / 2 x 12.5).
    expect(baselineP99Ms(backendOverloadScenario.backend)).toBeCloseTo(125.6, 1)
    // 50 ms, cv 1, as the saturation fixture: 50 x ln 100.
    expect(baselineP99Ms({ slots: 4, queueLimit: 40, meanMs: 50, cv: 1 })).toBeCloseTo(230.3, 1)
  })
})
