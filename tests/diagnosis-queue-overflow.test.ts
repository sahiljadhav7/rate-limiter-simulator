import { describe, expect, it } from 'vitest'
import { createDiagnoser, type DiagnoserOptions, type Finding } from '../src/sim/diagnosis.ts'
import type { Snapshot } from '../src/sim/metrics.ts'
import type { AllowedSubBuckets } from '../src/sim/engine.ts'
import { snapshotAt } from './snapshots.ts'

const options: DiagnoserOptions = {
  backend: { slots: 4, queueLimit: 20, meanMs: 100, cv: 1 },
  limiter: { algo: 'sliding-counter', keyBy: 'global', limit: 10, windowMs: 1000 },
}
const allowed: AllowedSubBuckets = { bucketMs: 100, counts: [] }

const snapshot = snapshotAt

/** Feeds 1,000 allowed a second with `lost[i]` of them shed in second 6 + i, after warm-up. */
function diagnose(lost: readonly number[], fields: Partial<Snapshot> = {}) {
  const diagnoser = createDiagnoser(options)
  const findings: (readonly Finding[])[] = []
  for (let i = 1; i <= 5; i++) {
    diagnoser.add(snapshot(i * 1000, { allowed: 1000, shed: 900 }), allowed)
  }
  lost.forEach((shed, i) => {
    diagnoser.add(snapshot((6 + i) * 1000, { allowed: 1000, shed, ...fields }), allowed)
    findings.push(diagnoser.findings())
  })
  return findings
}
const severityOf = (findings: readonly Finding[]) => findings[0]?.severity ?? 'healthy'

describe('the queue overflow rule', () => {
  it('ignores the warm-up, when every Backend sheds while its queue fills', () => {
    // Warm-up seconds shed 90%, but nothing in the first full window after it: healthy.
    expect(diagnose([0, 0, 0, 0, 0]).map(severityOf)).toEqual(Array(5).fill('healthy'))
  })

  it.each([
    [1, 'healthy'], // 0.1%: a calm Backend at its default
    [20, 'warn'], // 2%
    [60, 'broken'], // 6%
  ])('with %s of 1,000 allowed lost each second, the Backend is %s', (shed, severity) => {
    expect(severityOf(diagnose([shed, shed, shed, shed, shed]).at(-1) ?? [])).toBe(severity)
  })

  it('names the Failure Mode, the evidence over the last 5 s, why, and what to try', () => {
    const [finding] = diagnose([60, 60, 60, 60, 60]).at(-1) ?? []
    expect(finding).toMatchObject({
      id: 'queue-overflow',
      label: 'Queue overflow',
      kind: 'symptom',
      severity: 'broken',
      // The first full window after the warm-up ends at 10 s (6 s before full windows).
      startedAt: 10_000,
      role: 'root-cause',
      evidence: [
        { metric: 'Lost', value: '6.0%' },
        { metric: 'Shed', value: '300' },
        { metric: 'Timed out', value: '0' },
        { metric: 'Sent to the Backend', value: '5000' },
      ],
    })
    expect(finding?.why).toBe(
      'The queue of 20 filled, so 300 Attempts were shed and 0 timed out: 6.0% of what the Limiter let through.',
    )
    expect(finding?.fixes.map((fix) => fix.text)).toEqual([
      'Try a Limiter that lets Attempts through at a steady pace instead of a whole window of them after a quiet spell, such as a token bucket with a small capacity',
      'Try more Backend slots',
      'Try a bigger queue (Attempts wait longer)',
    ])
  })

  it('averages over the last 5 seconds, so one bad second is not a failure', () => {
    // One second at 6%, then none lost. Silent until the window is full at 10 s (before full
    // windows, that second alone read 6% and broken), then 1.2% over the window: warn, not
    // broken. 0% once that second leaves the window.
    expect(diagnose([60, 0, 0, 0, 0, 0]).map(severityOf)).toEqual([
      'healthy',
      'healthy',
      'healthy',
      'healthy',
      'warn',
      'healthy',
    ])
  })

  it('stays where it is near a threshold rather than flickering (hysteresis)', () => {
    // Per-second shares: 6% x5 (broken), then 4% x5 (still broken: above 2.5%), then 2% x5
    // (drops to warn: below 2.5%, above 0.5%), then 0.4% x5 (clears: below 0.5%).
    const shares = [
      ...Array(5).fill(60),
      ...Array(5).fill(40),
      ...Array(5).fill(20),
      ...Array(5).fill(4),
    ]
    const severities = diagnose(shares).map(severityOf)
    expect(severities.slice(4, 5)).toEqual(['broken'])
    expect(severities.slice(9, 10)).toEqual(['broken'])
    expect(severities.slice(14, 15)).toEqual(['warn'])
    expect(severities.slice(19)).toEqual(['healthy'])
  })

  it('keeps startedAt from when it first appeared, through warn and broken', () => {
    // First full window at 10 s: 220 of 5,000 lost, 4.4%, warn. At 11 s: 260, 5.2%, broken.
    // (Before full windows these were 6 s and 8 s.)
    const findings = diagnose([20, 20, 60, 60, 60, 60])
    expect(findings[4]?.[0]).toMatchObject({ severity: 'warn', startedAt: 10_000 })
    expect(findings.at(-1)?.[0]).toMatchObject({ severity: 'broken', startedAt: 10_000 })
  })

  it('counts Attempts that timed out as lost too', () => {
    const findings = diagnose([0, 0, 0, 0, 0], { attemptsTimedOut: 60 })
    expect(findings.at(-1)?.[0]?.severity).toBe('broken')
  })

  it('finds nothing with no Snapshots, or with nothing sent to the Backend: no 0% or NaN share', () => {
    expect(createDiagnoser(options).findings()).toEqual([])
    const quiet = createDiagnoser(options)
    for (let i = 1; i <= 10; i++) quiet.add(snapshot(i * 1000), allowed)
    expect(quiet.findings()).toEqual([])
  })
})
