/**
 * Diagnosis: Findings worked out from a Variant's Snapshots with explicit thresholds, the same
 * for every Scenario (BaseConcept.md "Failure diagnosis"). It reads only Snapshots and the
 * allowed-Attempt sub-buckets, so it is as deterministic as the run. A diagnoser runs a list
 * of rules, one per Failure Mode, each with its own state and hysteresis, and ranks what they
 * find: one Root Cause, every other Finding Contributing.
 */
import type { BackendSpec } from './backend.ts'
import { baselineP99Ms } from './baseline.ts'
import type { AllowedSubBuckets } from './engine.ts'
import { bucketAt } from './buckets.ts'
import { allowedPerSecond, type FixedWindowSpec, type LimiterSpec } from './limiter.ts'
import type { RetryPolicy } from './retry-policy.ts'
import { QUICK_RETRY_MS, SNAPSHOT_MS, WARM_UP_MS, type Snapshot } from './metrics.ts'
import { rollingWindowCounts } from './window-counts.ts'

/** A named way the simulated system goes wrong. */
export type FailureMode = 'saturation' | 'queue-overflow' | 'boundary-burst' | 'retry-storm'

/** A Cause is a design mistake; a Symptom is what it does to the system. */
export type FindingKind = 'cause' | 'symptom'

/**
 * Each Failure Mode's label, and whether it is a Cause or a Symptom: fixed per mode, not per
 * rule or per Finding (BaseConcept.md "Detection rules").
 */
export const FAILURE_MODES: Readonly<
  Record<FailureMode, { readonly label: string; readonly kind: FindingKind }>
> = {
  saturation: { label: 'Backend saturation', kind: 'symptom' },
  'queue-overflow': { label: 'Queue overflow', kind: 'symptom' },
  'boundary-burst': { label: 'Boundary burst', kind: 'cause' },
  'retry-storm': { label: 'Retry storm', kind: 'cause' },
}

/**
 * The order Symptoms are listed in, and with no Cause, which one is the Root Cause: the first
 * here (D6). Saturation comes first because a Backend that is busy all the time is why its
 * queue fills; goodput collapse joins at the end with RS-28. A Symptom left out of this list
 * is still listed, after these; a test checks every Symptom is here.
 */
export const SYMPTOM_ORDER: readonly FailureMode[] = ['saturation', 'queue-overflow']

/** How bad a Finding is: `warn` is amber, `broken` is red. */
export type Severity = 'warn' | 'broken'

/**
 * The configuration change a Fix makes, applied as a new Variant beside the one it fixes
 * (Apply fix, RS-27). Only a fix measured to help gets one; the rest stay text.
 */
export interface FixPatch {
  /** Short and lower case, added to the original's label: "Sliding window counter, more slots". */
  readonly name: string
  /** A different Limiter in place of the Variant's. */
  readonly limiter?: LimiterSpec
  /** Changes to the Variant's Retry Policy; the rest of it is kept. */
  readonly retry?: Partial<RetryPolicy>
  /** Changes to the Backend, for the fixed Variant alone. */
  readonly backend?: Partial<BackendSpec>
}

/** A suggested configuration change, with a patch when it can be applied. */
export interface Fix {
  readonly text: string
  readonly patch?: FixPatch
}

/** One detected occurrence of a Failure Mode in a Variant, with the evidence that fired it. */
export interface Finding {
  readonly id: FailureMode
  readonly label: string
  readonly kind: FindingKind
  readonly severity: Severity
  /**
   * When it first appeared, in ms of simulated time: the end of that Snapshot. A Finding that
   * goes from warn to broken keeps the time it first went amber.
   */
  readonly startedAt: number
  /** The numbers behind it, as shown. */
  readonly evidence: readonly { readonly metric: string; readonly value: string }[]
  readonly why: string
  /** Ranked, the most useful first. */
  readonly fixes: readonly Fix[]
  /** Set by ranking, not by the rule: exactly one active Finding is the Root Cause. */
  readonly role: 'root-cause' | 'contributing'
}

/** An active Finding before ranking gives it a role. */
type UnrankedFinding = Omit<Finding, 'role'>

/** A Finding that has cleared, as it was last seen. */
export interface PastFinding extends Finding {
  /** When it cleared, in ms of simulated time: the end of the first Snapshot without it. */
  readonly endedAt: number
}

