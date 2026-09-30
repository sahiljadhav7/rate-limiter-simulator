import { describe, expect, it } from 'vitest'
import { createRandomStream, type RandomStream } from '../src/sim/rng.ts'
import {
  checkTrafficSpec,
  clientShares,
  gapWork,
  pickClient,
  rateProfile,
  timeToWork,
  unitExponential,
  workBetween,
  type TrafficSpec,
} from '../src/sim/traffic.ts'

/** A stream that fails the test if anything draws from it. */
const noDraws: RandomStream = {
  next() {
    throw new Error('drew from a stream that must not be used')
  },
}

/**
 * Arrival times up to `untilMs` for a fixed spec, built from the public pieces the traffic
 * source uses: draw a gap's work, then find where the rate over time reaches it.
 */
function arrivalTimes(spec: TrafficSpec, stream: RandomStream, untilMs: number): number[] {
  const profile = rateProfile(spec)
  const times: number[] = []
  let fromMs = 0
  for (;;) {
    const atMs = timeToWork(profile, fromMs, gapWork(spec.shape, stream))
    if (atMs > untilMs) return times
    times.push(atMs)
    fromMs = atMs
  }
}

/**
 * Arrivals with their Client, in the source's draw order: the gap's work when the arrival is
 * scheduled, then the Client pick when it is emitted.
 */
function arrivals(
  spec: TrafficSpec,
  stream: RandomStream,
  untilMs: number,
): { atMs: number; clientId: string }[] {
  const profile = rateProfile(spec)
  const clientsByShare = clientShares(spec.clients, spec.greedy)
  const result: { atMs: number; clientId: string }[] = []
  let fromMs = 0
  for (;;) {
    const atMs = timeToWork(profile, fromMs, gapWork(spec.shape, stream))
    if (atMs > untilMs) return result
    result.push({ atMs, clientId: pickClient(clientsByShare, stream) })
    fromMs = atMs
  }
}

/** Each Client's share of the arrivals. */
function shares(list: { clientId: string }[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const { clientId } of list) counts[clientId] = (counts[clientId] ?? 0) + 1
  return Object.fromEntries(Object.entries(counts).map(([id, n]) => [id, n / list.length]))
}

/** The gaps between consecutive times. */
function gaps(times: number[]): number[] {
  return times.slice(1).map((t, i) => t - (times[i] ?? 0))
}

/** A stream that replays fixed values, for edge cases a real stream would take ages to hit. */
function fixedStream(values: number[]): RandomStream {
  let i = 0
  return {
    next() {
      const value = values[i++ % values.length]
      if (value === undefined) throw new Error('fixedStream needs at least one value')
      return value
    },
  }
}

describe('unitExponential', () => {
  // A stream can return exactly 0. -log(0) is Infinity, which would put an arrival at the end
  // of time; -log(1 - 0) is 0, a real (if unlikely) gap of zero.
  it('returns 0 for a draw of exactly 0, never Infinity or NaN', () => {
    expect(unitExponential(fixedStream([0]))).toBe(0)
  })

  it('returns -ln(1 - u) for a draw u', () => {
    expect(unitExponential(fixedStream([0.5]))).toBeCloseTo(Math.LN2, 15)
    expect(unitExponential(fixedStream([0.75]))).toBeCloseTo(Math.log(4), 15)
  })

  // A unit exponential has mean 1 and standard deviation 1, so the mean of 1,000,000 draws has
  // a standard error of 0.001. The +/- 0.005 band is 5 standard errors.
  it('has mean 1 over a million draws and is always finite', () => {
    const stream = createRandomStream(20260930)
    let sum = 0
    for (let i = 0; i < 1_000_000; i++) {
      const value = unitExponential(stream)
      expect(Number.isFinite(value)).toBe(true)
      sum += value
    }
    expect(Math.abs(sum / 1_000_000 - 1)).toBeLessThan(0.005)
  })
})

