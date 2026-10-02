import { memo, useId, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { WARM_UP_MS } from '../../sim/index.ts'
import {
  chartLayout,
  formatRatio,
  gridValues,
  hoverAt,
  linearScale,
  niceMax,
  peakRatio,
  pillLanes,
  timeDomain,
  toAreas,
  toPolylines,
  type Point,
} from './geometry.ts'
import { useElementWidth } from './use-element-width.ts'
import './chart.css'

/** One line on a chart. */
export interface Series {
  readonly id: string
  /** Named in the legend and the summary, so colour is never the only way to tell lines apart. */
  readonly label: string
  readonly points: readonly Point[]
  /** A CSS colour, always a token: `var(--danger-mark)`. */
  readonly color: string
  readonly dashed?: boolean
  /** Stroke width in px; SERIES_WIDTH by default. */
  readonly width?: number
}

/** A dashed horizontal line at a configured value, such as the limit, labelled at its right end. */
export interface ReferenceLine {
  readonly value: number
  readonly label: string
}

/** A vertical line at a moment of the run, such as when a Finding started (RS-26). */
export interface Marker {
  /** Simulated time, in ms. */
  readonly t: number
  readonly label: string
  /** The element its pill scrolls to and focuses, such as the Finding's card. */
  readonly targetId: string
}

/** Fills the area of one series above a limit, and labels its peak as a multiple of the limit. */
export interface OverLimit {
  readonly seriesId: string
  readonly limit: number
}

/** What a chart draws. Everything but `title`, `nowMs`, `series` and `unit` is optional. */
export interface TimeSeriesChartProps {
  /** What the chart shows, as a label above it. */
  readonly title: string
  /** The current simulated time, in ms: the right end of the time axis once it scrolls. */
  readonly nowMs: number
  readonly series: readonly Series[]
  readonly referenceLines?: readonly ReferenceLine[]
  readonly markers?: readonly Marker[]
  /** Whether this chart carries the markers' pills: only the top chart of a panel does. */
  readonly markerPills?: boolean
  readonly overLimit?: OverLimit
  /** Unit for the summary read by screen readers, such as "per second" or "milliseconds". */
  readonly unit: string
}

/**
 * The chart's height in px. Its width is its column's, measured, so text keeps its real size
 * at any number of columns (.scratch/panels/spec.md decision 8).
 */
const HEIGHT = 140
/** The highest and lowest y a value is drawn at, in px, leaving room for line caps. */
const TOP = 8
const BOTTOM = HEIGHT - 4

/** A series' stroke width, in px (DESIGN.md "Charts"). */
const SERIES_WIDTH = 1.5
/** The dash pattern of a dashed series, such as Demand. */
const SERIES_DASH = '4 3'

/** Pill size in px: label type is 11 px mono, about 0.66 of that per character with tracking. */
const PILL_CHAR_PX = 7.3
const PILL_PADDING_PX = 10
const PILL_HEIGHT = 13

/** How wide a pill must be to hold `text`, in px. */
function pillWidth(text: string): number {
  return text.length * PILL_CHAR_PX + PILL_PADDING_PX
}

/**
 * A marker pill's drawn height in px. The step between rows of them is `--marker-pill-step` in
 * chart.css, the height of the pill's hit area (32 px, or 44 px on a touch screen), so rows never
 * share a tap (DESIGN.md "Accessibility").
 */
const MARKER_PILL_HEIGHT = 18
/** The least space between two pills on one row, in px. */
const MARKER_PILL_GAP = 4

/**
 * Scrolls to the element `id` and moves focus there, so a keyboard user lands on what the
 * pill named. Smooth unless the reader asked for reduced motion.
 */
function goTo(id: string): void {
  const target = document.getElementById(id)
  if (target === null) return
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'nearest' })
  target.focus({ preventScroll: true })
}

/** The newest non-null value of a series, or null if it has none yet. */
function latest(points: readonly Point[]): number | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const v = points[i]?.v
    if (v !== null && v !== undefined) return v
  }
  return null
}

/**
 * A value as text: whole numbers, or one decimal place below 10. `missing` is what to show
 * when there is no value, never 0 (CLAUDE.md "The one rule").
 */
function asText(value: number | null, missing: string): string {
  if (value === null) return missing
  return value < 10 ? String(Math.round(value * 10) / 10) : String(Math.round(value))
}

/**
 * A hand-drawn SVG chart of the last 60 simulated seconds (DESIGN.md "Charts"): horizontal
 * gridlines, axis labels at the right edge, an inline legend, dashed reference lines, vertical
 * markers, the warm-up shaded, and an `aria-label` saying what it shows now.
 */
