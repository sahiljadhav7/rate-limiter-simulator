/**
 * The Demand slider's scale (DESIGN.md "Slider (Demand)"), worked out without React so it is
 * tested on its own (.scratch/controls/spec.md decision 5).
 */
import type { ControlEvent } from '../../sim/index.ts'

/** The slider's ends, in Requests per second. */
export const MIN_DEMAND = 1
export const MAX_DEMAND = 1000

/** Where the slider's tick labels sit, in Requests per second. */
export const DEMAND_TICKS = [1, 10, 100, 1000] as const

/** Powers of ten the slider spans: 1 to 1,000. */
const DECADES = Math.log10(MAX_DEMAND / MIN_DEMAND)

/**
 * The Demand at slider position `p`, from 0 to 1: a log scale, so each power of ten gets the
 * same length and 1 to 10 is as easy to set as 100 to 1,000. Rounded to two significant
 * figures, so the value reads as a round number.
 */
export function demandFromPosition(p: number): number {
  return Number((MIN_DEMAND * 10 ** (p * DECADES)).toPrecision(2))
}

/** Where `demandRps` sits on the slider, from 0 to 1; pinned to the ends outside 1 to 1,000. */
export function positionFromDemand(demandRps: number): number {
  if (!(demandRps > MIN_DEMAND)) return 0
  return Math.min(1, Math.log10(demandRps / MIN_DEMAND) / DECADES)
}

/**
 * The Demand in effect at `simMs`: the newest Demand change in `timeline` (in time order) at or
 * before then, or `scenarioDemand` before any. Other changes, such as a burst, leave it alone.
 */
export function demandAt(
  scenarioDemand: number,
  timeline: readonly ControlEvent[],
  simMs: number,
): number {
  let demand = scenarioDemand
  for (const { atMs, change } of timeline) {
    if (atMs > simMs) break
    if (change.kind === 'demand') demand = change.demandRps
  }
  return demand
}
