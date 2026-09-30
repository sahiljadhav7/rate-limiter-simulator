/**
 * The Limiter interface. Algorithms (fixed window, token bucket and the rest) implement it
 * from RS-7 on. A Limiter holds per-key state but never reads a clock or a random stream:
 * it decides from the `nowMs` it is given, so runs replay exactly.
 */
import type { ClientId } from './traffic.ts'

/**
 * The Limiter's answer for one Attempt: Allow sends it to the Backend, Reject turns it away
 * (optionally saying when to try again), Delay holds it and releases it at `releaseAt`
 * (leaky bucket, ADR 0001).
 */
export type LimiterDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'reject'; readonly retryAfterMs?: number }
  | { readonly kind: 'delay'; readonly releaseAt: number }

/** One Variant's Limiter. */
export interface Limiter {
  /** Decides one Attempt from `clientId` at simulated time `nowMs`, and counts it. */
  decide(clientId: ClientId, nowMs: number): LimiterDecision
  /** Forgets every count, as at the start of a run. */
  reset(): void
}
