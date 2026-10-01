/**
 * Chart geometry: everything about where a chart draws that can be worked out without React,
 * so it is tested on its own (.scratch/chart/spec.md decision 1). Components only map these to
 * SVG.
 */

/**
 * How much simulated time a chart shows, in ms. Only Snapshots inside it become points, so
 * the cost of drawing stays the same however long the run gets.
 */
export const VISIBLE_MS = 60_000

/** Room at a chart's right edge for the axis labels, in px. */
export const AXIS_WIDTH = 40

/** Where a chart draws, horizontally, at a measured width. */
export interface ChartLayout {
  /** The SVG's width in px, drawn at 1:1 so text keeps its real size. */
  readonly width: number
  /** Where the plot ends and the axis labels begin, in px. */
  readonly plotRight: number
  /** One simulated second along the plot, for moving the crosshair with the arrow keys, in px. */
  readonly keyStepPx: number
}

/**
 * A chart's layout at `measuredWidth` px, rounded down to a whole pixel so it never overflows
 * its column; null until there is room for a plot beside the axis labels, so a chart that has
 * not been measured yet draws nothing rather than NaN.
 */
export function chartLayout(measuredWidth: number): ChartLayout | null {
  const width = Math.floor(measuredWidth)
  const plotRight = width - AXIS_WIDTH
  if (!(plotRight > 0)) return null
  return { width, plotRight, keyStepPx: (plotRight * 1000) / VISIBLE_MS }
}

/** One point of a series: `v` is null when there was nothing to measure (no value, no point). */
export interface Point {
  /** Simulated time, in ms. */
  readonly t: number
  readonly v: number | null
}

/** Maps a number from one interval onto another. */
export type Scale = (value: number) => number

/**
 * A linear scale from `domain` onto `range`. An empty domain maps everything to the start of
 * the range rather than dividing by 0.
 */
export function linearScale(
  [d0, d1]: readonly [number, number],
  [r0, r1]: readonly [number, number],
): Scale {
  const span = d1 - d0
  if (span === 0) return () => r0
  const k = (r1 - r0) / span
  return (value) => r0 + (value - d0) * k
}

/** `value` as 1, 2 or 5 times a power of ten, and that power. */
function leadAndPower(value: number): { lead: number; power: number } {
  const power = 10 ** Math.floor(Math.log10(value))
  return { lead: value / power, power }
}

/**
 * The smallest of 1, 2 or 5 times a power of ten that is `value` or more: a y axis maximum
 * that reads as a round number. 1 for 0 or less, so an empty chart still has a scale.
 */
export function niceMax(value: number): number {
  if (!(value > 0)) return 1
  const { lead, power } = leadAndPower(value)
  // A hair of slack, so 3 measured as 2.9999999999999996 tenths stays 5 tenths, not 10.
  const nice = [1, 2, 5, 10].find((step) => lead <= step * (1 + 1e-9)) ?? 10
  return nice * power
}

/**
 * Gridline values from 0 up to `max`, a niceMax: steps of a fifth for 1 and 5 times a power
 * of ten, and of a quarter for 2.
 */
export function gridValues(max: number): number[] {
  const { lead } = leadAndPower(max)
  const intervals = Math.round(lead) === 2 ? 4 : 5
  return Array.from({ length: intervals + 1 }, (_, i) =>
    // toPrecision drops float noise such as 3 x 0.2 = 0.6000000000000001.
    Number(((i * max) / intervals).toPrecision(12)),
  )
}