export const TimeSeriesChart = memo(function TimeSeriesChart(props: TimeSeriesChartProps) {
  const {
    title,
    nowMs,
    series,
    referenceLines = [],
    markers = [],
    markerPills = false,
    overLimit,
    unit,
  } = props
  const clipId = useId()
  const [measureRef, measuredWidth] = useElementWidth<HTMLElement>()
  /** Null until the figure has been measured: then nothing is drawn, rather than NaN. */
  const layout = chartLayout(measuredWidth)
  const width = layout?.width ?? 0
  const plotRight = layout?.plotRight ?? 0
  /**
   * Where the pointer or keyboard put the crosshair, in px along the plot. Kept as a position
   * rather than a time, so the crosshair stays under the pointer while the chart scrolls.
   */
  const [hoverPx, setHoverPx] = useState<number | null>(null)
  const domain = timeDomain(nowMs)
  const x = linearScale(domain, [0, plotRight])
  let highest = 0
  for (const s of series) for (const p of s.points) if (p.v !== null && p.v > highest) highest = p.v
  for (const line of referenceLines) highest = Math.max(highest, line.value)
  const yMax = niceMax(highest)
  const y = linearScale([0, yMax], [BOTTOM, TOP])
  const warmUpEnd = x(Math.min(WARM_UP_MS, nowMs))
  const showWarmUp = domain[0] < WARM_UP_MS && nowMs > 0
  // The pill names the shading while it is all in view; once the chart scrolls, the strip
  // narrows and a full-size pill would cover data from after the warm-up.
  const showWarmUpPill = showWarmUp && domain[0] === 0

  const limited = overLimit && series.find((s) => s.id === overLimit.seriesId)
  const ratio =
    overLimit && limited
      ? peakRatio(
          limited.points.flatMap((p) => (p.v === null ? [] : [p.v])),
          overLimit.limit,
        )
      : null
  /** The peak over the limit, as DESIGN.md writes it, or null when it stayed at or under. */
  const peakText =
    ratio !== null && ratio > 1 ? `peak ${formatRatio(ratio)} the limit in the last 60 s` : null

  const visibleMarkers = markers.filter((m) => m.t >= domain[0] && m.t <= domain[1])
  // A pill sits right of its line, or left of it when it would run past the plot.
  const pills = visibleMarkers.map((m) => {
    const width = pillWidth(m.label)
    const right = x(m.t) + 3
    return { marker: m, width, x: right + width <= plotRight ? right : x(m.t) - 3 - width }
  })
  const lanes = pillLanes(pills, MARKER_PILL_GAP)

  const hover =
    hoverPx === null ? null : hoverAt(series, linearScale([0, plotRight], domain)(hoverPx))
  const hoverX = hover === null ? 0 : x(hover.t)

  function onPointerMove(event: PointerEvent<SVGSVGElement>) {
    const box = event.currentTarget.getBoundingClientRect()
    const px = ((event.clientX - box.left) * width) / box.width
    setHoverPx(px <= plotRight ? Math.max(0, px) : null)
  }

  function onKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    const keyStepPx = layout?.keyStepPx ?? 0
    const step = { ArrowLeft: -keyStepPx, ArrowRight: keyStepPx }[event.key]
    if (step !== undefined) {
      event.preventDefault()
      setHoverPx((px) => Math.min(plotRight, Math.max(0, (px ?? plotRight) + step)))
    } else if (event.key === 'Escape') {
      setHoverPx(null)
    }
  }

  const summary =
    `${title}: ` +
    series.map((s) => `${s.label} ${asText(latest(s.points), 'no value')}`).join(', ') +
    (unit ? ` ${unit}` : '') +
    referenceLines.map((line) => `; ${line.label} ${asText(line.value, 'no value')}`).join('') +
    (peakText ? `; ${peakText}` : '') +
    visibleMarkers.map((m) => `; ${m.label} started at ${(m.t / 1000).toFixed(1)} s`).join('')

  return (
    <figure className="chart" ref={measureRef}>
      <figcaption className="chart-head">
        <span className="chart-title">{title}</span>
        {peakText ? <span className="chart-peak">{peakText}</span> : null}
        <ul className="chart-legend">
          {series.map((s) => (
            <li key={s.id}>
              <svg width="16" height="8" aria-hidden="true">
                <line
                  x1="0"
                  y1="4"
                  x2="16"
                  y2="4"
                  stroke={s.color}
                  strokeWidth={s.width ?? SERIES_WIDTH}
                  strokeDasharray={s.dashed ? SERIES_DASH : undefined}
                />
              </svg>
              {s.label}
            </li>
          ))}
        </ul>
      </figcaption>
      <div className="chart-box" style={{ height: HEIGHT }}>
        {layout ? (
          <svg
            className="chart-plot"
            width={width}
            height={HEIGHT}
            viewBox={`0 0 ${width} ${HEIGHT}`}
            role="img"
            aria-label={summary}
            // Focusable so the arrow keys can move the crosshair (DESIGN.md "Accessibility").
            tabIndex={0}
            onPointerMove={onPointerMove}
            onPointerLeave={() => setHoverPx(null)}
            onKeyDown={onKeyDown}
            onBlur={() => setHoverPx(null)}
          >
            <rect className="chart-surface" x="0" y="0" width={plotRight} height={HEIGHT} />
            {showWarmUp ? (
              <g className="chart-warm-up">
                <rect x="0" y="0" width={Math.max(0, warmUpEnd)} height={HEIGHT} />
                {showWarmUpPill ? (
                  <>
                    <rect
                      className="chart-pill"
                      x="3"
                      y={TOP}
                      width={pillWidth('WARM-UP')}
                      height={PILL_HEIGHT}
                      rx={PILL_HEIGHT / 2}
                    />
                    <text x={3 + PILL_PADDING_PX / 2} y={TOP + 9.5}>
                      WARM-UP
                    </text>
                  </>
                ) : null}
              </g>
            ) : null}
            {gridValues(yMax).map((value) => (
              <g key={value}>
                <line className="chart-grid" x1="0" x2={plotRight} y1={y(value)} y2={y(value)} />
                <text className="chart-axis" x={plotRight + 6} y={y(value) + 3.5}>
                  {value}
                </text>
              </g>
            ))}
            {overLimit && limited && peakText ? (
              <g>
                <clipPath id={clipId}>
                  <rect x="0" y="0" width={plotRight} height={y(overLimit.limit)} />
                </clipPath>
                {toAreas(limited.points, x, y, BOTTOM).map((points) => (
                  <polygon
                    key={points}
                    className="chart-over-limit"
                    clipPath={`url(#${clipId})`}
                    points={points}
                  />
                ))}
              </g>
            ) : null}
            {referenceLines.map((line) => (
              <g key={line.label} className="chart-reference">
                <line x1="0" x2={plotRight} y1={y(line.value)} y2={y(line.value)} />
                <text x={plotRight - 4} y={y(line.value) - 4}>
                  {line.label} {line.value}
                </text>
              </g>
            ))}
            {series.map((s) =>
              toPolylines(s.points, x, y).map((points, i) => (
                <polyline
                  key={`${s.id}-${i}`}
                  className="chart-series"
                  points={points}
                  stroke={s.color}
                  strokeWidth={s.width ?? SERIES_WIDTH}
                  strokeDasharray={s.dashed ? SERIES_DASH : undefined}
                />
              )),
            )}
            {visibleMarkers.map((m) => (
              <line
                key={`${m.t}-${m.label}`}
                className="chart-marker"
                x1={x(m.t)}
                x2={x(m.t)}
                y1="0"
                y2={HEIGHT}
              />
            ))}
            {hover ? (
              <line className="chart-crosshair" x1={hoverX} x2={hoverX} y1="0" y2={HEIGHT} />
            ) : null}
          </svg>
        ) : null}
        {/* HTML, not SVG: a control inside role="img" is hidden from screen readers. */}
        {layout && markerPills
          ? pills.map(({ marker, width: pillPx, x: left }, i) => (
              <button
                key={`${marker.t}-${marker.label}`}
                type="button"
                className="chart-marker-pill"
                style={{
                  left: `${(left / width) * 100}%`,
                  top: `calc(${TOP}px + ${lanes[i] ?? 0} * var(--marker-pill-step))`,
                  width: pillPx,
                  height: MARKER_PILL_HEIGHT,
                }}
                aria-label={`${marker.label}, started at ${(marker.t / 1000).toFixed(1)} s`}
                onClick={() => goTo(marker.targetId)}
              >
                {marker.label}
              </button>
            ))
          : null}
        {hover ? (
          <div
            className="chart-tooltip"
            aria-hidden="true"
            data-side={hoverX > plotRight / 2 ? 'left' : 'right'}
            style={{ left: `${(hoverX / width) * 100}%` }}
          >
            <div className="chart-tooltip-time">{(hover.t / 1000).toFixed(1)} s</div>
            {hover.values.map(({ label, v }) => (
              <div key={label} className="chart-tooltip-row">
                <span>{label}</span>
                <span className="chart-tooltip-value">{asText(v, '–')}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </figure>
  )
})
