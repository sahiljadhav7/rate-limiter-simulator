/**
 * The Limiter interface and its algorithms. A Limiter holds per-key state but never reads a
 * clock or a random stream: it decides from the `nowMs` it is given, so runs replay exactly.
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

/**
 * Fixed window: each key may have `limit` Attempts allowed per window. Windows start at 0,
 * so window k covers [k x windowMs, (k + 1) x windowMs) for every key and every Variant.
 */
export interface FixedWindowSpec {
  readonly algo: 'fixed-window'
  /** One count shared by every Client, or one count per Client. */
  readonly keyBy: 'global' | 'client'
  /** Attempts allowed per window, per key: a whole number, 1 or more. */
  readonly limit: number
  /** The window length, in ms. */
  readonly windowMs: number
}

/** What a Variant's Limiter is built from. Each algorithm adds its own member. */
export type LimiterSpec = FixedWindowSpec

/** The key every Attempt counts against when a Limiter is keyed globally. */
const GLOBAL_KEY = ''

/** Creates the Limiter `spec` describes. */
export function createLimiter(spec: LimiterSpec): Limiter {
  return createFixedWindow(spec)
}

function createFixedWindow(spec: FixedWindowSpec): Limiter {
  const { keyBy, limit, windowMs } = spec
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`A fixed window's limit must be a whole number, 1 or more, got ${limit}`)
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new RangeError(
      `A fixed window's length must be a finite number of ms, more than 0, got ${windowMs}`,
    )
  }
  /**
   * The window `nowMs` is in: the k with k x windowMs <= nowMs < (k + 1) x windowMs. Dividing
   * alone can round across an edge when windowMs is not whole (2100 / (100 / 3) comes out
   * just under 63), so the result is checked against the edges themselves.
   */
  function windowAt(nowMs: number): number {
    const k = Math.floor(nowMs / windowMs)
    if ((k + 1) * windowMs <= nowMs) return k + 1
    if (k * windowMs > nowMs) return k - 1
    return k
  }
  /** Per key: the window its count belongs to, and the Attempts allowed in it. */
  const counts = new Map<ClientId, { window: number; allowed: number }>()
  return {
    decide(clientId, nowMs) {
      const window = windowAt(nowMs)
      const key = keyBy === 'client' ? clientId : GLOBAL_KEY
      let entry = counts.get(key)
      if (entry === undefined) {
        entry = { window, allowed: 0 }
        counts.set(key, entry)
      } else if (entry.window !== window) {
        entry.window = window
        entry.allowed = 0
      }
      if (entry.allowed >= limit) {
        return { kind: 'reject', retryAfterMs: (window + 1) * windowMs - nowMs }
      }
      entry.allowed++
      return { kind: 'allow' }
    },
    reset() {
      counts.clear()
    },
  }
}
