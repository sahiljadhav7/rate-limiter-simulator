/**
 * The metrics collector of one engine: it counts what the engine handles and turns each
 * simulated second into a Snapshot. Every value is measured from events; a value with
 * nothing to measure is null, never a guess (.scratch/engine/spec.md, decisions 3, 5, 8).
 */
import { bucketAt } from './buckets.ts'
import { createFifo } from './fifo.ts'
import type { ClientId } from './traffic.ts'

/** How long each Snapshot covers, in ms. */
export const SNAPSHOT_MS = 1000

/**
 * How far back latency percentiles look, in ms. Five seconds holds enough latencies for a
 * steady p99 at low Demand, and still shows a change within a few seconds.
 */
export const PERCENTILE_WINDOW_MS = 5000

/** The warm-up: Snapshots ending at or before this, in ms, are flagged and not diagnosed (D4). */
export const WARM_UP_MS = 5000

/** What one simulated second looked like. Counts are for that second only. */
export interface Snapshot {
  /** The end of the second, in ms: the Snapshot covers [t - 1000, t). */
  readonly t: number
  /** Part of the first 5 s, which diagnosis leaves out while the queue fills. */
  readonly warmUp: boolean
  /** New Requests, counted as they arrived, scripted and burst ones included. */
  readonly demand: number
  /** Attempts reaching the Limiter, retries included. */
  readonly offeredLoad: number
  /** Limiter Decisions made this second. */
  readonly allowed: number
  readonly rejected: number
  readonly delayed: number
  /** Requests that Succeeded. */
  readonly goodput: number
  /** Requests that ended failed, by how their last Attempt failed. */
  readonly failed: { readonly rejected: number; readonly timedOut: number; readonly shed: number }
  /** Backend slot time spent on Attempts that had already timed out, in ms. */
  readonly wastedWorkMs: number
  /** Fraction of Backend slot time that was busy, from 0 to 1. */
  readonly backendUtil: number
  /** Attempts waiting for a Backend slot at the end of the second. */
  readonly queueDepth: number
  /** Attempts dropped because the Backend queue was full. */
  readonly shed: number
  /** Attempt latency percentiles over the last 5 s, in ms; null when none completed. */
  readonly p50: number | null
  readonly p95: number | null
  readonly p99: number | null
  /** End-to-end latency percentiles of Succeeded Requests over the last 5 s, in ms. */
  readonly e2eP50: number | null
  readonly e2eP95: number | null
  readonly e2eP99: number | null
  /** Per Client seen so far: Attempts that reached the Limiter, and those allowed. */
  readonly perClient: Readonly<
    Record<ClientId, { readonly offeredLoad: number; readonly allowed: number }>
  >
}

/** A Failure is how a failed Request's last Attempt failed. */
export type Failure = 'rejected' | 'timedOut' | 'shed'

/**
 * The value at percentile `p` (0 to 1) of `sorted`, by nearest rank: the smallest recorded
 * value with at least p of the values at or below it. Always a latency that really
 * happened, never an interpolation. The small nudge stops rounding in p x n (such as
 * 0.95 x 20 coming out a hair above 19) from moving up a rank.
 */
function nearestRank(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null
  const rank = Math.max(1, Math.ceil(p * sorted.length - 1e-9))
  return sorted[rank - 1] ?? null
}

/** Latencies recorded over time, from which percentiles over the recent window are read. */
function createLatencyWindow() {
  const recorded = createFifo<{ readonly atMs: number; readonly latencyMs: number }>()
  return {
    record(atMs: number, latencyMs: number): void {
      recorded.push({ atMs, latencyMs })
    },
    /** p50, p95 and p99 of latencies recorded in [endMs - window, endMs). */
    percentiles(endMs: number): [number | null, number | null, number | null] {
      while ((recorded.peek()?.atMs ?? Infinity) < endMs - PERCENTILE_WINDOW_MS) recorded.shift()
      const sorted = recorded
        .toArray()
        .map((entry) => entry.latencyMs)
        .sort((a, b) => a - b)
      return [nearestRank(sorted, 0.5), nearestRank(sorted, 0.95), nearestRank(sorted, 0.99)]
    },
  }
}

/** Counts of what the engine handled: over one second, or since the start of the run. */
export interface Counts {
  demand: number
  offeredLoad: number
  allowed: number
  rejected: number
  delayed: number
  goodput: number
  failed: { rejected: number; timedOut: number; shed: number }
  shed: number
}

function emptyCounts(): Counts {
  return {
    demand: 0,
    offeredLoad: 0,
    allowed: 0,
    rejected: 0,
    delayed: 0,
    goodput: 0,
    failed: { rejected: 0, timedOut: 0, shed: 0 },
    shed: 0,
  }
}

