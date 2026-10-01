import { memo } from 'react'
import type { Finding } from '../../sim/index.ts'
import {
  announcement,
  findingAnchorId,
  ROLE_NAMES,
  sameFindings,
  SEVERITY_NAMES,
} from './diagnosis-card.ts'

/**
 * One active Finding (DESIGN.md "Diagnosis card"): a pill for its role and its label, the
 * evidence, why, and what to try. Focusable from script, so a chart marker can move to it.
 */
function DiagnosisCard({ finding, id }: { readonly finding: Finding; readonly id: string }) {
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
        {finding.fixes.map(({ text }) => (
          <li key={text}>{text}</li>
        ))}
      </ol>
    </article>
  )
}

/** What the diagnosis slot is drawn from. */
export interface DiagnosisSlotProps {
  readonly findings: readonly Finding[]
  /** The panel's id, which each card's id starts with. */
  readonly panelId: string
}

/**
 * The panel's last row: a card per active Finding, Root Cause first, and nothing at all when
 * there are none. A polite live region names the diagnosis without its numbers, so a screen
 * reader hears a new Root Cause once. It re-renders only when what it shows changes.
 */
export const DiagnosisSlot = memo(
  function DiagnosisSlot({ findings, panelId }: DiagnosisSlotProps) {
    return (
      <div className="diagnosis">
        <p className="visually-hidden" aria-live="polite">
          {announcement(findings)}
        </p>
        {findings.map((finding) => (
          <DiagnosisCard
            key={finding.id}
            finding={finding}
            id={findingAnchorId(panelId, finding.id)}
          />
        ))}
      </div>
    )
  },
  (before, after) =>
    before.panelId === after.panelId && sameFindings(before.findings, after.findings),
)
