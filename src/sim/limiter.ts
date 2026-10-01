/**
 * The Limiter interface and its algorithms. A Limiter holds per-key state but never reads a
 * clock or a random stream: it decides from the `nowMs` it is given, so runs replay exactly.
 */
import { checkPositive, checkWholeNumber } from './checks.ts'
import { bucketAt, bucketStart } from './buckets.ts'
import type { ClientId } from './traffic.ts'

/**
 * The Limiter's answer for one Attempt: Allow sends it to the Backend, Reject turns it away
 * (optionally saying when to try again), Delay holds it and releases it at `releaseAtMs`
 * (leaky bucket, ADR 0001).
 */
export type LimiterDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'reject'; readonly retryAfterMs?: number }
  | { readonly kind: 'delay'; readonly releaseAtMs: number }

/** One Variant's Limiter. */
export interface Limiter {
  /** Decides one Attempt from `clientId` at simulated time `nowMs`, and counts it. */
  decide(clientId: ClientId, nowMs: number): LimiterDecision
  /** Forgets every count, as at the start of a run. */
  reset(): void
}

/** Whether a Limiter keeps one count shared by every Client, or one count per Client (D2). */
export type KeyBy = 'global' | 'client'

/**
 * Fixed window: each key may have `limit` Attempts allowed per window. Windows start at 0,
 * so window k covers [k x windowMs, (k + 1) x windowMs) for every key and every Variant.
 */
export interface FixedWindowSpec {
  readonly algo: 'fixed-window'
  readonly keyBy: KeyBy
  /** Attempts allowed per window, per key: a whole number, 1 or more. */
  readonly limit: number
  /** The window length, in ms. */
  readonly windowMs: number
}

/**
 * Token bucket: each key has a bucket of `capacity` tokens, full at the start, that refills
 * continuously at `refillPerSec` up to `capacity`. An Attempt takes one token, or is rejected
 * when there is not a whole one. A quiet key can spend a full bucket at once, so it allows
 * bursts up to `capacity`.
 */
export interface TokenBucketSpec {
  readonly algo: 'token-bucket'
  readonly keyBy: KeyBy
  /** Tokens the bucket holds, and so the largest burst: a whole number, 1 or more. */
  readonly capacity: number
  /** Tokens added per second, more than 0: the long-run rate allowed. */
  readonly refillPerSec: number
}

/**
 * Sliding window counter: each key may have about `limit` Attempts allowed per window-length,
 * estimated from two fixed windows (the same edges as fixed window). `e` ms into a window, the
 * estimate is prev x (1 - e / windowMs) + curr: all of this window's count, and the part of
 * the previous window's count that still overlaps, as if its Attempts were spread evenly. An
 * Attempt is allowed when the estimate plus it is `limit` or less.
 */
export interface SlidingCounterSpec {
  readonly algo: 'sliding-counter'
  readonly keyBy: KeyBy
  /** Attempts allowed per window-length, per key: a whole number, 1 or more. */
  readonly limit: number
  /** The window length, in ms. */
  readonly windowMs: number
}

/** What a Variant's Limiter is built from. Each algorithm adds its own member. */
export type LimiterSpec = FixedWindowSpec | TokenBucketSpec | SlidingCounterSpec

/** The key an Attempt from `clientId` counts against: its Client, or one key for all. */
function keyFor(keyBy: KeyBy, clientId: ClientId): string {
  return keyBy === 'client' ? clientId : ''
}

/** Creates the Limiter `spec` describes. */
export function createLimiter(spec: LimiterSpec): Limiter {
  switch (spec.algo) {
    case 'fixed-window':
      return createFixedWindow(spec)
    case 'token-bucket':
      return createTokenBucket(spec)
    case 'sliding-counter':
      return createSlidingCounter(spec)
  }
}