/** Backend state read at the end of a second. */
export interface BackendReading {
  /** Busy and wasted slot time since 0, in ms. */
  readonly busySlotMs: number
  readonly wastedSlotMs: number
  readonly queueDepth: number
  readonly slots: number
}

/** Creates a collector. Allowed Attempts are also counted in sub-buckets of `subBucketMs`. */
export function createMetricsCollector(subBucketMs: number) {
  /** This second's counts, and the running totals since 0. Every event goes into both. */
  let counts = emptyCounts()
  const sinceStart = emptyCounts()
  function add(update: (into: Counts) => void): void {
    update(counts)
    update(sinceStart)
  }
  const perClient = new Map<ClientId, { offeredLoad: number; allowed: number }>()
  const attemptLatency = createLatencyWindow()
  const e2eLatency = createLatencyWindow()
  const subBuckets: number[] = []
  const snapshots: Snapshot[] = []
  let busyBefore = 0
  let wastedBefore = 0

  function client(clientId: ClientId): { offeredLoad: number; allowed: number } {
    let entry = perClient.get(clientId)
    if (entry === undefined) {
      entry = { offeredLoad: 0, allowed: 0 }
      perClient.set(clientId, entry)
    }
    return entry
  }

  return {
    newRequest(): void {
      add((c) => c.demand++)
    },
    offered(clientId: ClientId): void {
      add((c) => c.offeredLoad++)
      client(clientId).offeredLoad++
    },
    allowed(clientId: ClientId, nowMs: number): void {
      add((c) => c.allowed++)
      client(clientId).allowed++
      const index = bucketAt(nowMs, subBucketMs)
      while (subBuckets.length <= index) subBuckets.push(0)
      subBuckets[index] = (subBuckets[index] ?? 0) + 1
    },
    rejected(): void {
      add((c) => c.rejected++)
    },
    delayed(): void {
      add((c) => c.delayed++)
    },
    shed(): void {
      add((c) => c.shed++)
    },
    /** A Request Succeeded at `nowMs`; records both latencies. */
    succeeded(nowMs: number, attemptMs: number, endToEndMs: number): void {
      add((c) => c.goodput++)
      attemptLatency.record(nowMs, attemptMs)
      e2eLatency.record(nowMs, endToEndMs)
    },
    failed(failure: Failure): void {
      add((c) => c.failed[failure]++)
    },
    /**
     * Closes the second ending at `endMs` and starts the next. Call it before handling any
     * event at `endMs` or later, with the Backend read at `endMs`.
     */
    sample(endMs: number, backend: BackendReading): void {
      const [p50, p95, p99] = attemptLatency.percentiles(endMs)
      const [e2eP50, e2eP95, e2eP99] = e2eLatency.percentiles(endMs)
      // Busy and wasted time are running totals, so this second's share is a difference of
      // two large floats. Rounding in it can land a hair outside what is possible (utilization
      // 1.000000000015 after an hour at full load), so it is kept within [0, capacity]. Only
      // rounding can go past capacity: the Backend never has more than `slots` busy.
      const capacityMs = backend.slots * SNAPSHOT_MS
      const within = (ms: number) => Math.min(capacityMs, Math.max(0, ms))
      snapshots.push({
        t: endMs,
        warmUp: endMs <= WARM_UP_MS,
        ...counts,
        wastedWorkMs: within(backend.wastedSlotMs - wastedBefore),
        backendUtil: within(backend.busySlotMs - busyBefore) / capacityMs,
        queueDepth: backend.queueDepth,
        p50,
        p95,
        p99,
        e2eP50,
        e2eP95,
        e2eP99,
        perClient: Object.fromEntries([...perClient].map(([id, entry]) => [id, { ...entry }])),
      })
      // Sub-buckets with no allowed Attempt read 0, not missing, up to the end of the second.
      while (subBuckets.length < bucketAt(endMs, subBucketMs)) subBuckets.push(0)
      busyBefore = backend.busySlotMs
      wastedBefore = backend.wastedSlotMs
      counts = emptyCounts()
      for (const entry of perClient.values()) {
        entry.offeredLoad = 0
        entry.allowed = 0
      }
    },
    /** Counts since the start of the run, as a copy. */
    totals(): Counts {
      return { ...sinceStart, failed: { ...sinceStart.failed } }
    },
    snapshots(): readonly Snapshot[] {
      return snapshots
    },
    allowedSubBuckets(): readonly number[] {
      return subBuckets
    },
  }
}
