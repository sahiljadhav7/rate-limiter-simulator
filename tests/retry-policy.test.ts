import { describe, expect, it } from 'vitest'
import { checkRetryPolicy, retryDelayMs, type RetryPolicy } from '../src/sim/retry-policy.ts'
import { createRandomStream } from '../src/sim/rng.ts'
import { countingStream, fixedStream } from './streams.ts'

describe('no retry and immediate retry', () => {
  it('none gives up after the first failure', () => {
    const policy: RetryPolicy = { timeoutMs: 1000, maxAttempts: 3, retry: 'none' }
    expect(retryDelayMs(policy, { attemptNo: 1, failure: 'rejected' }, countingStream())).toBeNull()
  })

  it('immediate retries after 0 ms until maxAttempts', () => {
    const policy: RetryPolicy = { timeoutMs: 1000, maxAttempts: 3, retry: 'immediate' }
    const delays = [1, 2, 3].map((attemptNo) =>
      retryDelayMs(policy, { attemptNo, failure: 'timedOut' }, countingStream()),
    )
    expect(delays).toEqual([0, 0, null])
  })

  it.each(['none', 'immediate'] as const)('%s never draws jitter', (retry) => {
    const jitter = countingStream()
    for (const failure of ['rejected', 'timedOut', 'shed'] as const) {
      retryDelayMs({ timeoutMs: 1000, maxAttempts: 3, retry }, { attemptNo: 1, failure }, jitter)
    }
    expect(jitter.draws).toBe(0)
  })
})

describe('backoff', () => {
  const policy: RetryPolicy = {
    timeoutMs: 1000,
    maxAttempts: 5,
    retry: 'backoff',
    baseDelayMs: 100,
  }

  it('doubles the wait after each failed Attempt, from the base delay, and gives up at maxAttempts', () => {
    const delays = [1, 2, 3, 4, 5].map((attemptNo) =>
      retryDelayMs(policy, { attemptNo, failure: 'rejected' }, countingStream()),
    )
    expect(delays).toEqual([100, 200, 400, 800, null])
  })

  it('never draws jitter', () => {
    const jitter = countingStream()
    for (const attemptNo of [1, 2, 3]) retryDelayMs(policy, { attemptNo, failure: 'shed' }, jitter)
    expect(jitter.draws).toBe(0)
  })
})

describe('backoff with jitter', () => {
  const policy: RetryPolicy = {
    timeoutMs: 1000,
    maxAttempts: 4,
    retry: 'backoff-jitter',
    baseDelayMs: 100,
  }

  it('waits the draw times the backoff, so anywhere from 0 up to it (full jitter)', () => {
    const half = [1, 2, 3].map((attemptNo) =>
      retryDelayMs(policy, { attemptNo, failure: 'timedOut' }, fixedStream([0.5])),
    )
    expect(half).toEqual([50, 100, 200])
    expect(retryDelayMs(policy, { attemptNo: 3, failure: 'shed' }, fixedStream([0]))).toBe(0)
  })

  it('draws once per retry, and not at all when the Request gives up', () => {
    const jitter = countingStream()
    for (const attemptNo of [1, 2, 3])
      retryDelayMs(policy, { attemptNo, failure: 'rejected' }, jitter)
    expect(jitter.draws).toBe(3)
    expect(retryDelayMs(policy, { attemptNo: 4, failure: 'rejected' }, jitter)).toBeNull()
    expect(jitter.draws).toBe(3)
  })

  // After Attempt 3 the backoff is 400 ms, so waits are uniform on [0, 400): mean 200 ms,
  // standard deviation 400 / sqrt(12) = 115.5 ms. Over 100,000 waits the mean's standard error
  // is 0.37 ms, and the +/- 2 ms band is about 5.5 standard errors.
  it('spreads waits evenly from 0 up to the backoff: mean half the backoff over 100,000 waits', () => {
    const jitter = createRandomStream(20261001)
    let sum = 0
    let outside = 0
    for (let i = 0; i < 100_000; i++) {
      const delay = retryDelayMs(policy, { attemptNo: 3, failure: 'timedOut' }, jitter) ?? NaN
      // One expect per wait costs seconds; count the ones outside [0, 400) and assert once.
      if (!(delay >= 0 && delay < 400)) outside++
      sum += delay
    }
    expect(outside).toBe(0)
    expect(Math.abs(sum / 100_000 - 200)).toBeLessThan(2)
  })
})

describe('Retry-After', () => {
  const policy: RetryPolicy = {
    timeoutMs: 1000,
    maxAttempts: 4,
    retry: 'retry-after',
    baseDelayMs: 100,
  }

  it("waits exactly as long as the Limiter's Reject says, whatever the Attempt, without a draw", () => {
    const jitter = countingStream()
    for (const attemptNo of [1, 2, 3]) {
      const failed = { attemptNo, failure: 'rejected', retryAfterMs: 250 } as const
      expect(retryDelayMs(policy, failed, jitter)).toBe(250)
    }
    expect(jitter.draws).toBe(0)
  })

  it.each([
    ['a timeout', { failure: 'timedOut' }],
    ['a Shed', { failure: 'shed' }],
    ['a Reject without a retry time', { failure: 'rejected' }],
  ] as const)('backs off with jitter after %s, which says nothing', (_, { failure }) => {
    const jitter = countingStream(0.5)
    expect(retryDelayMs(policy, { attemptNo: 1, failure }, jitter)).toBe(50)
    expect(retryDelayMs(policy, { attemptNo: 3, failure }, jitter)).toBe(200)
    expect(jitter.draws).toBe(2)
  })

  it('still gives up at maxAttempts, even with a retry time', () => {
    const failed = { attemptNo: 4, failure: 'rejected', retryAfterMs: 250 } as const
    expect(retryDelayMs(policy, failed, countingStream())).toBeNull()
  })
})

describe('checking a policy', () => {
  const base = { timeoutMs: 1000, maxAttempts: 3 }

  it.each(['backoff', 'backoff-jitter', 'retry-after'] as const)(
    'accepts %s with a base delay',
    (retry) => {
      expect(() => checkRetryPolicy({ ...base, retry, baseDelayMs: 100 })).not.toThrow()
    },
  )

  it.each<[string, unknown]>([
    ['a missing base delay', { ...base, retry: 'backoff' }],
    ['a base delay of 0', { ...base, retry: 'backoff-jitter', baseDelayMs: 0 }],
    ['a NaN base delay', { ...base, retry: 'retry-after', baseDelayMs: NaN }],
    ['an infinite base delay', { ...base, retry: 'backoff', baseDelayMs: Infinity }],
    ['an unknown mode', { ...base, retry: 'sometimes' }],
  ])('throws a RangeError for %s', (_, policy) => {
    expect(() => checkRetryPolicy(policy as RetryPolicy)).toThrow(RangeError)
  })
})