function createFixedWindow(spec: FixedWindowSpec): Limiter {
  const { keyBy, limit, windowMs } = spec
  checkWholeNumber(limit, 1, "A fixed window's limit")
  checkPositive(windowMs, "A fixed window's length in ms")
  /** Per key: the window its count belongs to, and the Attempts allowed in it. */
  const counts = new Map<string, { window: number; allowed: number }>()
  return {
    decide(clientId, nowMs) {
      const window = bucketAt(nowMs, windowMs)
      const key = keyFor(keyBy, clientId)
      let entry = counts.get(key)
      if (entry === undefined) {
        entry = { window, allowed: 0 }
        counts.set(key, entry)
      } else if (entry.window !== window) {
        entry.window = window
        entry.allowed = 0
      }
      if (entry.allowed >= limit) {
        return { kind: 'reject', retryAfterMs: bucketStart(window + 1, windowMs) - nowMs }
      }
      entry.allowed++
      return { kind: 'allow' }
    },
    reset() {
      counts.clear()
    },
  }
}

function createTokenBucket(spec: TokenBucketSpec): Limiter {
  const { keyBy, capacity, refillPerSec } = spec
  checkWholeNumber(capacity, 1, "A token bucket's capacity")
  checkPositive(refillPerSec, "A token bucket's refill rate in tokens per second")
  /** How long one token takes to come back, in ms. */
  const tokenMs = 1000 / refillPerSec
  /**
   * Per key, the time its bucket will be full again, in ms. The bucket is kept as this time
   * rather than a token count: at `nowMs` it holds capacity - (fullAt - nowMs) / tokenMs
   * tokens, so it has a whole token when nowMs >= fullAt - (capacity - 1) x tokenMs. Comparing
   * times keeps the retry time exact, where a count would leave 0.9999999 of a token. A key
   * not in the map has a full bucket.
   */
  const fullAt = new Map<string, number>()
  return {
    decide(clientId, nowMs) {
      const key = keyFor(keyBy, clientId)
      const full = Math.max(fullAt.get(key) ?? nowMs, nowMs)
      const tokenAt = full - (capacity - 1) * tokenMs
      if (nowMs < tokenAt) return { kind: 'reject', retryAfterMs: tokenAt - nowMs }
      fullAt.set(key, full + tokenMs)
      return { kind: 'allow' }
    },
    reset() {
      fullAt.clear()
    },
  }
}

function createSlidingCounter(spec: SlidingCounterSpec): Limiter {
  const { keyBy, limit, windowMs } = spec
  checkWholeNumber(limit, 1, "A sliding window counter's limit")
  checkPositive(windowMs, "A sliding window counter's length in ms")
  /** Per key: the window `curr` belongs to, Attempts allowed in it, and in the one before. */
  const counts = new Map<string, { window: number; curr: number; prev: number }>()

  /**
   * The earliest time the next Attempt is allowed, in ms. Solving prev x (1 - e / windowMs) +
   * curr + 1 <= limit for e gives e >= windowMs x (prev - (limit - 1 - curr)) / prev. Kept as a
   * time, like the token bucket, so the decision and the retry time cannot disagree. With
   * `curr` at the limit only the next window has room, where `curr` becomes the previous count.
   */
  function nextAllowedAt(window: number, curr: number, prev: number): number {
    if (curr >= limit) {
      return bucketStart(window + 1, windowMs) + (windowMs * (curr - (limit - 1))) / curr
    }
    const room = limit - 1 - curr
    if (prev <= room) return bucketStart(window, windowMs)
    return bucketStart(window, windowMs) + (windowMs * (prev - room)) / prev
  }

  return {
    decide(clientId, nowMs) {
      const window = bucketAt(nowMs, windowMs)
      const key = keyFor(keyBy, clientId)
      let entry = counts.get(key)
      if (entry === undefined) {
        entry = { window, curr: 0, prev: 0 }
        counts.set(key, entry)
      } else if (entry.window !== window) {
        entry.prev = entry.window === window - 1 ? entry.curr : 0
        entry.window = window
        entry.curr = 0
      }
      const at = nextAllowedAt(window, entry.curr, entry.prev)
      if (nowMs < at) return { kind: 'reject', retryAfterMs: at - nowMs }
      entry.curr++
      return { kind: 'allow' }
    },
    reset() {
      counts.clear()
    },
  }
}