/**
 * How many of the newest non-warm-up Snapshots every rule judges: 5 seconds, the same span as
 * the panel's stats and the latency percentiles, long enough that one unlucky second does not
 * decide it. Rules stay silent until there are this many, so a rule first judges at 10 s: a
 * partial window right after the warm-up let one burst second read as the whole window (60%
 * to 74% busy from a single second, .scratch/review/rule-probe.ts).
 */
export const DIAGNOSIS_WINDOW_SNAPSHOTS = 5

/**
 * When rules first judge, in ms of simulated time: the warm-up, then one full window. The panel
 * says diagnosis starts here, so a student does not read the quiet before it as healthy.
 */
export const FIRST_JUDGEMENT_MS = WARM_UP_MS + DIAGNOSIS_WINDOW_SNAPSHOTS * SNAPSHOT_MS

/**
 * The share of Attempts sent to the Backend that it lost (shed because the queue was full, or
 * timed out) at which queue overflow becomes `warn`. Measured over seeds 1 to 8 and 120 s
 * (.scratch/review/loss.ts): a healthy Backend loses nothing in either Scenario (token bucket
 * 0.00% in Backend overload at 10 to 40/s; both Limiters 0.00% in Edge burst at 4 and 8/s), and
 * the sliding window counter starting to struggle at 20/s loses 0.25% to 2.7% overall. So 1% is
 * well clear of noise and catches the first real losses.
 */
export const QUEUE_OVERFLOW_WARN_SHARE = 0.01

/**
 * The loss share at which queue overflow becomes `broken`: one Attempt in twenty lost. In
 * Backend overload the sliding window counter loses 16% to 20% at 30/s and 29% to 31% at 40/s
 * (seeds 1 to 8, 120 s), well past it, while at 20/s only its worst 5 s windows reach it.
 */
export const QUEUE_OVERFLOW_BROKEN_SHARE = 0.05

/**
 * Queue overflow leaves a severity only once the share falls below this fraction of the
 * threshold that entered it (broken below 2.5%, warn below 0.5%), so a share hovering at a
 * threshold does not flicker between states.
 */
export const QUEUE_OVERFLOW_HYSTERESIS_FRACTION = 0.5

/**
 * The mean share of Backend slot time busy over the window at which saturation becomes
 * `broken` (BaseConcept): at 95% there is almost no slack left for a burst. Measured on the
 * saturation fixture (4 slots of 50 ms, ceiling 80/s, Poisson Demand, seeds 1 to 8, 120 s,
 * .scratch/diagnosis/saturation-probe.ts): no 5 s window at 40/s gets above 65% busy.
 */
export const SATURATION_BROKEN_BUSY = 0.95

/**
 * How many times the baseline p99 the newest p99 must be, with the Backend that busy, for
 * `broken` (BaseConcept): Attempts spend twice as long waiting for a slot as being served.
 * Busy alone is not enough; a Backend at full use that still answers quickly is doing its
 * job. On the fixture at 40/s the p99 never passes 1.8x the baseline.
 */
export const SATURATION_BROKEN_RATIO = 3

/**
 * The busy share for `warn`: 85%, where waiting for a slot starts to show in the p99. On the
 * fixture at 64/s, 0.8x the ceiling, 5 s windows read 79% to 84% busy on average and warn
 * shows in at most 15% of seconds; at 40/s never (.scratch/diagnosis/saturation-fixes.ts).
 */
export const SATURATION_WARN_BUSY = 0.85

/**
 * The p99 ratio for `warn`: the slowest Attempts take twice what the work alone takes. At
 * 40/s on the fixture the p99 stays at or under 1.8x the baseline; at 64/s it reaches 2.3x.
 */
export const SATURATION_WARN_RATIO = 2

/**
 * Saturation leaves a severity only once the busy share falls this far below the threshold
 * that entered it (broken below 90%, warn below 80%). Half the threshold, as queue overflow
 * uses, would hold a Backend at 50% busy in `broken`. On the fixture at 80/s, its ceiling,
 * 5 s windows range from 79% to 100% busy.
 */
export const SATURATION_BUSY_MARGIN = 0.05

/**
 * Saturation leaves a severity only once the p99 ratio falls this far below the one that
 * entered it (broken at 2.5x or less, warn at 1.5x or less). At 100/s on the fixture the p99
 * ranges from 2.2x to 4.1x the baseline from one 5 s window to the next.
 */
export const SATURATION_RATIO_MARGIN = 0.5

