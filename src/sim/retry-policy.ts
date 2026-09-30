/**
 * The Retry Policy: whether and when a Request makes another Attempt after one is rejected,
 * times out or is shed (D11). One policy applies to every Client in a Variant.
 *
 * Only 'none' and 'immediate' exist so far; RS-12 adds backoff, jitter and Retry-After.
 */
import { checkPositive, checkWholeNumber } from './checks.ts'

/** One Variant's Retry Policy. */
export interface RetryPolicy {
  /** How long a caller waits for each Attempt before giving up on it, in ms. More than 0. */
  readonly timeoutMs: number
  /** 'none' never retries; 'immediate' retries at once, with no wait. */
  readonly retry: 'none' | 'immediate'
  /** The most Attempts one Request may make, the first included. A whole number, 1 or more. */
  readonly maxAttempts: number
}

/** Throws a RangeError if the policy is invalid. */
export function checkRetryPolicy(policy: RetryPolicy): void {
  checkPositive(policy.timeoutMs, 'The timeout in ms')
  checkWholeNumber(policy.maxAttempts, 1, 'The most Attempts per Request')
  if (policy.retry !== 'none' && policy.retry !== 'immediate') {
    throw new RangeError(`Unknown retry mode, got ${String(policy.retry)}`)
  }
}

/**
 * How long after a failed Attempt the next one starts, in ms, or null when the Request gives
 * up. `attemptNo` is the failed Attempt's number, 1 for the first.
 */
export function retryDelayMs(policy: RetryPolicy, attemptNo: number): number | null {
  if (policy.retry === 'none' || attemptNo >= policy.maxAttempts) return null
  return 0
}
