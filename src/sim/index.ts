/**
 * The simulation engine's public surface.
 *
 * Everything under src/sim is pure TypeScript: no DOM, no real timers, no wall clock and
 * no unseeded randomness. tsconfig.sim.json (no DOM types) and tests/sim-boundary.test.ts
 * enforce that.
 *
 * Only what the runner and UI build on is exported here. Building blocks (the single-stream
 * constructor, the arrival-process pieces) stay out of this barrel, so code outside the engine
 * cannot make a stream outside the named set or time arrivals on its own; engine modules and
 * tests import them from their own files.
 */
export { checkBackendSpec, type BackendSpec } from './backend.ts'
export { checkNonNegative, checkPositive } from './checks.ts'
export { createSimClock, type SimClock } from './clock.ts'
export {
  createEngine,
  type AllowedSubBuckets,
  type Engine,
  type EngineOptions,
  type Totals,
} from './engine.ts'
export { createEventQueue, type EventQueue, type ScheduledEvent } from './event-queue.ts'
export {
  allowedPerSecond,
  createLimiter,
  limiterWindow,
  type FixedWindowSpec,
  type KeyBy,
  type Limiter,
  type LimiterDecision,
  type LimiterSpec,
  type SlidingCounterSpec,
  type TokenBucketSpec,
} from './limiter.ts'
export { WARM_UP_MS, type Snapshot } from './metrics.ts'
export { checkRetryPolicy, type RetryPolicy } from './retry-policy.ts'
export {
  createStreams,
  MAX_SEED,
  STREAM_NAMES,
  type RandomStream,
  type RandomStreams,
  type StreamName,
} from './rng.ts'
export type { BurstyPhases, ClientId, TrafficShape, TrafficSpec } from './traffic.ts'
export {
  createTrafficSource,
  type Arrival,
  type ControlChange,
  type ControlEvent,
  type RequestId,
  type ScriptedArrivals,
  type TrafficReader,
  type TrafficSource,
  type TrafficSourceOptions,
} from './traffic-source.ts'
export {
  createDiagnoser,
  HYSTERESIS_FRACTION,
  LOSS_WINDOW_SNAPSHOTS,
  QUEUE_OVERFLOW_BROKEN_SHARE,
  QUEUE_OVERFLOW_WARN_SHARE,
  type Diagnoser,
  type DiagnoserOptions,
  type FailureMode,
  type Finding,
  type Fix,
  type Severity,
} from './diagnosis.ts'
