import type { Scenario } from '../../runner/scenario.ts'
import { firstNote } from './scenario-notes.ts'
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
      {/* The same text as secondNote, with its two labels in the heavier weight. */}
      <p className="note note-small">
        <strong>Models:</strong> {scenario.models} <strong>Leaves out:</strong> {scenario.leavesOut}
      </p>
    </aside>
  )
}
