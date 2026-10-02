/**
 * The noisy neighbor lesson: one Client asks for eight times as much as each of the others, and
 * a limit shared by all lets it crowd them out, while the same limit given to each Client does
 * not (.scratch/new-scenarios/issues/02-noisy-neighbor-scenario.md).
 *
 * The arithmetic (CLAUDE.md "Adding a scenario"): the Backend's ceiling is 4 slots x (1000 / 50)
 * = 80 Requests per second. Client a has 8 of 10 shares of Demand, b and c 1 each, so at the
 * default 20/s a asks for 16 and the others 2 each: 20 in all, under the limit of 40, and
 * nobody is turned away. At 60/s (3x) a asks for 48 and the others 6 each. Shared, the limit lets
 * 40 through and turns away a third of everyone's, the others' included. Per Client, each has 40:
 * a loses 8 a second, the others nothing, and 52 reach the Backend, under its 80. The limits per
 * Client add up to 120, over the Backend, but a greedy Client fills only its own: they would
 * reach 80 only at 200/s (10x), with a at 40 and the others at 20 each.
 *
 * Measured over seeds 1 to 8, 120 s, every second from 15 s
 * (.scratch/new-scenarios/noisy-probe.ts): at 20/s neither Variant has a Finding; at 40/s the
 * shared limit has noisy neighbor amber for 7 to 47 s of 106 (the others lose 3.6% to 6.5%); at 60
 * and 80/s red for all 106 (they lose 33% to 35% and 49% to 52%). With no retry the limit per
 * Client never has a Finding. Goodput at 60/s: shared 40/s (the limit), per Client 51 to 53/s; at
 * 80/s 40 and 55.5 to 57. With retries on, the others' rejected Requests come back and they lose
 * 60% to 76% of their Attempts; noisy neighbor stays red for all 106 s under every Retry Policy,
 * and "Retry at once" adds a retry storm as the Root Cause, on the limit per Client too for 0 to
 * 11 s of 106 on some seeds (.scratch/new-scenarios/noisy-retry.ts). Limit too tight stays quiet:
 * the Backend is 47% to 51% busy behind the shared limit, over the 40% under which the limit
 * counts as too tight.
 *
 * Token buckets on both sides, so the only difference is the key: the same algorithm, limit and
 * capacity, shared by all Clients or one per Client. A sliding window counter shared by all fails
 * the same way as the token bucket (noisy neighbor red at 60/s), so comparing the two algorithms
 * teaches nothing here.
 */
import type { Scenario } from '../../runner/scenario.ts'

/** What each Limiter allows per second over the long run: half the Backend's 80. */
const RATE = 40

/** The token buckets' size, as in Backend overload: a burst the Backend can take at once. */
const BUCKET = 10

/** No retries, so what the others lose is what the greedy Client took, not retry Attempts. */
const noRetry = { timeoutMs: 1000, maxAttempts: 1, retry: 'none' } as const

export const noisyNeighborScenario: Scenario = {
  id: 'noisy-neighbor',
  title: 'Noisy neighbor',
  lesson:
    'Client a asks for 8 times as much as each other Client. Raise Demand to 60: with one ' +
    'limit for all, the others are turned away too; with a limit per Client, they are not.',
  why:
    'A shared limit serves whoever asks first, so a uses most of it. Per Client, each has its ' +
    'own 40 a second, and a can only use up its own.',
  models:
    'Three Clients sending at random times, a with 80% of Demand and b and c 10% each. A token ' +
    'bucket of 40 a second, holding 10, in front of one Backend with 4 slots and room for 20 to ' +
    'wait. Each Attempt takes about 50 ms there, varying a little.',
  leavesOut:
    'Retries unless you turn them on, Clients taking turns at the Limiter (weighted fair ' +
    'queuing), and Clients that change how much they ask for.',
  seed: 1,
  traffic: {
    shape: 'poisson',
    demandRps: 20,
    clients: ['a', 'b', 'c'],
    greedy: { clientId: 'a', multiplier: 8 },
  },
  backend: { slots: 4, queueLimit: 20, meanMs: 50, cv: 0.5 },
  variants: [
    {
      label: 'One limit for all',
      limiter: { algo: 'token-bucket', keyBy: 'global', capacity: BUCKET, refillPerSec: RATE },
      retry: noRetry,
    },
    {
      label: 'A limit per Client',
      limiter: { algo: 'token-bucket', keyBy: 'client', capacity: BUCKET, refillPerSec: RATE },
      retry: noRetry,
    },
  ],
}
