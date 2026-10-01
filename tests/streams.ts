/** Hand-made random streams for tests: fixed values, and counting how many draws were made. */
import type { RandomStream } from '../src/sim/rng.ts'

/** A stream that replays fixed values, for edge cases a real stream would take ages to hit. */
export function fixedStream(values: number[]): RandomStream {
  let i = 0
  return {
    next() {
      const value = values[i++ % values.length]
      if (value === undefined) throw new Error('fixedStream needs at least one value')
      return value
    },
  }
}

/** A stream that always returns `value` and counts its draws. */
export function countingStream(value = 0.5): RandomStream & { readonly draws: number } {
  let draws = 0
  return {
    next() {
      draws++
      return value
    },
    get draws() {
      return draws
    },
  }
}
