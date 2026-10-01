/**
 * The runner: one shared traffic source and one engine per Variant, advanced together in
 * simulated time. It is pure, like src/sim: no timers, no DOM, no wall clock. The UI calls
 * `tick` once per animation frame with the frame's wall time, and owns the frame loop and the
 * check that the tab is visible.
 */
import {
  checkNonNegative,
  createEngine,
  createLimiter,
  createStreams,
  type AllowedSubBuckets,
  type ControlChange,
  type ControlEvent,
  type Engine,
  type Snapshot,
  type Totals,
  type TrafficSource,
} from '../sim/index.ts'
import {
  checkScenario,
  createScenarioSource,
  subBucketMsFor,
  type Scenario,
  type VariantConfig,
} from './scenario.ts'

/**
 * The most wall time one frame may count, in ms. A frame that took longer, or the first frame
 * after the tab comes back from the background, advances as if it took this long, so the run
 * never jumps ahead by seconds at once.
 */
export const FRAME_CAP_MS = 100

/**
 * How far every Variant moves together before the runner looks at the event budget, in ms of
 * simulated time. Small enough that a frame stops close to its budget, large enough that the
 * steps cost little. Chunk invariance means the step size never changes a run's results.
 */
export const SUB_STEP_MS = 50

/**
 * The most events one frame handles by default, summed over every Variant. Past it the frame
 * ends early and the run goes slower than the speed asked for, rather than freezing the tab.
 * Measured at about 870,000 events per second of wall time (three Variants at 1,000 rps), so
 * 12,000 events take about 14 ms and still fit a 16.7 ms frame at 60 fps.
 */
export const DEFAULT_EVENT_BUDGET = 12_000

/** How fast simulated time runs against wall time. */
export const SPEEDS = [0.5, 1, 10] as const
export type Speed = (typeof SPEEDS)[number]

/** One Variant as the UI draws it. */
export interface VariantView {
  readonly label: string
  /** One per whole simulated second so far, oldest first. */
  readonly snapshots: readonly Snapshot[]
  readonly totals: Totals
  /** Allowed Attempts per tenth of a window, for the boundary-burst chart (D5). */
  readonly allowedSubBuckets: AllowedSubBuckets
}

/** What the UI reads after each frame. */
export interface RunnerView {
  /** How far the run has got, in ms of simulated time. Every Variant is at this time. */
  readonly simMs: number
  readonly paused: boolean
  readonly speed: Speed
  /** The last frame hit the event budget: the run is going slower than the speed asked for. */
  readonly behind: boolean
  /** Events handled since 0, summed over every Variant: what the ledger counts. */
  readonly eventsHandled: number
  /** Every load change so far, scripted and live. Seed plus this replays the run. */
  readonly timeline: readonly ControlEvent[]
  readonly variants: readonly VariantView[]
}

/** How a runner is set up, beyond its Scenario. */
export interface RunnerOptions {
  /**
   * The most events one frame may handle, summed over every Variant: DEFAULT_EVENT_BUDGET
   * when left out. Infinity turns it off. A frame always takes at least one sub-step, and
   * checks the budget after each, so it can go over by one sub-step's events.
   */
  readonly eventBudget?: number
}

/** Runs one Scenario, frame by frame. Every Variant is always at the same simulated time. */
export interface Runner {
  /**
   * Advances every Variant by `wallMs` x speed of simulated time, with `wallMs` capped at
   * FRAME_CAP_MS, in sub-steps of SUB_STEP_MS. Ends early, between sub-steps, once the frame
   * has handled the event budget, and then `view().behind` is true until a frame fits. Does
   * nothing while paused. Returns whether this frame hit the budget, so a caller that reads the
   * view less often than every frame still sees every slow frame. Throws a RangeError unless
   * `wallMs` is a finite number, 0 or more.
   */
  tick(wallMs: number): boolean
  /** Stops simulated time until `resume`; controls still apply, at the paused time. */
  pause(): void
  resume(): void
  /**
   * Starts a fresh run of the Scenario from 0: the same seed and scripted controls, with any
   * live changes dropped. The speed and whether it is paused stay as they were.
   */
  reset(): void
  /** Throws a RangeError for a speed not in SPEEDS. */
  setSpeed(speed: Speed): void
  /**
   * Applies a live load change at the current simulated time and records it in the timeline.
   * Throws a RangeError on an invalid change, leaving the run unchanged.
   */
  applyControl(change: ControlChange): void
  /** Where the run is now, read fresh from every engine. Reading changes nothing. */
  view(): RunnerView
  /**
   * How many new Requests the shared traffic log holds in memory: shows trimming keeps it
   * bounded. For tests and measurement; the UI has no use for it.
   */
  retainedArrivals(): number
}

