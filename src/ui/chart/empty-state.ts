/**
 * What a chart says instead of drawing an empty plot (.scratch/polish/spec.md decisions 14 and
 * 15). An empty chart would otherwise draw a made-up 0 to 1 scale, which looks like a measurement
 * and is not one (CLAUDE.md "The one rule").
 */
import type { Point } from './geometry.ts'

/** Before the first Snapshot, and after Reset: no series has a point yet. */
export const WAITING_TEXT = 'Waiting for the first simulated second'

/**
 * The words a chart shows in place of its plot, or null when it has something to draw.
 * `noValueText` is the chart's own words for a window with points but no value in it, such as
 * the latency chart when no Attempt succeeded; a chart without them draws its gaps. A gap in the
 * middle of a run stays a gap.
 */
export function chartEmptyState(
  series: readonly { readonly points: readonly Point[] }[],
  domain: readonly [number, number],
  noValueText?: string,
): string | null {
  if (series.every((s) => s.points.length === 0)) return WAITING_TEXT
  if (noValueText === undefined) return null
  const hasValue = series.some((s) =>
    s.points.some((p) => p.v !== null && p.t >= domain[0] && p.t <= domain[1]),
  )
  return hasValue ? null : noValueText
}
