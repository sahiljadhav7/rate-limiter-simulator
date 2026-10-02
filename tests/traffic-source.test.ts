import { describe, expect, it } from 'vitest'
import { createRandomStream } from '../src/sim/rng.ts'
import type { TrafficSpec } from '../src/sim/traffic.ts'
import {
  createTrafficSource,
  type Arrival,
  type ControlChange,
  type ControlEvent,
} from '../src/sim/traffic-source.ts'

const constant: TrafficSpec = { shape: 'constant', demandRps: 40, clients: ['a'] }

/** Every arrival a fresh reader sees up to the source's horizon. */
function readAll(source: ReturnType<typeof createTrafficSource>): Arrival[] {
  return source.reader().read(source.horizonMs())
}

describe('createTrafficSource', () => {
  it('generates every arrival up to and including untilMs, and nothing later', () => {
    const source = createTrafficSource({ spec: constant, stream: createRandomStream(1) })
    source.advanceTo(100)
    expect(readAll(source)).toEqual([
      { requestId: 0, atMs: 25, clientId: 'a', origin: 'generated' },
      { requestId: 1, atMs: 50, clientId: 'a', origin: 'generated' },
      { requestId: 2, atMs: 75, clientId: 'a', origin: 'generated' },
      { requestId: 3, atMs: 100, clientId: 'a', origin: 'generated' },
    ])
    source.advanceTo(124.9)
    expect(readAll(source)).toHaveLength(4)
    expect(source.horizonMs()).toBe(124.9)
  })
})

describe('chunk invariance', () => {
  const clients = ['a', 'b', 'c']
  const specs: [string, TrafficSpec][] = [
    ['constant', { shape: 'constant', demandRps: 37, clients }],
    ['Poisson', { shape: 'poisson', demandRps: 180, clients }],
    [
      'bursty',
      {
        shape: 'bursty',
        demandRps: 90,
        clients,
        greedy: { clientId: 'b', multiplier: 4 },
        bursty: { onMs: 150, offMs: 350 },
      },
    ],
  ]
  const SEEDS = [1, 2, 3, 42, 20260930]
  const UNTIL_MS = 20_000

  /**
   * Advances in random chunks from a separate seeded stream: some land exactly on an arrival
   * time from `landOn`, some are zero-size, the rest random lengths up to 300 ms.
   */
  function chunked(spec: TrafficSpec, seed: number, landOn: number[]): Arrival[] {
    const source = createTrafficSource({ spec, stream: createRandomStream(seed) })
    const chunks = createRandomStream(seed + 1_000_000)
    let t = 0
    while (t < UNTIL_MS) {
      const kind = chunks.next()
      if (kind < 0.2) {
        const exact = landOn.find((at) => at > t)
        t = exact === undefined ? UNTIL_MS : Math.min(exact, UNTIL_MS)
      } else if (kind >= 0.3) {
        t = Math.min(UNTIL_MS, t + chunks.next() * 300)
      }
      source.advanceTo(t)
    }
    return readAll(source)
  }

  // The engine asks for traffic once per frame, and frame lengths depend on the browser. If
  // chunking changed a single arrival, replays would drift with no error.
  it.each(specs)('gives the same %s log in one call or in many random chunks', (_name, spec) => {
    for (const seed of SEEDS) {
      const whole = createTrafficSource({ spec, stream: createRandomStream(seed) })
      whole.advanceTo(UNTIL_MS)
      const expected = readAll(whole)
      expect(expected.length, `seed ${seed}`).toBeGreaterThan(100)
      const landOn = expected.map((a) => a.atMs)
      expect(chunked(spec, seed, landOn), `seed ${seed}`).toEqual(expected)
    }
  })
})

