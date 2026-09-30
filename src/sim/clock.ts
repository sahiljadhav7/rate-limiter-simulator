/**
 * The engine's only notion of time: milliseconds of simulated time. The engine loop moves
 * it to each event's timestamp; wall-clock pacing, speed and frames belong to src/runner.
 */
import { checkNonNegative, checkNumber } from './checks.ts'

/** The current simulated time, which only ever moves forward. */
export interface SimClock {
  /** The current simulated time in ms. */
  now(): number
  /**
   * Moves the clock to `timeMs`. Staying at the current time is allowed, because several
   * events can share a timestamp. Throws a RangeError if `timeMs` is earlier than now
   * (time going backwards is always an engine bug) or is NaN or infinite; the time is
   * left unchanged when it throws.
   */
  advanceTo(timeMs: number): void
}

/**
 * Creates a clock at `startMs` (0 by default). Throws a RangeError if the start is negative,
 * NaN or infinite.
 */
export function createSimClock(startMs = 0): SimClock {
  checkNonNegative(startMs, 'The start time in ms')
  let current = startMs
  return {
    now() {
      return current
    },
    advanceTo(timeMs) {
      checkNumber(timeMs, () => true, 'Simulated time must be a finite number of ms')
      if (timeMs < current) {
        throw new RangeError(`Simulated time cannot go backwards: at ${current} ms, got ${timeMs}`)
      }
      current = timeMs
    },
  }
}