describe('constant traffic', () => {
  const spec = (demandRps: number): TrafficSpec => ({
    shape: 'constant',
    demandRps,
    clients: ['a'],
  })

  it('spaces arrivals exactly 1000 / Demand ms apart, the first one gap after t = 0', () => {
    const times = arrivalTimes(spec(40), noDraws, 200)
    expect(times).toEqual([25, 50, 75, 100, 125, 150, 175, 200])
  })

  // T is off an arrival time on purpose: 60.5 s x 30 rps lands exactly on the 1,815th arrival,
  // and whether it counts would be decided by float rounding in the sum of gaps.
  it('gives floor(T x Demand) arrivals over T seconds, without drawing from the stream', () => {
    const times = arrivalTimes(spec(30), noDraws, 60_510)
    expect(times).toHaveLength(Math.floor(60.51 * 30))
    for (const gap of gaps(times)) expect(gap).toBeCloseTo(1000 / 30, 9)
  })
})

describe('Poisson traffic', () => {
  const spec: TrafficSpec = { shape: 'poisson', demandRps: 200, clients: ['a'] }
  const times = arrivalTimes(spec, createRandomStream(4101), 120_000)

  // 120 s at 200 rps expects n = 24,000 arrivals, and a Poisson count has standard error
  // sqrt(n) = 155. The 3 percent band (720) is about 4.6 standard errors.
  it('arrives at Demand on average over a long fixed-seed run', () => {
    expect(Math.abs(times.length - 24_000)).toBeLessThan(720)
  })

  // The mean gap is 5 ms with standard deviation 5 ms, so over 24,000 gaps its standard error
  // is 5 / sqrt(24,000) = 0.032 ms. The +/- 0.15 ms band is about 4.7 standard errors.
  it('has a mean gap of 1000 / Demand ms', () => {
    const all = gaps(times)
    const mean = all.reduce((sum, gap) => sum + gap, 0) / all.length
    expect(Math.abs(mean - 5)).toBeLessThan(0.15)
  })

  // Exponential gaps have a coefficient of variation (standard deviation / mean) of 1;
  // constant traffic has 0. Over 24,000 gaps the sample value has a standard error of about
  // 0.01, so the +/- 0.05 band is about 5 standard errors. This checks the shape of the
  // gaps, not only their mean.
  it('has gaps with a coefficient of variation of 1, as exponential gaps do', () => {
    const all = gaps(times)
    const mean = all.reduce((sum, gap) => sum + gap, 0) / all.length
    const variance = all.reduce((sum, gap) => sum + (gap - mean) ** 2, 0) / all.length
    expect(Math.abs(Math.sqrt(variance) / mean - 1)).toBeLessThan(0.05)
  })
})

describe('bursty traffic', () => {
  // On for 200 ms, off for 800 ms: the on rate is 100 x 1000 / 200 = 500 rps, so the mean over
  // whole cycles is Demand (100 rps).
  const spec: TrafficSpec = {
    shape: 'bursty',
    demandRps: 100,
    clients: ['a'],
    bursty: { onMs: 200, offMs: 800 },
  }
  const times = arrivalTimes(spec, createRandomStream(5150), 240_000)

  it('never arrives inside an off phase (phases start with on at t = 0)', () => {
    const inOff = times.filter((t) => t % 1000 > 200)
    expect(inOff).toEqual([])
  })

  // 240 whole cycles expect n = 24,000 arrivals, standard error sqrt(n) = 155. The 3 percent
  // band (720) is about 4.6 standard errors.
  it('averages Demand over whole on/off cycles', () => {
    expect(Math.abs(times.length - 24_000)).toBeLessThan(720)
  })

  // With no off phase the on rate is Demand itself, so the same seed must give exactly the
  // Poisson run.
  it('is Poisson at Demand when the off phase is 0 ms', () => {
    const alwaysOn = { ...spec, bursty: { onMs: 300, offMs: 0 } }
    const poisson = { ...spec, shape: 'poisson' as const }
    expect(arrivalTimes(alwaysOn, createRandomStream(7), 10_000)).toEqual(
      arrivalTimes(poisson, createRandomStream(7), 10_000),
    )
  })
})

