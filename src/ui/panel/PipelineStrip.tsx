import type { ReactNode } from 'react'
import { DASH, formatNumber, formatShare, type PanelStats } from './stats.ts'

/** A pipeline node's kind, which picks its colours through the `[data-kind]` rules. */
type Kind = 'client' | 'limiter' | 'backend'

/** One metric of a node: the value in mono, then its unit and an uppercase label in kind ink. */
interface Metric {
  readonly value: string
  readonly unit: string
  readonly label: ReactNode
}

/**
 * A bar along the bottom of a node, from 0 to 1: how close it is to what it can handle. Never
 * --danger-mark yet; a node turns failing only when diagnosis (RS-26) says so.
 */
interface Meter {
  readonly value: number | null
  /** What the meter measures, for screen readers. */
  readonly label: string
}

function Node(props: {
  readonly kind: Kind
  readonly name: string
  readonly metrics: readonly Metric[]
  readonly meter?: Meter
}) {
  const { kind, name, metrics, meter } = props
  return (
    <li className="node" data-kind={kind}>
      <span className="node-name">{name}</span>
      <ul className="node-metrics">
        {metrics.map((m, i) => (
          // The metrics of a node never change order, so the index is a stable key.
          <li key={i}>
            <span className="node-value">
              {m.value}
              {m.value === DASH ? null : <span className="node-unit">{m.unit}</span>}
            </span>{' '}
            <span className="node-label">{m.label}</span>
          </li>
        ))}
      </ul>
      {meter ? (
        <div
          className="meter"
          role="meter"
          aria-label={meter.label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={meter.value === null ? undefined : Math.round(meter.value * 100)}
        >
          <div className="meter-fill" style={{ width: `${(meter.value ?? 0) * 100}%` }} />
        </div>
      ) : null}
    </li>
  )
}

/** The arrow between two nodes, with the rate flowing along it. Static until RS-22. */
function Edge(props: { readonly rate: number | null; readonly label: string }) {
  const text = formatNumber(props.rate)
  return (
    <li className="edge" aria-label={`${props.label}: ${text} per second`}>
      <span className="edge-rate" aria-hidden="true">
        {text}
        {props.rate === null ? null : '/s'}
      </span>
      <span className="edge-line" aria-hidden="true" />
    </li>
  )
}

/**
 * A Variant's pipeline (DESIGN.md "Pipeline node", "Edge"): Clients → Limiter → Backend with
 * the same numbers as the stat row: rates and Busy over the last 5 seconds, Waiting now. Real text in a list,
 * so a screen reader reads it in order.
 */
export function PipelineStrip({ stats }: { readonly stats: PanelStats }) {
  return (
    <ol
      className="pipeline"
      aria-label="Pipeline: rates and Busy over the last 5 seconds, Waiting now"
    >
      <Node
        kind="client"
        name="Clients"
        metrics={[
          { value: formatNumber(stats.demand), unit: '/s', label: 'Demand' },
          { value: formatNumber(stats.offeredLoad), unit: '/s', label: 'Offered' },
        ]}
      />
      <Edge rate={stats.offeredLoad} label="Offered Load to the Limiter" />
      <Node
        kind="limiter"
        name="Limiter"
        metrics={[
          { value: formatNumber(stats.allowed), unit: '/s', label: 'Allowed' },
          { value: formatShare(stats.rejectedShare), unit: '%', label: 'Rejected' },
        ]}
        meter={{ value: stats.limiterMeter, label: 'Allowed against the limit, percent' }}
      />
      <Edge rate={stats.allowed} label="Allowed to the Backend" />
      <Node
        kind="backend"
        name="Backend"
        metrics={[
          { value: formatShare(stats.busy), unit: '%', label: 'Busy' },
          {
            value: formatNumber(stats.p99),
            unit: 'ms',
            label: <abbr title="99th percentile">p99</abbr>,
          },
          { value: formatNumber(stats.waiting), unit: '', label: 'Waiting' },
        ]}
        meter={{ value: stats.backendMeter, label: 'Backend slots busy, percent' }}
      />
    </ol>
  )
}
