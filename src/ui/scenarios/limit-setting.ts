/**
 * The limit setting lesson: the same token bucket and traffic with two limits set wrong in
 * opposite ways. One far under what the Backend can serve turns Requests away while the Backend
 * idles (limit too tight); one far over it lets everything in, and the Backend saturates (limit
 * too loose) (.scratch/new-scenarios/issues/05-limit-scenario.md).
 *
 * The arithmetic (CLAUDE.md "Adding a scenario"): the Backend's ceiling is 4 slots x (1000 / 50)
 * = 80 Requests per second. At the default 30/s the limit of 20 rejects about a third, and what
 * it lets through keeps the Backend about a quarter busy; the limit of 200 lets all 30 in. At
 * 90/s (3x) the limit of 20 still lets 20 through and rejects nearly four in five, while the
 * limit of 200 lets all 90 in, 10 a second more than the Backend serves: its queue of 40 fills,
 * Attempts wait up to half a second on top of their own work, and some are shed.
 *
 * Measured over seeds 1 to 8, 120 s, every second from 15 s
 * (.scratch/new-scenarios/limit-scenario.ts). At 30/s the limit of 20 has limit too tight
 * Warning for 93 to 106 s of 106, rejecting 33% to 36% with the Backend 25% busy, and the limit
 * of 200 has no Finding. At 60/s the limit of 20 is Broken all 106 s and the limit of 200 has
 * limit too loose and saturation
 * Warning for 0 to 6 s. At 90/s the limit of 20 rejects 78% and is Broken
 * throughout; the limit of 200 has limit too loose for 106 s (Broken 85 to 100), with saturation
 * and queue overflow contributing: the Backend 99% to 100% busy, the p99 687 to 754 ms against
 * 223 to 245 ms at 30/s, and 10% to 14% of Attempts shed. At 120/s the same, shedding 33% to 35%.
 *
 * Too loose finishes more than too tight (78 to 80/s against 20/s at 90/s), so the lesson is
 * not that more is worse: it is what the Backend pays, waits three times as long and Attempts
 * shed at a full queue, which a limit a little under the ceiling avoids (on the saturation
 * fixture the same Limiter at 60/s is never saturated and holds 60/s,
 * .scratch/apply-fix/patch-probe.ts).
 *
 * Token buckets on both sides, so the only difference is the limit. The fix for both is a limit
 * a little under the ceiling, as the cards say; it is not a third Variant.
 */
import type { Scenario } from '../../runner/scenario.ts'

/** No retries, so what is turned away or lost is the limit's doing, not retry traffic. */
const noRetry = { timeoutMs: 2000, maxAttempts: 1, retry: 'none' } as const

export const limitSettingScenario: Scenario = {
  id: 'limit-setting',
  title: 'Limit too tight or too loose',
  lesson:
    'Two limits, the same traffic. At 30 a second the limit of 20 turns a third away while ' +
    'the Backend is mostly idle. Raise Demand to 90: the limit of 200 lets all in and the ' +
    'Backend saturates.',
  why:
    'Aim a little under what the Backend serves, 80 a second. Far under wastes it; at or ' +
    'over, Attempts queue, wait and some are shed.',
  models:
    'Three Clients sending at random times, through a token bucket holding 10, to one Backend ' +
    'with 4 slots and room for 40 to wait. Each Attempt takes about 50 ms there, varying a lot, ' +
    'and its Client waits up to 2 s.',
  leavesOut:
    'Retries unless you turn them on, limits that adjust themselves to how busy the Backend ' +
    'is, and network latency.',
  seed: 1,
  traffic: { shape: 'poisson', demandRps: 30, clients: ['a', 'b', 'c'] },
  backend: { slots: 4, queueLimit: 40, meanMs: 50, cv: 1 },
  variants: [
    {
      label: 'Limit of 20 a second',
      limiter: { algo: 'token-bucket', keyBy: 'global', capacity: 10, refillPerSec: 20 },
      retry: noRetry,
    },
    {
      label: 'Limit of 200 a second',
      limiter: { algo: 'token-bucket', keyBy: 'global', capacity: 10, refillPerSec: 200 },
      retry: noRetry,
    },
  ],
}
