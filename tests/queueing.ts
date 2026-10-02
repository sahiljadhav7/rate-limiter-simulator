/**
 * Queueing-theory helpers for tests: a run of the real traffic source into the real Backend,
 * measured Request by Request, and the textbook formulas to compare it with.
 *
 * The engine only reports latency percentiles over 5 s windows, so the mean time a Request
 * spends in the system, and the mean number of Requests in it, are measured here instead, from
 * the same parts the engine uses: the Poisson traffic source, the Backend and the event queue.
 * Each Request makes exactly one Attempt.
 */
import { createBackend, type BackendSpec } from '../src/sim/backend.ts'
import { createEventQueue } from '../src/sim/event-queue.ts'
import { createStreams, type RandomStreams } from '../src/sim/rng.ts'
import { createTrafficSource, type TrafficSource } from '../src/sim/traffic-source.ts'

/** Poisson Demand at `demandRps` from one Client, drawn from the `traffic` stream of `streams`. */
export function poissonSource(demandRps: number, streams: RandomStreams): TrafficSource {
  return createTrafficSource({
    spec: { shape: 'poisson', demandRps, clients: ['a'] },
    stream: streams.traffic,
  })
}

/**
 * The share of slot time a Backend serving `demandRps` is busy: Demand x mean service time /
 * slots. Queueing theory calls it rho; above 1 the queue grows without end.
 */
export function busyShare(spec: BackendSpec, demandRps: number): number {
  return (demandRps * spec.meanMs) / 1000 / spec.slots
}

/** What one run measured. Times in ms. */
export interface QueueRun {
  /** Requests that arrived, all of which were served. */
  readonly requests: number
  /** When the last Request left; the run covers [0, endMs]. */
  readonly endMs: number
  /** Mean time from arrival to the end of service, waiting included. */
  readonly meanInSystemMs: number
  /** Time-average of Requests waiting for a slot or in service over [0, endMs]. */
  readonly meanRequestsInSystem: number
  /** Slot time spent serving, from the Backend's own measure. */
  readonly busySlotMs: number
  /** Requests that found the queue full. Every test here sizes the queue so this is 0. */
  readonly shed: number
}

/**
 * Poisson Demand at `demandRps` for `arrivalsForMs`, into a Backend built from `spec`, then run
 * until every Request has left. Arrivals use the `traffic` stream and service times the
 * `service` stream of `seed`, as in the engine. Service ends pop before an arrival at the same
 * time, so a freed slot is free for it.
 */
export function runQueue(
  spec: BackendSpec,
  demandRps: number,
  arrivalsForMs: number,
  seed: number,
): QueueRun {
  const streams = createStreams(seed)
  const source = poissonSource(demandRps, streams)
  source.advanceTo(arrivalsForMs)
  const arrivals = source.reader().read(arrivalsForMs)
  /** The Backend's jobs are Request ids: positions in `arrivedAt`. */
  const backend = createBackend<number>(spec, streams.service)
  const serviceEnds = createEventQueue<number>()
  const arrivedAt: number[] = []

  let nowMs = 0
  /** Requests in the system multiplied by how long they were there, summed: request-ms. */
  let presentRequestMs = 0
  let inSystemMs = 0
  let shed = 0
  /** Adds the Requests present since the last event, then moves to `toMs`. */
  const moveTo = (toMs: number) => {
    presentRequestMs += (backend.busySlots() + backend.queueDepth()) * (toMs - nowMs)
    nowMs = toMs
  }

  let next = 0
  for (;;) {
    const end = serviceEnds.peek()
    const arrival = arrivals[next]
    if (end === undefined && arrival === undefined) break
    if (end !== undefined && (arrival === undefined || end.timeMs <= arrival.atMs)) {
      serviceEnds.pop()
      moveTo(end.timeMs)
      inSystemMs += nowMs - (arrivedAt[end.event] as number)
      const started = backend.finish(end.event, nowMs)
      if (started !== null) serviceEnds.push(started.endsAtMs, started.job)
    } else if (arrival !== undefined) {
      next++
      moveTo(arrival.atMs)
      const request = arrivedAt.length
      arrivedAt.push(nowMs)
      const result = backend.submit(request, nowMs)
      if (result.kind === 'shed') shed++
      if (result.kind === 'started') serviceEnds.push(result.endsAtMs, request)
    }
  }

  const requests = arrivedAt.length
  return {
    requests,
    endMs: nowMs,
    meanInSystemMs: inSystemMs / requests,
    meanRequestsInSystem: presentRequestMs / nowMs,
    busySlotMs: backend.measure(nowMs).busySlotMs,
    shed,
  }
}

/**
 * Mean time in system for one slot, Poisson arrivals and any service time distribution
 * (M/G/1, the Pollaczek-Khinchine formula): service plus a wait of
 * busy x mean x (1 + cv^2) / (2 x (1 - busy)), where busy is the share of time the slot works.
 * The (1 + cv^2) is why more varied service times wait longer at the same load.
 */
export function mg1MeanInSystemMs(spec: BackendSpec, demandRps: number): number {
  const busy = busyShare({ ...spec, slots: 1 }, demandRps)
  return spec.meanMs + (busy * spec.meanMs * (1 + spec.cv * spec.cv)) / (2 * (1 - busy))
}

/**
 * Mean time in system for `slots` slots, Poisson arrivals and exponential service (M/M/c, the
 * Erlang C formula): service plus the chance of having to wait, times the mean wait of those
 * who do, mean / (slots x (1 - busy)).
 *
 * The chance of waiting compares how likely all slots are taken against fewer: with `busySlots`
 * = Demand x mean on average, the weight of k slots busy is busySlots^k / k!, and of all slots
 * busy (any queue length included) busySlots^slots / slots! / (1 - busy).
 */
export function mmcMeanInSystemMs(spec: BackendSpec, demandRps: number): number {
  const busySlots = (demandRps * spec.meanMs) / 1000
  const busy = busyShare(spec, demandRps)
  let weight = 1
  let fewerBusyWeight = 0
  for (let k = 0; k < spec.slots; k++) {
    fewerBusyWeight += weight
    weight *= busySlots / (k + 1)
  }
  const allBusyWeight = weight / (1 - busy)
  const chanceToWait = allBusyWeight / (fewerBusyWeight + allBusyWeight)
  return spec.meanMs + (chanceToWait * spec.meanMs) / (spec.slots * (1 - busy))
}
