/**
 * Apply fix (RS-27): a Fix's patch becomes a new Variant right after the one it fixes, on the
 * same seed and traffic, so the two are compared from the same start. One fix at a time: applying
 * another replaces it, and removing it gives back the Scenario as authored. Pure, like the runner.
 */
import type { Fix, RetryPolicy } from '../sim/index.ts'
import { checkScenario, type Scenario, type VariantConfig } from './scenario.ts'

/**
 * `scenario` with Variant `index` fixed by `fix`: the fixed Variant is inserted after it, labelled
 * "<original>, <fix name>" with `fixOf` naming the original, and any fix applied before is
 * removed first. `index` counts the Variants of `scenario` as given. Throws a RangeError for a Fix
 * with no patch, an index that is not an original Variant, or a patch that makes the Variant
 * invalid.
 */
export function applyFix(scenario: Scenario, index: number, fix: Fix): Scenario {
  const original = scenario.variants[index]
  if (original === undefined) {
    throw new RangeError(`There is no Variant ${index} to fix`)
  }
  if (original.fixOf !== undefined) {
    throw new RangeError(`${original.label} is already a fix of ${original.fixOf}`)
  }
  const { patch } = fix
  if (patch === undefined) {
    throw new RangeError(`"${fix.text}" has no patch to apply`)
  }
  const fixed: VariantConfig = {
    label: `${original.label}, ${patch.name}`,
    fixOf: original.label,
    limiter: patch.limiter ?? original.limiter,
    // Only a whole policy can be checked, so a patch that leaves out what its mode needs (such as
    // a base delay) fails checkScenario below.
    retry: { ...original.retry, ...patch.retry } as RetryPolicy,
    ...((original.backend !== undefined || patch.backend !== undefined) && {
      backend: { ...original.backend, ...patch.backend },
    }),
  }
  const authored = removeFix(scenario)
  const at = authored.variants.findIndex((v) => v.label === original.label)
  const next: Scenario = {
    ...authored,
    variants: [...authored.variants.slice(0, at + 1), fixed, ...authored.variants.slice(at + 1)],
  }
  checkScenario(next)
  return next
}

/** `scenario` without its applied fix, as authored. A Scenario with none is returned as it is. */
export function removeFix(scenario: Scenario): Scenario {
  if (scenario.variants.every((v) => v.fixOf === undefined)) return scenario
  return { ...scenario, variants: scenario.variants.filter((v) => v.fixOf === undefined) }
}