describe('readers', () => {
  const spec: TrafficSpec = { shape: 'poisson', demandRps: 120, clients: ['a', 'b'] }

  // Each Variant's engine reads the shared log at its own pace (a slow Variant can lag a
  // frame). Whatever the pace, every Variant must see the same Requests.
  it('give two and three Variants identical arrivals, read at different paces', () => {
    const source = createTrafficSource({ spec, stream: createRandomStream(8) })
    const readers = [source.reader(), source.reader(), source.reader()]
    const seen: Arrival[][] = [[], [], []]
    const steps = [7, 33.3, 250] // each reader's own step, in ms
    for (let t = 0; t <= 10_000; t += 100) {
      source.advanceTo(t)
      readers.forEach((reader, i) => {
        const done = seen[i] ?? []
        const readTo = done.at(-1)?.atMs ?? 0
        for (let r = readTo; r < t; r = Math.min(t, r + (steps[i] ?? 1)))
          done.push(...reader.read(r))
        done.push(...reader.read(t))
      })
    }
    expect(seen[0]?.length).toBeGreaterThan(1000)
    expect(seen[1]).toEqual(seen[0])
    expect(seen[2]).toEqual(seen[0])
  })

  it('return nothing twice, and nothing past the time asked for', () => {
    const source = createTrafficSource({ spec, stream: createRandomStream(8) })
    source.advanceTo(1000)
    const reader = source.reader()
    const first = reader.read(500)
    expect(first.every((a) => a.atMs <= 500)).toBe(true)
    const second = reader.read(1000)
    expect(second.every((a) => a.atMs > 500)).toBe(true)
    expect([...first, ...second]).toEqual(readAll(source))
    expect(reader.read(1000)).toEqual([])
  })

  it('throw when asked past the horizon, because the source must be advanced first', () => {
    const source = createTrafficSource({ spec, stream: createRandomStream(8) })
    source.advanceTo(100)
    expect(() => source.reader().read(100.5)).toThrow(RangeError)
  })
})

