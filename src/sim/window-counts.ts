/**
 * Allowed Attempts per window-length, from the engine's sub-buckets. Both the boundary-burst
 * chart and the boundary burst rule read this one count, so the card's peak and the chart's
 * label can never disagree (.scratch/diagnosis/spec.md decision 9).
 */
import type { AllowedSubBuckets } from './engine.ts'

/**
 * Allowed Attempts in the window ending at each sub-bucket's end: the boundary-burst chart's
 * rolling count, sampled every sub-bucket (a tenth of a window). Per-second buckets would split
 * a burst across a window edge and hide the 2x (CLAUDE.md). The last sub-bucket is still
 * filling, so its point is at `nowMs`. Only points at `fromMs` or later are returned, and the
 * sums start one window before that, so the cost depends on the time shown, not the run's
 * length.
 */
export function rollingWindowCounts(
  { bucketMs, counts }: AllowedSubBuckets,
  windowMs: number,
  nowMs: number,
  fromMs = 0,
): { readonly t: number; readonly v: number }[] {
  const perWindow = Math.round(windowMs / bucketMs)
  const first = Math.max(0, Math.floor(fromMs / bucketMs) - perWindow)
  const points: { t: number; v: number }[] = []
  let inWindow = 0
  for (let i = first; i < counts.length; i++) {
    inWindow += (counts[i] ?? 0) - (i - perWindow >= first ? (counts[i - perWindow] ?? 0) : 0)
    const t = Math.min((i + 1) * bucketMs, nowMs)
    if (t >= fromMs) points.push({ t, v: inWindow })
  }
  return points
}