/**
 * How far over its limit a fixed window's most allowed Attempts in one window-length must be
 * for boundary burst to become `warn` (BaseConcept: "exceed the limit by > 30%"). A sliding
 * window counter on Edge burst peaks at 1.2x to 1.4x of the same limit (seeds 1 to 8, 120 s,
 * .scratch/diagnosis/boundary-fixes.ts), but the rule judges fixed windows only.
 */
export const BOUNDARY_BURST_WARN_RATIO = 1.3

/**
 * The ratio at which boundary burst becomes `broken`: well over half a window's worth extra.
 * Edge burst's fixed window shows 2.0x at every burst, the most a fixed window can allow.
 */
export const BOUNDARY_BURST_BROKEN_RATIO = 1.6

/**
 * How many windows in a row must stay at or under a threshold before boundary burst leaves
 * that severity: 10, so no burst for 15 s. A burst is in the 5 s window for only 5 Snapshots,
 * and Edge burst's come every 10 s, leaving 5 quiet windows between; a margin on the ratio
 * cannot bridge that gap, because between bursts the count is the background traffic alone.
 * Twice the gap holds the Finding through a regular rhythm of bursts and clears it once they
 * stop.
 */
export const BOUNDARY_BURST_CLEAR_WINDOWS = 10

/**
 * Retry Amplification (Offered Load over Demand, across the window) at which a retry storm
 * becomes `warn` when retries are quick (BaseConcept: 1.5). Without retries it is 1.00 in
 * every window of both Scenarios (seeds 1 to 8, 120 s, .scratch/diagnosis/retry-probe.ts).
 */
export const RETRY_STORM_AMPLIFICATION = 1.5

/**
 * Retry Amplification at which a retry storm with quick retry Attempts becomes `broken`: each
 * Request sends twice its share. With "Retry at once" the highest window peaks at 2.1x (token
 * bucket) to 2.6x (sliding window counter) in Backend overload at 30/s, and at 2.3x to 2.6x in
 * Edge burst at 4/s (seeds 1 to 8, .scratch/diagnosis/retry-probe.ts).
 */
export const RETRY_STORM_BROKEN_AMPLIFICATION = 2

/**
 * The share of retries that must have started within QUICK_RETRY_MS of their failure for
 * amplification to count as a storm. Amplification alone cannot tell a storm from retries that
 * back off: every retrying policy reaches 2x to 4x in Backend overload at 30/s and Edge burst.
 * Measured in windows at 1.5x or more (seeds 1 to 8, 120 s, default and 3x Demand,
 * .scratch/diagnosis/retry-probe.ts): "Retry at once" is always 100% quick; "Back off" 0%;
 * "Back off with jitter" at most 27%; "Wait for Retry-After" at most 42%, from a token bucket
 * whose Retry-After is the 14 ms to its next token. Retries timed by the Limiter's own advice
 * are what the fix recommends, so 60% sits well clear of them and of 100%.
 */
export const RETRY_STORM_QUICK_SHARE = 0.6

/**
 * How many windows in a row must stay under a threshold before a retry storm leaves that
 * severity: 10, as for boundary burst. In Edge burst retries come with the bursts every 10 s,
 * so with "Retry at once" amplification is over 1.5 in only 60% of windows; without a hold the
 * Finding would start again at every burst.
 */
export const RETRY_STORM_CLEAR_WINDOWS = 10

/**
 * The first backoff, in ms, a fix gives a Retry Policy that had none: the same as the Retry
 * Policy dropdown's default, so an applied fix matches what choosing that mode there does.
 */
export const FIX_BASE_DELAY_MS = 100

/**
 * A lower limit for a saturated Backend, as a share of what it can serve (slots x 1000 / mean
 * ms). On the saturation fixture at 100/s (ceiling 80), a token bucket at 0.75 of it, 60/s,
 * clears saturation in every second, seeds 1 to 8; at 0.875 (70/s) it still warns for up to 8 s
 * of 111 (.scratch/apply-fix/patch-probe.ts).
 */
export const FIX_LOWER_LIMIT_SHARE = 0.75

/** A token bucket's capacity for a fix: half the Backend's queue, so a full bucket fits in it. */
function smallCapacity({ queueLimit }: BackendSpec): number {
  return Math.max(1, Math.floor(queueLimit / 2))
}

/**
 * What a rule detects in one full window: the parts of a Finding that come from its numbers.
 * (Not a "verdict": CONTEXT.md keeps that word away from a Limiter Decision.)
 */
