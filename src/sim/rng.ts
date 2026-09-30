/**
 * The engine's only source of randomness: mulberry32 generators, one per named stream.
 */

/** A seeded source of uniform floats in [0, 1). */
export interface RandomStream {
  /** The next float in [0, 1). */
  next(): number
}

/** The largest seed: seeds are 32-bit unsigned integers. */
export const MAX_SEED = 0xffffffff

/**
 * Returns the seed if it is a whole number in [0, MAX_SEED], and throws otherwise.
 * Seeds are rejected rather than normalised: truncating or wrapping would quietly map
 * different seeds (1.5 and 1, or -1 and MAX_SEED) to the same run.
 */
function checkSeed(seed: number): number {
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) {
    throw new RangeError(`Seed must be a whole number from 0 to ${MAX_SEED}, got ${seed}`)
  }
  return seed
}

/**
 * A mulberry32 generator. Mulberry32 is small, fast and has a 32-bit state, which is
 * enough for a teaching simulator and easy to replay from one number.
 */
export function createRandomStream(seed: number): RandomStream {
  let state = checkSeed(seed)
  return {
    next() {
      state = (state + 0x6d2b79f5) >>> 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    },
  }
}

/** The engine's random streams. Each part of the model draws only from its own. */
export const STREAM_NAMES = ['traffic', 'service', 'jitter'] as const

/**
 * A named stream: `traffic` for arrivals, `service` for Backend service times, `jitter`
 * for retry jitter. A union, so a misspelt name fails to type-check instead of quietly
 * creating a new stream.
 */
export type StreamName = (typeof STREAM_NAMES)[number]

/** One independent stream per name, all derived from one root seed. */
export type RandomStreams = Readonly<Record<StreamName, RandomStream>>

/** FNV-1a, 32-bit, over the UTF-16 code units of the name (stream names are ASCII). */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** The murmur3 32-bit finalizer: a bijection that spreads every input bit over the output. */
function fmix32(value: number): number {
  let h = value
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/**
 * The seed of one named stream: fmix32(rootSeed XOR fnv1a32(name)).
 *
 * Why this scheme: FNV-1a turns the name into a fixed 32-bit tag, and fmix32 scrambles
 * it with the root seed. Mulberry32's state is a counter, so seeds that differ by a small
 * step would give streams that are shifted copies of each other; fmix32 makes nearby
 * inputs land far apart. fmix32 is a bijection, so for one root seed, streams with
 * different name hashes always get different seeds. Two streams could still overlap
 * after a long run (about N / 2^32 chance per pair for N draws), which is negligible here.
 */
function deriveStreamSeed(rootSeed: number, name: StreamName): number {
  return fmix32((rootSeed ^ fnv1a32(name)) >>> 0)
}

/**
 * Creates the traffic, service and jitter streams from one root seed. They are separate
 * generators, so an extra draw in one never shifts the others. Throws a RangeError if the
 * root seed is not a whole number from 0 to MAX_SEED.
 */
export function createStreams(rootSeed: number): RandomStreams {
  const seed = checkSeed(rootSeed)
  return {
    traffic: createRandomStream(deriveStreamSeed(seed, 'traffic')),
    service: createRandomStream(deriveStreamSeed(seed, 'service')),
    jitter: createRandomStream(deriveStreamSeed(seed, 'jitter')),
  }
}
