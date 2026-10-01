import { describe, expect, it } from 'vitest'
import { demandAt, demandFromPosition, positionFromDemand } from '../src/ui/controls/demand.ts'
import type { ControlEvent } from '../src/sim/index.ts'

describe('the Demand slider scale', () => {
  it('spreads 1 to 1,000 Requests per second evenly by powers of ten', () => {
    expect([0, 1 / 3, 2 / 3, 1].map(demandFromPosition)).toEqual([1, 10, 100, 1000])
  })

  it('rounds to two significant figures, so the value reads as a round number', () => {
    // 10^(3p) = 3.98 here.
    expect(demandFromPosition(Math.log10(3.98) / 3)).toBe(4)
    expect(demandFromPosition(Math.log10(156) / 3)).toBe(160)
    expect(demandFromPosition(Math.log10(1.234) / 3)).toBe(1.2)
  })

  it('puts the tick values back where they came from', () => {
    for (const rps of [1, 10, 100, 1000]) {
      expect(demandFromPosition(positionFromDemand(rps))).toBe(rps)
    }
    expect(positionFromDemand(10)).toBeCloseTo(1 / 3, 12)
  })

  it('pins Demand below 1 to the left end and above 1,000 to the right end', () => {
    expect(positionFromDemand(0)).toBe(0)
    expect(positionFromDemand(0.5)).toBe(0)
    expect(positionFromDemand(4000)).toBe(1)
  })
})

describe('demandAt', () => {
  const timeline: ControlEvent[] = [
    { atMs: 2000, change: { kind: 'demand', demandRps: 50 } },
    { atMs: 3000, change: { kind: 'burst', multiplier: 5, durationMs: 2000 } },
    { atMs: 5000, change: { kind: 'demand', demandRps: 8 } },
  ]

  it("is the Scenario's Demand until the first change, then the newest change at or before then", () => {
    expect(demandAt(4, timeline, 1999)).toBe(4)
    expect(demandAt(4, timeline, 2000)).toBe(50)
    // A burst is not a Demand change: the slider stays where the student put it.
    expect(demandAt(4, timeline, 4000)).toBe(50)
    expect(demandAt(4, timeline, 9000)).toBe(8)
    expect(demandAt(4, [], 9000)).toBe(4)
  })
})
