import type { Scenario } from '../../runner/scenario.ts'
import { firstNote, secondNoteParts } from './scenario-notes.ts'
import './notes.css'

/**
 * The Scenario's two handwritten notes on the paper below the panels (DESIGN.md "Handwritten
 * note"; .scratch/ship/spec.md decision 3): what you're seeing and why, then, smaller, what this
 * models and leaves out. Always visible, with no island around them.
 */
export function ScenarioNotes(props: { readonly scenario: Scenario }) {
  const { scenario } = props
  return (
    <aside className="notes" aria-label="About this Scenario">
      <p className="note">{firstNote(scenario)}</p>
      <p className="note note-small">
        {secondNoteParts(scenario).map(([label, text], i) => (
          <span key={label}>
            {i > 0 ? ' ' : null}
            <strong>{label}</strong> {text}
          </span>
        ))}
      </p>
    </aside>
  )
}
