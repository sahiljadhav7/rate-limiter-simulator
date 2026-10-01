/**
 * The Backend: the simulated service behind the Limiter, with a fixed number of slots and a
 * bounded first-in, first-out queue. An Attempt that finds every slot busy waits in the
 * queue; one that finds the queue full is shed.
 *
 * The Backend never cancels work. An Attempt whose caller gave up still holds its slot, or
 * its place in the queue, until its service ends; that time is Wasted Work
 * (.scratch/engine/spec.md, decision 1).
 */
import { checkNonNegative, checkPositive, checkWholeNumber } from './checks.ts'
import { createFifo } from './fifo.ts'
import type { RandomStream } from './rng.ts'

/** How big and how fast the Backend is. */
export interface BackendSpec {
  /** How many Attempts it serves at once. A whole number, 1 or more. */
  readonly slots: number
  /** How many Attempts may wait for a slot. A whole number, 0 or more; 0 means no queue. */
  readonly queueLimit: number
  /** Mean service time, in ms. More than 0. */
  readonly meanMs: number
  /**
   * Coefficient of variation of the service time: its standard deviation divided by its
   * mean. 0 means every service takes exactly `meanMs`; 1 is as spread out as an exponential.
   */
  readonly cv: number
}

/** What happened to a submitted job. */
export type SubmitResult =
  | { readonly kind: 'started'; readonly endsAtMs: number }
  | { readonly kind: 'queued' }
  | { readonly kind: 'shed' }

/** The Backend of one Variant. `T` is the engine's job, an Attempt. */
export interface Backend<T> {
  /**
   * Starts `job` in a free slot, or queues it if every slot is busy, or sheds it if the queue
   * is full. When it starts, the result says when its service ends; the engine schedules that.
   */
  submit(job: T, nowMs: number): SubmitResult
  /**
   * Ends the service of `job`, frees its slot and starts the oldest queued job in it, if any.
   * Returns that job and when its service ends, or null when the queue was empty. Throws a
   * RangeError if `job` is not in service.
   */
  finish(job: T, nowMs: number): { readonly job: T; readonly endsAtMs: number } | null
  /**
   * Marks `job` as abandoned: its caller timed out. Nothing is freed. The job keeps its slot,
   * or its place in the queue, and every ms of its service from now on is Wasted Work. Does
   * nothing if the Backend does not hold `job`.
   */
  abandon(job: T, nowMs: number): void
  /**
   * Slot time from 0 to `nowMs`, in ms: one slot serving for 1 ms counts 1. `busySlotMs`
   * counts all service, `wastedSlotMs` the part spent on abandoned jobs. Utilization over a
   * span is the busy time in it divided by slots x the span's length. Only reads: measuring
   * as often as you like never changes a later result.
   */
  measure(nowMs: number): { readonly busySlotMs: number; readonly wastedSlotMs: number }
  /** How many Attempts wait for a slot. */
  queueDepth(): number
  /** How many slots are serving an Attempt. */
  busySlots(): number
}

/** A standard normal draw (Box-Muller). Takes two draws; `1 - u` keeps the log finite. */
function standardNormal(stream: RandomStream): number {
  const radius = Math.sqrt(-2 * Math.log(1 - stream.next()))
  return radius * Math.cos(2 * Math.PI * stream.next())
}

/**
 * A gamma draw with scale 1 (Marsaglia and Tsang, 2000). The number of draws it takes
 * varies, which is fine because the `service` stream is used for nothing else. Shapes below
 * 1 use the boost gamma(shape) = gamma(shape + 1) x U^(1 / shape).
 */
function unitGamma(shape: number, stream: RandomStream): number {
  if (shape < 1) return unitGamma(shape + 1, stream) * (1 - stream.next()) ** (1 / shape)
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (;;) {
    const x = standardNormal(stream)
    const cube = (1 + c * x) ** 3
    if (cube <= 0) continue
    const u = 1 - stream.next()
    if (Math.log(u) < 0.5 * x * x + d - d * cube + d * Math.log(cube)) return d * cube
  }
}

