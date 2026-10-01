/**
 * The boundary burst lesson. Fixed window against sliding window counter on an Edge Burst: 30 Requests 50 ms
 * before a window edge and 30 just after, every 10 seconds, on light background traffic.
 *
 * The arithmetic (CLAUDE.md "Adding a scenario"): the Backend's ceiling is 4 slots x (1000 / 50)
 * = 80 Requests per second. Both Limiters allow 10 per second, and background Demand is 4 per
 * second, so outside the bursts nothing waits. Fixed window lets 10 through before the edge and
 * 10 more after it, about 20 in one window-length; the sliding counter still counts the window
 * before and lets about 10 through. 20 Attempts at once queue for at most 5 x 50 ms, well
 * inside the 1 s timeout, so what the Limiter allows is what the Backend serves.
 */
import type { Scenario } from '../../runner/scenario.ts'

const WINDOW_MS = 1000
const BURST_EVERY_MS = 10_000
const BURST_SIZE = 30
/** Ten minutes of bursts, enough to check the charts over a 10-minute run. */
const BURSTS = 60

const edgeBursts = Array.from({ length: BURSTS }, (_, i) => {
  const edgeMs = (i + 1) * BURST_EVERY_MS
  return [
    { atMs: edgeMs - 50, count: BURST_SIZE },
    { atMs: edgeMs + 50, count: BURST_SIZE },
  ]
}).flat()

const noRetry = { timeoutMs: 1000, maxAttempts: 1, retry: 'none' } as const

export const edgeBurstScenario: Scenario = {
  id: 'edge-burst',
  title: 'Edge burst',
  lesson: 'Watch the fixed window let about twice its limit through across each window edge.',
  models: 'One Limiter counting all Clients together, in front of one Backend.',
  leavesOut: 'Retries, network latency and more than one Limiter node.',
  seed: 1,
  traffic: { shape: 'poisson', demandRps: 4, clients: ['a', 'b', 'c'] },
  scriptedArrivals: edgeBursts,
  backend: { slots: 4, queueLimit: 40, meanMs: 50, cv: 1 },
  variants: [
    {
      label: 'Fixed window',
      limiter: { algo: 'fixed-window', keyBy: 'global', limit: 10, windowMs: WINDOW_MS },
      retry: noRetry,
    },
    {
      label: 'Sliding window counter',
      limiter: { algo: 'sliding-counter', keyBy: 'global', limit: 10, windowMs: WINDOW_MS },
      retry: noRetry,
    },
  ],
}
