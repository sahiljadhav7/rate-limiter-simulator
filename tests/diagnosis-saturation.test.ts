import { describe, expect, it } from 'vitest'
import { createRunner } from '../src/runner/runner.ts'
import type { Scenario } from '../src/runner/scenario.ts'
import { createDiagnoser, saturationRule, type Finding } from '../src/sim/diagnosis.ts'
import type { AllowedSubBuckets } from '../src/sim/engine.ts'
import type { Snapshot } from '../src/sim/metrics.ts'
import type { BackendSpec } from '../src/sim/backend.ts'
import { snapshotAt } from './snapshots.ts'

/** Ceiling 4 x 1000 / 50 = 80 per second; cv 1, so the baseline p99 is 50 x ln 100 = 230.3 ms. */
const backend: BackendSpec = { slots: 4, queueLimit: 40, meanMs: 50, cv: 1 }
const allowed: AllowedSubBuckets = { bucketMs: 100, counts: [] }

/** Poisson Demand at `demandRps` through a Limiter that lets every Attempt through. */
const scenario = (demandRps: number, seed = 1): Scenario => ({
  id: 'saturation-fixture',
  title: 'Saturation fixture',
  lesson: 'None: a test fixture.',
  why: 'It only exists to be run.',
  models: 'One Backend with nothing in front of it.',
  leavesOut: 'Everything a lesson would need.',
  seed,
  traffic: { shape: 'poisson', demandRps, clients: ['a', 'b', 'c'] },
  backend,
  variants: [
    {
      label: 'Lets all through',
      limiter: { algo: 'token-bucket', keyBy: 'global', capacity: 10_000, refillPerSec: 10_000 },
      // A long timeout, so latency is not cut short by Attempts giving up.
      retry: { timeoutMs: 2000, maxAttempts: 1, retry: 'none' },
    },
  ],
})

/** Runs `sc` for 120 s and gives the saturation Finding (or none) after each second from 10 s. */
function saturationEachSecond(sc: Scenario) {
  const runner = createRunner(sc, { eventBudget: Infinity })
  const seen: (Finding | undefined)[] = []
  for (let second = 10; second <= 120; second++) {
    while (runner.view().simMs < second * 1000) runner.tick(100)
    seen.push(runner.view().variants[0]?.findings.find((f) => f.id === 'saturation'))
  }
  return { seen, last: runner.view().variants[0] }
}

/** A Snapshot ending at `t` after the warm-up, with `backendUtil` and `p99`. */
const snapshot = (t: number, backendUtil: number, p99: number | null): Snapshot =>
  snapshotAt(t, { warmUp: false, backendUtil, p99 })

/** Severity after each of `seconds`, each [busy, p99 in ms], fed to the saturation rule alone. */
function severities(seconds: readonly (readonly [number, number | null])[]) {
  const diagnoser = createDiagnoser(
    {
      backend,
      limiter: { algo: 'token-bucket', keyBy: 'global', capacity: 1, refillPerSec: 1 },
    },
    [saturationRule(backend)],
  )
  return seconds.map(([busy, p99], i) => {
    diagnoser.add(snapshot((6 + i) * 1000, busy, p99), allowed)
    return diagnoser.findings()[0]?.severity ?? 'healthy'
  })
}
const repeat = <T>(n: number, x: T): T[] => Array<T>(n).fill(x)

