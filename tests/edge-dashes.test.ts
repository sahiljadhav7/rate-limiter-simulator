import { describe, expect, it } from 'vitest'
import {
  DASH_CAP_PX_PER_S,
  DASH_FLOOR_PX_PER_S,
  DASH_STEP_PX_PER_S,
  dashPxPerSimSecond,
  dashPxPerWallSecond,
} from '../src/ui/panel/edge-dashes.ts'

describe('dashPxPerSimSecond', () => {
  it('is 0 with nothing flowing, or nothing measured yet', () => {
    expect(dashPxPerSimSecond(0)).toBe(0)
    expect(dashPxPerSimSecond(null)).toBe(0)
  })

  it('starts at the floor for 1 a second and adds the same step for every tenfold rise', () => {
    expect(dashPxPerSimSecond(1)).toBeCloseTo(DASH_FLOOR_PX_PER_S, 9)
    expect(dashPxPerSimSecond(10)).toBeCloseTo(DASH_FLOOR_PX_PER_S + DASH_STEP_PX_PER_S, 9)
    expect(dashPxPerSimSecond(1000)).toBeCloseTo(DASH_FLOOR_PX_PER_S + 3 * DASH_STEP_PX_PER_S, 9)
  })

  it('never goes below the floor for a positive rate', () => {
    expect(dashPxPerSimSecond(0.2)).toBe(DASH_FLOOR_PX_PER_S)
  })
})

describe('dashPxPerWallSecond', () => {
  it('follows simulated time: still while paused, faster at 10x, slower at 0.5x', () => {
    const atOne = dashPxPerWallSecond(10, 1, false)
    expect(dashPxPerWallSecond(10, 1, true)).toBe(0)
    expect(dashPxPerWallSecond(10, 0.5, false)).toBeCloseTo(atOne / 2, 9)
    expect(dashPxPerWallSecond(1, 10, false)).toBeCloseTo(10 * dashPxPerSimSecond(1), 9)
  })

  it('never passes the cap, at any rate and speed', () => {
    for (const rate of [1, 10, 100, 1000, 1e6])
      for (const speed of [0.5, 1, 10])
        expect(dashPxPerWallSecond(rate, speed, false)).toBeLessThanOrEqual(DASH_CAP_PX_PER_S)
  })
})