export interface Detection {
  readonly severity: Severity
  readonly evidence: Finding['evidence']
  readonly why: string
  readonly fixes: readonly Fix[]
}

/**
 * One Failure Mode's detection. A rule keeps its own state, such as the severity it is in for
 * hysteresis, so each diagnoser needs its own rules.
 */
export interface Rule {
  readonly id: FailureMode
  /**
   * Judges the newest full window: `window` holds exactly DIAGNOSIS_WINDOW_SNAPSHOTS
   * non-warm-up Snapshots, oldest first. `allowed` covers at least up to the newest
   * Snapshot's end and may run past it, so a rule reads only the sub-buckets before that
   * time. Null when the Failure Mode is not present.
   */
  judge(window: readonly Snapshot[], allowed: AllowedSubBuckets): Detection | null
}

/** What a diagnoser needs to know about the Variant beyond its Snapshots. */
export interface DiagnoserOptions {
  /** The Scenario's Backend: its queue limit, and later its baseline p99. */
  readonly backend: BackendSpec
  /** The Variant's Limiter: whether it is a fixed window, with its limit and window. */
  readonly limiter: LimiterSpec
  /** The Variant's Retry Policy, which the retry storm's fixes change. */
  readonly retry: RetryPolicy
}

/** Reads a Variant's Snapshots one at a time and keeps its Findings. */
export interface Diagnoser {
  /**
   * The next Snapshot, in time order, with the allowed-Attempt sub-buckets so far. Warm-up
   * Snapshots are ignored.
   */
  add(snapshot: Snapshot, allowed: AllowedSubBuckets): void
  /**
   * The Findings active after the last Snapshot added: the Root Cause first, then the other
   * Causes by `startedAt`, then the Symptoms in a fixed order.
   */
  findings(): readonly Finding[]
  /** Every Finding that has cleared, in the order they cleared. */
  history(): readonly PastFinding[]
}

function percent(share: number): string {
  return `${(share * 100).toFixed(1)}%`
}

/** The queue overflow rule: the share of Attempts sent to the Backend that it lost. */
export function queueOverflowRule(backend: BackendSpec, limiter: LimiterSpec): Rule {
  const { queueLimit } = backend
  let severity: Severity | null = null
  const fixes: readonly Fix[] = [
    // Ranked by what each did for the sliding window counter in Backend overload at 30/s,
    // seeds 1 to 8 (.scratch/apply-fix/patch-probe.ts), against broken 96 to 111 s of 111 and
    // Goodput 11.3 to 11.7/s as is: a token bucket at the same rate holding half the queue (10)
    // never overflows, Goodput 15.6 to 15.7/s, and at 40/s too; twice the slots, broken never and
    // warn at most 5 s, 14.0/s (at 40/s broken 5 to 21 s); twice the queue, broken 5 to 35 s and
    // 13.5 to 13.8/s, with the p99 up from about 340 ms to 450 to 484 ms. A lower limit stops the
    // loss but turns so much away that Goodput falls (7.9/s at 40, .scratch/review/fixes.ts),
    // so it is not suggested.
    {
      text: 'Try a Limiter that lets Attempts through at a steady pace instead of a whole window at once, such as a token bucket with a small capacity',
      patch: {
        name: 'token bucket',
        limiter: {
          algo: 'token-bucket',
          keyBy: limiter.keyBy,
          capacity: smallCapacity(backend),
          refillPerSec: allowedPerSecond(limiter),
        },
      },
    },
    {
      text: 'Try more Backend slots',
      patch: { name: 'more slots', backend: { slots: backend.slots * 2 } },
    },
    {
      text: 'Try a bigger queue (Attempts wait longer)',
      patch: { name: 'bigger queue', backend: { queueLimit: Math.max(1, queueLimit * 2) } },
    },
  ]

  /** The severity after a window that lost `share`, given the one before. */
  function nextSeverity(share: number | null): Severity | null {
    if (share === null) return null
    const warn = QUEUE_OVERFLOW_WARN_SHARE
    const broken = QUEUE_OVERFLOW_BROKEN_SHARE
    const margin = QUEUE_OVERFLOW_HYSTERESIS_FRACTION
    if (share >= broken) return 'broken'
    if (severity === 'broken' && share >= broken * margin) return 'broken'
    if (share >= warn) return 'warn'
    if (severity !== null && share >= warn * margin) return 'warn'
    return null
  }

  return {
    id: 'queue-overflow',
    judge(window) {
      const sum = (pick: (s: Snapshot) => number) => window.reduce((t, s) => t + pick(s), 0)
      // Attempts sent to the Backend: allowed now, or delayed and released later.
      const sent = sum((s) => s.allowed + s.delayed)
      const shed = sum((s) => s.shed)
      const timedOut = sum((s) => s.attemptsTimedOut)
      // With nothing sent for 5 s nothing can be lost, so there is no share and no Finding.
      const share = sent === 0 ? null : (shed + timedOut) / sent
      severity = nextSeverity(share)
      if (severity === null || share === null) return null
      return {
        severity,
        evidence: [
          { metric: 'Lost', value: percent(share) },
          { metric: 'Shed', value: String(shed) },
          { metric: 'Timed out', value: String(timedOut) },
          { metric: 'Sent to the Backend', value: String(sent) },
        ],
        why:
          `The queue of ${queueLimit} filled, so ${shed} Attempts were shed and ${timedOut} ` +
          `timed out: ${percent(share)} of what the Limiter let through.`,
        fixes,
      }
    },
  }
}

