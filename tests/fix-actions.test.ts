import { describe, expect, it } from 'vitest'
import { applyFix } from '../src/runner/apply-fix.ts'
import type { Finding, Fix } from '../src/sim/diagnosis.ts'
import { fixActions } from '../src/ui/panel/fix-actions.ts'
import { backendOverloadScenario } from '../src/ui/scenarios/backend-overload.ts'

const tokenBucket: Fix = {
  text: 'Try a token bucket',
  patch: {
    name: 'token bucket',
    limiter: { algo: 'token-bucket', keyBy: 'global', capacity: 10, refillPerSec: 70 },
  },
}
const moreSlots: Fix = {
  text: 'Try more Backend slots',
  patch: { name: 'more slots', backend: { slots: 8 } },
}
const textOnly: Fix = { text: 'Try something not modelled' }

const finding = (role: Finding['role'], fixes: readonly Fix[]): Finding => ({
  id: 'queue-overflow',
  label: 'Queue overflow',
  kind: 'symptom',
  severity: 'broken',
  startedAt: 10_000,
  evidence: [],
  why: '',
  fixes,
  role,
})

const scenario = backendOverloadScenario
const [sliding] = scenario.variants
if (sliding === undefined) throw new Error('No Variant')

describe('fixActions', () => {
  it("gives each fix with a patch a button, the Root Cause's first one primary", () => {
    const actions = fixActions(
      finding('root-cause', [textOnly, tokenBucket, moreSlots]),
      sliding,
      scenario.variants,
    )
    expect(actions).toEqual([
      null,
      { fix: tokenBucket, primary: true, applied: false },
      { fix: moreSlots, primary: false, applied: false },
    ])
  })

  it('makes no button primary on a Contributing Finding, so a panel has one at most', () => {
    const actions = fixActions(
      finding('contributing', [tokenBucket, moreSlots]),
      sliding,
      scenario.variants,
    )
    expect(actions.map((a) => a?.primary)).toEqual([false, false])
  })

  it('marks the fix already applied, and moves primary to the next one', () => {
    const fixed = applyFix(scenario, 0, tokenBucket)
    const actions = fixActions(
      finding('root-cause', [tokenBucket, moreSlots]),
      sliding,
      fixed.variants,
    )
    expect(actions).toEqual([
      { fix: tokenBucket, primary: false, applied: true },
      { fix: moreSlots, primary: true, applied: false },
    ])
  })

  it('gives a Variant that is itself a fix no buttons: one fix at a time', () => {
    const fixed = applyFix(scenario, 0, tokenBucket)
    const fixedConfig = fixed.variants[1]
    if (fixedConfig === undefined) throw new Error('No fixed Variant')
    expect(fixActions(finding('root-cause', [moreSlots]), fixedConfig, fixed.variants)).toEqual([
      null,
    ])
  })
})
