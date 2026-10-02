import { describe, expect, it } from 'vitest'
import { createRunner } from '../src/runner/runner.ts'
import type { Scenario } from '../src/runner/scenario.ts'
import { SYMPTOM_ORDER, type Finding } from '../src/sim/diagnosis.ts'
import type { ControlEvent } from '../src/sim/traffic-source.ts'

/**
 * A Backend that serves 80/s (4 slots of 50 ms) with room for 200 to wait, behind a Limiter that
 * lets everything through, with callers that give up after 500 ms. Demand starts at `startRps`
 * and changes as `controls` say (.scratch/more-rules/spec.md "Measured").
 */
const fixture = (startRps: number, controls: readonly ControlEvent[], seed = 1): Scenario => ({
  id: 'goodput-collapse-fixture',
  title: 'Goodput collapse fixture',
  lesson: 'None: a test fixture.',
  why: 'It only exists to be run.',
  models: 'One Backend with a long queue behind a Limiter that lets all through.',
  leavesOut: 'Everything a lesson would need.',
  seed,
  traffic: { shape: 'poisson', demandRps: startRps, clients: ['a', 'b', 'c'] },
  controls,
  backend: { slots: 4, queueLimit: 200, meanMs: 50, cv: 1 },
  variants: [
    {
      label: 'Lets all through',
      limiter: { algo: 'token-bucket', keyBy: 'global', capacity: 10_000, refillPerSec: 10_000 },
      retry: { timeoutMs: 500, maxAttempts: 1, retry: 'none' },
    },
  ],
})
/** 60/s, under the Backend's 80, for 30 s; then 120/s, over it. */
const rising = (seed = 1) =>
  fixture(60, [{ atMs: 30_000, change: { kind: 'demand', demandRps: 120 } }], seed)

/** Every second from 10 s to 120 s: the active Findings. */
function findingsEachSecond(sc: Scenario): (readonly Finding[])[] {
  const runner = createRunner(sc, { eventBudget: Infinity })
  const seen: (readonly Finding[])[] = []
  for (let second = 10; second <= 120; second++) {
    while (runner.view().simMs < second * 1000) runner.tick(100)
    seen.push(runner.view().variants[0]?.findings ?? [])
  }
  return seen
}
const collapse = (fs: readonly Finding[]) => fs.find((f) => f.id === 'goodput-collapse')

describe('the goodput collapse rule', () => {
  it('is the third Symptom, after saturation and queue overflow', () => {
    expect(SYMPTOM_ORDER).toEqual(['saturation', 'queue-overflow', 'goodput-collapse'])
  })

  it('stays quiet while Demand is under what the Backend serves, then goes broken once callers give up on queued work', () => {
    for (let seed = 1; seed <= 3; seed++) {
      const seen = findingsEachSecond(rising(seed))
      // Seconds 10 to 30 (indices 0 to 20): Demand 60/s, Goodput at its peak.
      expect(seen.slice(0, 21).filter((fs) => collapse(fs))).toEqual([])
      // From 40 s Goodput is 0/s with every busy ms wasted (seeds 1 to 8).
      expect(seen.slice(30).every((fs) => collapse(fs)?.severity === 'broken')).toBe(true)
    }
  })

  it('ranks behind the Cause and the earlier Symptoms', () => {
    const last = findingsEachSecond(rising()).at(-1)
    expect(last?.map((f) => [f.id, f.role])).toEqual([
      ['limit-too-loose', 'root-cause'],
      ['saturation', 'contributing'],
      ['queue-overflow', 'contributing'],
      ['goodput-collapse', 'contributing'],
    ])
  })

  it('names the evidence and says why from the numbers', () => {
    const finding = collapse(findingsEachSecond(rising()).at(-1) ?? [])
    expect(finding?.evidence.map((e) => e.metric)).toEqual([
      'Goodput',
      'Its peak',
      'Busy',
      'Wasted Work',
    ])
    expect(finding?.evidence[0]?.value).toBe('0.0/s')
    expect(finding?.why).toMatch(
      /^Goodput fell to 0\.0\/s from a peak of \d+\.\d\/s while the Backend stayed \d+\.\d% busy: \d+\.\d% of its time went on Attempts whose callers had already given up\.$/,
    )
  })

  it('stays quiet when Demand falls to a tenth: Goodput drops, but the Backend goes idle', () => {
    const seen = findingsEachSecond(
      fixture(70, [{ atMs: 40_000, change: { kind: 'demand', demandRps: 7 } }]),
    )
    expect(seen.filter((fs) => collapse(fs))).toEqual([])
  })
})
