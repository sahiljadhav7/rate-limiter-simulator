import { describe, expect, it } from 'vitest'
import { withRetryMode, withVariantRetry } from '../src/ui/controls/retry-options.ts'
import { checkRetryPolicy, type RetryPolicy } from '../src/sim/index.ts'
import { edgeBurstScenario } from '../src/ui/edge-burst-scenario.ts'

const none: RetryPolicy = { timeoutMs: 1000, maxAttempts: 1, retry: 'none' }

describe('withRetryMode', () => {
  it('gives a policy that really retries: 3 Attempts when there was 1, and a base delay to wait', () => {
    expect(withRetryMode(none, 'immediate')).toEqual({
      timeoutMs: 1000,
      maxAttempts: 3,
      retry: 'immediate',
    })
    expect(withRetryMode(none, 'backoff')).toEqual({
      timeoutMs: 1000,
      maxAttempts: 3,
      retry: 'backoff',
      baseDelayMs: 100,
    })
  })

  it('keeps the Attempts and base delay a policy already had', () => {
    const jitter: RetryPolicy = {
      timeoutMs: 400,
      maxAttempts: 5,
      retry: 'backoff-jitter',
      baseDelayMs: 50,
    }
    expect(withRetryMode(jitter, 'retry-after')).toEqual({ ...jitter, retry: 'retry-after' })
    // No retry has no base delay; going back to a waiting mode gets the default again.
    const stopped = withRetryMode(jitter, 'none')
    expect(stopped).toEqual({ timeoutMs: 400, maxAttempts: 5, retry: 'none' })
    expect(withRetryMode(stopped, 'backoff')).toMatchObject({ maxAttempts: 5, baseDelayMs: 100 })
  })

  it('always gives a valid policy', () => {
    const modes = ['none', 'immediate', 'backoff', 'backoff-jitter', 'retry-after'] as const
    for (const from of modes) {
      for (const to of modes) {
        expect(() => checkRetryPolicy(withRetryMode(withRetryMode(none, from), to))).not.toThrow()
      }
    }
  })
})

describe('withVariantRetry', () => {
  it('changes only that Variant', () => {
    const policy = withRetryMode(none, 'immediate')
    const edited = withVariantRetry(edgeBurstScenario, 1, policy)
    expect(edited.variants[1]?.retry).toEqual(policy)
    expect(edited.variants[0]).toBe(edgeBurstScenario.variants[0])
    expect({ ...edited, variants: [] }).toEqual({ ...edgeBurstScenario, variants: [] })
  })
})
