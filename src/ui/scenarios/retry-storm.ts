/**
 * The retry storm lesson: the same token bucket, the same traffic, and two Retry Policies.
 * Retrying at once turns into a retry storm; backing off sends as many retry Attempts, or more,
 * but later, when there is room for them
 * (.scratch/new-scenarios/issues/03-retry-storm-scenario.md).
 *
 * The arithmetic (CLAUDE.md "Adding a scenario"): Backend overload's traffic and Backend, with
 * its token bucket on both sides. The Backend's ceiling is 4 slots x (1000 / 50) = 80 Requests
 * per second, the bucket allows 70 a second and holds 10, so the Backend keeps up with whatever
 * the bucket lets through. Traffic comes for 1 s and stops for 4 s, so a burst runs at 5 times
 * Demand: 50/s at the default 10/s, under the bucket, so nothing is rejected and nobody retries.
 * At 40/s a burst brings 200 a second, the bucket lets about 80 of them through (10 saved up and
 * 70 refilled), and the rest are rejected, each with up to 2 retry Attempts left.
 *
 * Retried at once, a rejected Attempt comes back within the same moment and finds the bucket as
 * empty as before. Backing off waits 100 ms, then 200 ms, so some retry Attempts arrive after
 * the burst, when tokens refill unused. Measured at 40/s over seeds 1 to 8, 15 to 120 s, by
 * second of the 5 s cycle (.scratch/new-scenarios/storm-phase.ts): in the burst second both have
 * about the same Attempts allowed (13,203 at once, 13,238 backing off); in the second after it,
 * none at once and 3,371 backing off.
 *
 * Measured over seeds 1 to 8, 120 s, every second from 15 s, on this Scenario
 * (.scratch/new-scenarios/storm-scenario.ts): at 10/s neither has a Finding. Retrying at once:
 * retry storm Warning for 56 to 96 s of 106 at 20/s; Warning 30 to 53 s and Broken 53 to 76 s
 * at 30/s; Broken all 106 s at 40/s. Backing off never has a Finding. Goodput at 40/s: at once
 * 15.6 to 15.8/s, backing off 19.7 to 19.8/s. Backing off does not send fewer Attempts: Offered
 * Load over Demand is 2.21x to 2.24x at once and 2.31x to 2.35x backing off.
 *
 * Plain backing off, not with jitter: jitter waits a random share of the backoff, so less on
 * average, and does worse here (18.0 to 18.5/s at 40/s, .scratch/new-scenarios/storm-fixes.ts).
 * Token bucket on both sides: with the sliding window counter of Backend overload, queue overflow
 * fires on both sides too (at 40/s Broken all 106 s backing off as well,
 * .scratch/new-scenarios/storm-probe.ts plain-swc), so two lessons would show at once.
 */
import type { Scenario } from '../../runner/scenario.ts'

/** What the token bucket allows per second over the long run, under the Backend's 80. */
const RATE = 70

/** The token bucket's size, as in Backend overload: a burst the Backend can take at once. */
const BUCKET = 10

/** What both Retry Policies share: up to 3 Attempts per Request, each abandoned after 500 ms. */
const SHARED_POLICY = { timeoutMs: 500, maxAttempts: 3 } as const

const limiter = {
  algo: 'token-bucket',
  keyBy: 'global',
  capacity: BUCKET,
  refillPerSec: RATE,
} as const

export const retryStormScenario: Scenario = {
  id: 'retry-storm',
  title: 'Retry storm',
  lesson:
    'Both use the same token bucket. Raise Demand to 40: retrying at once becomes a retry ' +
    'storm, while backing off stays calm and finishes more Requests.',
  why:
    'Retried at once, an Attempt finds the bucket as empty as before. Backing off waits 100 ms, ' +
    'then 200, so some retry Attempts come after the burst, when tokens are free.',
  models:
    'One token bucket of 70 a second, holding 10, for all Clients, in front of one Backend with ' +
    '4 slots and room for 20 to wait. Each Attempt takes about 50 ms there and is abandoned ' +
    'after 500 ms. Traffic comes for 1 s, then stops for 4 s. Each Request gets up to 3 ' +
    'Attempts. Backing off sends as many retry Attempts, or more; only when they arrive differs.',
  leavesOut:
    'Retry budgets that cap how much a Client retries, and network latency. Random waits ' +
    '(jitter) help Clients that all fail at the same moment; here failures spread over each ' +
    'burst, so jitter only waits less, and does a little worse.',
  seed: 1,
  traffic: {
    shape: 'bursty',
    demandRps: 10,
    clients: ['a', 'b', 'c'],
    bursty: { onMs: 1000, offMs: 4000 },
  },
  backend: { slots: 4, queueLimit: 20, meanMs: 50, cv: 0.5 },
  variants: [
    { label: 'Retry at once', limiter, retry: { ...SHARED_POLICY, retry: 'immediate' } },
    {
      label: 'Back off',
      limiter,
      retry: { ...SHARED_POLICY, retry: 'backoff', baseDelayMs: 100 },
    },
  ],
}