describe('the saturation rule', () => {
  it.each([
    [0.97, 800, 'broken'], // busy, and p99 3.5x the 230 ms baseline
    [0.9, 600, 'warn'], // 2.6x
    [0.97, 600, 'warn'], // busy enough for broken, but only 2.6x
    [0.97, 400, 'healthy'], // busy but quick: a Backend doing its job at full use
    [0.7, 800, 'healthy'], // slow but not busy: not saturation
    [0.97, null, 'healthy'], // nothing finished in time, so no p99 to enter on
  ] as const)('busy %s with p99 %s ms is %s', (busy, p99, severity) => {
    expect(severities(repeat(5, [busy, p99] as const)).at(-1)).toBe(severity)
  })

  it('stays where it is near a threshold rather than flickering (hysteresis)', () => {
    // Broken, then busy dips to 92% and p99 to 2.7x: inside both margins, still broken. Then
    // 88%: below 90%, so warn. Then 82% at 1.8x: still warn. Then 78%: clears.
    const levels = [
      [0.97, 800],
      [0.92, 630],
      [0.88, 630],
      [0.82, 420],
      [0.78, 420],
    ] as const
    const result = severities(levels.flatMap((level) => repeat(5, level)))
    expect([4, 9, 14, 19, 24].map((i) => result[i])).toEqual([
      'broken',
      'broken',
      'warn',
      'warn',
      'healthy',
    ])
  })

  it('stays while a held Backend is so stalled that nothing finishes in time, with a dash for p99', () => {
    // Broken, then 5 s with every Attempt given up on (no p99) at 99% busy: still broken. Then
    // the Backend empties (50% busy): it clears.
    const result = severities([
      ...repeat(5, [0.97, 800] as const),
      ...repeat(5, [0.99, null] as const),
      ...repeat(5, [0.5, null] as const),
    ])
    expect([4, 9, 14].map((i) => result[i])).toEqual(['broken', 'broken', 'healthy'])
    const diagnoser = createDiagnoser(
      {
        backend,
        limiter: { algo: 'token-bucket', keyBy: 'global', capacity: 1, refillPerSec: 1 },
      },
      [saturationRule(backend)],
    )
    for (let i = 0; i < 5; i++) diagnoser.add(snapshot((6 + i) * 1000, 0.97, 800), allowed)
    diagnoser.add(snapshot(11_000, 0.99, null), allowed)
    const [finding] = diagnoser.findings()
    expect(finding?.evidence.slice(1).map((e) => e.value)).toEqual(['–', '230 ms', '–'])
    expect(finding?.why).toBe(
      'The Backend was busy 97.4% of the time, and no Attempt finished before its caller gave up waiting for a slot.',
    )
  })

  it('names the evidence and says why from the numbers', () => {
    const diagnoser = createDiagnoser(
      {
        backend,
        limiter: { algo: 'token-bucket', keyBy: 'global', capacity: 1, refillPerSec: 1 },
      },
      [saturationRule(backend)],
    )
    for (let i = 0; i < 5; i++) diagnoser.add(snapshot((6 + i) * 1000, 0.98, 806), allowed)
    const [finding] = diagnoser.findings()
    expect(finding).toMatchObject({
      id: 'saturation',
      label: 'Backend saturation',
      kind: 'symptom',
      severity: 'broken',
      evidence: [
        { metric: 'Busy', value: '98.0%' },
        { metric: 'Slowest 1 in 100 (p99)', value: '806 ms' },
        { metric: 'Its work alone (baseline p99)', value: '230 ms' },
        { metric: 'Against the baseline', value: '3.5×' },
      ],
    })
    expect(finding?.why).toBe(
      'The Backend was busy 98.0% of the time, so Attempts waited for a slot: the slowest 1 in ' +
        '100 took 806 ms, 3.5× the 230 ms its work alone takes.',
    )
    expect(finding?.fixes.map((fix) => fix.text)).toEqual([
      'Try more Backend slots',
      'Try making each Attempt cheaper for the Backend, such as with a cache',
      'Try a limit below what the Backend can serve (it turns more away, but what gets through is quick)',
    ])
  })

  // Behind a Limiter that lets everything through, limit too loose explains the saturation, so it
  // is the Root Cause from RS-28 (.scratch/more-rules/spec.md decision 3); saturation still comes
  // before queue overflow among the Symptoms.
  it('fires on Demand above the Backend ceiling (100/s against 80/s), before queue overflow', () => {
    const { seen, last } = saturationEachSecond(scenario(100))
    const broken = seen.filter((f) => f?.severity === 'broken').length
    // Broken 95% to 100% of seconds over seeds 1 to 8 (.scratch/diagnosis/saturation-fixes.ts).
    expect(broken / seen.length).toBeGreaterThan(0.9)
    expect(last?.findings.map((f) => [f.id, f.role])).toEqual([
      ['limit-too-loose', 'root-cause'],
      ['saturation', 'contributing'],
      ['queue-overflow', 'contributing'],
    ])
  })

  it('finds nothing at half the ceiling (40/s), at any second, on seeds 1 to 8', () => {
    for (let seed = 1; seed <= 8; seed++) {
      expect(saturationEachSecond(scenario(40, seed)).seen.filter(Boolean)).toEqual([])
    }
  })
})
