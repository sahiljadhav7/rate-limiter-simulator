import type { ReactNode } from 'react'
import type { Severity } from '../../sim/index.ts'
import type { NodeState } from './node-state.ts'
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
 * A bar along the bottom of a node, from 0 to 1: how close it is to what it can handle. It
 * turns amber or red only with the node, which only a Finding makes so.
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
  /** From the Findings about this node; healthy when left out. */
  readonly state?: NodeState
}) {
  const { kind, name, metrics, meter, state } = props
  return (
    <li className="node" data-kind={kind} data-state={state?.severity ?? undefined}>
      <span className="node-name">
        {name}
        {state?.word ? <span className="node-word"> {state.word}</span> : null}
      </span>
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

/**
 * The arrow between two nodes, with the rate flowing along it. Static until RS-22. It turns red
 * when the node it feeds is failing (DESIGN.md "Edge").
 */
function Edge(props: {
  readonly rate: number | null
  readonly label: string
  readonly severity?: Severity | null
}) {
  const text = formatNumber(props.rate)
  return (
    <li
      className="edge"
      data-state={props.severity ?? undefined}
      aria-label={`${props.label}: ${text} per second`}
    >
      <span className="edge-rate" aria-hidden="true">
        {text}
        {props.rate === null ? null : '/s'}
      </span>
      <span className="edge-line" aria-hidden="true" />
    </li>
  )
}

/**
 * A Variant's pipeline (DESIGN.md "Pipeline node", "Edge"): Clients → Limiter → Backend with the
 * same numbers as the stat row, over the last 5 seconds, and the most waiting in the newest one.
 * A node the Findings say is struggling or failing says so, in colour and in words. Real text in
 * a list, so a screen reader reads it in order.
 */
export function PipelineStrip(props: {
  readonly stats: PanelStats
  /** The Backend node's state, from the Variant's Findings. */
  readonly backend: NodeState
}) {
  const { stats, backend } = props
  // The wrapper is the container the strip's narrow layout queries (panel.css). The panel itself
  // cannot be: a container has layout containment, and that stops it being a subgrid.
  return (
    <div className="pipeline-box">
      <ol
        className="pipeline"
        aria-label="Pipeline: rates and Busy over the last 5 seconds, most waiting in the last second"
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
        <Edge rate={stats.allowed} label="Allowed to the Backend" severity={backend.severity} />
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
            { value: formatNumber(stats.waiting), unit: '', label: 'Most waiting' },
            // The share the Finding measured, shown as it shows it, only while there is one.
            ...(backend.lost === null ? [] : [{ value: backend.lost, unit: '', label: 'Lost' }]),
          ]}
          meter={{ value: stats.backendMeter, label: 'Backend slots busy, percent' }}
          state={backend}
        />
      </ol>
    </div>
  )
}
