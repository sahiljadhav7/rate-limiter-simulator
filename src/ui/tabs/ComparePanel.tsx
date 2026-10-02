import type { VariantView } from '../../runner/runner.ts'
import type { Scenario } from '../../runner/scenario.ts'
import { nodeState } from '../panel/node-state.ts'
import { panelStats } from '../panel/stats.ts'
import { StatRow } from '../panel/VariantPanel.tsx'
import { rootCause } from './tabs.ts'

/**
 * The phone's Compare tab (.scratch/polish/spec.md decision 11): per Variant, its short name, its
 * stat row and its Root Cause, one above the other, so every Variant's numbers fit one screen.
 * Each name is a button that opens that Variant's tab. CSS shows it below 640px, while open.
 */
export function ComparePanel(props: {
  readonly id: string
  readonly scenario: Scenario
  readonly variants: readonly VariantView[]
  readonly names: readonly string[]
  readonly open: boolean
  readonly onOpen: (index: number) => void
}) {
  const { id, scenario, variants, names, open, onOpen } = props
  return (
    <section
      id={id}
      className="island compare"
      role="tabpanel"
      aria-label="Compare"
      data-tab-open={open}
    >
      {scenario.variants.map((config, i) => {
        const variant = variants[i]
        if (!variant) return null
        const stats = panelStats(variant.snapshots, config.limiter, scenario.traffic.clients.length)
        const cause = rootCause(variant.findings)
        return (
          <div key={config.label} className="compare-variant">
            <h2 className="compare-name">
              <button type="button" className="compare-open" onClick={() => onOpen(i)}>
                {names[i] ?? config.label}
                <span className="visually-hidden">: open its tab</span>
              </button>
            </h2>
            <StatRow
              stats={stats}
              backendSeverity={nodeState(variant.findings, 'backend').severity}
            />
            {cause ? (
              <p className="compare-cause" data-severity={cause.severity}>
                <span className="pill">Root cause</span>
                {cause.label}
                <span className="label compare-severity">{cause.word}</span>
              </p>
            ) : null}
          </div>
        )
      })}
    </section>
  )
}
