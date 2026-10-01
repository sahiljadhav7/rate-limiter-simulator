/**
 * The Backend overload lesson: three Limiters that all allow 70 a second, in front of a Backend
 * that serves 80, and only one of them lets it fail (.scratch/backend-overload/spec.md).
 *
 * The arithmetic (CLAUDE.md "Adding a scenario"): the Backend's ceiling is 4 slots x (1000 /
 * 50) = 80 Requests per second, and every Limiter's long-run rate is 70, so on average none
 * overloads it. Under load, fixed window lets its 70 through in a rush right after each window
 * edge: at 240/s Demand, all 70 within about 290 ms, a rate of 240/s into a Backend that serves
 * 80/s, so the 20-place queue overflows and about 24 Attempts a second are shed. Sliding window
 * counter (which still counts the window before) and token bucket (one token every 14 ms) let
 * them through evenly. Measured goodput at 60, 120 and 240/s over 5 minutes: fixed window 59,
 * 65 and 45; the other two 59 to 70.
 *
 * Service times vary moderately (cv 0.5), not exponentially (cv 1). At 70 a second the Backend
 * is 87.5% busy, and with exponential service a 20-place queue overflows now and then even when
 * Attempts arrive evenly: every Variant went amber for 5 to 10 seconds in 5 minutes at the
 * default Demand. That is a lesson about utilization, not pacing, so it is kept out of this one
 * (.scratch/backend-overload/tune.ts).
 */
import type { Scenario } from '../../runner/scenario.ts'

/** What every Limiter allows per second over the long run, under the Backend's 80. */
const RATE = 70
const WINDOW_MS = 1000

/** No retries, so what is lost is what the Limiter's pacing cost, not retry traffic. */
const noRetry = { timeoutMs: 500, maxAttempts: 1, retry: 'none' } as const

export const backendOverloadScenario: Scenario = {
  id: 'backend-overload',
  title: 'Backend overload',
  lesson:
    "All three allow 70 a second, under the Backend's 80. Watch fixed window let its 70 through " +
    'in a rush at each window edge, so the queue overflows. Raise Demand to see it.',
  models:
    'One Limiter counting all Clients together, in front of one Backend with 4 slots, a queue ' +
    'of 20, and service times that vary moderately around 50 ms.',
  leavesOut: 'Retries, network latency, and Backends that slow down as they fill.',
  seed: 1,
  traffic: { shape: 'poisson', demandRps: 60, clients: ['a', 'b', 'c'] },
  backend: { slots: 4, queueLimit: 20, meanMs: 50, cv: 0.5 },
  variants: [
    {
      label: 'Fixed window',
      limiter: { algo: 'fixed-window', keyBy: 'global', limit: RATE, windowMs: WINDOW_MS },
      retry: noRetry,
    },
    {
      label: 'Sliding window counter',
      limiter: { algo: 'sliding-counter', keyBy: 'global', limit: RATE, windowMs: WINDOW_MS },
      retry: noRetry,
    },
    {
      label: 'Token bucket',
      // Holds two seconds' worth: after a quiet spell it can release 140 at once.
      limiter: { algo: 'token-bucket', keyBy: 'global', capacity: RATE * 2, refillPerSec: RATE },
      retry: noRetry,
    },
  ],
}
