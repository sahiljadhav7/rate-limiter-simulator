import { describe, expect, it } from 'vitest'
import { createDiagnoser, FIRST_JUDGEMENT_MS } from '../src/sim/diagnosis.ts'
import { diagnosisWarmUpLine } from '../src/ui/panel/diagnosis-card.ts'
import { snapshotAt } from './snapshots.ts'

describe('FIRST_JUDGEMENT_MS', () => {
  it('is when a diagnoser first gives a Finding, for a Backend failing from the first second', () => {
    const diagnoser = createDiagnoser({
      backend: { slots: 4, queueLimit: 20, meanMs: 100, cv: 1 },
      limiter: { algo: 'sliding-counter', keyBy: 'global', limit: 10, windowMs: 1000 },
      retry: { timeoutMs: 500, maxAttempts: 1, retry: 'none' },
    })
    let firstAt: number | null = null
    for (let t = 1000; t <= 20_000 && firstAt === null; t += 1000) {
      // 60% of what the Limiter let through is shed in every second, warm-up included.
      diagnoser.add(snapshotAt(t, { allowed: 1000, shed: 600 }), { bucketMs: 100, counts: [] })
      if (diagnoser.findings().length > 0) firstAt = t
    }
    expect(firstAt).toBe(FIRST_JUDGEMENT_MS)
    expect(FIRST_JUDGEMENT_MS).toBe(10_000)
  })
})

describe('diagnosisWarmUpLine', () => {
  it('says when diagnosis starts, until it does', () => {
    expect(diagnosisWarmUpLine(0)).toBe('Diagnosis starts at 10 s, after the warm-up')
    expect(diagnosisWarmUpLine(9_900)).toBe('Diagnosis starts at 10 s, after the warm-up')
  })

  it('is gone from the first judgement on', () => {
    expect(diagnosisWarmUpLine(FIRST_JUDGEMENT_MS)).toBeNull()
    expect(diagnosisWarmUpLine(60_000)).toBeNull()
  })
})
