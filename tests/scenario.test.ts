import { describe, expect, it } from 'vitest'
import { checkScenario, subBucketMsFor, type Scenario } from '../src/runner/scenario.ts'

const scenario: Scenario = {
  id: 'scenario-test',
  title: 'Scenario test',
  lesson: 'Watch the two Limiters pace the same traffic differently.',
  why: 'The counter resets at the edge, so a burst on either side gets two windows of room.',
  models: 'One global Limiter in front of one Backend.',
  leavesOut: 'Network latency and more than one Limiter node.',
  seed: 7,
  traffic: { shape: 'poisson', demandRps: 20, clients: ['a', 'b'] },
  controls: [
    { atMs: 2000, change: { kind: 'demand', demandRps: 40 } },
    { atMs: 4000, change: { kind: 'burst', multiplier: 2, durationMs: 1000 } },
  ],
  scriptedArrivals: [{ atMs: 990, count: 10, clientId: 'b' }],
  backend: { slots: 4, queueLimit: 10, meanMs: 50, cv: 1 },
  variants: [
    {
      label: 'Token bucket',
      limiter: { algo: 'token-bucket', keyBy: 'global', capacity: 10, refillPerSec: 10 },
      retry: { timeoutMs: 500, maxAttempts: 1, retry: 'none' },
    },
    {
      label: 'Sliding counter',
      limiter: { algo: 'sliding-counter', keyBy: 'global', limit: 10, windowMs: 1000 },
      retry: { timeoutMs: 500, maxAttempts: 3, retry: 'backoff-jitter', baseDelayMs: 100 },
    },
  ],
}

const variant = scenario.variants[0] as Scenario['variants'][number]

describe('checkScenario', () => {
  it('accepts a valid two-Variant Scenario', () => {
    expect(() => checkScenario(scenario)).not.toThrow()
  })

  it('accepts one and three Variants', () => {
    expect(() => checkScenario({ ...scenario, variants: [variant] })).not.toThrow()
    const three = ['A', 'B', 'C'].map((label) => ({ ...variant, label }))
    expect(() => checkScenario({ ...scenario, variants: three })).not.toThrow()
  })

  const invalid: [string, Scenario][] = [
    ['no Variants', { ...scenario, variants: [] }],
    [
      'more than 3 Variants',
      { ...scenario, variants: ['A', 'B', 'C', 'D'].map((label) => ({ ...variant, label })) },
    ],
    ['duplicate Variant labels', { ...scenario, variants: [variant, { ...variant }] }],
    ['an invalid seed', { ...scenario, seed: -1 }],
    ['an invalid traffic spec', { ...scenario, traffic: { ...scenario.traffic, clients: [] } }],
    [
      'an invalid Limiter',
      {
        ...scenario,
        variants: [
          variant,
          {
            ...variant,
            label: 'B',
            limiter: { algo: 'sliding-counter', keyBy: 'global', limit: 0, windowMs: 1000 },
          },
        ],
      },
    ],
    [
      'an invalid Retry Policy',
      {
        ...scenario,
        variants: [
          variant,
          { ...variant, label: 'B', retry: { timeoutMs: 500, maxAttempts: 0, retry: 'none' } },
        ],
      },
    ],
    ['an invalid Backend', { ...scenario, backend: { ...scenario.backend, slots: 0 } }],
    [
      'controls out of time order',
      {
        ...scenario,
        controls: [
          { atMs: 4000, change: { kind: 'demand', demandRps: 40 } },
          { atMs: 2000, change: { kind: 'demand', demandRps: 30 } },
        ],
      },
    ],
    [
      'an invalid control',
      { ...scenario, controls: [{ atMs: 1000, change: { kind: 'demand', demandRps: -5 } }] },
    ],
    [
      'a scripted arrival at a negative time',
      { ...scenario, scriptedArrivals: [{ atMs: -1, count: 10 }] },
    ],
    [
      'a scripted arrival for a Client not in the traffic spec',
      { ...scenario, scriptedArrivals: [{ atMs: 990, count: 10, clientId: 'z' }] },
    ],
  ]

  it.each(invalid)('throws a RangeError for %s', (_, bad) => {
    expect(() => checkScenario(bad)).toThrow(RangeError)
  })
})

describe('subBucketMsFor', () => {
  it('is a tenth of the window for sliding counter', () => {
    expect(
      subBucketMsFor({ algo: 'sliding-counter', keyBy: 'global', limit: 5, windowMs: 1000 }),
    ).toBe(100)
    expect(
      subBucketMsFor({ algo: 'sliding-counter', keyBy: 'client', limit: 5, windowMs: 500 }),
    ).toBe(50)
  })

  it('is a tenth of a window that is not a whole number of ms', () => {
    expect(
      subBucketMsFor({ algo: 'sliding-counter', keyBy: 'global', limit: 5, windowMs: 333 }),
    ).toBe(33.3)
    expect(
      subBucketMsFor({ algo: 'sliding-counter', keyBy: 'global', limit: 5, windowMs: 2.5 }),
    ).toBe(0.25)
  })

  it('is 100 ms for token bucket, which has no window', () => {
    expect(
      subBucketMsFor({ algo: 'token-bucket', keyBy: 'global', capacity: 5, refillPerSec: 10 }),
    ).toBe(100)
  })
})
