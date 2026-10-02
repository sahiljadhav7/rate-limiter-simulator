import { memo, useId, type CSSProperties, type ReactNode } from 'react'
import type { VariantView } from '../../runner/runner.ts'
import type { VariantConfig } from '../../runner/scenario.ts'
import type { BackendSpec, Severity } from '../../sim/index.ts'
import { RETRY_MODES, type RetryMode } from '../controls/retry-options.ts'
import { CHART_ROWS, VariantCharts } from '../VariantCharts.tsx'
import { DiagnosisSlot } from './DiagnosisCard.tsx'
import { ALGORITHM_NAMES, KEY_SCOPE_NAMES } from './limiter-names.ts'
import { nodeState } from './node-state.ts'
import { PipelineStrip } from './PipelineStrip.tsx'
import { DASH, formatNumber, formatShare, panelStats } from './stats.ts'
import './panel.css'

/**
 * How many grid rows a panel has: the header, the pipeline strip, the stat row, the charts and
 * the diagnosis slot. The panels share these rows through `subgrid`, so the same row sits at
 * the same height in every column.
 */
export const PANEL_ROWS = 4 + CHART_ROWS

/** One stat (DESIGN.md "Stat"): label above, the value in mono, the unit beside it. */
function Stat(props: {
  readonly label: ReactNode
  readonly value: string
  readonly unit: string
  readonly hero?: boolean
  /** Set only while a Finding is active for this value (DESIGN.md "Stat"). */
  readonly severity?: Severity | null
}) {
  const { label, value, unit, hero = false, severity = null } = props
  return (
    <div className={hero ? 'stat stat-hero' : 'stat'} data-state={severity ?? undefined}>
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
  /** This Variant's place in the Scenario, passed back with a Retry Policy change. */
  readonly index: number
  /** Switches Variant `index` to `mode`, which restarts the run. */
  readonly onRetryMode: (index: number, mode: RetryMode) => void
  /** The panel's id, which the phone's tab names in `aria-controls`. */
  readonly panelId: string
  /** Below 640px: the panel is a tab panel, shown only while its tab is open. */
  readonly phone: boolean
  /** Whether its tab is open on a phone; wider screens show every panel whatever this says. */
  readonly tabOpen: boolean
}

/**
 * One Variant as an island (DESIGN.md "Island"): a header naming it with its algorithm and key
 * scope, the pipeline strip and the stat row over the last 5 seconds, then its charts, then
 * a diagnosis card for each active Finding.
 */
export const VariantPanel = memo(function VariantPanel(props: VariantPanelProps) {
  const { variant, config, backend, clients, nowMs, index, onRetryMode, panelId, phone, tabOpen } =
    props
  const headingId = `${panelId}-heading`
  const retryId = useId()
  const stats = panelStats(variant.snapshots, config.limiter, clients)
  const backendState = nodeState(variant.findings, 'backend')
  return (
    <section
      className="island panel"
      id={panelId}
      // Focusable from script: an ended Finding's marker pill moves here.
      tabIndex={-1}
      aria-labelledby={headingId}
      role={phone ? 'tabpanel' : undefined}
      data-tab-open={tabOpen}
      style={{ '--panel-rows': PANEL_ROWS } as CSSProperties}
      data-testid="variant"
    >
      <header className="panel-head">
        <h2 id={headingId}>{config.label}</h2>
        <span className="pill">{ALGORITHM_NAMES[config.limiter.algo]}</span>
        <span className="pill">{KEY_SCOPE_NAMES[config.limiter.keyBy]}</span>
        <span className="retry">
          <label className="label" htmlFor={retryId}>
            Retry Policy
          </label>
          <select
            id={retryId}
            className="field"
            value={config.retry.retry}
            title="Changing it restarts the run from 0"
            onChange={(event) => onRetryMode(index, event.currentTarget.value as RetryMode)}
          >
            {RETRY_MODES.map(({ mode, name }) => (
              <option key={mode} value={mode}>
                {name}
              </option>
            ))}
          </select>
        </span>
      </header>
      <PipelineStrip stats={stats} backend={backendState} />
      <dl className="stats" aria-label="Last 5 seconds">
        <Stat label="Offered Load" value={formatNumber(stats.offeredLoad)} unit="/s" />
        {/* Goodput is what a failing Backend costs, so it carries the Backend's Finding. */}
        <Stat
          label="Goodput"
          value={formatNumber(stats.goodput)}
          unit="/s"
          severity={backendState.severity}
        />
        <Stat label="Rejected" value={formatShare(stats.rejectedShare)} unit="%" />
        <Stat
          label={
            <>
              Attempt <abbr title="99th percentile">p99</abbr>
            </>
          }
          value={formatNumber(stats.p99)}
          unit="ms"
          hero
        />
      </dl>
      <VariantCharts
        variant={variant}
        config={config}
        backend={backend}
        clients={clients}
        nowMs={nowMs}
        panelId={panelId}
      />
      <DiagnosisSlot findings={variant.findings} panelId={panelId} />
    </section>
  )
})
