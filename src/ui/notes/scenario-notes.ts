/**
 * The two handwritten notes under the panels (.scratch/ship/spec.md decision 8), as text, so the
 * test checks exactly what the page shows.
 */
import type { Scenario } from '../../runner/scenario.ts'

/** What you're seeing and why: what to watch, then why it happens. */
export function firstNote(scenario: Scenario): string {
  return `${scenario.lesson} ${scenario.why}`
}

/** What this models and what it leaves out, as label and text pairs; the page bolds the labels. */
export function secondNoteParts(scenario: Scenario): readonly (readonly [string, string])[] {
  return [
    ['Models:', scenario.models],
    ['Leaves out:', scenario.leavesOut],
  ]
}

/** What this models and what it leaves out, as one line of text. */
export function secondNote(scenario: Scenario): string {
  return secondNoteParts(scenario)
    .map((part) => part.join(' '))
    .join(' ')
}
