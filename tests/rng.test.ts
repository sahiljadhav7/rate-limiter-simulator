import { describe, expect, it } from 'vitest'
import { createRandomStream, createStreams, STREAM_NAMES } from '../src/sim/rng.ts'

function take(stream: { next(): number }, count: number): number[] {
  return Array.from({ length: count }, () => stream.next())
}

describe('createRandomStream (mulberry32)', () => {
  // Computed with the canonical mulberry32 (Tommy Ettinger, as published in bryc/code
  // jshash/PRNGs.md) in plain JavaScript, and cross-checked with an independent Python
  // port. A refactor that changes any sequence fails here.
  it.each([
    [
      0,
      [
        0.26642920868471265, 0.0003297457005828619, 0.2232720274478197, 0.1462021479383111,
        0.46732782293111086,
      ],
    ],
    [
      12345,
      [
        0.9797282677609473, 0.3067522644996643, 0.484205421525985, 0.817934412509203,
        0.5094283693470061,
      ],
    ],
    [
      4294967295,
      [
        0.8964226141106337, 0.189478256739676, 0.7156526781618595, 0.9440599093213677,
        0.8452364315744489,
      ],
    ],
  ])('matches the reference mulberry32 for seed %i', (seed, expected) => {
    expect(take(createRandomStream(seed), 5)).toEqual(expected)
  })

  it('gives the same sequence for the same seed and a different one for a different seed', () => {
    expect(take(createRandomStream(7), 20)).toEqual(take(createRandomStream(7), 20))
    expect(take(createRandomStream(7), 20)).not.toEqual(take(createRandomStream(8), 20))
  })

  // Normalising (truncating, wrapping) would quietly map different seeds to the same run,
  // so a seed that is not a whole number in [0, 2^32 - 1] is rejected instead.
  it.each([-1, 1.5, 4294967296, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects seed %s',
    (seed) => {
      expect(() => createRandomStream(seed)).toThrow(RangeError)
    },
  )
})

describe('uniform output', () => {
  const DRAWS = 1_000_000

  // With a fixed seed, every value is in [0, 1), and the mean and variance of 1,000,000 draws
  // are within tolerance of the uniform distribution's 1/2 and 1/12. For uniform draws the
  // standard error of the mean is sqrt(1/12 / 1e6), about 0.00029, so the +/- 0.002 band is
  // about 7 standard errors. The sample variance has a standard error of about 0.000075, so
  // its +/- 0.001 band is about 13. A correct generator cannot plausibly miss either band,
  // while a biased or truncated one misses by far more.
  it('stays in [0, 1) with mean 1/2 and variance 1/12 over a million draws', () => {
    const stream = createRandomStream(20260930)
    let sum = 0
    let sumOfSquares = 0
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (let i = 0; i < DRAWS; i++) {
      const value = stream.next()
      sum += value
      sumOfSquares += value * value
      min = Math.min(min, value)
      max = Math.max(max, value)
    }
    const mean = sum / DRAWS
    const variance = sumOfSquares / DRAWS - mean * mean
    expect(min).toBeGreaterThanOrEqual(0)
    expect(max).toBeLessThan(1)
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.002)
    expect(Math.abs(variance - 1 / 12)).toBeLessThan(0.001)
  })
})

describe('createStreams', () => {
  // Stream seed = murmur3 fmix32(rootSeed XOR FNV-1a-32(name)), computed with an independent
  // Python port of FNV-1a, fmix32 and mulberry32 (FNV-1a checked against the published
  // vector for "a", 0xe40c292c). A change to the derivation scheme breaks every saved run,
  // so it fails here.
  it.each([
    ['traffic', [0.1042853007093072, 0.30343469604849815, 0.5764341913163662]],
    ['service', [0.9358647293411195, 0.5652950792573392, 0.7777059739455581]],
    ['jitter', [0.2021187620703131, 0.4782103404868394, 0.8758128110785037]],
  ] as const)(
    'derives the %s stream from the root seed by the documented scheme',
    (name, expected) => {
      expect(take(createStreams(42)[name], 3)).toEqual(expected)
    },
  )

  it('has the traffic, service and jitter streams', () => {
    expect([...STREAM_NAMES].sort()).toEqual(['jitter', 'service', 'traffic'])
  })

  it('replays the same streams from the same root seed', () => {
    const first = createStreams(2024)
    const second = createStreams(2024)
    for (const name of STREAM_NAMES) {
      expect(take(first[name], 20)).toEqual(take(second[name], 20))
    }
  })

  it('gives different streams for a different root seed', () => {
    const first = createStreams(2024)
    const second = createStreams(2025)
    for (const name of STREAM_NAMES) {
      expect(take(first[name], 20)).not.toEqual(take(second[name], 20))
    }
  })

  it('gives pairwise different streams from one root seed', () => {
    const streams = createStreams(2024)
    const [traffic, service, jitter] = [streams.traffic, streams.service, streams.jitter].map((s) =>
      take(s, 20),
    )
    expect(traffic).not.toEqual(service)
    expect(traffic).not.toEqual(jitter)
    expect(service).not.toEqual(jitter)
  })

  it('leaves the service and jitter sequences unchanged when traffic draws extra values', () => {
    const untouched = createStreams(99)
    const busy = createStreams(99)
    take(busy.traffic, 1000)
    expect(take(busy.service, 50)).toEqual(take(untouched.service, 50))
    expect(take(busy.jitter, 50)).toEqual(take(untouched.jitter, 50))
  })

  it('rejects an invalid root seed', () => {
    expect(() => createStreams(-1)).toThrow(RangeError)
  })

  it('only offers the named streams, so a typo does not type-check', () => {
    const streams = createStreams(1)
    // @ts-expect-error: 'trafic' is not a stream name
    expect(streams.trafic).toBeUndefined()
  })
})