/** Rounds a coordinate to a tenth of a pixel, which is finer than the screen can show. */
function coordinate(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * SVG polyline `points` strings for a series: one per run of non-null values, so a null
 * breaks the line rather than drawing a 0 or joining across the gap.
 */
export function toPolylines(points: readonly Point[], x: Scale, y: Scale): string[] {
  const lines: string[] = []
  let run: string[] = []
  for (const { t, v } of points) {
    if (v === null) {
      if (run.length > 0) lines.push(run.join(' '))
      run = []
    } else {
      run.push(`${coordinate(x(t))},${coordinate(y(v))}`)
    }
  }
  if (run.length > 0) lines.push(run.join(' '))
  return lines
}

/**
 * SVG polygon `points` strings filling each run of non-null values down to `baseline` (a y
 * coordinate), for shading the area under a line.
 */
export function toAreas(points: readonly Point[], x: Scale, y: Scale, baseline: number): string[] {
  const areas: string[] = []
  let run: Point[] = []
  const close = () => {
    const first = run[0]
    const last = run.at(-1)
    if (first === undefined || last === undefined) return
    const base = coordinate(baseline)
    const top = run.map(({ t, v }) => `${coordinate(x(t))},${coordinate(y(v ?? 0))}`)
    areas.push(
      [`${coordinate(x(first.t))},${base}`, ...top, `${coordinate(x(last.t))},${base}`].join(' '),
    )
  }
  for (const point of points) {
    if (point.v === null) {
      close()
      run = []
    } else {
      run.push(point)
    }
  }
  close()
  return areas
}

/**
 * The simulated time a chart spans at `nowMs`: the first VISIBLE_MS until the run passes
 * them, then the last VISIBLE_MS, so the chart scrolls left.
 */
export function timeDomain(nowMs: number): [number, number] {
  const end = Math.max(nowMs, VISIBLE_MS)
  return [end - VISIBLE_MS, end]
}

/**
 * The Snapshots inside the visible window at `nowMs`, the one at its start included. They are
 * in time order, so this looks back from the newest and stops at the window's start.
 */
export function visibleSnapshots<S extends { readonly t: number }>(
  snapshots: readonly S[],
  nowMs: number,
): readonly S[] {
  const [start] = timeDomain(nowMs)
  let first = snapshots.length
  while (first > 0 && (snapshots[first - 1]?.t ?? -Infinity) >= start) first--
  return snapshots.slice(first)
}

/** The largest value as a multiple of `limit`, or null when there are no values. */
export function peakRatio(values: readonly number[], limit: number): number | null {
  if (values.length === 0) return null
  return Math.max(...values) / limit
}

/** A ratio as DESIGN.md writes it: one decimal place and a multiplication sign, as in 2.0×. */
export function formatRatio(ratio: number): string {
  return `${ratio.toFixed(1)}×`
}

/** The index of the point in `points` (in time order) whose time is nearest `t`; -1 if none. */
function nearestIndex(points: readonly Point[], t: number): number {
  let lo = 0
  let hi = points.length - 1
  if (hi < 0) return -1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((points[mid]?.t ?? 0) < t) lo = mid + 1
    else hi = mid
  }
  // `lo` is the first point at or after t; the one before it may be nearer.
  const before = points[lo - 1]
  const after = points[lo]
  if (before !== undefined && (after === undefined || t - before.t <= after.t - t)) return lo - 1
  return lo
}

/** What the hover tooltip lists: the time it is at, and every series' value then. */
export interface Hover {
  readonly t: number
  /** In series order; `v` is null when the series has no value at that time. */
  readonly values: readonly { readonly label: string; readonly v: number | null }[]
}

/**
 * The hover at simulated time `t`: the point nearest it, taken from the series with the most
 * points, and each series' value at exactly that time. Null when there are no points.
 */
export function hoverAt(
  series: readonly { readonly label: string; readonly points: readonly Point[] }[],
  t: number,
): Hover | null {
  let grid: readonly Point[] = []
  for (const s of series) if (s.points.length > grid.length) grid = s.points
  const at = grid[nearestIndex(grid, t)]?.t
  if (at === undefined) return null
  return {
    t: at,
    values: series.map(({ label, points }) => {
      const point = points[nearestIndex(points, at)]
      return { label, v: point !== undefined && point.t === at ? point.v : null }
    }),
  }
}
