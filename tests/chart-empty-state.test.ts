import { describe, expect, it } from 'vitest'
import { chartEmptyState, WAITING_TEXT } from '../src/ui/chart/empty-state.ts'

const NO_LATENCY = 'No Attempt succeeded in the last 5 seconds'
const domain: readonly [number, number] = [0, 60_000]
const series = (...values: (number | null)[]) => ({
  points: values.map((v, i) => ({ t: (i + 1) * 1000, v })),
})

describe('chartEmptyState', () => {
  it('is waiting before the first Snapshot, when no series has a point', () => {
    expect(chartEmptyState([series(), series()], domain)).toBe(WAITING_TEXT)
    expect(chartEmptyState([series()], domain, NO_LATENCY)).toBe(WAITING_TEXT)
  })

  it("is the chart's own words when no value falls in the window", () => {
    expect(chartEmptyState([series(null, null), series(null)], domain, NO_LATENCY)).toBe(NO_LATENCY)
  })

  it('counts only points inside the window', () => {
    const old = {
      points: [
        { t: 1000, v: 120 },
        { t: 70_000, v: null },
      ],
    }
    expect(chartEmptyState([old], [10_000, 70_000], NO_LATENCY)).toBe(NO_LATENCY)
  })

  it('is nothing once one real value is there', () => {
    expect(chartEmptyState([series(null, 151), series(null, null)], domain, NO_LATENCY)).toBeNull()
  })

  it('keeps a gap in the middle of a run as a gap', () => {
    expect(chartEmptyState([series(120, null, 140)], domain, NO_LATENCY)).toBeNull()
  })

  it('is nothing for a chart without its own words, even with only nulls', () => {
    expect(chartEmptyState([series(null, null)], domain)).toBeNull()
  })
})
