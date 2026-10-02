/**
 * The goodput collapse lesson: a limit above what the Backend can serve lets in work that waits
 * in a long queue past its timeout, so the Backend stays busy serving Clients who already gave up
 * and finishes almost nothing; a limit below it keeps finishing
 * (.scratch/new-scenarios/issues/04-goodput-collapse-scenario.md).
 *
 * The arithmetic (CLAUDE.md "Adding a scenario"): the Backend's ceiling is 4 slots x (1000 / 50)
 * = 80 Requests per second, and it has room for 200 to wait: 2.5 s of work at 80/s, five times
 * the 500 ms a Client waits. At the default 40/s both limits let everything through and the
 * Backend is about half busy. Raised to 120/s, the limit of 120 lets all of it in, 40 a second
 * more than the Backend serves, so the queue grows by about 40 a second, and within a few
 * seconds every Attempt waits longer than 500 ms: its Client gives up, but the Backend still
 * serves it when its turn comes (Wasted Work). The limit of 60 turns half away, and the Backend,
 * 75% busy, keeps up.
 *
 * Measured over seeds 1 to 8, 120 s, every second from 15 s, Demand raised from 40/s at 30 s
 * (.scratch/new-scenarios/collapse-scenario.ts): before the raise both finish 39 to 41/s with no
 * Finding. Raised to 120/s, the limit of 120 finishes 0/s from 35 s with the Backend 100% busy,
 * all of it Wasted Work; goodput collapse is Broken for 83 to 86 s and limit too loose for 82 to
 * 85 s of the 90 after the raise, queue overflow Root Cause for the first seconds until
 * saturation is judged. The limit of 60 finishes 60/s at 74% to 78% busy and never has a
 * Finding. At 160/s the same; at 80/s, the Backend's own ceiling, the limit of 120 collapses on
 * some seeds and not others (1.4 to 58/s from 35 s), so the lesson asks for 120.
 *
 * The lesson needs the raise. Goodput collapse compares Goodput with the Variant's own best 5 s,
 * so a run that starts at 120/s has never had a good spell to fall from: its Goodput is 0 from
 * the start, and limit too loose, saturation and queue overflow fire for all 106 s but goodput
 * collapse never does (collapse-scenario.ts start 120). Limit too loose, a Cause,
 * is the Root Cause once the Backend is saturated, and goodput collapse contributes; the fix
 * that does most, a shorter queue, is a Backend change, so it is a step on the card rather
 * than a Variant.
 */
import type { Scenario } from '../../runner/scenario.ts'

/** No retries, so the collapse is the queue's alone, not retry traffic. */
const noRetry = { timeoutMs: 500, maxAttempts: 1, retry: 'none' } as const

export const goodputCollapseScenario: Scenario = {
  id: 'goodput-collapse',
  title: 'Goodput collapse',
  lesson:
    'Both limits cope at 40 a second. While it runs, raise Demand to 120: behind the limit of ' +
    '120 the Backend stays busy but finishes almost nothing; behind 60 it keeps going.',
  why:
    '120 lets in more than the Backend can serve, so Attempts wait in its long queue past ' +
    'their timeout, and it works for Clients who already gave up.',
  models:
    'Three Clients sending at random times, through a token bucket holding 10, to one Backend ' +
    'with 4 slots and room for 200 to wait. Each Attempt takes about 50 ms there, varying ' +
    'a lot, and its Client gives up after 500 ms.',
  leavesOut:
    'Retries unless you turn them on, Backends that cancel work whose Client has gone, and ' +
    'network latency.',
  seed: 1,
  traffic: { shape: 'poisson', demandRps: 40, clients: ['a', 'b', 'c'] },
  backend: { slots: 4, queueLimit: 200, meanMs: 50, cv: 1 },
  variants: [
    {
      label: 'Limit of 120 a second',
      limiter: { algo: 'token-bucket', keyBy: 'global', capacity: 10, refillPerSec: 120 },
      retry: noRetry,
    },
    {
      label: 'Limit of 60 a second',
      limiter: { algo: 'token-bucket', keyBy: 'global', capacity: 10, refillPerSec: 60 },
      retry: noRetry,
    },
  ],
}
