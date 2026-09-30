/**
 * Arrival processes: when new Requests arrive and which Client sends each one.
 *
 * Every gap between arrivals is an amount of work in expected arrivals, consumed against the
 * rate over time: the next arrival is where the integrated rate reaches the work. Keeping the
 * work separate from the rate lets a control change rescale a gap already in progress
 * without a new draw (see .scratch/traffic/spec.md, decision 5).
 */
import { checkNonNegative, checkPositive } from './checks.ts'
import { bucketAt, bucketStart } from './buckets.ts'
import type { RandomStream } from './rng.ts'

/**
 * A unit exponential draw (mean 1): the work of one Poisson gap. Uses -ln(1 - u) rather than
 * -ln(u) because u is in [0, 1): 1 - u is in (0, 1], so the result is always finite.
 * log1p keeps precision for small u, and `0 -` turns a draw of 0 into +0 rather than -0.
 */
export function unitExponential(stream: RandomStream): number {
  return 0 - Math.log1p(-stream.next())
}

/** One caller identity; per-client Limiters count against it. */
export type ClientId = string

/** How arrivals are spaced: evenly, at random (Poisson), or in on/off bursts. */
export type TrafficShape = 'constant' | 'poisson' | 'bursty'

/** The on and off phases of bursty traffic, in ms. */
export interface BurstyPhases {
  /** How long each on phase lasts, in ms. More than 0. */
  readonly onMs: number
  /** How long each off phase lasts, in ms. 0 or more; 0 means always on. */
  readonly offMs: number
}

/** The traffic of new Requests shared by every Variant of a Scenario. */
export interface TrafficSpec {
  readonly shape: TrafficShape
  /**
   * Demand: total new Requests per second across all Clients, before retries. For bursty
   * traffic it is the long-run mean over whole on/off cycles.
   */
  readonly demandRps: number
  /** The Clients that send Requests. Their listed order is the order of the weighted pick. */
  readonly clients: readonly ClientId[]
  /** One Client that gets `multiplier` shares of Demand; every other Client gets 1 share. */
  readonly greedy?: { readonly clientId: ClientId; readonly multiplier: number }
  /** Required when the shape is bursty, or when a control may switch it to bursty. */
  readonly bursty?: BurstyPhases
}

/**
 * Throws a RangeError if the spec cannot produce a meaningful run: Demand must be a finite
 * number, 0 or more; Clients must be listed once each, at least one, with any greedy Client
 * among them and a finite multiplier above 0; bursty traffic needs phases, with an on phase longer than 0 ms and an
 * off phase of 0 ms or more. Phases are checked whenever they are given, because a control
 * can switch the shape to bursty later.
 */
export function checkTrafficSpec(spec: TrafficSpec): void {
  checkDemand(spec.demandRps)
  if (spec.shape === 'bursty' && spec.bursty === undefined) {
    throw new RangeError('Bursty traffic needs on and off phases')
  }
  if (spec.clients.length === 0) throw new RangeError('Traffic needs at least one Client')
  if (new Set(spec.clients).size !== spec.clients.length) {
    throw new RangeError(`Clients must be listed once each, got ${spec.clients.join(', ')}`)
  }
  if (spec.greedy !== undefined) {
    checkGreedy(spec, spec.greedy.clientId, spec.greedy.multiplier)
  }
  if (spec.bursty !== undefined) {
    checkPositive(spec.bursty.onMs, 'The on phase in ms')
    checkNonNegative(spec.bursty.offMs, 'The off phase in ms')
  }
}

/** Throws a RangeError unless `demandRps` is a valid Demand: 0 or more Requests per second. */
export function checkDemand(demandRps: number): void {
  checkNonNegative(demandRps, 'Demand in Requests per second')
}

/**
 * Throws a RangeError unless `clientId` is one of the spec's Clients and `multiplier`, its
 * shares of Demand, is more than 0.
 */
export function checkGreedy(spec: TrafficSpec, clientId: ClientId, multiplier: number): void {
  if (!spec.clients.includes(clientId)) {
    throw new RangeError(`The greedy Client ${clientId} is not one of the Clients`)
  }
  checkPositive(multiplier, 'The greedy multiplier')
}

/**
 * The rate of new Requests over time, from which gaps are timed. Rates are in Requests per
 * second and times in ms of simulated time.
 */
export interface RateProfile {
  /** Demand, in Requests per second. For bursty traffic, the long-run mean. */
  readonly demandRps: number
  /** On/off phases when the shape is bursty, null otherwise. */
  readonly phases: BurstyPhases | null
  /** When the first on phase starts, in ms. Phases repeat from here. */
  readonly phaseAnchorMs: number
  /**
   * A temporary rate multiplier (the burst button) that lasts until `endMs`, or null. It
   * only ever covers times from when it was applied, so it has no start.
   */
  readonly burst: { readonly multiplier: number; readonly endMs: number } | null
}

/** The rate profile of a spec from t = 0, before any control change. */
export function rateProfile(spec: TrafficSpec): RateProfile {
  return {
    demandRps: spec.demandRps,
    phases: spec.shape === 'bursty' ? (spec.bursty ?? null) : null,
    phaseAnchorMs: 0,
    burst: null,
  }
}

