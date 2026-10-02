import { memo } from 'react'
import type { VariantConfig } from '../../runner/scenario.ts'
import type { Finding, Fix } from '../../sim/index.ts'
import {
  announcement,
  findingAnchorId,
  ROLE_NAMES,
  sameFindings,
  SEVERITY_NAMES,
} from './diagnosis-card.ts'
import { fixActions, type FixAction } from './fix-actions.ts'

/**
 * A fix's Apply fix button (DESIGN.md "Button"): primary for the Root Cause's first one. Its
 * accessible name adds what it applies, as a card can hold several.
 */
function ApplyButton(props: { readonly action: FixAction; readonly onApply: (fix: Fix) => void }) {
  const { action, onApply } = props
  const name = action.fix.patch?.name ?? ''
  return (
    <button
      type="button"
      className={action.primary ? 'btn btn-primary fix-apply' : 'btn fix-apply'}
      disabled={action.applied}
      aria-label={action.applied ? `Applied: ${name}` : `Apply fix: ${name}`}
      title="Runs this fix beside the Variant, both from 0 on the same traffic"
      onClick={() => onApply(action.fix)}
    >
      {action.applied ? 'Applied' : 'Apply fix'}
    </button>
  )
}

/**
 * One active Finding (DESIGN.md "Diagnosis card"): a pill for its role and its label, the
 * evidence, why, and what to try. Focusable from script, so a chart marker can move to it.
 */
function DiagnosisCard(props: {
  readonly finding: Finding
  readonly id: string
  /** Per fix, its Apply fix button or null. */
  readonly actions: readonly (FixAction | null)[]
  readonly onApply: (fix: Fix) => void
}) {
  const { finding, id, actions, onApply } = props
  const titleId = `${id}-title`
  return (
    <article
      className="island diagnosis-card"
      id={id}
      data-severity={finding.severity}
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      <header className="diagnosis-head">
        <span className="pill">{ROLE_NAMES[finding.role]}</span>
        <h3 id={titleId}>{finding.label}</h3>
        <span className="label diagnosis-severity">{SEVERITY_NAMES[finding.severity]}</span>
      </header>
      <dl className="evidence">
        {finding.evidence.map(({ metric, value }) => (
          <div key={metric}>
            <dt className="label">{metric}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <h4 className="label">Why</h4>
      <p>{finding.why}</p>
      <h4 className="label">How to fix</h4>
      <ol className="fixes">
        {finding.fixes.map((fix, i) => {
          const action = actions[i]
          return (
            <li key={fix.text}>
              <span>{fix.text}</span>
              {action ? <ApplyButton action={action} onApply={onApply} /> : null}
            </li>
          )
        })}
      </ol>
    </article>
  )
}

/** What the diagnosis slot is drawn from. */
export interface DiagnosisSlotProps {
  readonly findings: readonly Finding[]
  /** The panel's id, which each card's id starts with. */
  readonly panelId: string
  /** Before the first judgement, the line saying when diagnosis starts; null after. */
  readonly warmUpLine: string | null
  /** The Variant the Findings are about, and every Variant of the Scenario, for Apply fix. */
  readonly config: VariantConfig
  readonly variants: readonly VariantConfig[]
  /** Applies `fix` to this Variant, which restarts the run. */
  readonly onApply: (fix: Fix) => void
}

/**
 * The panel's last row: a card per active Finding, Root Cause first, and nothing at all when
 * there are none, except during the warm-up, when a line says when diagnosis starts. A polite
 * live region names the diagnosis without its numbers, so a screen reader hears a new Root Cause
 * once. Each fix with a patch has an Apply fix button. It re-renders only when what it shows
 * changes.
 */
export const DiagnosisSlot = memo(
  function DiagnosisSlot(props: DiagnosisSlotProps) {
    const { findings, panelId, warmUpLine, config, variants, onApply } = props
    return (
      <div className="diagnosis">
        {warmUpLine ? <p className="label diagnosis-warm-up">{warmUpLine}</p> : null}
        <p className="visually-hidden" aria-live="polite">
          {announcement(findings)}
        </p>
        {findings.map((finding) => (
          <DiagnosisCard
            key={finding.id}
            finding={finding}
            id={findingAnchorId(panelId, finding.id)}
            actions={fixActions(finding, config, variants)}
            onApply={onApply}
          />
        ))}
      </div>
    )
  },
  (before, after) =>
    before.panelId === after.panelId &&
    before.warmUpLine === after.warmUpLine &&
    before.config === after.config &&
    before.variants === after.variants &&
    before.onApply === after.onApply &&
    sameFindings(before.findings, after.findings),
)
