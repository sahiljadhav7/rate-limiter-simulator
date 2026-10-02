/**
 * Time cut into equal buckets that repeat from an origin: a Limiter's windows, bursty on/off cycles
 * and the allowed-Attempt sub-buckets. Bucket k covers [start(k), start(k + 1)), half-open.
 *
 * Every edge comes from `bucketStart`, and `bucketAt` checks against those same edges. Working
 * out an edge two ways (k x width, or dividing a time by width) can round differently when the
 * width is not a whole number of ms, and then a time on an edge lands in the wrong bucket.
 */

/** Where bucket `k` starts, in ms. The one way every edge is computed. */
export function bucketStart(k: number, widthMs: number, originMs = 0): number {
  return originMs + k * widthMs
}

/**
 * The bucket `timeMs` falls in: the k with bucketStart(k) <= timeMs < bucketStart(k + 1).
 * Dividing alone can round across an edge (2100 / (100 / 3) comes out just under 63), so the
 * result is corrected against the edges themselves.
 */
export function bucketAt(timeMs: number, widthMs: number, originMs = 0): number {
  const k = Math.floor((timeMs - originMs) / widthMs)
  if (timeMs < bucketStart(k, widthMs, originMs)) return k - 1
  if (timeMs >= bucketStart(k + 1, widthMs, originMs)) return k + 1
  return k
}
