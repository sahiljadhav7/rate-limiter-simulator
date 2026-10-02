/**
 * The phone's tab bar (DESIGN.md "Mobile", .scratch/polish/spec.md decisions 8 to 10): what
 * each Variant's tab is called, whether it carries a Finding's badge, and how the arrow keys
 * move between tabs. Pure, so it is tested without a browser.
 */
import type { VariantConfig } from '../../runner/scenario.ts'
import type { Finding, Severity } from '../../sim/index.ts'
import { SEVERITY_NAMES } from '../panel/diagnosis-card.ts'
import { KEY_SCOPE_NAMES, SHORT_ALGORITHM_NAMES } from '../panel/limiter-names.ts'

/** True if `names` has `name` more than once. */
const repeated = (names: readonly string[], name: string) =>
  names.indexOf(name) !== names.lastIndexOf(name)

/**
 * Each Variant's tab name: its algorithm, shortened. Variants sharing an algorithm add their key
 * scope ("Token bucket, per client"); if that still does not tell them apart, each uses its own
 * label, which the Scenario keeps unique.
 */
export function shortNames(variants: readonly VariantConfig[]): string[] {
  const byAlgorithm = variants.map((v) => SHORT_ALGORITHM_NAMES[v.limiter.algo])
  const withScope = variants.map((v, i) =>
    repeated(byAlgorithm, byAlgorithm[i] as string)
      ? `${byAlgorithm[i]}, ${KEY_SCOPE_NAMES[v.limiter.keyBy].toLowerCase()}`
      : (byAlgorithm[i] as string),
  )
  return variants.map((v, i) =>
    repeated(withScope, withScope[i] as string) ? v.label : (withScope[i] as string),
  )
}

/** The badge on a Variant's tab: the worst active Finding's severity, or null with none. */
export function tabBadge(findings: readonly Finding[]): Severity | null {
  if (findings.some((f) => f.severity === 'broken')) return 'broken'
  return findings.length > 0 ? 'warn' : null
}

/**
 * The tab a key moves to from tab `index` of `count` (WAI-ARIA tabs pattern): the arrow keys
 * step and wrap, Home and End go to either end. Null for any other key.
 */
export function movedTab(index: number, key: string, count: number): number | null {
  switch (key) {
    case 'ArrowRight':
      return (index + 1) % count
    case 'ArrowLeft':
      return (index - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

/**
 * What the Compare tab says broke in a Variant: its Root Cause's Failure Mode and severity, in
 * words as the diagnosis card says it. Contributing Findings stay on the Variant's own tab.
 */
export function rootCause(
  findings: readonly Finding[],
): { readonly label: string; readonly severity: Severity; readonly word: string } | null {
  const cause = findings.find((f) => f.role === 'root-cause')
  return cause
    ? { label: cause.label, severity: cause.severity, word: SEVERITY_NAMES[cause.severity] }
    : null
}
