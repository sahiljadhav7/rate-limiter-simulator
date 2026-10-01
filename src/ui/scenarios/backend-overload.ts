/**
 * The Backend overload lesson: two Limiters that both allow 70 a second, in front of a Backend
 * that serves 80, on traffic that comes in bursts, and only one of them lets the Backend fail
 * (.scratch/backend-overload/spec.md).
 *
 * The arithmetic (CLAUDE.md "Adding a scenario"): the Backend's ceiling is 4 slots x (1000 /
 * 50) = 80 Requests per second, and both Limiters' long-run rate is 70, so on average neither
 * overloads it. Traffic is on for 1 s and off for 4 s, so a burst runs at 5 times the mean
 * Demand: 50/s at the default 10/s, 200/s at 40/s.
 *
 * After 4 quiet seconds the sliding window counter remembers an empty window, so it lets a
 * whole window's worth, 70, through as fast as the burst brings them: at 200/s, within about
 * 350 ms, into a Backend that serves 80/s with 20 places to wait. The queue overflows and
 * Attempts are shed. The token bucket holds only 10 tokens, then lets one through every 14 ms
 * (70/s), which the Backend keeps up with. Measured over 8 seeds: at 10/s neither goes amber or
 * red; at 20/s the sliding counter is amber or red for 10 to 45 s of 115; at 30 and 40/s red
 * nearly throughout; the token bucket never. Goodput at 20, 30 and 40/s: sliding counter 13.7,
 * 11.6 and 9.9 (more traffic, less work done); token bucket 15.4 to 15.7.
 *
 * Service times vary moderately (cv 0.5), not exponentially (cv 1): at 70 a second the Backend
 * is 87.5% busy, and with exponential service its queue overflows now and then however evenly
 * Attempts arrive. That is a lesson about utilization, not pacing, so it is kept out of this
 * one (.scratch/backend-overload/tune.ts).
 */
import type { Scenario } from '../../runner/scenario.ts'

/** What both Limiters allow per second over the long run, under the Backend's 80. */
const RATE = 70
const WINDOW_MS = 1000

/**
 * The token bucket's size: a burst the Backend can take at once (4 slots and 20 places to
 * wait). A bucket of 140 would let 140 through at the start of a burst and fail like the
 * sliding counter; the size is part of the lesson.
 */
const BUCKET = 10

/** No retries, so what is lost is what the Limiter's pacing cost, not retry traffic. */
const noRetry = { timeoutMs: 500, maxAttempts: 1, retry: 'none' } as const

export const backendOverloadScenario: Scenario = {
  id: 'backend-overload',
  title: 'Backend overload',
  lesson:
    "Both allow 70 a second, under the Backend's 80. Raise Demand to 30: the sliding window " +
    "counter's Backend turns red, the token bucket's stays calm.",
  why:
    'After a quiet gap the counter lets a whole window of 70 in at once, too fast for the ' +
    'Backend, so it sheds some. The bucket holds 10, then lets them in one at a time.',
  models:
    'One Limiter counting all Clients together, in front of one Backend with 4 slots and room ' +
    'for 20 to wait. Each Attempt takes about 50 ms there, varying a little. Traffic comes for ' +
    '1 s, then stops for 4 s.',
  leavesOut:
    'Retries unless you turn them on, network latency, and Backends that slow down as they fill.',
  seed: 1,
  traffic: {
    shape: 'bursty',
    demandRps: 10,
    clients: ['a', 'b', 'c'],
    bursty: { onMs: 1000, offMs: 4000 },
  },
  backend: { slots: 4, queueLimit: 20, meanMs: 50, cv: 0.5 },
  variants: [
    {
      label: 'Sliding window counter',
      limiter: { algo: 'sliding-counter', keyBy: 'global', limit: RATE, windowMs: WINDOW_MS },
      retry: noRetry,
    },
    {
      label: 'Token bucket',
      limiter: { algo: 'token-bucket', keyBy: 'global', capacity: BUCKET, refillPerSec: RATE },
      retry: noRetry,
    },
  ],
}
