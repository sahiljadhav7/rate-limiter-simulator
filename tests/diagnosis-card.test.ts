import { describe, expect, it } from 'vitest'
import type { Finding } from '../src/sim/index.ts'
import { announcement, findingAnchorId, sameFindings } from '../src/ui/panel/diagnosis-card.ts'

const finding = (fields: Partial<Finding> = {}): Finding => ({
  id: 'queue-overflow',
  label: 'Queue overflow',
  kind: 'symptom',
  severity: 'broken',
  startedAt: 11_000,
  evidence: [{ metric: 'Lost', value: '18.2%' }],
  why: 'The queue of 20 filled.',
  fixes: [{ text: 'Try more Backend slots' }],
  role: 'root-cause',
  ...fields,
})

describe('sameFindings', () => {
  it('is true for new objects with the same content, so the card does not re-render each frame', () => {
    expect(sameFindings([finding()], [finding()])).toBe(true)
  })

  it.each([
    ['severity', { severity: 'warn' }],
    ['role', { role: 'contributing' }],
    ['evidence', { evidence: [{ metric: 'Lost', value: '18.3%' }] }],
    ['why', { why: 'The queue of 20 filled again.' }],
    ['startedAt', { startedAt: 12_000 }],
  ] as const)('is false when the %s changes', (_, fields) => {
    expect(sameFindings([finding()], [finding(fields)])).toBe(false)
  })

  it('is false when a Finding comes or goes', () => {
    expect(sameFindings([finding()], [])).toBe(false)
    expect(sameFindings([finding()], [finding(), finding({ id: 'saturation' })])).toBe(false)
  })
})

describe('announcement', () => {
  it('names the Root Cause and its severity, then what contributes', () => {
    expect(
      announcement([
        finding({ id: 'retry-storm', label: 'Retry storm', kind: 'cause' }),
        finding({ role: 'contributing', severity: 'warn' }),
      ]),
    ).toBe('Root cause: Retry storm, broken. Contributing: Queue overflow, warning.')
  })

  it('stays the same while only the numbers change, so a screen reader hears it once', () => {
    const before = announcement([finding()])
    expect(announcement([finding({ evidence: [{ metric: 'Lost', value: '30.0%' }] })])).toBe(before)
  })

  it('is empty with no Finding', () => {
    expect(announcement([])).toBe('')
  })
})

describe('findingAnchorId', () => {
  it("joins the panel's id and the Failure Mode, one card per mode in a panel", () => {
    expect(findingAnchorId(':r1:', 'limit-too-tight')).toBe(':r1:-limit-too-tight')
  })
})