describe('Demand of 0', () => {
  const spec: TrafficSpec = { shape: 'poisson', demandRps: 0, clients: ['a'] }

  it('never arrives: the next arrival is at Infinity, not NaN', () => {
    expect(timeToWork(rateProfile(spec), 500, 1)).toBe(Number.POSITIVE_INFINITY)
    const bursty = { ...spec, shape: 'bursty' as const, bursty: { onMs: 100, offMs: 100 } }
    expect(timeToWork(rateProfile(bursty), 500, 1)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('checkTrafficSpec', () => {
  const valid: TrafficSpec = { shape: 'poisson', demandRps: 50, clients: ['a'] }

  it('accepts a valid spec, including Demand 0 and an off phase of 0 ms', () => {
    expect(() => checkTrafficSpec(valid)).not.toThrow()
    expect(() => checkTrafficSpec({ ...valid, demandRps: 0 })).not.toThrow()
    const alwaysOn = { ...valid, shape: 'bursty' as const, bursty: { onMs: 10, offMs: 0 } }
    expect(() => checkTrafficSpec(alwaysOn)).not.toThrow()
  })

  it.each([
    ['negative Demand', { ...valid, demandRps: -1 }],
    ['NaN Demand', { ...valid, demandRps: Number.NaN }],
    ['infinite Demand', { ...valid, demandRps: Number.POSITIVE_INFINITY }],
    ['bursty without phases', { ...valid, shape: 'bursty' as const }],
    ['an on phase of 0 ms', { ...valid, shape: 'bursty' as const, bursty: { onMs: 0, offMs: 5 } }],
    ['a negative off phase', { ...valid, bursty: { onMs: 5, offMs: -1 } }],
    ['an infinite on phase', { ...valid, bursty: { onMs: Infinity, offMs: 5 } }],
  ])('rejects %s', (_name, spec) => {
    expect(() => checkTrafficSpec(spec)).toThrow(RangeError)
  })
})

describe('Client assignment', () => {
  const four: TrafficSpec = { shape: 'poisson', demandRps: 200, clients: ['a', 'b', 'c', 'd'] }
  const greedy: TrafficSpec = { ...four, greedy: { clientId: 'b', multiplier: 5 } }

  // 24,000 arrivals; a share p has standard error sqrt(p(1 - p) / 24,000). For p = 1/4 that is
  // 0.0028, and the +/- 0.012 band is about 4.3 standard errors.
  it('gives every Client an equal share when none is greedy', () => {
    const result = shares(arrivals(four, createRandomStream(3), 120_000))
    for (const id of four.clients) expect(Math.abs((result[id] ?? 0) - 0.25)).toBeLessThan(0.012)
  })

  // Weights 1, 5, 1, 1: the greedy Client's share is 5 / 8 (standard error 0.0031, band 0.013,
  // about 4.2) and each other Client's is 1 / 8 (standard error 0.0021, band 0.009, about 4.2).
  it('gives the greedy Client multiplier shares of Demand and the others 1 share each', () => {
    const result = shares(arrivals(greedy, createRandomStream(3), 120_000))
    expect(Math.abs((result['b'] ?? 0) - 5 / 8)).toBeLessThan(0.013)
    for (const id of ['a', 'c', 'd'])
      expect(Math.abs((result[id] ?? 0) - 1 / 8)).toBeLessThan(0.009)
  })

  // Demand is the total (spec decision 1), and the pick spends one draw per arrival whatever
  // the Clients, so the arrival times are identical, not just close.
  it('leaves every arrival time unchanged by a greedy Client or a different number of Clients', () => {
    const times = (spec: TrafficSpec) =>
      arrivals(spec, createRandomStream(3), 20_000).map((a) => a.atMs)
    const plain = times(four)
    expect(times(greedy)).toEqual(plain)
    expect(times({ ...four, clients: ['solo'] })).toEqual(plain)
  })

  it('picks by listed order, so reordering the Clients changes who gets which arrival', () => {
    const pick = (spec: TrafficSpec) =>
      arrivals(spec, createRandomStream(3), 2_000).map((a) => a.clientId)
    expect(pick({ ...four, clients: ['d', 'c', 'b', 'a'] })).not.toEqual(pick(four))
  })

  it('maps a draw to the Client whose stretch of cumulative weight contains it', () => {
    const shares = [
      { clientId: 'a', weight: 1 },
      { clientId: 'b', weight: 2 },
      { clientId: 'c', weight: 1 },
    ]
    // Cumulative weights 1, 3, 4 out of 4: a covers [0, 0.25), b [0.25, 0.75), c [0.75, 1).
    expect(pickClient(shares, fixedStream([0]))).toBe('a')
    expect(pickClient(shares, fixedStream([0.2499]))).toBe('a')
    expect(pickClient(shares, fixedStream([0.25]))).toBe('b')
    expect(pickClient(shares, fixedStream([0.7499]))).toBe('b')
    expect(pickClient(shares, fixedStream([0.75]))).toBe('c')
    expect(pickClient(shares, fixedStream([0.999999]))).toBe('c')
  })

  it.each([
    ['no Clients', { ...four, clients: [] }],
    ['a duplicate Client', { ...four, clients: ['a', 'b', 'a'] }],
    ['a greedy Client that is not listed', { ...four, greedy: { clientId: 'z', multiplier: 2 } }],
    ['a greedy multiplier of 0', { ...four, greedy: { clientId: 'a', multiplier: 0 } }],
    ['a NaN greedy multiplier', { ...four, greedy: { clientId: 'a', multiplier: Number.NaN } }],
  ])('rejects %s', (_name, spec) => {
    expect(() => checkTrafficSpec(spec)).toThrow(RangeError)
  })
})

describe('bursty phase edges', () => {
  // Found in review: with a fractional anchor (a shape switch anchors phases at the frame
  // time), start + period and anchor + (cycle + 1) x period rounded differently, so a walk
  // that landed on the edge got a stretch of zero length and looped forever. Each case is a
  // real edge where the two expressions differed; the walk starts in the off phase before it.
  it.each([
    [81681.79523199797, 92.58274980727583, 47.39661181718111, 12817284.074548338],
    [66058.31286869943, 63.85335463471711, 78.52392508555204, 11715652.094140563],
    [170586.23675256968, 71.36617593839765, 22.286837034858763, 9151348.262810018],
  ])('walks past the edge at anchor %s', (anchorMs, onMs, offMs, edgeMs) => {
    const profile = { demandRps: 10, phases: { onMs, offMs }, phaseAnchorMs: anchorMs, burst: null }
    const fromMs = edgeMs - offMs / 2
    // Half a unit of work at the on rate, Demand x (on + off) / on, starting at the edge.
    const expected = edgeMs + (0.5 * 1000 * onMs) / (10 * (onMs + offMs))
    expect(timeToWork(profile, fromMs, 0.5)).toBeCloseTo(expected, 6)
    expect(workBetween(profile, fromMs, edgeMs + 1)).toBeGreaterThan(0)
  })

  // The same walk over thousands of edges with random fractional anchors and phase lengths, far
  // from t = 0 where rounding is coarsest. A regression here hangs rather than fails, so the
  // walk counts steps and gives up loudly.
  it('always moves forward across edges with fractional anchors', () => {
    const rng = createRandomStream(20260930)
    for (let i = 0; i < 2_000; i++) {
      const phases = { onMs: 1 + rng.next() * 100, offMs: 1 + rng.next() * 100 }
      const anchorMs = rng.next() * 200_000
      const profile = { demandRps: 50, phases, phaseAnchorMs: anchorMs, burst: null }
      let t = anchorMs + Math.floor(rng.next() * 100_000) * (phases.onMs + phases.offMs)
      for (let step = 0; step < 20; step++) {
        const next = timeToWork(profile, t, rng.next() * 3)
        expect(next).toBeGreaterThanOrEqual(t)
        t = next
      }
    }
  })
})
