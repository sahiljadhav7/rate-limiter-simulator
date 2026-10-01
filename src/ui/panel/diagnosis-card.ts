/**
 * What the diagnosis card shows that can be worked out without React (spec decisions 11 and
 * 13): its words, when it needs to re-render, and what a screen reader hears.
 */
import type { FailureMode, Finding, PastFinding, Severity } from '../../sim/index.ts'

/** The pill: shown in label type, which uppercases it. */
export const ROLE_NAMES: Readonly<Record<Finding['role'], string>> = {
  'root-cause': 'Root cause',
  contributing: 'Contributing',
}

/** The severity in words, so it is never shown by colour alone. */
export const SEVERITY_NAMES: Readonly<Record<Severity, string>> = {
  broken: 'Broken',
  warn: 'Warning',
}

/**
 * Whether two lists of Findings would draw the same cards. The runner hands out new objects
 * as Snapshots close, so the card compares what it shows instead of the references. A field
 * the card starts to show must be compared here too, or the card will not update for it.
 */
export function sameFindings(a: readonly Finding[], b: readonly Finding[]): boolean {
  if (a.length !== b.length) return false
  return a.every((x, i) => {
    const y = b[i]
    return (
      y !== undefined &&
      x.id === y.id &&
      x.role === y.role &&
      x.severity === y.severity &&
      x.startedAt === y.startedAt &&
      x.why === y.why &&
      x.evidence.length === y.evidence.length &&
      x.evidence.every(
        (e, j) => e.metric === y.evidence[j]?.metric && e.value === y.evidence[j]?.value,
      ) &&
      x.fixes.length === y.fixes.length &&
      x.fixes.every((f, j) => f.text === y.fixes[j]?.text)
    )
  })
}

/**
 * The polite live region's text: the Root Cause and what contributes, with severities. It
 * leaves the numbers out, so it changes only when the diagnosis does and a screen reader
 * announces a new Root Cause once, not every second.
 */
export function announcement(findings: readonly Finding[]): string {
  const name = (f: Finding) => `${f.label}, ${SEVERITY_NAMES[f.severity].toLowerCase()}`
  const [root, ...rest] = findings
  if (root === undefined) return ''
  const contributing = rest.length === 0 ? '' : ` Contributing: ${rest.map(name).join('; ')}.`
  return `Root cause: ${name(root)}.${contributing}`
}

/** The card's element id, which a chart marker scrolls to. */
export function findingAnchorId(panelId: string, mode: FailureMode): string {
  return `${panelId}-${mode}`
}

/** Where a Finding started, as a chart marks it, and where its pill takes the reader. */
export interface FindingMarker {
  /** `startedAt`, in ms of simulated time. */
  readonly t: number
  readonly label: string
  /** The card's id while the Finding is active; the panel's once it has ended. */
  readonly targetId: string
}

/**
 * A marker for every active and past Finding, oldest first (spec decision 10): a burst that
 * came and went still leaves its line.
 */
export function findingMarkers(
  active: readonly Finding[],
  past: readonly PastFinding[],
  panelId: string,
): FindingMarker[] {
  return [
    ...past.map((f) => ({ t: f.startedAt, label: f.label, targetId: panelId })),
    ...active.map((f) => ({
      t: f.startedAt,
      label: f.label,
      targetId: findingAnchorId(panelId, f.id),
    })),
  ].sort((a, b) => a.t - b.t)
}
