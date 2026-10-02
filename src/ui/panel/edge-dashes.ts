/**
 * How fast an edge's dashes move (DESIGN.md "Edge"; .scratch/polish/spec.md decisions 18 and
 * 19). Speed follows the logarithm of the rate the edge's label shows, so 1 a second still crawls
 * and 1,000 a second does not blur. It does not follow the run's speed: the dashes say how much
 * flows here against there, and at 10x every edge would hit the cap and move alike. They stop
 * while paused. Pure; `useDashAnimation` moves the dashes.
 *
 * The numbers were chosen by arithmetic, not by watching (a headless browser cannot judge
 * motion): a dash and its gap are DASH_PERIOD_PX together.
 */

/** One dash and one gap, in px. */
export const DASH_PERIOD_PX = 8

/** Speed at 1 a second, in px a second: one dash period a second, a slow crawl. */
export const DASH_FLOOR_PX_PER_S = 8

/** Speed added for every tenfold rise in the rate, in px a second: 1,000/s gives 56. */
export const DASH_STEP_PX_PER_S = 16

/**
 * The most a dash moves, in px a second: 2 px a frame at 60 fps, a quarter of the dash period.
 * Near half the period a frame, dashes would seem to stand still or run backwards. No rate in a
 * Scenario reaches it (1,000/s is 56); it guards against a rate far beyond the slider.
 */
export const DASH_CAP_PX_PER_S = 120

/** Px a second for an edge carrying `ratePerSecond`, before the cap; 0 with no rate or no flow. */
export function dashSpeedForRate(ratePerSecond: number | null): number {
  if (ratePerSecond === null || ratePerSecond <= 0) return 0
  return Math.max(
    DASH_FLOOR_PX_PER_S,
    DASH_FLOOR_PX_PER_S + DASH_STEP_PX_PER_S * Math.log10(ratePerSecond),
  )
}

/** Px a second the dashes move: the rate's speed, capped, and 0 while paused. */
export function dashPxPerSecond(ratePerSecond: number | null, paused: boolean): number {
  if (paused) return 0
  return Math.min(DASH_CAP_PX_PER_S, dashSpeedForRate(ratePerSecond))
}
