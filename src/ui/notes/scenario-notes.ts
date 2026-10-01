/**
 * The two handwritten notes under the panels (.scratch/ship/spec.md decision 8), as text, so the
 * test checks exactly what the page shows.
 */
import type { Scenario } from '../../runner/scenario.ts'

/** What you're seeing and why: what to watch, then why it happens. */
export function firstNote(scenario: Scenario): string {
  return `${scenario.lesson} ${scenario.why}`
}

/** What this models and what it leaves out. */
export function secondNote(scenario: Scenario): string {
  return `Models: ${scenario.models} Leaves out: ${scenario.leavesOut}`
}
