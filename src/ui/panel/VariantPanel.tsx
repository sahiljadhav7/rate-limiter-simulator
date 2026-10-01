import { memo, useId, type CSSProperties } from 'react'
import type { VariantView } from '../../runner/runner.ts'
import type { VariantConfig } from '../../runner/scenario.ts'
import type { BackendSpec } from '../../sim/index.ts'
import { CHART_ROWS, VariantCharts } from '../VariantCharts.tsx'
import { ALGORITHM_NAMES, KEY_SCOPE_NAMES } from './limiter-names.ts'
import { DASH, formatRate, formatShare, panelStats } from './stats.ts'
import './panel.css'

/**
 * How many grid rows a panel has: the header, the stat row and the charts. The panels share
 * these rows through `subgrid`, so the same row sits at the same height in every column.
 */
export const PANEL_ROWS = 2 + CHART_ROWS

/** One stat (DESIGN.md "Stat"): label above, the value in mono, the unit beside it. */
function Stat(props: {
  readonly label: string
  readonly value: string
  readonly unit: string
  readonly hero?: boolean
}) {
  const { label, value, unit, hero = false } = props
  return (
    <div className={hero ? 'stat stat-hero' : 'stat'}>
      <dt className="label">{label}</dt>
      <dd className="stat-value">
        {value}
        {value === DASH ? null : <span className="unit">{unit}</span>}
      </dd>
    </div>
  )
}

/** What one Variant's panel is drawn from. */
export interface VariantPanelProps {
  readonly variant: VariantView
  readonly config: VariantConfig
  readonly backend: BackendSpec
  /** How many Clients the Scenario has: a per-client Limiter allows its rate to each. */
  readonly clients: number
  /** The current simulated time, in ms. */
  readonly nowMs: number
}

/**
 * One Variant as an island (DESIGN.md "Island"): a header naming it with its algorithm and key
 * scope, the stat row over the last 5 seconds, then its charts. The pipeline strip (ticket 06)
 * goes between the header and the stats, and the diagnosis card (RS-26) after the charts.
 */
export const VariantPanel = memo(function VariantPanel(props: VariantPanelProps) {
  const { variant, config, backend, clients, nowMs } = props
  const headingId = useId()
  const stats = panelStats(variant.snapshots, config.limiter, clients)
  return (
    <section
      className="island panel"
      aria-labelledby={headingId}
      style={{ '--panel-rows': PANEL_ROWS } as CSSProperties}
      data-testid="variant"
    >
      <header className="panel-head">
        <h2 id={headingId}>{config.label}</h2>
        <span className="pill">{ALGORITHM_NAMES[config.limiter.algo]}</span>
        <span className="pill">{KEY_SCOPE_NAMES[config.limiter.keyBy]}</span>
      </header>
      <dl className="stats" aria-label="Last 5 seconds">
        <Stat label="Offered Load" value={formatRate(stats.offeredLoad)} unit="/s" />
        <Stat label="Goodput" value={formatRate(stats.goodput)} unit="/s" />
        <Stat label="Rejected" value={formatShare(stats.rejectedShare)} unit="%" />
        <Stat label="Attempt p99" value={formatRate(stats.p99)} unit="ms" hero />
      </dl>
      <VariantCharts
        variant={variant}
        config={config}
        backend={backend}
        clients={clients}
        nowMs={nowMs}
      />
    </section>
  )
})
