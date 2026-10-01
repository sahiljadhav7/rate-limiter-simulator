/**
 * One Variant's engine: it reads the shared traffic, sends each Request's Attempts through
 * the Limiter and the Backend, and counts what happens. Everything it reports comes from
 * events it handled.
 *
 * The runner advances the shared traffic source first, then each engine to the same time.
 */
import { checkNonNegative, checkPositive } from './checks.ts'
import { createSimClock } from './clock.ts'
import { createBackend, type Backend, type BackendSpec } from './backend.ts'
import { createEventQueue } from './event-queue.ts'
import type { Limiter } from './limiter.ts'
import { createMetricsCollector, SNAPSHOT_MS, type Failure, type Snapshot } from './metrics.ts'
import { checkRetryPolicy, retryDelayMs, type RetryPolicy } from './retry-policy.ts'
import type { RandomStreams } from './rng.ts'
import type { ClientId } from './traffic.ts'
import type { Arrival, RequestId, TrafficReader } from './traffic-source.ts'

/** What an engine is built from. */
export interface EngineOptions {
  /** This engine's reader over the shared traffic log. */
  readonly traffic: TrafficReader
  readonly limiter: Limiter
  readonly retry: RetryPolicy
  readonly backend: BackendSpec
  /**
   * The run's streams. The Backend draws service times from `service`, and the Retry Policy
   * draws its jittered waits from `jitter`.
   */
  readonly streams: RandomStreams
  /**
   * How long the Limiter takes to decide, in ms: the round trip to a shared counter store
   * (D1). 0, the default, decides the moment the Attempt arrives.
   */
  readonly decisionDelayMs?: number
  /**
   * The width of the allowed-Attempt sub-buckets, in ms: the Limiter's window / 10, so a
   * burst straddling a window edge shows up (D5). 100 by default.
   */
  readonly subBucketMs?: number
}

/** Running totals since the start of the run. */
export interface Totals {
  /** New Requests and how they ended. */
  readonly requests: {
    readonly created: number
    readonly succeeded: number
    readonly rejected: number
    readonly timedOut: number
    readonly shed: number
    /** Requests that have not ended yet, counted from the open Requests themselves. */
    readonly inFlight: number
  }
  /** Attempts, retries included, and what happened to them. */
  readonly attempts: {
    /** Attempts that reached the Limiter (Offered Load). */
    readonly offered: number
    readonly allowed: number
    readonly rejected: number
    readonly delayed: number
    /** Reached the Limiter, decision not made yet. */
    readonly awaitingDecision: number
    /**
     * Delayed, and held until their release time. One whose caller has timed out stays
     * counted here until then, as it still holds its place with the Limiter.
     */
    readonly awaitingRelease: number
    /** Delayed, then sent to the Backend at their release time. */
    readonly released: number
    /** Delayed, then timed out before their release time, so never sent to the Backend. */
    readonly droppedAtRelease: number
    /** Allowed or released, then dropped because the Backend queue was full. */
    readonly shed: number
    /** Got a Backend response, discarded ones included. */
    readonly served: number
    /** Allowed or released, and still queued or in service, counted by the Backend. */
    readonly inBackend: number
    /** Timed out before their response. */
    readonly timedOut: number
  }
  /** Backend slot time spent on Attempts that had already timed out, in ms. */
  readonly wastedWorkMs: number
}

/** One Variant's simulation. */
export interface Engine {
  /**
   * Handles every event up to and including `untilMs`. The traffic source must already be
   * advanced that far. Throws a RangeError if `untilMs` is earlier than the last call.
   */
  advanceTo(untilMs: number): void
  /** Running totals, for conservation checks. */
  totals(): Totals
  /** One Snapshot per whole simulated second so far, oldest first. */
  snapshots(): readonly Snapshot[]
  /**
   * Allowed Attempts per sub-bucket since 0: `counts[i]` covers [i x bucketMs, (i + 1) x
   * bucketMs).
   */
  allowedSubBuckets(): { readonly bucketMs: number; readonly counts: readonly number[] }
}

/** A new Request, followed across its Attempts. */
interface RequestState {
  readonly id: RequestId
  readonly clientId: ClientId
  readonly arrivedAtMs: number
}

/** One Attempt of a Request. The Backend holds these as its jobs. */
interface AttemptState {
  readonly request: RequestState
  /** 1 for the first Attempt. */
  readonly attemptNo: number
  /** When it reached the Limiter, in ms. */
  readonly reachedAtMs: number
  /**
   * Waiting for its Limiter Decision, Delayed and held until its release, with the Backend
   * (queued or in service), or finished.
   */
  stage: 'deciding' | 'delayed' | 'backend' | 'done'
  /**
   * Its caller timed out. It still runs its course, but nothing it does later retries or
   * ends its Request (.scratch/engine/spec.md, decision 9).
   */
  abandoned: boolean
}