/** A stretch of time with one rate: the rate holds from the asked time until `endMs`. */
interface Segment {
  /** Requests per second. */
  readonly rateRps: number
  /** When the rate next changes, in ms; Infinity if it never does. */
  readonly endMs: number
}

/** The rate at `timeMs` and how long it holds, before any burst. */
function phaseSegmentAt(profile: RateProfile, timeMs: number): Segment {
  const { demandRps, phases } = profile
  // With no off phase the on rate is Demand itself. Returning it directly, rather than
  // Demand x (on + off) / on, keeps it bit-exact with Poisson traffic at the same Demand.
  if (phases === null || phases.offMs === 0) {
    return { rateRps: demandRps, endMs: Number.POSITIVE_INFINITY }
  }
  const periodMs = phases.onMs + phases.offMs
  // Every cycle edge comes from bucketStart. Computing the same edge two ways (say start +
  // period and anchor + (cycle + 1) x period) can round differently, and then a walk that
  // lands on an edge gets a stretch of zero length and never moves on.
  const cycleStart = (cycle: number) => bucketStart(cycle, periodMs, profile.phaseAnchorMs)
  const cycle = bucketAt(timeMs, periodMs, profile.phaseAnchorMs)
  const onEndMs = cycleStart(cycle) + phases.onMs
  if (timeMs < onEndMs) return { rateRps: (demandRps * periodMs) / phases.onMs, endMs: onEndMs }
  // timeMs < cycleStart(cycle + 1) by the correction above, so the stretch always has length.
  return { rateRps: 0, endMs: cycleStart(cycle + 1) }
}

/** The rate at `timeMs` and how long it holds, including an active burst. */
function segmentAt(profile: RateProfile, timeMs: number): Segment {
  const segment = phaseSegmentAt(profile, timeMs)
  const { burst } = profile
  if (burst === null || timeMs >= burst.endMs) return segment
  return {
    rateRps: segment.rateRps * burst.multiplier,
    endMs: Math.min(segment.endMs, burst.endMs),
  }
}

/**
 * The work of the next gap, in expected arrivals: exactly 1 for constant traffic (no draw),
 * a unit exponential from `stream` for Poisson and bursty traffic.
 */
export function gapWork(shape: TrafficShape, stream: RandomStream): number {
  return shape === 'constant' ? 1 : unitExponential(stream)
}

/**
 * The time at which the rate, integrated from `fromMs`, reaches `work` expected arrivals.
 * Infinity if it never does, for example while Demand is 0. Walks the stretches of constant
 * rate (bursty phase edges) one at a time.
 */
export function timeToWork(profile: RateProfile, fromMs: number, work: number): number {
  if (profile.demandRps === 0) return Number.POSITIVE_INFINITY
  let timeMs = fromMs
  let remaining = work
  for (;;) {
    const segment = segmentAt(profile, timeMs)
    if (segment.rateRps > 0) {
      const neededMs = (remaining * 1000) / segment.rateRps
      if (timeMs + neededMs <= segment.endMs) return timeMs + neededMs
      // Rounding can push the remainder a hair below 0; it then arrives at the next edge.
      remaining = Math.max(0, remaining - ((segment.endMs - timeMs) * segment.rateRps) / 1000)
    } else if (segment.endMs === Number.POSITIVE_INFINITY) {
      // No rate from here on (or a rate that is not a number): never arrives, and never loops.
      return Number.POSITIVE_INFINITY
    }
    timeMs = segment.endMs
  }
}

/** A Client and its weight: how many shares of Demand it gets. */
export interface ClientShare {
  readonly clientId: ClientId
  readonly weight: number
}

/**
 * Each Client's share, in listed order: weight 1, or the multiplier for the one greedy Client
 * (`greedy`, when given). Shares split Demand between Clients; they never change the total
 * (spec decision 1).
 */
export function clientShares(
  clients: readonly ClientId[],
  greedy?: { readonly clientId: ClientId; readonly multiplier: number },
): ClientShare[] {
  return clients.map((clientId) => ({
    clientId,
    weight: clientId === greedy?.clientId ? greedy.multiplier : 1,
  }))
}

/**
 * Picks the Client of one arrival with a single draw from `stream`, walking the cumulative
 * weights in listed order (never object key order, which would make runs depend on how a
 * Scenario was written). It draws even when there is one Client, so every arrival uses the
 * same number of draws and arrival times never depend on the Clients or their weights.
 */
export function pickClient(shares: readonly ClientShare[], stream: RandomStream): ClientId {
  const total = shares.reduce((sum, share) => sum + share.weight, 0)
  let target = stream.next() * total
  for (const share of shares) {
    target -= share.weight
    if (target < 0) return share.clientId
  }
  // Rounding can leave a hair of weight at the end; it belongs to the last Client.
  return (shares[shares.length - 1] as ClientShare).clientId
}

/**
 * The work, in expected arrivals, that the rate provides between `fromMs` and `toMs`. A
 * control change uses it to find how much of the current gap is left.
 */
export function workBetween(profile: RateProfile, fromMs: number, toMs: number): number {
  let work = 0
  for (let timeMs = fromMs; timeMs < toMs;) {
    const segment = segmentAt(profile, timeMs)
    const endMs = Math.min(segment.endMs, toMs)
    work += ((endMs - timeMs) * segment.rateRps) / 1000
    timeMs = endMs
  }
  return work
}
