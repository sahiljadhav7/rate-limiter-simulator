import { memo } from 'react'
import type { VariantView } from '../runner/runner.ts'
import type { VariantConfig } from '../runner/scenario.ts'
import {
  limiterWindow,
  rollingWindowCounts,
  type BackendSpec,
  type Snapshot,
} from '../sim/index.ts'
import { timeDomain, visibleSnapshots, type Point } from './chart/geometry.ts'
import { TimeSeriesChart } from './chart/TimeSeriesChart.tsx'
import { ALGORITHM_NAMES } from './panel/limiter-names.ts'
import { limiterCapacity } from './panel/stats.ts'
import { findingMarkers } from './panel/diagnosis-card.ts'

/** One value of every visible Snapshot, at the end of the second it covers. */
function pointsOf(snapshots: readonly Snapshot[], pick: (s: Snapshot) => number | null): Point[] {
  return snapshots.map((s) => ({ t: s.t, v: pick(s) }))
}

/**
 * How many rows VariantCharts adds to its panel, one per chart. Every Variant has the same
 * rows, a Limiter without a window included, so the panels' rows line up.
 */
export const CHART_ROWS = 5

/** The window chart's title; a Limiter without a window keeps it over a short line. */
const BOUNDARY_TITLE = 'Allowed in the last window'

/** What one Variant's charts are drawn from. */
export interface VariantChartsProps {
  readonly variant: VariantView
  readonly config: VariantConfig
  readonly backend: BackendSpec
  /** How many Clients the Scenario has: a per-client Limiter allows its rate to each. */
  readonly clients: number
  /** The current simulated time, in ms. */
  readonly nowMs: number
  /** The panel's id: a marker's pill scrolls to the panel, or to a card whose id starts with it. */
  readonly panelId: string
}

/**
 * The charts of one Variant, one grid row each (CHART_ROWS): Attempts allowed in the last window,
 * Attempts per second, latency, the Backend queue, and Offered Load against Demand. A Limiter
 * without a window (token bucket) has nothing to count per window, so its first row says so.
 */
export const VariantCharts = memo(function VariantCharts({
  variant,
  config,
  backend,
  clients,
  nowMs,
  panelId,
}: VariantChartsProps) {
  const snapshots = visibleSnapshots(variant.snapshots, nowMs)
  const limiterWindowSpec = limiterWindow(config.limiter)
  const [start] = timeDomain(nowMs)
  // Every chart marks where each Finding started, active or past, so the lines line up down
  // the panel; only the top chart carries the pills.
  const markers = findingMarkers(variant.findings, variant.pastFindings, panelId)
  return (
    <>
      {limiterWindowSpec ? (
        <TimeSeriesChart
          title={BOUNDARY_TITLE}
          unit=""
          nowMs={nowMs}
          markers={markers}
          markerPills
          series={[
            {
              id: 'rolling',
              label: 'Allowed Attempts',
              color: 'var(--kind-limiter-stroke)',
              points: rollingWindowCounts(
                variant.allowedSubBuckets,
                limiterWindowSpec.windowMs,
                nowMs,
                start,
              ),
            },
          ]}
          referenceLines={[{ value: limiterWindowSpec.limit, label: 'limit' }]}
          overLimit={{ seriesId: 'rolling', limit: limiterWindowSpec.limit }}
        />
      ) : (
        <div className="chart-none">
          <span className="chart-title">{BOUNDARY_TITLE}</span>
          <p>
            {ALGORITHM_NAMES[config.limiter.algo]} has no window: it lets Attempts through as its
            tokens come back, so there is no count per window to show.
          </p>
        </div>
      )}
      <TimeSeriesChart
        title="Attempts per second"
        unit="per second"
        nowMs={nowMs}
        markers={markers}
        // Without a window there is no window chart, so this is the top chart.
        markerPills={limiterWindowSpec === null}
        series={[
          {
            id: 'allowed',
            label: 'Allowed',
            color: 'var(--kind-limiter-stroke)',
            points: pointsOf(snapshots, (s) => s.allowed),
          },
          {
            id: 'rejected',
            label: 'Rejected',
            color: 'var(--danger-mark)',
            points: pointsOf(snapshots, (s) => s.rejected),
          },
          {
            id: 'delayed',
            label: 'Delayed',
            color: 'var(--kind-queue-stroke)',
            points: pointsOf(snapshots, (s) => s.delayed),
          },
        ]}
        referenceLines={[{ value: limiterCapacity(config.limiter, clients), label: 'limit' }]}
      />
      <TimeSeriesChart
        title="How long Attempts took (milliseconds, last 5 seconds)"
        unit="milliseconds"
        noValueText="No Attempt succeeded in the last 5 seconds"
        nowMs={nowMs}
        markers={markers}
        series={[
          {
            id: 'p50',
            label: 'Median (p50)',
            color: 'var(--line-3)',
            points: pointsOf(snapshots, (s) => s.p50),
          },
          {
            id: 'p95',
            label: '95th percentile (p95)',
            color: 'var(--line-4)',
            points: pointsOf(snapshots, (s) => s.p95),
          },
          {
            id: 'p99',
            label: '99th percentile (p99)',
            color: 'var(--text-dim)',
            width: 2,
            points: pointsOf(snapshots, (s) => s.p99),
          },
        ]}
      />
      <TimeSeriesChart
        title="Attempts waiting for a Backend slot, and shed"
        unit=""
        nowMs={nowMs}
        series={[
          {
            // The most during each second: one that fills and drains within it reads 0 at its end.
            id: 'queue',
            label: 'Most waiting',
            color: 'var(--kind-backend-stroke)',
            points: pointsOf(snapshots, (s) => s.peakQueueDepth),
          },
          {
            id: 'shed',
            label: 'Shed per second',
            color: 'var(--danger-mark)',
            points: pointsOf(snapshots, (s) => s.shed),
          },
        ]}
        referenceLines={[{ value: backend.queueLimit, label: 'queue limit' }]}
        markers={markers}
      />
      <TimeSeriesChart
        title="Offered Load against Demand (per second)"
        unit="per second"
        nowMs={nowMs}
        markers={markers}
        series={[
          {
            id: 'offered',
            label: 'Offered Load',
            color: 'var(--accent)',
            points: pointsOf(snapshots, (s) => s.offeredLoad),
          },
          {
            id: 'demand',
            label: 'Demand',
            color: 'var(--line-3)',
            dashed: true,
            points: pointsOf(snapshots, (s) => s.demand),
          },
        ]}
      />
    </>
  )
})