/** The parts of one run, rebuilt from the Scenario on reset. */
interface Run {
  readonly source: TrafficSource
  readonly variants: readonly { readonly config: VariantConfig; readonly engine: Engine }[]
}

function startRun(scenario: Scenario): Run {
  const source = createScenarioSource(scenario)
  const variants = scenario.variants.map((config) => ({
    config,
    engine: createEngine({
      traffic: source.reader(),
      limiter: createLimiter(config.limiter),
      retry: config.retry,
      backend: scenario.backend,
      // Each Variant has its own streams from the same seed, so service times and jitter
      // draws in one never shift another's.
      streams: createStreams(scenario.seed),
      subBucketMs: subBucketMsFor(config.limiter),
    }),
  }))
  return { source, variants }
}

/**
 * Creates a runner at 0, running at speed 1. Throws a RangeError for an invalid Scenario or a
 * budget that is not more than 0.
 */
export function createRunner(scenario: Scenario, options: RunnerOptions = {}): Runner {
  checkScenario(scenario)
  const eventBudget = options.eventBudget ?? DEFAULT_EVENT_BUDGET
  // Not checkPositive: Infinity is a valid budget, meaning none.
  if (!(eventBudget > 0)) {
    throw new RangeError(`The event budget must be more than 0, got ${eventBudget}`)
  }
  let run = startRun(scenario)
  let simMs = 0
  let paused = false
  let speed: Speed = 1
  let behind = false

  /** Events handled so far, summed over every Variant. */
  function eventsHandled(): number {
    return run.variants.reduce((sum, { engine }) => sum + engine.eventsHandled(), 0)
  }

  /** Moves the source, then every engine, to `untilMs`. */
  function advanceTo(untilMs: number): void {
    run.source.advanceTo(untilMs)
    for (const { engine } of run.variants) engine.advanceTo(untilMs)
    simMs = untilMs
  }

  return {
    tick(wallMs) {
      checkNonNegative(wallMs, "A frame's wall time in ms")
      if (paused) return false
      const targetMs = simMs + Math.min(wallMs, FRAME_CAP_MS) * speed
      const stopAt = eventsHandled() + eventBudget
      behind = false
      while (simMs < targetMs) {
        advanceTo(Math.min(simMs + SUB_STEP_MS, targetMs))
        if (simMs < targetMs && eventsHandled() >= stopAt) {
          behind = true
          break
        }
      }
      run.source.trim()
      return behind
    },
    pause() {
      paused = true
    },
    resume() {
      paused = false
    },
    reset() {
      run = startRun(scenario)
      simMs = 0
      behind = false
    },
    setSpeed(next) {
      if (!SPEEDS.includes(next)) {
        throw new RangeError(`Speed must be one of ${SPEEDS.join(', ')}, got ${next}`)
      }
      speed = next
    },
    applyControl(change) {
      run.source.applyControl(change)
    },
    view() {
      return {
        simMs,
        paused,
        speed,
        behind,
        eventsHandled: eventsHandled(),
        timeline: run.source.timeline(),
        variants: run.variants.map(({ config, engine }) => ({
          label: config.label,
          snapshots: engine.snapshots(),
          totals: engine.totals(),
          allowedSubBuckets: engine.allowedSubBuckets(),
        })),
      }
    },
    retainedArrivals() {
      return run.source.retainedArrivals()
    },
  }
}
