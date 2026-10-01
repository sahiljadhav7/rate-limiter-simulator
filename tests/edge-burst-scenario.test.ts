import { describe, expect, it } from 'vitest'
import { createRunner } from '../src/runner/runner.ts'
import { checkScenario } from '../src/runner/scenario.ts'
import { rollingWindowCounts } from '../src/ui/chart/geometry.ts'
import { edgeBurstScenario } from '../src/ui/edge-burst-scenario.ts'

/**
 * What the boundary-burst chart shows for the Edge burst Scenario, computed from the same seed the
 * app runs, so the peak the browser labels can be checked against it.
 */
describe('the Edge burst Scenario', () => {
  it('is a valid Scenario', () => {
    expect(() => checkScenario(edgeBurstScenario)).not.toThrow()
  })

  /** The most allowed Attempts in one window around each of the first five Edge Bursts. */
  function peaksPerBurst(variantIndex: number): number[] {
    const runner = createRunner(edgeBurstScenario, { eventBudget: Number.POSITIVE_INFINITY })
    while (runner.view().simMs < 55_000) runner.tick(100)
    const variant = runner.view().variants[variantIndex]
    if (variant === undefined) throw new Error('no such Variant')
    const points = rollingWindowCounts(variant.allowedSubBuckets, 1000, runner.view().simMs)
    return [1, 2, 3, 4, 5].map((k) => {
      const edgeMs = k * 10_000
      const near = points.filter((p) => p.t > edgeMs - 1000 && p.t <= edgeMs + 1000)
      return Math.max(...near.map((p) => p.v))
    })
  }

  it('lets twice the limit through the fixed window at every Edge Burst', () => {
    expect(peaksPerBurst(0)).toEqual([20, 20, 20, 20, 20])
  })

  it('keeps the sliding window counter close to the limit, though not always under it', () => {
    // The counter assumes the previous window's Attempts were spread evenly. Background
    // traffic plus a burst at the window's end breaks that, so a window can hold 1 or 2 more
    // than the limit of 10. The chart shows this as a peak of 1.1x or 1.2x.
    expect(peaksPerBurst(1)).toEqual([11, 10, 11, 12, 10])
  })
})
