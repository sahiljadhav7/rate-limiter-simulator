import { memo } from 'react'
import type { VariantView } from '../runner/runner.ts'
import type { VariantConfig } from '../runner/scenario.ts'
import { limiterWindow, type BackendSpec, type Snapshot } from '../sim/index.ts'
import { rollingWindowCounts, timeDomain, visibleSnapshots, type Point } from './chart/geometry.ts'
import { TimeSeriesChart } from './chart/TimeSeriesChart.tsx'
import { limiterCapacity } from './panel/stats.ts'

/** One value of every visible Snapshot, at the end of the second it covers. */
function pointsOf(snapshots: readonly Snapshot[], pick: (s: Snapshot) => number | null): Point[] {
  return snapshots.map((s) => ({ t: s.t, v: pick(s) }))
}

/** What one Variant's charts are drawn from. */
export interface VariantChartsProps {
  readonly variant: VariantView
  readonly config: VariantConfig
  readonly backend: BackendSpec
  /** How many Clients the Scenario has: a per-client Limiter allows its rate to each. */
  readonly clients: number
  /** The current simulated time, in ms. */
  readonly nowMs: number
}

/**
 * The charts of one Variant: the boundary burst (for a Limiter with a window), Attempts per
 * second, latency, the Backend queue, and Offered Load against Demand.
 */
export const VariantCharts = memo(function VariantCharts({
  variant,
  config,
  backend,
  clients,
  nowMs,
}: VariantChartsProps) {
  const snapshots = visibleSnapshots(variant.snapshots, nowMs)
  const limiterWindowSpec = limiterWindow(config.limiter)
  const [start] = timeDomain(nowMs)
  return (
    <div className="variant-charts">
      {limiterWindowSpec ? (
        <TimeSeriesChart
          title="Allowed in the last window"
          unit=""
          nowMs={nowMs}
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
      ) : null}
      <TimeSeriesChart
        title="Attempts per second"
        unit="per second"
        nowMs={nowMs}
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
        nowMs={nowMs}
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
        title="Requests waiting for a Backend slot"
        unit=""
        nowMs={nowMs}
        series={[
          {
            id: 'queue',
            label: 'Waiting',
            color: 'var(--kind-backend-stroke)',
            points: pointsOf(snapshots, (s) => s.queueDepth),
          },
        ]}
        referenceLines={[{ value: backend.queueLimit, label: 'queue limit' }]}
      />
      <TimeSeriesChart
        title="Offered Load against Demand (per second)"
        unit="per second"
        nowMs={nowMs}
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
    </div>
  )
})
