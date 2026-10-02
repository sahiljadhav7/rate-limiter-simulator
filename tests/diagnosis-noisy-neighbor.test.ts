import { describe, expect, it } from 'vitest'
import { createRunner } from '../src/runner/runner.ts'
import type { Scenario } from '../src/runner/scenario.ts'
import { createDiagnoser, noisyNeighborRule, type Finding } from '../src/sim/diagnosis.ts'
import { snapshotAt } from './snapshots.ts'
import type { KeyBy } from '../src/sim/limiter.ts'
import { withRetryMode, type RetryMode } from '../src/ui/controls/retry-options.ts'
import { backendOverloadScenario } from '../src/ui/scenarios/backend-overload.ts'

/**
 * Poisson 60/s from three Clients, `greedy` sending 8 shares (48/s) and the others 6/s each,
 * through a token bucket of 40/s, in front of a Backend of 4 slots of 50 ms (80/s). Measured in
 * .scratch/more-rules/spec.md: the Backend runs 46% to 55% busy, so limit too tight stays quiet.
 */
const fixture = (keyBy: KeyBy, greedy: string | null = 'a', seed = 1): Scenario => ({
  id: 'noisy-neighbor-fixture',
  title: 'Noisy neighbor fixture',
  lesson: 'None: a test fixture.',
  why: 'It only exists to be run.',
  models: 'Three Clients behind one Limiter.',
  leavesOut: 'Everything a lesson would need.',
  seed,
  traffic: {
    shape: 'poisson',
    demandRps: 60,
    clients: ['a', 'b', 'c'],
    ...(greedy !== null && { greedy: { clientId: greedy, multiplier: 8 } }),
  },
  backend: { slots: 4, queueLimit: 20, meanMs: 50, cv: 0.5 },
  variants: [
    {
      label: 'Token bucket',
      // Keyed per Client, each gets the 40/s, so the total stays far over what is sent.
      limiter: { algo: 'token-bucket', keyBy, capacity: 10, refillPerSec: 40 },
      retry: { timeoutMs: 1000, maxAttempts: 1, retry: 'none' },
    },
  ],
})

/** Every second from 10 s to 120 s: each Variant's active Findings. */
function findingsEachSecond(sc: Scenario): (readonly Finding[])[][] {
  const runner = createRunner(sc, { eventBudget: Infinity })
  const seen: (readonly Finding[])[][] = sc.variants.map(() => [])
  for (let second = 10; second <= 120; second++) {
    while (runner.view().simMs < second * 1000) runner.tick(100)
    runner.view().variants.forEach((v, i) => seen[i]?.push(v.findings))
  }
  return seen
}
const noisy = (fs: readonly Finding[]) => fs.find((f) => f.id === 'noisy-neighbor')
/** Backend overload at 3x its Demand, where the most is turned away. */
const at30: Scenario = {
  ...backendOverloadScenario,
  traffic: { ...backendOverloadScenario.traffic, demandRps: 30 },
}
const withRetry = (sc: Scenario, mode: RetryMode): Scenario => ({
  ...sc,
  variants: sc.variants.map((v) => ({ ...v, retry: withRetryMode(v.retry, mode) })),
})

describe('the noisy neighbor rule', () => {
  it('fires broken when one greedy Client crowds the others out of a global limit, from 15 s', () => {
    for (let seed = 1; seed <= 3; seed++) {
      const [seen = []] = findingsEachSecond(fixture('global', 'a', seed))
      expect(seen.slice(0, 5).filter((fs) => noisy(fs))).toEqual([])
      // 846 to 847 of 848 windows over seeds 1 to 8; the others lose 17% to 46% of theirs.
      const broken = seen.slice(5).filter((fs) => noisy(fs)?.severity === 'broken').length
      expect(broken / (seen.length - 5)).toBeGreaterThan(0.9)
      expect(seen.at(-1)?.map((f) => [f.id, f.role])).toEqual([['noisy-neighbor', 'root-cause']])
    }
  })

  it('names the Client, its share, and what the others lost', () => {
    const [seen = []] = findingsEachSecond(fixture('global'))
    const finding = noisy(seen.at(-1) ?? [])
    expect(finding?.evidence.map((e) => e.metric)).toEqual([
      'Client',
      'Its share of allowed',
      'Others sent',
      'Others rejected',
    ])
    expect(finding?.evidence[0]?.value).toBe('a')
    expect(finding?.why).toMatch(
      /^Client a sent more than its fair share of the limit \(13\.3\/s, 40\/s shared by 3 Clients\) in each of the last 10 seconds and got \d+\.\d% of what the Limiter allowed, so the other Clients, sending \d+\.\d\/s between them, had \d+\.\d% of their Attempts rejected\.$/,
    )
  })

  it('stays quiet with a limit per Client, or with no greedy Client', () => {
    for (const sc of [fixture('client'), fixture('global', null)]) {
      const [seen = []] = findingsEachSecond(sc)
      expect(seen.filter((fs) => noisy(fs))).toEqual([])
    }
  })

  // With no greedy Client no one is over its fair share for 10 seconds running (at most 4 in
  // Backend overload at 3x, seeds 1 to 8), so the Scenario written for other rules stays quiet.
  it.each([
    ['Backend overload at 10/s', backendOverloadScenario],
    ['Backend overload at 30/s with "Retry at once"', withRetry(at30, 'immediate')],
    ['Backend overload at 30/s with "Wait for Retry-After"', withRetry(at30, 'retry-after')],
  ])('stays quiet in %s, seeds 1 to 3', (_, scenario) => {
    for (let seed = 1; seed <= 3; seed++) {
      for (const seen of findingsEachSecond({ ...scenario, seed })) {
        expect(seen.filter((fs) => noisy(fs))).toEqual([])
      }
    }
  })

  // Retries are not greed: a Client whose own new Requests are under its fair share, but whose
  // failed Attempts come straight back, sends more Attempts without asking for more.
  it.each([
    [10, 'quiet', null],
    [20, 'fires', 'broken'],
  ] as const)(
    'judges what a Client asks for, not its retries: Demand %s/s against a fair share of 13.3/s %s',
    (demand, _, expected) => {
      const limiter = {
        algo: 'token-bucket',
        keyBy: 'global',
        capacity: 10,
        refillPerSec: 40,
      } as const
      const diagnoser = createDiagnoser(
        { backend: { slots: 4, queueLimit: 20, meanMs: 50, cv: 0.5 }, limiter },
        [noisyNeighborRule(limiter)],
      )
      // Client a: 30 Attempts and 30 allowed a second, whatever its own Demand. The others ask
      // for 4 each, under their share, and half of theirs are rejected.
      for (let t = 6; t <= 20; t++) {
        const other = { demand: 4, offeredLoad: 4, allowed: 2 }
        diagnoser.add(
          snapshotAt(t * 1000, {
            perClient: { a: { demand, offeredLoad: 30, allowed: 30 }, b: other, c: other },
          }),
          { bucketMs: 100, counts: [] },
        )
      }
      expect(diagnoser.findings()[0]?.severity ?? null).toBe(expected)
    },
  )
})
