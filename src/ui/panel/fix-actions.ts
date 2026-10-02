/**
 * Which of a Finding's fixes get an Apply fix button, worked out without React so it is tested
 * on its own (.scratch/apply-fix/spec.md decisions 3 and 5).
 */
import { fixedLabel } from '../../runner/apply-fix.ts'
import type { VariantConfig } from '../../runner/scenario.ts'
import type { Finding, Fix } from '../../sim/index.ts'

/** One fix's Apply fix button. */
export interface FixAction {
  readonly fix: Fix
  /**
   * The primary button (DESIGN.md "Button": at most one per panel): the Root Cause's first fix
   * not already applied. Every other Apply fix button is an ordinary one.
   */
  readonly primary: boolean
  /** Its fixed Variant is already running beside this one. */
  readonly applied: boolean
}

/**
 * Per fix of `finding` in Variant `config`, in order: its button, or null for a fix with no
 * patch. A Variant that is itself a fix gets none, as one fix is applied at a time. `variants`
 * are the Scenario's, to see which fix is applied.
 */
export function fixActions(
  finding: Finding,
  config: VariantConfig,
  variants: readonly VariantConfig[],
): (FixAction | null)[] {
  if (config.fixOf !== undefined) return finding.fixes.map(() => null)
  let primaryGiven = finding.role !== 'root-cause'
  return finding.fixes.map((fix) => {
    if (fix.patch === undefined) return null
    const label = fixedLabel(config.label, fix.patch.name)
    const applied = variants.some((v) => v.fixOf === config.label && v.label === label)
    const primary = !primaryGiven && !applied
    if (primary) primaryGiven = true
    return { fix, primary, applied }
  })
}
