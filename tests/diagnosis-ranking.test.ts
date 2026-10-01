import { describe, expect, it } from 'vitest'
import {
  createDiagnoser,
  DIAGNOSIS_WINDOW_SNAPSHOTS,
  FAILURE_MODES,
  SYMPTOM_ORDER,
  type FailureMode,
  type Rule,
} from '../src/sim/diagnosis.ts'
import type { AllowedSubBuckets } from '../src/sim/engine.ts'
import type { BackendSpec } from '../src/sim/backend.ts'
import type { LimiterSpec } from '../src/sim/limiter.ts'
import { snapshotAt } from './snapshots.ts'

const backend: BackendSpec = { slots: 4, queueLimit: 20, meanMs: 100, cv: 1 }
const limiter: LimiterSpec = { algo: 'fixed-window', keyBy: 'global', limit: 10, windowMs: 1000 }
const allowed: AllowedSubBuckets = { bucketMs: 100, counts: [] }

const snapshot = snapshotAt

/** A rule that fires `warn` while the newest Snapshot's end is in one of `spans` (ms, [from, to)). */
function scripted(id: FailureMode, ...spans: (readonly [number, number])[]): Rule {
  return {
    id,
    judge(window) {
      const t = window.at(-1)?.t ?? 0
      if (!spans.some(([from, to]) => t >= from && t < to)) return null
      return { severity: 'warn', evidence: [], why: '', fixes: [] }
    },
  }
}

/** Feeds Snapshots ending at 1 s to `untilS` s through a diagnoser with `rules`. */
function run(rules: readonly Rule[], untilS: number) {
  const diagnoser = createDiagnoser({ backend, limiter }, rules)
  for (let s = 1; s <= untilS; s++) diagnoser.add(snapshot(s * 1000), allowed)
  return diagnoser
}

const roles = (diagnoser: ReturnType<typeof run>) =>
  diagnoser.findings().map((f) => [f.id, f.role, f.kind])

describe('ranking Findings (D6)', () => {
  it('one Finding is the Root Cause, whatever its kind', () => {
    expect(roles(run([scripted('queue-overflow', [0, 99_000])], 12))).toEqual([
      ['queue-overflow', 'root-cause', 'symptom'],
    ])
  })

  it('a Cause is the Root Cause over Symptoms that started earlier', () => {
    const diagnoser = run(
      [
        scripted('queue-overflow', [0, 99_000]),
        scripted('saturation', [0, 99_000]),
        scripted('boundary-burst', [14_000, 99_000]),
      ],
      16,
    )
    expect(roles(diagnoser)).toEqual([
      ['boundary-burst', 'root-cause', 'cause'],
      ['saturation', 'contributing', 'symptom'],
      ['queue-overflow', 'contributing', 'symptom'],
    ])
  })

  it('of two Causes, the one that started earlier is the Root Cause, whatever the rule order', () => {
    const diagnoser = run(
      [scripted('boundary-burst', [14_000, 99_000]), scripted('retry-storm', [12_000, 99_000])],
      16,
    )
    expect(roles(diagnoser)).toEqual([
      ['retry-storm', 'root-cause', 'cause'],
      ['boundary-burst', 'contributing', 'cause'],
    ])
    expect(diagnoser.findings().map((f) => f.startedAt)).toEqual([12_000, 14_000])
  })

  it('with no Cause, saturation is the Root Cause before queue overflow, even when it started later', () => {
    const diagnoser = run(
      [scripted('queue-overflow', [0, 99_000]), scripted('saturation', [14_000, 99_000])],
      16,
    )
    expect(roles(diagnoser)).toEqual([
      ['saturation', 'root-cause', 'symptom'],
      ['queue-overflow', 'contributing', 'symptom'],
    ])
  })

  it('places every Symptom in the fixed order, so none is listed by chance', () => {
    const symptoms = Object.entries(FAILURE_MODES)
      .filter(([, mode]) => mode.kind === 'symptom')
      .map(([id]) => id)
    expect([...SYMPTOM_ORDER].sort()).toEqual(symptoms.sort())
  })

  it('labels each Failure Mode from one table', () => {
    const diagnoser = run(
      (['queue-overflow', 'saturation', 'boundary-burst', 'retry-storm'] as const).map((id) =>
        scripted(id, [0, 99_000]),
      ),
      10,
    )
    expect(diagnoser.findings().map((f) => f.label)).toEqual([
      'Boundary burst',
      'Retry storm',
      'Backend saturation',
      'Queue overflow',
    ])
  })
})

describe('full windows only', () => {
  it(`judges nothing until ${DIAGNOSIS_WINDOW_SNAPSHOTS} Snapshots after the warm-up`, () => {
    const seen: number[] = []
    const spy: Rule = {
      id: 'queue-overflow',
      judge(window) {
        seen.push(window.length)
        return null
      },
    }
    run([spy], 12)
    // Warm-up ends at 5 s; 6 s to 9 s are not yet a full window, so a rule first judges at 10 s.
    expect(seen).toEqual([5, 5, 5])
  })

  it('finds no queue overflow before 10 s even when every Attempt after the warm-up is lost', () => {
    const diagnoser = createDiagnoser({ backend, limiter })
    const findingsAt: number[] = []
    for (let s = 1; s <= 12; s++) {
      diagnoser.add(snapshot(s * 1000, { allowed: 100, shed: 100 }), allowed)
      findingsAt.push(diagnoser.findings().length)
    }
    expect(findingsAt).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1])
    expect(diagnoser.findings()[0]).toMatchObject({ severity: 'broken', startedAt: 10_000 })
  })
})

describe('past Findings', () => {
  it('a Finding that clears appears once in history, with when it started and ended', () => {
    const diagnoser = run([scripted('queue-overflow', [11_000, 14_000])], 20)
    expect(diagnoser.findings()).toEqual([])
    expect(diagnoser.history()).toHaveLength(1)
    expect(diagnoser.history()[0]).toMatchObject({
      id: 'queue-overflow',
      startedAt: 11_000,
      endedAt: 14_000,
    })
  })

  it('one that comes back later is a new entry; one still active is not in history', () => {
    const diagnoser = run(
      [scripted('queue-overflow', [11_000, 13_000], [15_000, 17_000], [19_000, 99_000])],
      20,
    )
    expect(diagnoser.history().map((f) => [f.startedAt, f.endedAt])).toEqual([
      [11_000, 13_000],
      [15_000, 17_000],
    ])
    expect(diagnoser.findings().map((f) => f.startedAt)).toEqual([19_000])
  })

  it('is a new list when a Finding clears, and the same one otherwise', () => {
    const diagnoser = createDiagnoser({ backend, limiter }, [
      scripted('queue-overflow', [11_000, 13_000]),
    ])
    for (let s = 1; s <= 12; s++) diagnoser.add(snapshot(s * 1000), allowed)
    const before = diagnoser.history()
    diagnoser.add(snapshot(13_000), allowed)
    expect(diagnoser.history()).not.toBe(before)
    expect(before).toEqual([])
    const after = diagnoser.history()
    diagnoser.add(snapshot(14_000), allowed)
    expect(diagnoser.history()).toBe(after)
  })
})