describe('advanceTo', () => {
  it.each([50, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects %s after advancing to 100, leaving the log unchanged',
    (untilMs) => {
      const source = createTrafficSource({ spec: constant, stream: createRandomStream(1) })
      source.advanceTo(100)
      expect(() => source.advanceTo(untilMs)).toThrow(RangeError)
      expect(source.horizonMs()).toBe(100)
      expect(readAll(source)).toHaveLength(4)
    },
  )

  it('rejects an invalid spec', () => {
    expect(() =>
      createTrafficSource({ spec: { ...constant, demandRps: -5 }, stream: createRandomStream(1) }),
    ).toThrow(RangeError)
  })
})

describe('scripted arrivals', () => {
  const spec: TrafficSpec = { shape: 'constant', demandRps: 40, clients: ['a', 'b'] }

  it('merges them into the log at their time, before a generated arrival at the same time', () => {
    const source = createTrafficSource({
      spec,
      stream: createRandomStream(1),
      scriptedArrivals: [
        { atMs: 60, count: 1, clientId: 'b' },
        { atMs: 50, count: 2 },
      ],
    })
    source.advanceTo(75)
    const log = readAll(source)
    expect(log.map(({ atMs, origin }) => [atMs, origin])).toEqual([
      [25, 'generated'],
      [50, 'scripted'],
      [50, 'scripted'],
      [50, 'generated'],
      [60, 'scripted'],
      [75, 'generated'],
    ])
    expect(log.map((a) => a.requestId)).toEqual([0, 1, 2, 3, 4, 5])
    // No clientId means the first listed Client; an explicit one is kept.
    expect(log.filter((a) => a.origin === 'scripted').map((a) => a.clientId)).toEqual([
      'a',
      'a',
      'b',
    ])
  })

  it('includes scripted arrivals at t = 0 from the start', () => {
    const source = createTrafficSource({
      spec,
      stream: createRandomStream(1),
      scriptedArrivals: [{ atMs: 0, count: 3 }],
    })
    expect(source.reader().read(0)).toHaveLength(3)
  })

  // Scripted arrivals take no draw from the traffic stream, so adding a burst at a window edge
  // to a Scenario leaves every generated arrival exactly where it was.
  it('leaves every generated arrival time and Client unchanged', () => {
    const poisson: TrafficSpec = { shape: 'poisson', demandRps: 150, clients: ['a', 'b', 'c'] }
    const generated = (scriptedArrivals: { atMs: number; count: number }[]) => {
      const source = createTrafficSource({
        spec: poisson,
        stream: createRandomStream(77),
        scriptedArrivals,
      })
      source.advanceTo(10_000)
      return readAll(source)
        .filter((a) => a.origin === 'generated')
        .map(({ atMs, clientId }) => ({ atMs, clientId }))
    }
    expect(
      generated([
        { atMs: 999.5, count: 40 },
        { atMs: 1999.5, count: 40 },
      ]),
    ).toEqual(generated([]))
  })

  it.each([
    ['a negative time', { atMs: -1, count: 1 }],
    ['a NaN time', { atMs: Number.NaN, count: 1 }],
    ['a count of 0', { atMs: 10, count: 0 }],
    ['a fractional count', { atMs: 10, count: 1.5 }],
    ['a Client that is not listed', { atMs: 10, count: 1, clientId: 'z' }],
  ])('rejects %s', (_name, scripted) => {
    expect(() =>
      createTrafficSource({ spec, stream: createRandomStream(1), scriptedArrivals: [scripted] }),
    ).toThrow(RangeError)
  })
})

describe('demand changes', () => {
  // 10 rps is one arrival every 100 ms. At t = 50 half a gap of work is left; at 20 rps that
  // half takes 25 ms, so the next arrival is at 75, then every 50 ms.
  it('keeps the work left in the current gap and times it at the new rate', () => {
    const source = createTrafficSource({
      spec: { shape: 'constant', demandRps: 10, clients: ['a'] },
      stream: createRandomStream(1),
    })
    source.advanceTo(50)
    source.applyControl({ kind: 'demand', demandRps: 20 })
    source.advanceTo(200)
    expect(readAll(source).map((a) => a.atMs)).toEqual([75, 125, 175])
  })

  /** Arrival counts in (fromMs, toMs]. */
  function countIn(log: Arrival[], fromMs: number, toMs: number): number {
    return log.filter((a) => a.atMs > fromMs && a.atMs <= toMs).length
  }

  function poissonWithChanges(steps: [number, number][], untilMs: number): Arrival[] {
    const source = createTrafficSource({
      spec: { shape: 'poisson', demandRps: 100, clients: ['a'] },
      stream: createRandomStream(606),
    })
    for (const [atMs, demandRps] of steps) {
      source.advanceTo(atMs)
      source.applyControl({ kind: 'demand', demandRps })
    }
    source.advanceTo(untilMs)
    return readAll(source)
  }

  // 120 s at 300 rps expects n = 36,000, standard error sqrt(n) = 190. The 3 percent band
  // (1,080) is about 5.7 standard errors.
  it('arrives at the new rate after a rise', () => {
    const log = poissonWithChanges([[60_000, 300]], 180_000)
    expect(Math.abs(countIn(log, 60_000, 180_000) - 36_000)).toBeLessThan(1_080)
  })

  // 120 s at 50 rps expects n = 6,000, standard error 77. The 5.5 percent band (330) is about
  // 4.3 standard errors.
  it('arrives at the new rate after a drop', () => {
    const log = poissonWithChanges([[60_000, 50]], 180_000)
    expect(Math.abs(countIn(log, 60_000, 180_000) - 6_000)).toBeLessThan(330)
  })

  // At 0 rps nothing arrives. The rise to 200 rps then gives n = 24,000 over 120 s, standard
  // error 155, and the 3 percent band (720) is about 4.6 standard errors.
  it('stops at 0 rps and resumes at the new rate after a rise', () => {
    const log = poissonWithChanges(
      [
        [10_000, 0],
        [20_000, 200],
      ],
      140_000,
    )
    expect(countIn(log, 10_000, 20_000)).toBe(0)
    expect(Math.abs(countIn(log, 20_000, 140_000) - 24_000)).toBeLessThan(720)
  })
})

describe('bursts', () => {
  // 10 rps is a gap of 100 ms. A 5x burst at t = 1000 for 200 ms makes it 20 ms until 1200,
  // then 100 ms again.
  const expected = [1020, 1040, 1060, 1080, 1100, 1120, 1140, 1160, 1180, 1200, 1300, 1400]

  it('multiplies the rate for its duration, then returns to Demand', () => {
    const source = createTrafficSource({
      spec: { shape: 'constant', demandRps: 10, clients: ['a'] },
      stream: createRandomStream(1),
    })
    source.advanceTo(1000)
    source.applyControl({ kind: 'burst', multiplier: 5, durationMs: 200 })
    source.advanceTo(1400)
    expect(
      readAll(source)
        .filter((a) => a.atMs > 1000)
        .map((a) => a.atMs),
    ).toEqual(expected)
  })

  // The burst's end is part of the rate over time, not something a frame has to notice, so
  // it ends at 1200 even when no frame lands there.
  it('ends at the same simulated time however the run is chunked', () => {
    const source = createTrafficSource({
      spec: { shape: 'constant', demandRps: 10, clients: ['a'] },
      stream: createRandomStream(1),
    })
    source.advanceTo(1000)
    source.applyControl({ kind: 'burst', multiplier: 5, durationMs: 200 })
    for (const t of [1001, 1133.7, 1199.99, 1257, 1400]) source.advanceTo(t)
    expect(
      readAll(source)
        .filter((a) => a.atMs > 1000)
        .map((a) => a.atMs),
    ).toEqual(expected)
  })

  // Poisson at 400 rps with a 5x burst for 2 s expects n = 4,000 in the burst (standard error
  // 63; the 7 percent band, 280, is about 4.4) and 24,000 in the 60 s after it (standard error
  // 155; the 3 percent band, 720, is about 4.6).
  it('arrives at 5x Demand during a Poisson burst and at Demand afterwards', () => {
    const source = createTrafficSource({
      spec: { shape: 'poisson', demandRps: 400, clients: ['a'] },
      stream: createRandomStream(31),
    })
    source.advanceTo(10_000)
    source.applyControl({ kind: 'burst', multiplier: 5, durationMs: 2_000 })
    source.advanceTo(72_000)
    const log = readAll(source)
    const inBurst = log.filter((a) => a.atMs > 10_000 && a.atMs <= 12_000).length
    const after = log.filter((a) => a.atMs > 12_000).length
    expect(Math.abs(inBurst - 4_000)).toBeLessThan(280)
    expect(Math.abs(after - 24_000)).toBeLessThan(720)
  })

  it('replaces an active burst when a new one starts', () => {
    const source = createTrafficSource({
      spec: { shape: 'constant', demandRps: 10, clients: ['a'] },
      stream: createRandomStream(1),
    })
    source.advanceTo(1000)
    source.applyControl({ kind: 'burst', multiplier: 5, durationMs: 1000 })
    source.advanceTo(1100)
    // 2x for 100 ms: gaps of 50 ms until 1200, then 100 ms. The first burst's 5x is gone.
    source.applyControl({ kind: 'burst', multiplier: 2, durationMs: 100 })
    source.advanceTo(1400)
    expect(
      readAll(source)
        .filter((a) => a.atMs > 1100)
        .map((a) => a.atMs),
    ).toEqual([1150, 1200, 1300, 1400])
  })
})

describe('greedy multiplier changes', () => {
  const spec: TrafficSpec = { shape: 'poisson', demandRps: 200, clients: ['a', 'b', 'c', 'd'] }

  function run(withChange: boolean): Arrival[] {
    const source = createTrafficSource({ spec, stream: createRandomStream(12) })
    source.advanceTo(30_000)
    if (withChange) source.applyControl({ kind: 'greedyMultiplier', clientId: 'b', multiplier: 5 })
    source.advanceTo(150_000)
    return readAll(source)
  }

  // 24,000 arrivals after the change; a 5 / 8 share has standard error 0.0031 and the +/- 0.013
  // band is about 4.2 standard errors.
  it('gives the Client multiplier shares of the arrivals after the change', () => {
    const after = run(true).filter((a) => a.atMs > 30_000)
    const share = after.filter((a) => a.clientId === 'b').length / after.length
    expect(Math.abs(share - 5 / 8)).toBeLessThan(0.013)
  })

  // Demand is the total (spec decision 1): the multiplier moves who sends, never when.
  it('leaves every arrival time unchanged', () => {
    expect(run(true).map((a) => a.atMs)).toEqual(run(false).map((a) => a.atMs))
  })
  // There is one greedy Client at a time (the noisy-neighbor lesson is about one heavy
  // Client), so moving the multiplier from b to c puts b back to 1 share. Weights 1, 1, 5, 1:
  // c's share is 5 / 8 (band 0.013, about 4.2 standard errors) and b's is 1 / 8 (band 0.009,
  // about 4.2).
  it('moves the greedy role: the previous greedy Client goes back to 1 share', () => {
    const source = createTrafficSource({
      spec: { ...spec, greedy: { clientId: 'b', multiplier: 5 } },
      stream: createRandomStream(12),
    })
    source.advanceTo(30_000)
    source.applyControl({ kind: 'greedyMultiplier', clientId: 'c', multiplier: 5 })
    source.advanceTo(150_000)
    const after = readAll(source).filter((a) => a.atMs > 30_000)
    const share = (id: string) => after.filter((a) => a.clientId === id).length / after.length
    expect(Math.abs(share('c') - 5 / 8)).toBeLessThan(0.013)
    expect(Math.abs(share('b') - 1 / 8)).toBeLessThan(0.009)
  })
})

describe('shape changes', () => {
  it('keeps the pending arrival and uses the new shape for the gaps after it', () => {
    const source = createTrafficSource({
      spec: { shape: 'constant', demandRps: 10, clients: ['a'] },
      stream: createRandomStream(5),
    })
    source.advanceTo(50)
    source.applyControl({ kind: 'shape', shape: 'poisson' })
    source.advanceTo(5_000)
    const times = readAll(source).map((a) => a.atMs)
    expect(times[0]).toBe(100)
    const later = times.slice(1).map((t, i) => t - (times[i] ?? 0))
    expect(new Set(later.map((gap) => gap.toFixed(6))).size).toBeGreaterThan(10)
  })

  // A student who flips to bursty should see an on phase start right away, so the phases are
  // anchored at the switch time: on for (1050, 1150], off for (1150, 1250], and so on.
  it('anchors bursty phases at the time of the switch', () => {
    const source = createTrafficSource({
      spec: { shape: 'poisson', demandRps: 100, clients: ['a'], bursty: { onMs: 100, offMs: 100 } },
      stream: createRandomStream(5),
    })
    source.advanceTo(1050)
    source.applyControl({ kind: 'shape', shape: 'bursty' })
    source.advanceTo(60_000)
    const after = readAll(source).filter((a) => a.atMs > 1050)
    expect(after.length).toBeGreaterThan(1000)
    expect(after.filter((a) => (a.atMs - 1050) % 200 > 100)).toEqual([])
  })

  it('keeps the phases where they were when the shape is already bursty', () => {
    const source = createTrafficSource({
      spec: { shape: 'bursty', demandRps: 100, clients: ['a'], bursty: { onMs: 100, offMs: 100 } },
      stream: createRandomStream(5),
    })
    source.advanceTo(1050)
    source.applyControl({ kind: 'shape', shape: 'bursty' })
    source.advanceTo(60_000)
    expect(readAll(source).filter((a) => a.atMs % 200 > 100)).toEqual([])
  })
})

describe('control validation', () => {
  const spec: TrafficSpec = { shape: 'poisson', demandRps: 100, clients: ['a', 'b'] }

  it.each([
    ['a negative Demand', { kind: 'demand', demandRps: -1 }],
    ['a NaN Demand', { kind: 'demand', demandRps: Number.NaN }],
    [
      'a greedy Client that is not listed',
      { kind: 'greedyMultiplier', clientId: 'z', multiplier: 2 },
    ],
    ['a greedy multiplier of 0', { kind: 'greedyMultiplier', clientId: 'a', multiplier: 0 }],
    ['a burst multiplier of 0', { kind: 'burst', multiplier: 0, durationMs: 100 }],
    ['a burst of 0 ms', { kind: 'burst', multiplier: 2, durationMs: 0 }],
    ['an infinite burst', { kind: 'burst', multiplier: 2, durationMs: Infinity }],
    ['bursty without phases in the spec', { kind: 'shape', shape: 'bursty' }],
    ['an unknown shape', { kind: 'shape', shape: 'wavy' }],
  ] as [string, ControlChange][])(
    'rejects %s, leaving the log and timeline unchanged',
    (_name, change) => {
      const source = createTrafficSource({ spec, stream: createRandomStream(9) })
      source.advanceTo(1_000)
      source.applyControl({ kind: 'demand', demandRps: 150 })
      expect(() => source.applyControl(change)).toThrow(RangeError)
      expect(source.timeline()).toEqual([
        { atMs: 1_000, change: { kind: 'demand', demandRps: 150 } },
      ])
      source.advanceTo(5_000)
      const untouched = createTrafficSource({ spec, stream: createRandomStream(9) })
      untouched.advanceTo(1_000)
      untouched.applyControl({ kind: 'demand', demandRps: 150 })
      untouched.advanceTo(5_000)
      expect(readAll(source)).toEqual(readAll(untouched))
    },
  )
})

describe('control timeline and replay', () => {
  const spec: TrafficSpec = {
    shape: 'poisson',
    demandRps: 120,
    clients: ['a', 'b', 'c'],
    bursty: { onMs: 250, offMs: 400 },
  }
  const UNTIL_MS = 60_000

  /** A random control change of any kind, drawn from `rng`. */
  function randomChange(rng: ReturnType<typeof createRandomStream>): ControlChange {
    const kind = rng.next()
    if (kind < 0.3) return { kind: 'demand', demandRps: Math.round(rng.next() * 400) }
    if (kind < 0.5)
      return { kind: 'burst', multiplier: 1 + rng.next() * 4, durationMs: 100 + rng.next() * 3000 }
    if (kind < 0.7)
      return { kind: 'greedyMultiplier', clientId: 'b', multiplier: 1 + rng.next() * 9 }
    const shapes = ['constant', 'poisson', 'bursty'] as const
    return { kind: 'shape', shape: shapes[Math.floor(rng.next() * 3)] ?? 'poisson' }
  }

  /** A live run: random chunks, with a random control change after some of them. */
  function liveRun(seed: number) {
    const source = createTrafficSource({ spec, stream: createRandomStream(seed) })
    const rng = createRandomStream(seed + 500)
    for (let t = 0; t < UNTIL_MS;) {
      t = Math.min(UNTIL_MS, t + rng.next() * 700)
      source.advanceTo(t)
      if (rng.next() < 0.3) source.applyControl(randomChange(rng))
    }
    return { log: readAll(source), timeline: source.timeline() }
  }

  // Seed plus control timeline must rebuild the run exactly, whatever frames the replay uses.
  it('replays a live run exactly from the seed and the recorded timeline', () => {
    for (const seed of [1, 2, 3, 99]) {
      const live = liveRun(seed)
      expect(live.timeline.length, `seed ${seed}`).toBeGreaterThan(10)
      const replay = createTrafficSource({
        spec,
        stream: createRandomStream(seed),
        controls: live.timeline,
      })
      const chunks = createRandomStream(seed + 9_000)
      for (let t = 0; t < UNTIL_MS;) {
        t = Math.min(UNTIL_MS, t + chunks.next() * 2_000)
        replay.advanceTo(t)
      }
      expect(readAll(replay), `seed ${seed}`).toEqual(live.log)
      expect(replay.timeline(), `seed ${seed}`).toEqual(live.timeline)
    }
  })

  it('applies scripted controls at their time, after arrivals at that same time', () => {
    const source = createTrafficSource({
      spec: { shape: 'constant', demandRps: 10, clients: ['a'] },
      stream: createRandomStream(1),
      controls: [{ atMs: 100, change: { kind: 'demand', demandRps: 20 } }],
    })
    source.advanceTo(200)
    // The arrival at exactly 100 happens at the old rate; the gap after it is 50 ms.
    expect(readAll(source).map((a) => a.atMs)).toEqual([100, 150, 200])
  })

  it('records scripted and live changes in the order applied', () => {
    const scripted = { atMs: 100, change: { kind: 'demand', demandRps: 20 } } as const
    const source = createTrafficSource({
      spec,
      stream: createRandomStream(1),
      controls: [scripted],
    })
    expect(source.timeline()).toEqual([])
    source.advanceTo(300)
    source.applyControl({ kind: 'burst', multiplier: 2, durationMs: 50 })
    expect(source.timeline()).toEqual([
      scripted,
      { atMs: 300, change: { kind: 'burst', multiplier: 2, durationMs: 50 } },
    ])
  })

  it.each([
    [
      'unsorted controls',
      [
        { atMs: 200, change: { kind: 'demand', demandRps: 1 } },
        { atMs: 100, change: { kind: 'demand', demandRps: 2 } },
      ],
    ],
    ['a negative time', [{ atMs: -1, change: { kind: 'demand', demandRps: 1 } }]],
    ['a NaN time', [{ atMs: Number.NaN, change: { kind: 'demand', demandRps: 1 } }]],
    ['an invalid change', [{ atMs: 10, change: { kind: 'demand', demandRps: -1 } }]],
  ] as [string, ControlEvent[]][])('rejects %s up front', (_name, controls) => {
    expect(() => createTrafficSource({ spec, stream: createRandomStream(1), controls })).toThrow(
      RangeError,
    )
  })
})

describe('trimming the log', () => {
  const poisson: TrafficSpec = { shape: 'poisson', demandRps: 300, clients: ['a', 'b'] }
  const STEP_MS = 50

  /**
   * Two readers at different paces, the slow one a whole second behind, read in 50 ms steps
   * to 20 s. Returns everything each one read, and the log size seen after each step.
   */
  function readAtTwoPaces(trim: boolean) {
    const source = createTrafficSource({ spec: poisson, stream: createRandomStream(4) })
    const fast = source.reader()
    const slow = source.reader()
    const fastRead: Arrival[] = []
    const slowRead: Arrival[] = []
    const retained: number[] = []
    for (let t = STEP_MS; t <= 20_000; t += STEP_MS) {
      source.advanceTo(t)
      fastRead.push(...fast.read(t))
      if (t >= 1000) slowRead.push(...slow.read(t - 1000))
      if (trim) source.trim()
      retained.push(source.retainedArrivals())
    }
    slowRead.push(...slow.read(20_000))
    return { fastRead, slowRead, retained }
  }

  it('leaves every reader returning exactly what it would have without trimming', () => {
    const untrimmed = readAtTwoPaces(false)
    const trimmed = readAtTwoPaces(true)
    // Lengths first: a wrong read makes long arrays, and Vitest's diff of those takes minutes.
    expect(trimmed.fastRead.length).toBe(untrimmed.fastRead.length)
    expect(trimmed.slowRead.length).toBe(untrimmed.slowRead.length)
    expect(trimmed.fastRead).toEqual(untrimmed.fastRead)
    // The slow reader still got the entries it had not read when the fast one trimmed past them.
    expect(trimmed.slowRead).toEqual(untrimmed.slowRead)
    expect(untrimmed.slowRead.length).toBeGreaterThan(5000)
  })

  it('keeps the log bounded by what the slowest reader has not read', () => {
    const untrimmed = readAtTwoPaces(false)
    const { retained } = readAtTwoPaces(true)
    // About 6,000 arrivals in 20 s. Untrimmed the log keeps them all; trimmed it keeps only
    // the slow reader's last second, about 300 at 300 rps; 345 at most on this seed.
    expect(untrimmed.retained.at(-1)).toBeGreaterThan(5500)
    expect(Math.max(...retained)).toBeLessThan(450)
    expect(Math.max(...retained)).toBeGreaterThan(200)
  })

  it('keeps request ids as positions in the whole log', () => {
    const source = createTrafficSource({ spec: poisson, stream: createRandomStream(4) })
    const reader = source.reader()
    source.advanceTo(1000)
    const first = reader.read(1000)
    source.trim()
    source.advanceTo(2000)
    const second = reader.read(2000)
    expect(source.retainedArrivals()).toBe(second.length)
    expect(second[0]?.requestId).toBe(first.length)
  })

  it('throws a RangeError for a reader created after entries were trimmed', () => {
    const source = createTrafficSource({ spec: poisson, stream: createRandomStream(4) })
    const reader = source.reader()
    source.advanceTo(1000)
    source.trim()
    // Nothing was read yet, so nothing was dropped and a new reader still sees it all.
    expect(source.reader().read(1000)).toEqual(reader.read(1000))
    source.trim()
    expect(() => source.reader()).toThrow(RangeError)
  })
})
