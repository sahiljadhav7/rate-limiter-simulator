import { describe, expect, it } from 'vitest'
import { applyFix, appliedFix, removeFix } from '../src/runner/apply-fix.ts'
import { MAX_VARIANTS, variantBackend, type Scenario } from '../src/runner/scenario.ts'
import type { Fix } from '../src/sim/diagnosis.ts'

/** Two Variants, as both shipped Scenarios have, so one applied fix fills the third place. */
const scenario: Scenario = {
  id: 'apply-fix-test',
  title: 'Apply fix test',
  lesson: 'None: a test fixture.',
  why: 'It only exists to be run.',
  models: 'Two Limiters in front of one Backend.',
  leavesOut: 'Everything a lesson would need.',
  seed: 5,
  traffic: { shape: 'poisson', demandRps: 30, clients: ['a', 'b', 'c'] },
  backend: { slots: 4, queueLimit: 20, meanMs: 50, cv: 0.5 },
  variants: [
    {
      label: 'Sliding window counter',
      limiter: { algo: 'sliding-counter', keyBy: 'global', limit: 70, windowMs: 1000 },
      retry: { timeoutMs: 500, maxAttempts: 3, retry: 'immediate' },
    },
    {
      label: 'Token bucket',
      limiter: { algo: 'token-bucket', keyBy: 'global', capacity: 10, refillPerSec: 70 },
      retry: { timeoutMs: 500, maxAttempts: 1, retry: 'none' },
    },
  ],
}

const moreSlots: Fix = {
  text: 'Try more Backend slots',
  patch: { name: 'more slots', backend: { slots: 8 } },
}
const tokenBucket: Fix = {
  text: 'Try a token bucket',
  patch: {
    name: 'token bucket',
    limiter: { algo: 'token-bucket', keyBy: 'global', capacity: 10, refillPerSec: 70 },
  },
}
const jitter: Fix = {
  text: 'Try backing off with jitter',
  patch: { name: 'back off with jitter', retry: { retry: 'backoff-jitter', baseDelayMs: 100 } },
}

describe('applyFix', () => {
  it("adds the fixed Variant right after its original, named for the fix, on the Scenario's seed and traffic", () => {
    const fixed = applyFix(scenario, 0, moreSlots)
    expect(fixed.variants.map((v) => v.label)).toEqual([
      'Sliding window counter',
      'Sliding window counter, more slots',
      'Token bucket',
    ])
    expect(fixed.variants[1]?.fixOf).toBe('Sliding window counter')
    expect(fixed.seed).toBe(5)
    expect(fixed.traffic).toEqual(scenario.traffic)
    expect(fixed.variants[0]).toEqual(scenario.variants[0])
    expect(fixed.variants[2]).toEqual(scenario.variants[1])
  })

  it('gives a Backend patch to that Variant alone', () => {
    const fixed = applyFix(scenario, 1, moreSlots)
    expect(variantBackend(fixed, 2)).toEqual({ slots: 8, queueLimit: 20, meanMs: 50, cv: 0.5 })
    expect(variantBackend(fixed, 1)).toEqual(scenario.backend)
    expect(fixed.backend).toEqual(scenario.backend)
  })

  it('replaces the Limiter with a Limiter patch, keeping the Retry Policy', () => {
    const fixed = applyFix(scenario, 0, tokenBucket).variants[1]
    expect(fixed?.limiter).toEqual({
      algo: 'token-bucket',
      keyBy: 'global',
      capacity: 10,
      refillPerSec: 70,
    })
    expect(fixed?.retry).toEqual(scenario.variants[0]?.retry)
  })

  it('changes only what a Retry Policy patch names, keeping the timeout and Attempts', () => {
    const fixed = applyFix(scenario, 0, jitter).variants[1]
    expect(fixed?.retry).toEqual({
      timeoutMs: 500,
      maxAttempts: 3,
      retry: 'backoff-jitter',
      baseDelayMs: 100,
    })
    expect(fixed?.limiter).toEqual(scenario.variants[0]?.limiter)
  })

  it('replaces a fix already applied, so there is only ever one', () => {
    const once = applyFix(scenario, 0, moreSlots)
    // The token bucket is at index 2 once the first fix sits beside the sliding counter.
    const twice = applyFix(once, 2, jitter)
    expect(twice.variants.map((v) => v.label)).toEqual([
      'Sliding window counter',
      'Token bucket',
      'Token bucket, back off with jitter',
    ])
    expect(twice.variants.length).toBeLessThanOrEqual(MAX_VARIANTS)
  })

  it('throws a RangeError for a Fix with no patch, a Variant that is itself a fix, or one not there', () => {
    expect(() => applyFix(scenario, 0, { text: 'Try something' })).toThrow(RangeError)
    const once = applyFix(scenario, 0, moreSlots)
    expect(() => applyFix(once, 1, jitter)).toThrow(RangeError)
    expect(() => applyFix(scenario, 2, moreSlots)).toThrow(RangeError)
  })

  it('throws a RangeError for a patch that makes the Variant invalid, changing nothing', () => {
    const before = structuredClone(scenario)
    const noBaseDelay: Fix = {
      text: 'Back off',
      patch: { name: 'back off', retry: { retry: 'backoff' } },
    }
    const noSlots: Fix = { text: 'No slots', patch: { name: 'no slots', backend: { slots: 0 } } }
    expect(() => applyFix(scenario, 0, noBaseDelay)).toThrow(RangeError)
    expect(() => applyFix(scenario, 0, noSlots)).toThrow(RangeError)
    expect(scenario).toEqual(before)
  })
})

describe('removeFix', () => {
  it('gives back the Scenario as authored', () => {
    expect(removeFix(applyFix(scenario, 1, tokenBucket))).toEqual(scenario)
  })

  it('leaves a Scenario with no fix applied as it is', () => {
    expect(removeFix(scenario)).toEqual(scenario)
  })
})

describe('appliedFix', () => {
  it('is the Variant made by Apply fix, or undefined with none applied', () => {
    expect(appliedFix(scenario)).toBeUndefined()
    expect(appliedFix(applyFix(scenario, 1, moreSlots))).toMatchObject({
      label: 'Token bucket, more slots',
      fixOf: 'Token bucket',
    })
  })
})