/**
 * The saturation rule: the Backend busy nearly all the time over the window, with the newest
 * p99 far above what its service times alone would give, so Attempts are waiting for a slot.
 */
export function saturationRule(backend: BackendSpec): Rule {
  const baseline = baselineP99Ms(backend)
  const ceiling = backend.slots * (1000 / backend.meanMs)
  const fixes: readonly Fix[] = [
    // Ranked by what each did on the saturation fixture at 100/s, 1.25x its ceiling, seeds 1 to
    // 8 (.scratch/apply-fix/patch-probe.ts), against broken 106 to 111 s of 111 at 78 to 81/s
    // as is: twice the slots, never saturated and Goodput 98.6 to 101.2/s; half the service
    // time, the same Goodput with the p99 down to 120 to 129 ms; a token bucket at 0.75 of the
    // ceiling, never saturated but Goodput held at 60/s. The simulator has no cache, so
    // "cheaper" is measured as a shorter service time.
    {
      text: 'Try more Backend slots',
      patch: { name: 'more slots', backend: { slots: backend.slots * 2 } },
    },
    {
      text: 'Try making each Attempt cheaper for the Backend, such as with a cache',
      patch: { name: 'cheaper Attempts', backend: { meanMs: backend.meanMs / 2 } },
    },
    {
      text: 'Try a limit below what the Backend can serve (it turns more away, but what gets through is quick)',
      patch: {
        name: 'lower limit',
        limiter: {
          algo: 'token-bucket',
          keyBy: 'global',
          capacity: smallCapacity(backend),
          refillPerSec: ceiling * FIX_LOWER_LIMIT_SHARE,
        },
      },
    },
  ]
  let severity: Severity | null = null

  const broken = { busy: SATURATION_BROKEN_BUSY, ratio: SATURATION_BROKEN_RATIO }
  const warn = { busy: SATURATION_WARN_BUSY, ratio: SATURATION_WARN_RATIO }

  /**
   * Whether `busy` and `ratio` reach `level`, or stay within its margins once `held`. With no
   * p99 (nothing finished in time to be measured), a held level stays while the Backend is
   * still that busy: a Backend so stalled that every caller gave up is not healthy.
   */
  function reaches(
    level: { readonly busy: number; readonly ratio: number },
    busy: number,
    ratio: number | null,
    held: boolean,
  ): boolean {
    if (!held) return ratio !== null && busy >= level.busy && ratio > level.ratio
    const busyEnough = busy >= level.busy - SATURATION_BUSY_MARGIN
    return busyEnough && (ratio === null || ratio > level.ratio - SATURATION_RATIO_MARGIN)
  }

  return {
    id: 'saturation',
    judge(window) {
      const busy = window.reduce((t, s) => t + s.backendUtil, 0) / window.length
      // The newest p99 already covers the last 5 s of completed Attempts.
      const p99 = window.at(-1)?.p99 ?? null
      const ratio = p99 === null ? null : p99 / baseline
      if (reaches(broken, busy, ratio, severity === 'broken')) severity = 'broken'
      else if (reaches(warn, busy, ratio, severity !== null)) severity = 'warn'
      else severity = null
      if (severity === null) return null
      const ms = (value: number) => `${Math.round(value)} ms`
      // No measured p99 is shown as a dash, never as a number (CLAUDE.md "The one rule").
      return {
        severity,
        evidence: [
          { metric: 'Busy', value: percent(busy) },
          { metric: 'Slowest 1 in 100 (p99)', value: p99 === null ? '–' : ms(p99) },
          { metric: 'Its work alone (baseline p99)', value: ms(baseline) },
          { metric: 'Against the baseline', value: ratio === null ? '–' : `${ratio.toFixed(1)}×` },
        ],
        why:
          p99 === null || ratio === null
            ? `The Backend was busy ${percent(busy)} of the time, and no Attempt finished ` +
              'before its caller gave up waiting for a slot.'
            : `The Backend was busy ${percent(busy)} of the time, so Attempts waited for a ` +
              `slot: the slowest 1 in 100 took ${ms(p99)}, ${ratio.toFixed(1)}× the ` +
              `${ms(baseline)} its work alone takes.`,
        fixes,
      }
    },
  }
}

