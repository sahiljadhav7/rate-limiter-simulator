import { describe, expect, it } from 'vitest'
import type { VariantConfig } from '../src/runner/scenario.ts'
import type { Finding, LimiterSpec } from '../src/sim/index.ts'
import { movedTab, rootCause, shortNames, tabBadge } from '../src/ui/tabs/tabs.ts'

const retry = { timeoutMs: 1000, retry: 'none', maxAttempts: 1 } as const
const variant = (label: string, limiter: LimiterSpec): VariantConfig => ({ label, limiter, retry })
const tokenBucket = (keyBy: 'global' | 'client'): LimiterSpec => ({
  algo: 'token-bucket',
  keyBy,
  capacity: 10,
  refillPerSec: 70,
})

describe('shortNames', () => {
  it('names each Variant by its algorithm, shortened for a phone tab', () => {
    expect(
      shortNames([
        variant('Fixed window', {
          algo: 'fixed-window',
          keyBy: 'global',
          limit: 70,
          windowMs: 1000,
        }),
        variant('Sliding window counter', {
          algo: 'sliding-counter',
          keyBy: 'global',
          limit: 70,
          windowMs: 1000,
        }),
        variant('Token bucket', tokenBucket('global')),
      ]),
    ).toEqual(['Fixed window', 'Sliding window', 'Token bucket'])
  })

  it('adds the key scope to both when two Variants share an algorithm', () => {
    expect(
      shortNames([
        variant('Shared', tokenBucket('global')),
        variant('Each', tokenBucket('client')),
      ]),
    ).toEqual(['Token bucket, global', 'Token bucket, per client'])
  })

  it("falls back to the Variant's own label when the scope does not tell them apart", () => {
    expect(
      shortNames([
        variant('Small bucket', tokenBucket('global')),
        variant('Big bucket', tokenBucket('global')),
      ]),
    ).toEqual(['Small bucket', 'Big bucket'])
  })
})

const finding = (severity: 'warn' | 'broken'): Finding => ({
  id: 'queue-overflow',
  label: 'Queue overflow',
  kind: 'symptom',
  severity,
  startedAt: 10_000,
  evidence: [],
  why: '',
  fixes: [],
  role: 'root-cause',
})

describe('tabBadge', () => {
  it('is none with no active Finding', () => {
    expect(tabBadge([])).toBeNull()
  })

  it('is the worst active severity', () => {
    expect(tabBadge([finding('warn')])).toBe('warn')
    expect(tabBadge([finding('warn'), finding('broken')])).toBe('broken')
  })
})

describe('movedTab', () => {
  it('moves with the arrow keys and wraps at either end', () => {
    expect(movedTab(0, 'ArrowRight', 3)).toBe(1)
    expect(movedTab(2, 'ArrowRight', 3)).toBe(0)
    expect(movedTab(0, 'ArrowLeft', 3)).toBe(2)
  })

  it('goes to the first and last tab with Home and End', () => {
    expect(movedTab(1, 'Home', 3)).toBe(0)
    expect(movedTab(1, 'End', 3)).toBe(2)
  })

  it('ignores any other key', () => {
    expect(movedTab(1, 'Enter', 3)).toBeNull()
  })
})

describe('rootCause', () => {
  it('is null with no active Finding', () => {
    expect(rootCause([])).toBeNull()
  })

  it("names the Root Cause's Failure Mode and severity in words", () => {
    expect(rootCause([finding('warn')])).toEqual({
      label: 'Queue overflow',
      severity: 'warn',
      word: 'Warning',
    })
  })

  it('leaves out Contributing Findings', () => {
    const contributing: Finding = {
      ...finding('broken'),
      id: 'saturation',
      label: 'Saturation',
      role: 'contributing',
    }
    expect(rootCause([contributing, finding('broken')])).toEqual({
      label: 'Queue overflow',
      severity: 'broken',
      word: 'Broken',
    })
  })
})
