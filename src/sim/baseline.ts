/**
 * Baseline p99 (D4): the p99 of the Backend's service times on their own, with no waiting, as
 * a fixed property of its spec. It is well defined even when a Scenario starts overloaded,
 * which a p99 measured early in the run is not. Pure arithmetic: no draws, no clock.
 */
import type { BackendSpec } from './backend.ts'

/** The share of service times at or below the baseline. */
const BASELINE_QUANTILE = 0.99

/**
 * Bisection stops when the bracket is this narrow, as a share of the mean: 1e-9 of 50 ms is
 * far below anything shown (one decimal of a millisecond).
 */
const BISECTION_TOLERANCE = 1e-9

/** Series and continued fraction stop when a term changes the result by less than this. */
const SERIES_EPSILON = 1e-15

/** Lanczos coefficients (g = 7, n = 9), good to about 15 significant digits. */
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
]

/** ln Gamma(a) for a > 0. */
function lnGamma(a: number): number {
  if (a < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * a)) - lnGamma(1 - a)
  const x = a - 1
  let sum = LANCZOS[0] ?? 0
  for (let i = 1; i < LANCZOS.length; i++) sum += (LANCZOS[i] ?? 0) / (x + i)
  const t = x + 7.5
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(sum)
}

/**
 * The regularized lower incomplete gamma P(a, x): the share of a gamma(shape a, scale 1)
 * distribution at or below x. A series below a + 1, a continued fraction above (Numerical
 * Recipes, 6.2), each where it converges fast.
 */
function regularizedGammaP(a: number, x: number): number {
  if (x <= 0) return 0
  const front = Math.exp(-x + a * Math.log(x) - lnGamma(a))
  if (x < a + 1) {
    let term = 1 / a
    let sum = term
    for (let n = 1; n < 10_000 && Math.abs(term) > Math.abs(sum) * SERIES_EPSILON; n++) {
      term *= x / (a + n)
      sum += term
    }
    return front * sum
  }
  // Q(a, x) by Lentz's method, then P = 1 - Q.
  const tiny = 1e-300
  let b = x + 1 - a
  let c = 1 / tiny
  let d = 1 / b
  let h = d
  for (let i = 1; i < 10_000; i++) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < tiny) d = tiny
    c = b + an / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const delta = d * c
    h *= delta
    if (Math.abs(delta - 1) < SERIES_EPSILON) break
  }
  return 1 - front * h
}

/**
 * The p99 of the Backend's service time in ms: gamma with shape 1 / cv^2 and scale
 * mean x cv^2 (`serviceTimeMs` in backend.ts). cv 0 is exactly the mean; cv 1 is exponential,
 * mean x ln 100. Found by bisection on P(shape, x / scale) = 0.99.
 */
export function baselineP99Ms({ meanMs, cv }: BackendSpec): number {
  if (cv === 0) return meanMs
  const shape = 1 / (cv * cv)
  const scale = meanMs * cv * cv
  let low = 0
  let high = meanMs
  while (regularizedGammaP(shape, high / scale) < BASELINE_QUANTILE) high *= 2
  while (high - low > meanMs * BISECTION_TOLERANCE) {
    const mid = (low + high) / 2
    if (regularizedGammaP(shape, mid / scale) < BASELINE_QUANTILE) low = mid
    else high = mid
  }
  return (low + high) / 2
}