/**
 * Severity for a Failure Mode that comes and goes in bursts faster than the window: a level
 * holds until `clearWindows` windows in a row have not reached it, and the reading shown is
 * the newest one that did. Returns a function taking each window's level and reading.
 */
function createHold<T>(clearWindows: number) {
  let quietSinceBroken = Infinity
  let quietSinceWarn = Infinity
  let lastBroken: T | null = null
  let lastWarn: T | null = null
  return (level: Severity | null, reading: T): { severity: Severity; reading: T } | null => {
    quietSinceBroken = level === 'broken' ? 0 : quietSinceBroken + 1
    quietSinceWarn = level !== null ? 0 : quietSinceWarn + 1
    if (level === 'broken') lastBroken = reading
    if (level !== null) lastWarn = reading
    if (quietSinceBroken < clearWindows && lastBroken !== null) {
      return { severity: 'broken', reading: lastBroken }
    }
    if (quietSinceWarn < clearWindows && lastWarn !== null) {
      return { severity: 'warn', reading: lastWarn }
    }
    return null
  }
}

/**
 * The boundary burst rule, for a fixed window: allowed Attempts in any span of one
 * window-length, sampled every sub-bucket (a tenth of a window), against the limit. It reads
 * the same rolling count the boundary-burst chart draws.
 *
 * Keyed per Client, each key has its own limit but the sub-buckets count every key together,
 * so the total is judged against the limit times the Clients seen so far. Over that, some key
 * must have crossed an edge; one Client bursting while the others are quiet can stay under it,
 * so the rule can miss a burst but never reports one that did not happen.
 */
export function boundaryBurstRule(limiter: FixedWindowSpec): Rule {
  const { keyBy, limit, windowMs } = limiter
  const fixes: readonly Fix[] = [
    // Measured on Edge burst at 4/s against 10 per 1000 ms, seeds 1 to 8: a sliding window
    // counter peaks at 1.2x to 1.4x, a token bucket of capacity 5 at 1.1x to 1.4x, but one of
    // capacity 10 still at 1.6x to 1.9x, so the capacity has to be small
    // (.scratch/diagnosis/boundary-fixes.ts). Applied, both clear boundary burst in every second
    // (.scratch/apply-fix/patch-probe.ts); Goodput moves from 4.8 to 5.4/s to 4.0 to 4.8/s,
    // since a limit really kept lets less of each burst through.
    {
      text: 'Try a sliding window counter, which still counts the window before the edge',
      patch: {
        name: 'sliding window counter',
        limiter: { algo: 'sliding-counter', keyBy, limit, windowMs },
      },
    },
    {
      text: 'Try a token bucket with a small capacity, such as half the limit, so a burst cannot spend a whole window at once',
      patch: {
        name: 'token bucket',
        limiter: {
          algo: 'token-bucket',
          keyBy,
          capacity: Math.max(1, Math.ceil(limit / 2)),
          refillPerSec: allowedPerSecond(limiter),
        },
      },
    },
  ]
  /** The newest window-length over each threshold: its count, its end, the limit then. */
  type Peak = {
    readonly count: number
    readonly at: number
    readonly limit: number
    readonly keys: number
  }
  const hold = createHold<Peak>(BOUNDARY_BURST_CLEAR_WINDOWS)

  return {
    id: 'boundary-burst',
    judge(window, allowed) {
      const newest = window.at(-1)
      if (newest === undefined) return null
      const end = newest.t
      const start = end - window.length * SNAPSHOT_MS
      // Only sub-buckets that ended by this Snapshot: `allowed` may run past it.
      const counts = allowed.counts.slice(0, bucketAt(end, allowed.bucketMs))
      const points = rollingWindowCounts(
        { bucketMs: allowed.bucketMs, counts },
        windowMs,
        end,
        start,
      ).filter((p) => p.t > start)
      const keys = keyBy === 'client' ? Math.max(1, Object.keys(newest.perClient).length) : 1
      let peak: Peak | null = null
      for (const p of points) {
        if (peak === null || p.v > peak.count)
          peak = { count: p.v, at: p.t, limit: limit * keys, keys }
      }
      const ratio = peak === null ? 0 : peak.count / peak.limit
      const level =
        peak === null || ratio <= BOUNDARY_BURST_WARN_RATIO
          ? null
          : ratio >= BOUNDARY_BURST_BROKEN_RATIO
            ? 'broken'
            : 'warn'
      const held = peak === null ? hold(null, { count: 0, at: 0, limit, keys }) : hold(level, peak)
      if (held === null) return null
      const { severity, reading: shown } = held
      const over = `${(shown.count / shown.limit).toFixed(1)}×`
      const when = `${(shown.at / 1000).toFixed(1)} s`
      const limitText =
        shown.keys === 1
          ? String(shown.limit)
          : `${shown.limit} (${limit} for each of ${shown.keys} Clients)`
      return {
        severity,
        evidence: [
          { metric: 'Most allowed in one window', value: String(shown.count) },
          { metric: 'Limit per window', value: limitText },
          { metric: 'Over the limit', value: over },
          { metric: 'When', value: when },
        ],
        why:
          'The fixed window starts counting from zero at each edge, so Attempts just before an ' +
          `edge and just after it both fit: ${shown.count} got through in one window-length ` +
          `around ${when}, ${over} the limit of ${limitText}.`,
        fixes,
      }
    },
  }
}