/** Events the engine schedules on its queue. New arrivals are read from the traffic log. */
type EngineEvent =
  | { readonly kind: 'serviceEnd'; readonly attempt: AttemptState }
  | { readonly kind: 'retry'; readonly request: RequestState; readonly attemptNo: number }
  | { readonly kind: 'timeout'; readonly attempt: AttemptState }
  | { readonly kind: 'decision'; readonly attempt: AttemptState }
  | { readonly kind: 'release'; readonly attempt: AttemptState }

/** Creates an engine at time 0. Throws a RangeError if an option is invalid. */
export function createEngine(options: EngineOptions): Engine {
  const { traffic, limiter, retry } = options
  checkRetryPolicy(retry)
  const decisionDelayMs = options.decisionDelayMs ?? 0
  checkNonNegative(decisionDelayMs, 'The decision latency in ms')
  const subBucketMs = options.subBucketMs ?? 100
  checkPositive(subBucketMs, 'The sub-bucket width in ms')
  const metrics = createMetricsCollector(subBucketMs)
  const backend: Backend<AttemptState> = createBackend(options.backend, options.streams.service)
  const queue = createEventQueue<EngineEvent>()
  const openRequests = new Set<RequestState>()
  const clock = createSimClock()
  let nextSampleMs = SNAPSHOT_MS
  let arrivals: Arrival[] = []
  let nextArrival = 0

  /**
   * Attempt counts only the engine sees. Everything the Snapshots also count (Requests,
   * Offered Load, Decisions, sheds) is counted once, by the metrics collector.
   */
  const attempts = {
    awaitingDecision: 0,
    awaitingRelease: 0,
    released: 0,
    droppedAtRelease: 0,
    served: 0,
    timedOut: 0,
  }

  function arrive(arrival: Arrival): void {
    const request: RequestState = {
      id: arrival.requestId,
      clientId: arrival.clientId,
      arrivedAtMs: arrival.atMs,
    }
    metrics.newRequest()
    openRequests.add(request)
    startAttempt(request, 1)
  }

  function startAttempt(request: RequestState, attemptNo: number): void {
    const attempt: AttemptState = {
      request,
      attemptNo,
      reachedAtMs: clock.now(),
      stage: 'deciding',
      abandoned: false,
    }
    metrics.offered(request.clientId)
    queue.push(clock.now() + retry.timeoutMs, { kind: 'timeout', attempt })
    if (decisionDelayMs === 0) {
      decide(attempt)
    } else {
      attempts.awaitingDecision++
      queue.push(clock.now() + decisionDelayMs, { kind: 'decision', attempt })
    }
  }

  /**
   * Asks the Limiter about `attempt` and acts on the answer. An Attempt whose caller already
   * timed out is still decided and counted: the Limiter cannot know the caller left.
   */
  function decide(attempt: AttemptState): void {
    const decision = limiter.decide(attempt.request.clientId, clock.now())
    if (decision.kind === 'delay') {
      if (!(decision.releaseAtMs >= clock.now())) {
        throw new RangeError(
          `The Limiter delayed an Attempt at ${clock.now()} ms until ${decision.releaseAtMs} ms, which is earlier`,
        )
      }
      metrics.delayed()
      attempts.awaitingRelease++
      attempt.stage = 'delayed'
      queue.push(decision.releaseAtMs, { kind: 'release', attempt })
      return
    }
    if (decision.kind === 'reject') {
      metrics.rejected()
      attempt.stage = 'done'
      if (!attempt.abandoned) retryOrEnd(attempt, 'rejected', decision.retryAfterMs)
      return
    }
    metrics.allowed(attempt.request.clientId, clock.now())
    toBackend(attempt)
  }

  /**
   * A Delayed Attempt's release time came. It goes to the Backend unless its caller already
   * timed out: then nobody is waiting for it, and it is dropped without using a slot.
   */
  function release(attempt: AttemptState): void {
    attempts.awaitingRelease--
    if (attempt.abandoned) {
      attempts.droppedAtRelease++
      attempt.stage = 'done'
      return
    }
    attempts.released++
    toBackend(attempt)
  }

  /** Submits an allowed or released Attempt to the Backend, which starts, queues or sheds it. */
  function toBackend(attempt: AttemptState): void {
    const result = backend.submit(attempt, clock.now())
    if (result.kind === 'shed') {
      metrics.shed()
      attempt.stage = 'done'
      if (!attempt.abandoned) retryOrEnd(attempt, 'shed')
      return
    }
    attempt.stage = 'backend'
    if (result.kind === 'started') queue.push(result.endsAtMs, { kind: 'serviceEnd', attempt })
    if (attempt.abandoned) backend.abandon(attempt, clock.now())
  }

  /**
   * The caller stops waiting. An Attempt that already finished is left alone. One still with
   * the Backend keeps its slot or queue place, and the rest of its service is Wasted Work.
   */
  function timeout(attempt: AttemptState): void {
    if (attempt.stage === 'done') return
    attempts.timedOut++
    attempt.abandoned = true
    if (attempt.stage === 'backend') backend.abandon(attempt, clock.now())
    retryOrEnd(attempt, 'timedOut')
  }

  /**
   * An Attempt failed: the Retry Policy schedules the next Attempt, or the Request ends with
   * this failure. A Reject passes on the Limiter's retry time, if it gave one. Called once per
   * Attempt at most: an abandoned Attempt's later reject or shed never comes here, because its
   * timeout already did.
   */
  function retryOrEnd(attempt: AttemptState, failure: Failure, retryAfterMs?: number): void {
    const failed =
      retryAfterMs === undefined
        ? { attemptNo: attempt.attemptNo, failure }
        : { attemptNo: attempt.attemptNo, failure, retryAfterMs }
    const delayMs = retryDelayMs(retry, failed, options.streams.jitter)
    if (delayMs === null) {
      metrics.failed(failure)
      openRequests.delete(attempt.request)
      return
    }
    queue.push(clock.now() + delayMs, {
      kind: 'retry',
      request: attempt.request,
      attemptNo: attempt.attemptNo + 1,
    })
  }

  /**
   * The Backend responds. The slot goes to the next queued Attempt. The response completes
   * the Request unless its caller already timed out, in which case it is discarded.
   */
  function serviceEnd(attempt: AttemptState): void {
    attempts.served++
    attempt.stage = 'done'
    const next = backend.finish(attempt, clock.now())
    if (next !== null) queue.push(next.endsAtMs, { kind: 'serviceEnd', attempt: next.job })
    if (attempt.abandoned) return
    const nowMs = clock.now()
    metrics.succeeded(nowMs, nowMs - attempt.reachedAtMs, nowMs - attempt.request.arrivedAtMs)
    openRequests.delete(attempt.request)
  }

  function handle(event: EngineEvent): void {
    switch (event.kind) {
      case 'serviceEnd':
        serviceEnd(event.attempt)
        return
      case 'retry':
        startAttempt(event.request, event.attemptNo)
        return
      case 'timeout':
        timeout(event.attempt)
        return
      case 'decision':
        attempts.awaitingDecision--
        decide(event.attempt)
        return
      case 'release':
        release(event.attempt)
        return
    }
  }

  /**
   * Takes the Snapshot of every whole second ending at or before `timeMs`. Called before
   * handling an event at `timeMs`, so events at exactly a second's end count in the next one.
   */
  function sampleUpTo(timeMs: number): void {
    while (nextSampleMs <= timeMs) {
      const { busySlotMs, wastedSlotMs } = backend.measure(nextSampleMs)
      metrics.sample(nextSampleMs, {
        busySlotMs,
        wastedSlotMs,
        queueDepth: backend.queueDepth(),
        slots: options.backend.slots,
      })
      nextSampleMs += SNAPSHOT_MS
    }
  }

  return {
    advanceTo(untilMs) {
      if (!Number.isFinite(untilMs) || untilMs < clock.now()) {
        throw new RangeError(
          `The engine can only advance forward from ${clock.now()} ms, got ${untilMs}`,
        )
      }
      arrivals = arrivals.slice(nextArrival).concat(traffic.read(untilMs))
      nextArrival = 0
      for (;;) {
        const event = queue.peek()
        const arrival = arrivals[nextArrival]
        const eventMs = event?.timeMs ?? Number.POSITIVE_INFINITY
        const arrivalMs = arrival?.atMs ?? Number.POSITIVE_INFINITY
        const nextMs = Math.min(eventMs, arrivalMs)
        if (nextMs > untilMs) break
        sampleUpTo(nextMs)
        if (event !== undefined && eventMs <= arrivalMs) {
          queue.pop()
          clock.advanceTo(eventMs)
          handle(event.event)
        } else if (arrival !== undefined) {
          nextArrival++
          clock.advanceTo(arrivalMs)
          arrive(arrival)
        }
      }
      sampleUpTo(untilMs)
      clock.advanceTo(untilMs)
    },
    snapshots() {
      return metrics.snapshots()
    },
    allowedSubBuckets() {
      return { bucketMs: subBucketMs, counts: metrics.allowedSubBuckets() }
    },
    totals() {
      const counted = metrics.totals()
      return {
        requests: {
          created: counted.demand,
          succeeded: counted.goodput,
          ...counted.failed,
          inFlight: openRequests.size,
        },
        attempts: {
          offered: counted.offeredLoad,
          allowed: counted.allowed,
          rejected: counted.rejected,
          delayed: counted.delayed,
          shed: counted.shed,
          ...attempts,
          inBackend: backend.busySlots() + backend.queueDepth(),
        },
        wastedWorkMs: backend.measure(clock.now()).wastedSlotMs,
      }
    },
  }
}
