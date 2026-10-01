/**
 * The Retry Policy dropdown's options and what switching between them does, worked out without
 * React so it is tested on its own (.scratch/controls/spec.md decision 6).
 */
import type { RetryPolicy } from '../../sim/index.ts'
import type { Scenario } from '../../runner/scenario.ts'

export type RetryMode = RetryPolicy['retry']

/** Each mode with the plain name the dropdown shows, in the order it lists them. */
export const RETRY_MODES: readonly { readonly mode: RetryMode; readonly name: string }[] = [
  { mode: 'none', name: 'No retry' },
  { mode: 'immediate', name: 'Retry at once' },
  { mode: 'backoff', name: 'Back off' },
  { mode: 'backoff-jitter', name: 'Back off with jitter' },
  { mode: 'retry-after', name: 'Wait for Retry-After' },
]

/**
 * The most Attempts a Request gets when a student switches from a policy allowing only 1 to one
 * that retries: with 1, retrying would change nothing, and the lesson would be invisible.
 */
export const DEFAULT_RETRY_ATTEMPTS = 3

/** The first backoff, in ms, for a mode that waits when the old policy had no base delay. */
export const DEFAULT_BASE_DELAY_MS = 100

/**
 * `policy` switched to `mode`, keeping its timeout, its Attempts (DEFAULT_RETRY_ATTEMPTS when
 * it allowed 1 and the new mode retries) and its base delay (DEFAULT_BASE_DELAY_MS when the new
 * mode waits and it had none). Always a valid policy.
 */
export function withRetryMode(policy: RetryPolicy, mode: RetryMode): RetryPolicy {
  const { timeoutMs } = policy
  if (mode === 'none') return { timeoutMs, maxAttempts: policy.maxAttempts, retry: 'none' }
  const maxAttempts = policy.maxAttempts > 1 ? policy.maxAttempts : DEFAULT_RETRY_ATTEMPTS
  if (mode === 'immediate') return { timeoutMs, maxAttempts, retry: 'immediate' }
  const baseDelayMs = 'baseDelayMs' in policy ? policy.baseDelayMs : DEFAULT_BASE_DELAY_MS
  return { timeoutMs, maxAttempts, retry: mode, baseDelayMs }
}

/** `scenario` with Variant `index` given `retry`; every other Variant is left as it was. */
export function withVariantRetry(scenario: Scenario, index: number, retry: RetryPolicy): Scenario {
  return {
    ...scenario,
    variants: scenario.variants.map((variant, i) =>
      i === index ? { ...variant, retry } : variant,
    ),
  }
}
