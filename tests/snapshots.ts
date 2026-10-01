/** Hand-made Snapshots for tests that feed diagnosis or the panel without running an engine. */
import type { Snapshot } from '../src/sim/metrics.ts'

/** A Snapshot ending at `t` (ms) with every count 0 and no percentiles, plus `fields`. */
export function snapshotAt(t: number, fields: Partial<Snapshot> = {}): Snapshot {
  return {
    t,
    warmUp: t <= 5000,
    demand: 0,
    offeredLoad: 0,
    retries: 0,
    quickRetries: 0,
    allowed: 0,
    rejected: 0,
    delayed: 0,
    goodput: 0,
    failed: { rejected: 0, timedOut: 0, shed: 0 },
    wastedWorkMs: 0,
    backendUtil: 0,
    queueDepth: 0,
    peakQueueDepth: 0,
    shed: 0,
    attemptsTimedOut: 0,
    p50: null,
    p95: null,
    p99: null,
    e2eP50: null,
    e2eP95: null,
    e2eP99: null,
    perClient: {},
    ...fields,
  }
}
