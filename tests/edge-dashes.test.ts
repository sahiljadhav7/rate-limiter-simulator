import { describe, expect, it } from 'vitest'
import {
  DASH_CAP_PX_PER_S,
  DASH_FLOOR_PX_PER_S,
  DASH_STEP_PX_PER_S,
  dashSpeedForRate,
  dashPxPerSecond,
} from '../src/ui/panel/edge-dashes.ts'

describe('dashSpeedForRate', () => {
  it('is 0 with nothing flowing, or nothing measured yet', () => {
    expect(dashSpeedForRate(0)).toBe(0)
    expect(dashSpeedForRate(null)).toBe(0)
  })

  it('starts at the floor for 1 a second and adds the same step for every tenfold rise', () => {
    expect(dashSpeedForRate(1)).toBeCloseTo(DASH_FLOOR_PX_PER_S, 9)
    expect(dashSpeedForRate(10)).toBeCloseTo(DASH_FLOOR_PX_PER_S + DASH_STEP_PX_PER_S, 9)
    expect(dashSpeedForRate(1000)).toBeCloseTo(DASH_FLOOR_PX_PER_S + 3 * DASH_STEP_PX_PER_S, 9)
  })

  it('never goes below the floor for a positive rate', () => {
    expect(dashSpeedForRate(0.2)).toBe(DASH_FLOOR_PX_PER_S)
  })
})

describe('dashPxPerSecond', () => {
  it("is the rate's own speed whatever the run's speed, so edges compare at 10x too", () => {
    expect(dashPxPerSecond(10, false)).toBeCloseTo(dashSpeedForRate(10), 9)
    expect(dashPxPerSecond(1000, false)).toBeGreaterThan(dashPxPerSecond(10, false))
  })

  it('is still while paused', () => {
    expect(dashPxPerSecond(10, true)).toBe(0)
  })

  it('never passes the cap, even at a rate far above any Scenario', () => {
    for (const rate of [1, 10, 100, 1000, 1e6, 1e12])
      expect(dashPxPerSecond(rate, false)).toBeLessThanOrEqual(DASH_CAP_PX_PER_S)
  })
})
