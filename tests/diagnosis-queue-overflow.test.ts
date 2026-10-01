import { describe, expect, it } from 'vitest'
import { createDiagnoser, type Finding } from '../src/sim/diagnosis.ts'
import type { Snapshot } from '../src/sim/metrics.ts'

/** A Snapshot ending at `t` (ms) with every count 0, plus `fields`. */
function snapshot(t: number, fields: Partial<Snapshot> = {}): Snapshot {
  return {
    t,
    warmUp: t <= 5000,
    demand: 0,
    offeredLoad: 0,
    allowed: 0,
    rejected: 0,
    delayed: 0,
    goodput: 0,
    failed: { rejected: 0, timedOut: 0, shed: 0 },
    wastedWorkMs: 0,
    backendUtil: 0,
    queueDepth: 0,
    peakQueueDepth: 0,
    shed: 0,
    attemptsTimedOut: 0,
    p50: null,
    p95: null,
    p99: null,
    e2eP50: null,
    e2eP95: null,
    e2eP99: null,
    perClient: {},
    ...fields,
  }
}

/** Feeds 1,000 allowed a second with `lost[i]` of them shed in second 6 + i, after warm-up. */
function diagnose(lost: readonly number[], fields: Partial<Snapshot> = {}) {
  const diagnoser = createDiagnoser({ queueLimit: 20 })
  const findings: (readonly Finding[])[] = []
  for (let i = 1; i <= 5; i++) diagnoser.add(snapshot(i * 1000, { allowed: 1000, shed: 900 }))
  lost.forEach((shed, i) => {
    diagnoser.add(snapshot((6 + i) * 1000, { allowed: 1000, shed, ...fields }))
    findings.push(diagnoser.findings())
  })
  return findings
}
const severityOf = (findings: readonly Finding[]) => findings[0]?.severity ?? 'healthy'

describe('the queue overflow rule', () => {
  it('ignores the warm-up, when every Backend sheds while its queue fills', () => {
    // Warm-up seconds shed 90%, but nothing after: healthy.
    expect(diagnose([0]).map(severityOf)).toEqual(['healthy'])
  })

  it.each([
    [1, 'healthy'], // 0.1%: fixed window at its calm default
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
      startedAt: 6000,
      role: 'root-cause',
      evidence: [
        { metric: 'Lost', value: '6.0%' },
        { metric: 'Shed', value: '300' },
        { metric: 'Timed out', value: '0' },
        { metric: 'Allowed', value: '5000' },
      ],
    })
    expect(finding?.why).toBe(
      'The queue of 20 filled, so 300 Attempts were dropped and 0 timed out: 6.0% of what the Limiter let through.',
    )
    expect(finding?.fixes.map((fix) => fix.text)).toEqual([
      'Try a Limiter that spreads Attempts evenly (sliding window counter or token bucket)',
      'Try a bigger queue (Attempts wait longer)',
      'Try more Backend slots',
    ])
  })

  it('averages over the last 5 seconds, so one bad second is not a failure', () => {
    // One second at 6%, then none lost. Over the window: 6%, 3% (still above 2.5%, so it stays
    // broken), 2%, 1.5%, 1.2% (warn), then 0% once that second leaves the window.
    expect(diagnose([60, 0, 0, 0, 0, 0]).map(severityOf)).toEqual([
      'broken',
      'broken',
      'warn',
      'warn',
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
    const findings = diagnose([20, 20, 60, 60, 60, 60])
    expect(findings[0]?.[0]?.startedAt).toBe(6000)
    expect(findings.at(-1)?.[0]).toMatchObject({ severity: 'broken', startedAt: 6000 })
  })

  it('counts Attempts that timed out as lost too', () => {
    const findings = diagnose([0, 0, 0, 0, 0], { attemptsTimedOut: 60 })
    expect(findings.at(-1)?.[0]?.severity).toBe('broken')
  })

  it('finds nothing with no Snapshots, or with nothing sent to the Backend: no 0% or NaN share', () => {
    expect(createDiagnoser({ queueLimit: 20 }).findings()).toEqual([])
    const quiet = createDiagnoser({ queueLimit: 20 })
    for (let i = 1; i <= 10; i++) quiet.add(snapshot(i * 1000))
    expect(quiet.findings()).toEqual([])
  })
})