/**
 * One service time in ms: gamma with shape 1 / cv^2 and scale mean x cv^2, which has the
 * asked mean and cv. Gamma is always positive and its right tail grows with cv, which is how
 * real service times look. cv 0 takes exactly the mean and makes no draw.
 */
export function serviceTimeMs(spec: BackendSpec, stream: RandomStream): number {
  if (spec.cv === 0) return spec.meanMs
  const cvSquared = spec.cv * spec.cv
  return spec.meanMs * cvSquared * unitGamma(1 / cvSquared, stream)
}

/** Throws a RangeError if the spec cannot describe a working Backend. */
export function checkBackendSpec(spec: BackendSpec): void {
  const { slots, queueLimit, meanMs, cv } = spec
  checkWholeNumber(slots, 1, 'Backend slots')
  checkWholeNumber(queueLimit, 0, 'The queue limit')
  checkPositive(meanMs, 'The mean service time in ms')
  checkNonNegative(
    cv,
    'The coefficient of variation of the service time (how spread out service times are)',
  )
}

/**
 * Creates an idle Backend. Service times are drawn from `stream`, which must be the
 * `service` stream. Throws a RangeError if the spec is invalid.
 */
export function createBackend<T>(spec: BackendSpec, stream: RandomStream): Backend<T> {
  checkBackendSpec(spec)
  const inService = new Set<T>()
  /** Every queued job, for `abandon`; `queue` keeps their order. */
  const waiting = new Set<T>()
  const abandoned = new Set<T>()
  /** How many jobs in service are abandoned. */
  let wastingSlots = 0
  const queue = createFifo<T>()
  let busySlotMs = 0
  let wastedSlotMs = 0
  let lastMs = 0

  /** Throws a RangeError if `nowMs` is before the last change. */
  function checkForward(nowMs: number): void {
    if (!(nowMs >= lastMs)) {
      throw new RangeError(`Backend time cannot go backwards: at ${lastMs} ms, got ${nowMs}`)
    }
  }

  /** Adds the busy time since the last change and moves to `nowMs`, which never goes back. */
  function accrue(nowMs: number): void {
    checkForward(nowMs)
    busySlotMs += inService.size * (nowMs - lastMs)
    wastedSlotMs += wastingSlots * (nowMs - lastMs)
    lastMs = nowMs
  }

  /** Puts `job` in a slot and returns when its service ends, drawn as it starts. */
  function start(job: T, nowMs: number): number {
    inService.add(job)
    if (abandoned.has(job)) wastingSlots++
    return nowMs + serviceTimeMs(spec, stream)
  }

  return {
    submit(job, nowMs) {
      accrue(nowMs)
      if (inService.size < spec.slots) return { kind: 'started', endsAtMs: start(job, nowMs) }
      if (queue.size() < spec.queueLimit) {
        queue.push(job)
        waiting.add(job)
        return { kind: 'queued' }
      }
      return { kind: 'shed' }
    },
    finish(job, nowMs) {
      if (!inService.has(job)) throw new RangeError('Only a job in service can finish')
      accrue(nowMs)
      inService.delete(job)
      if (abandoned.delete(job)) wastingSlots--
      if (queue.size() === 0) return null
      const next = queue.shift() as T
      waiting.delete(next)
      return { job: next, endsAtMs: start(next, nowMs) }
    },
    abandon(job, nowMs) {
      accrue(nowMs)
      if (abandoned.has(job)) return
      if (inService.has(job)) {
        abandoned.add(job)
        wastingSlots++
      } else if (waiting.has(job)) {
        abandoned.add(job)
      }
    },
    measure(nowMs) {
      // Reads without moving the running totals, so measuring never changes a later result:
      // the totals are only ever split at submit, finish and abandon, which happen at the same
      // times however often anyone measures. Adding a partial sum here and the rest later
      // would round differently in the last bits.
      checkForward(nowMs)
      return {
        busySlotMs: busySlotMs + inService.size * (nowMs - lastMs),
        wastedSlotMs: wastedSlotMs + wastingSlots * (nowMs - lastMs),
      }
    },
    queueDepth() {
      return queue.size()
    },
    busySlots() {
      return inService.size
    },
  }
}
