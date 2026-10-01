/**
 * The Retry Policy: whether and when a Request makes another Attempt after one is rejected,
 * times out or is shed (D11). One policy applies to every Client in a Variant.
 */
import { checkPositive, checkWholeNumber } from './checks.ts'
import type { Failure } from './metrics.ts'
import type { RandomStream } from './rng.ts'

/** What every Retry Policy has. */
interface RetryPolicyBase {
  /** How long a caller waits for each Attempt before giving up on it, in ms. More than 0. */
  readonly timeoutMs: number
  /** The most Attempts one Request may make, the first included. A whole number, 1 or more. */
  readonly maxAttempts: number
}

/** One Variant's Retry Policy. Each mode that waits has its own base delay. */
export type RetryPolicy =
  | (RetryPolicyBase & {
      /** 'none' never retries; 'immediate' retries at once, with no wait. */
      readonly retry: 'none' | 'immediate'
    })
  | (RetryPolicyBase & {
      /**
       * 'backoff' waits base x 2^(n - 1) after Attempt n fails, so each wait doubles.
       * 'backoff-jitter' waits a random time from 0 up to that backoff, so callers that failed
       * together do not all come back together. 'retry-after' waits as long as the Limiter's
       * Reject says, and backs off with jitter when it says nothing (a timeout or a Shed).
       */
      readonly retry: 'backoff' | 'backoff-jitter' | 'retry-after'
      /** The first retry's backoff, in ms. More than 0. */
      readonly baseDelayMs: number
    })

/** What the Retry Policy is told about the Attempt that failed. */
export interface FailedAttempt {
  /** The failed Attempt's number, 1 for a Request's first. */
  readonly attemptNo: number
  readonly failure: Failure
  /** When the Limiter's Reject said to try again, in ms from now, if it said. */
  readonly retryAfterMs?: number
}

/** Throws a RangeError if the policy is invalid. */
export function checkRetryPolicy(policy: RetryPolicy): void {
  checkPositive(policy.timeoutMs, 'The timeout in ms')
  checkWholeNumber(policy.maxAttempts, 1, 'The most Attempts per Request')
  switch (policy.retry) {
    case 'none':
    case 'immediate':
      return
    case 'backoff':
    case 'backoff-jitter':
    case 'retry-after':
      checkPositive(policy.baseDelayMs, 'The base delay in ms')
      return
    default:
      throw new RangeError(
        `Unknown retry mode, got ${String((policy as { retry: unknown }).retry)}`,
      )
  }
}

/**
 * How long after `failed` the next Attempt starts, in ms, or null when the Request gives up.
 * Draws from `jitter` only for a retry that jitters, so a run that gives up or waits a fixed
 * time never shifts the stream.
 */
export function retryDelayMs(
  policy: RetryPolicy,
  failed: FailedAttempt,
  jitter: RandomStream,
): number | null {
  if (failed.attemptNo >= policy.maxAttempts) return null
  switch (policy.retry) {
    case 'none':
      return null
    case 'immediate':
      return 0
    case 'backoff':
      return backoffMs(policy.baseDelayMs, failed.attemptNo)
    case 'retry-after':
      // Only a Reject can carry a retry time; after a timeout or a Shed, back off with jitter.
      if (failed.retryAfterMs !== undefined) return failed.retryAfterMs
      return jitteredMs(policy.baseDelayMs, failed.attemptNo, jitter)
    case 'backoff-jitter':
      return jitteredMs(policy.baseDelayMs, failed.attemptNo, jitter)
  }
}

/** The wait after Attempt `attemptNo` fails: the base delay, doubled for each Attempt before. */
function backoffMs(baseDelayMs: number, attemptNo: number): number {
  return baseDelayMs * 2 ** (attemptNo - 1)
}

/** Full jitter: a random wait from 0 up to the backoff, one draw from `jitter`. */
function jitteredMs(baseDelayMs: number, attemptNo: number, jitter: RandomStream): number {
  return jitter.next() * backoffMs(baseDelayMs, attemptNo)
}
