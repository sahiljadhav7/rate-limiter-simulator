import type { Scenario } from '../../runner/scenario.ts'
import { GLOSSARY } from './glossary.ts'
import { firstNote, secondNoteParts } from './scenario-notes.ts'
import './notes.css'

/**
 * The Scenario's two handwritten notes on the paper below the panels (DESIGN.md "Handwritten
 * note"; .scratch/ship/spec.md decision 3): what you're seeing and why, then, smaller, what this
 * models and leaves out. Always visible, with no island around them. Under them, closed until
 * asked for, what every number on the page means (ticket 06): a native disclosure, so it opens
 * from the keyboard with no script.
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
      <details className="glossary">
        <summary className="btn">What the numbers mean</summary>
        <dl className="island glossary-list">
          {GLOSSARY.map(({ term, definition }) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd>{definition}</dd>
            </div>
          ))}
        </dl>
      </details>
    </aside>
  )
}
