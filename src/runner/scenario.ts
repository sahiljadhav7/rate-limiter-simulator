/**
 * A Scenario: one lesson, as the traffic every Variant shares, the Backend behind them, and
 * one to three Variants that differ only in Limiter and Retry Policy.
 */
import {
  checkBackendSpec,
  checkRetryPolicy,
  createLimiter,
  createStreams,
  limiterWindow,
  createTrafficSource,
  type BackendSpec,
  type ControlEvent,
  type LimiterSpec,
  type RetryPolicy,
  type ScriptedArrivals,
  type TrafficSource,
  type TrafficSpec,
} from '../sim/index.ts'

/** The most Variants a Scenario compares side by side. */
export const MAX_VARIANTS = 3

/** One column of the comparison: a Limiter and a Retry Policy in front of the shared Backend. */
export interface VariantConfig {
  /** What the student sees above the Variant's panel. Unique within a Scenario. */
  readonly label: string
  /** The rate limiting algorithm this Variant is about. */
  readonly limiter: LimiterSpec
  /** What a client does after a failed Attempt. */
  readonly retry: RetryPolicy
  /**
   * Changes to the Scenario's Backend for this Variant alone, such as more slots: a Variant made
   * by applying a fix may run its own Backend (CONTEXT.md "Variant"). Left out, it runs the
   * Scenario's. Read it through `variantBackend`.
   */
  readonly backend?: Partial<BackendSpec>
}

/**
 * One lesson: the traffic every Variant shares, the Backend behind them, and what changes
 * between Variants. Seed plus the control timeline replays a run exactly.
 */
export interface Scenario {
  /** Stable name, for links and tests. */
  readonly id: string
  /** What the student sees in the Scenario picker. */
  readonly title: string
  /** What to watch. */
  readonly lesson: string
  /** Why it happens, in plain words. */
  readonly why: string
  /** What this models. */
  readonly models: string
  /** What it leaves out. */
  readonly leavesOut: string
  /** The root seed of every random stream. Seed plus control timeline replays a run. */
  readonly seed: number
  /** One spec for all the traffic; its `clients` and `greedy` describe several Clients. */
  readonly traffic: TrafficSpec
  /** Load changes the Scenario makes on its own, in time order. */
  readonly controls?: readonly ControlEvent[]
  /** Requests at exact times, such as an Edge Burst (D12). */
  readonly scriptedArrivals?: readonly ScriptedArrivals[]
  readonly backend: BackendSpec
  /** One to three. */
  readonly variants: readonly VariantConfig[]
}

/**
 * Throws a RangeError if `scenario` cannot run, so a bad Scenario fails where it is built.
 * The seed, traffic, controls, scripted arrivals, Limiters, Retry Policies and Backend are
 * checked by the same code that runs them: the streams, a throwaway traffic source and each
 * Limiter are built and dropped.
 */
export function checkScenario(scenario: Scenario): void {
  const { variants } = scenario
  if (variants.length < 1 || variants.length > MAX_VARIANTS) {
    throw new RangeError(`A Scenario has 1 to ${MAX_VARIANTS} Variants, got ${variants.length}`)
  }
  const labels = variants.map((variant) => variant.label)
  if (new Set(labels).size !== labels.length) {
    throw new RangeError(`Variant labels must differ, got ${labels.join(', ')}`)
  }
  createScenarioSource(scenario)
  checkBackendSpec(scenario.backend)
  variants.forEach((variant, i) => {
    createLimiter(variant.limiter)
    checkRetryPolicy(variant.retry)
    if (variant.backend === undefined) return
    try {
      checkBackendSpec(variantBackend(scenario, i))
    } catch (error) {
      if (!(error instanceof RangeError)) throw error
      throw new RangeError(`The Backend of ${variant.label}: ${error.message}`)
    }
  })
}

/**
 * The Backend Variant `index` runs: the Scenario's, with the Variant's own changes over it.
 * Throws a RangeError for a Variant the Scenario does not have. It does not check the result;
 * `checkScenario` does.
 */
export function variantBackend(scenario: Scenario, index: number): BackendSpec {
  const variant = scenario.variants[index]
  if (variant === undefined) {
    throw new RangeError(
      `The Scenario has ${scenario.variants.length} Variants, so there is no Variant ${index}`,
    )
  }
  return { ...scenario.backend, ...variant.backend }
}

/**
 * The Scenario's shared traffic source at 0, from its seed, scripted controls and scripted
 * arrivals. Throws a RangeError if any of them is invalid.
 */
export function createScenarioSource(scenario: Scenario): TrafficSource {
  return createTrafficSource({
    spec: scenario.traffic,
    stream: createStreams(scenario.seed).traffic,
    ...(scenario.controls && { controls: scenario.controls }),
    ...(scenario.scriptedArrivals && { scriptedArrivals: scenario.scriptedArrivals }),
  })
}

/**
 * Sub-buckets per Limiter window. Ten is fine enough that the rolling count of the last
 * window, summed from them, catches a burst straddling a window edge (D5).
 */
const SUB_BUCKETS_PER_WINDOW = 10

/** The sub-bucket width for a Limiter with no window, in ms. */
const WINDOWLESS_SUB_BUCKET_MS = 100

/**
 * The width of a Variant's allowed-Attempt sub-buckets, in ms: a tenth of the Limiter's
 * window, so a burst straddling a window edge shows up (D5). Token bucket has no window, so it
 * uses 100 ms.
 */
export function subBucketMsFor(limiter: LimiterSpec): number {
  const window = limiterWindow(limiter)
  return window === null ? WINDOWLESS_SUB_BUCKET_MS : window.windowMs / SUB_BUCKETS_PER_WINDOW
}