/**
 * The retry storm rule: Offered Load well above Demand over the window because failed
 * Attempts come straight back, measured by how many retries started within QUICK_RETRY_MS of
 * the failure that caused them.
 */
export function retryStormRule(retry: RetryPolicy): Rule {
  const baseDelayMs = 'baseDelayMs' in retry ? retry.baseDelayMs : FIX_BASE_DELAY_MS
  const fixes: readonly Fix[] = [
    // Ranked by Goodput for the sliding window counter in Backend overload at 30/s with "Retry
    // at once", seeds 1 to 8 (.scratch/apply-fix/patch-probe.ts), against broken 110 to 111 s
    // of 111 and 10.0 to 10.6/s as is: back off with jitter, never a storm and 12.8 to 13.4/s;
    // wait for Retry-After, never a storm and 10.9 to 11.5/s; one Attempt fewer, warn throughout
    // instead of broken and 10.5 to 10.9/s. The same order holds for the token bucket there and
    // the fixed window in Edge burst.
    {
      text: 'Try backing off with jitter, so each new Attempt waits a random, growing time',
      patch: { name: 'back off with jitter', retry: { retry: 'backoff-jitter', baseDelayMs } },
    },
    {
      text: 'Try waiting for Retry-After, so new Attempts come when the Limiter says there is room',
      patch: { name: 'wait for Retry-After', retry: { retry: 'retry-after', baseDelayMs } },
    },
    {
      text: 'Try fewer Attempts per Request, so each failure adds less traffic',
      patch: { name: 'fewer Attempts', retry: { maxAttempts: Math.max(1, retry.maxAttempts - 1) } },
    },
  ]
  type Reading = {
    readonly demand: number
    readonly offered: number
    readonly quickShare: number
    readonly seconds: number
    /** The end of the window, in ms: a held Finding shows numbers from up to 10 s before. */
    readonly at: number
  }
  const hold = createHold<Reading>(RETRY_STORM_CLEAR_WINDOWS)

  return {
    id: 'retry-storm',
    judge(window) {
      const sum = (pick: (s: Snapshot) => number) => window.reduce((t, s) => t + pick(s), 0)
      const demand = sum((s) => s.demand)
      const offered = sum((s) => s.offeredLoad)
      const retryAttempts = sum((s) => s.retryAttempts)
      const quickAttempts = sum((s) => s.quickRetryAttempts)
      const reading = {
        demand,
        offered,
        quickShare: retryAttempts === 0 ? 0 : quickAttempts / retryAttempts,
        seconds: window.length,
        at: window.at(-1)?.t ?? 0,
      }
      // With no Demand there is no amplification to judge.
      const amplification = demand === 0 ? 0 : offered / demand
      const storm = reading.quickShare >= RETRY_STORM_QUICK_SHARE
      const level =
        !storm || amplification < RETRY_STORM_AMPLIFICATION
          ? null
          : amplification >= RETRY_STORM_BROKEN_AMPLIFICATION
            ? 'broken'
            : 'warn'
      const held = hold(level, reading)
      if (held === null) return null
      const shown = held.reading
      const perSecond = (n: number) => `${(n / shown.seconds).toFixed(1)}/s`
      const amp = `${(shown.offered / shown.demand).toFixed(1)}×`
      const quick = `${Math.round(shown.quickShare * 100)}%`
      return {
        severity: held.severity,
        evidence: [
          { metric: 'Offered Load', value: perSecond(shown.offered) },
          { metric: 'Demand', value: perSecond(shown.demand) },
          { metric: 'Retry Amplification', value: amp },
          { metric: `Retry Attempts within ${QUICK_RETRY_MS} ms`, value: quick },
          {
            metric: 'When',
            value: `${((shown.at - shown.seconds * SNAPSHOT_MS) / 1000).toFixed(0)} to ${(shown.at / 1000).toFixed(0)} s`,
          },
        ],
        why:
          `Offered Load reached ${amp} Demand because ${quick} of retry Attempts came within ` +
          `${QUICK_RETRY_MS} ms of the failure that caused them, too soon for anything to have ` +
          'changed.',
        fixes,
      }
    },
  }
}

