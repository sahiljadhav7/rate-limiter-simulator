/**
 * The simulation engine's public surface.
 *
 * Everything under src/sim is pure TypeScript: no DOM, no real timers, no wall clock and
 * no unseeded randomness. tsconfig.sim.json (no DOM types) and tests/sim-boundary.test.ts
 * enforce that.
 */
export { createSimClock, type SimClock } from './clock.ts'
export { createEventQueue, type EventQueue, type ScheduledEvent } from './event-queue.ts'
export {
  createRandomStream,
  createStreams,
  MAX_SEED,
  STREAM_NAMES,
  type RandomStream,
  type RandomStreams,
  type StreamName,
} from './rng.ts'
export {
  checkTrafficSpec,
  clientWeights,
  gapWork,
  pickClient,
  rateProfile,
  timeToWork,
  unitExponential,
  workBetween,
  type BurstyPhases,
  type ClientId,
  type RateProfile,
  type TrafficShape,
  type TrafficSpec,
} from './traffic.ts'
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