/** The rules every Variant is diagnosed with: boundary burst only behind a fixed window. */
export function defaultRules({ backend, limiter, retry }: DiagnoserOptions): Rule[] {
  return [
    ...(limiter.algo === 'fixed-window' ? [boundaryBurstRule(limiter)] : []),
    retryStormRule(retry),
    saturationRule(backend),
    queueOverflowRule(backend, limiter),
  ]
}

/** Orders active Findings and sets their roles (D6, BaseConcept.md "Ranking and behavior"). */
function rank(active: readonly UnrankedFinding[]): Finding[] {
  // Array sort is stable, so Causes that started together keep the rules' order.
  const causes = active.filter((f) => f.kind === 'cause').sort((a, b) => a.startedAt - b.startedAt)
  const place = (id: FailureMode) => {
    const i = SYMPTOM_ORDER.indexOf(id)
    return i === -1 ? SYMPTOM_ORDER.length : i
  }
  const symptoms = active
    .filter((f) => f.kind === 'symptom')
    .sort((a, b) => place(a.id) - place(b.id))
  return [...causes, ...symptoms].map((f, i) => ({
    ...f,
    role: i === 0 ? 'root-cause' : 'contributing',
  }))
}

/**
 * Creates a diagnoser for one Variant. `rules` are fresh ones for this diagnoser; tests pass
 * stub rules to check ranking and windows on their own.
 */
export function createDiagnoser(
  options: DiagnoserOptions,
  rules: readonly Rule[] = defaultRules(options),
): Diagnoser {
  const window: Snapshot[] = []
  /** Per rule, its Finding while active. */
  const active = new Map<FailureMode, UnrankedFinding>()
  // Replaced, not pushed to, so a view that kept the old list sees a new one when it changes.
  let past: readonly PastFinding[] = []
  let ranked: readonly Finding[] = []

  return {
    add(snapshot, allowed) {
      if (snapshot.warmUp) return
      window.push(snapshot)
      if (window.length > DIAGNOSIS_WINDOW_SNAPSHOTS) window.shift()
      if (window.length < DIAGNOSIS_WINDOW_SNAPSHOTS) return
      for (const rule of rules) {
        const detection = rule.judge(window, allowed)
        const before = active.get(rule.id)
        if (detection === null) {
          if (before !== undefined) {
            const last = ranked.find((f) => f.id === rule.id)
            past = [...past, { ...before, role: last?.role ?? 'contributing', endedAt: snapshot.t }]
            active.delete(rule.id)
          }
          continue
        }
        active.set(rule.id, {
          id: rule.id,
          ...FAILURE_MODES[rule.id],
          ...detection,
          startedAt: before?.startedAt ?? snapshot.t,
        })
      }
      ranked = rank([...active.values()])
    },
    findings() {
      return ranked
    },
    history() {
      return past
    },
  }
}
