/**
 * Diagnosis: Findings worked out from a Variant's Snapshots with explicit thresholds, the same
 * for every Scenario (BaseConcept.md "Failure diagnosis"). It reads only Snapshots and the
 * allowed-Attempt sub-buckets, so it is as deterministic as the run. A diagnoser runs a list
 * of rules, one per Failure Mode, each with its own state and hysteresis, and ranks what they
 * find: one Root Cause, every other Finding Contributing.
 *
 * Every number in these comments is printed by the probe it cites, run on the code as it is:
 * Backend overload (the one shipped Scenario) and each rule's fixture, seeds 1 to 8, 120 s.
 */
import { backendCeiling, type BackendSpec } from './backend.ts'
import { baselineP99Ms } from './baseline.ts'
import type { AllowedSubBuckets } from './engine.ts'
import { allowedPerSecond, type LimiterSpec } from './limiter.ts'
import { QUICK_RETRY_MS, SNAPSHOT_MS, WARM_UP_MS, type Snapshot } from './metrics.ts'
import type { ClientId } from './traffic.ts'

/** A named way the simulated system goes wrong. */
export type FailureMode =
  | 'saturation'
  | 'queue-overflow'
  | 'retry-storm'
  | 'limit-too-loose'
  | 'limit-too-tight'
  | 'goodput-collapse'
  | 'noisy-neighbor'

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
  'retry-storm': { label: 'Retry storm', kind: 'cause' },
  'limit-too-loose': { label: 'Limit too loose', kind: 'cause' },
  'limit-too-tight': { label: 'Limit too tight', kind: 'cause' },
  'goodput-collapse': { label: 'Goodput collapse', kind: 'symptom' },
  'noisy-neighbor': { label: 'Noisy neighbor', kind: 'cause' },
}

/**
 * The order Symptoms are listed in, and with no Cause, which one is the Root Cause: the first
 * here (D6). Saturation comes first because a Backend that is busy all the time is why its
 * queue fills, and a full queue is what callers give up waiting in, so goodput collapse is last. A Symptom left out of this list
 * is still listed, after these; a test checks every Symptom is here.
 */
export const SYMPTOM_ORDER: readonly FailureMode[] = [
  'saturation',
  'queue-overflow',
  'goodput-collapse',
]

/** How bad a Finding is: `warn` is amber, `broken` is red. */
export type Severity = 'warn' | 'broken'

/** A suggested configuration change, as text. */
export interface Fix {
  readonly text: string
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
 * partial window right after the warm-up let one burst second read as the whole window. In
 * Backend overload a single burst second runs 67% to 100% busy while no 5 s window passes 24%
 * (.scratch/evidence/diagnosis-evidence.ts).
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
 * (.scratch/review/loss.ts): a healthy Backend loses nothing (the token bucket 0.00% in Backend
 * overload at 10 to 40/s, the sliding window counter 0.00% at 10/s), and the sliding window
 * counter starting to struggle at 20/s loses 0.25% to 2.7% overall. So 1% is
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
 * Retry Amplification (Offered Load over Demand, across the window) at which a retry storm
 * becomes `warn` when retries are quick (BaseConcept: 1.5). Without retries it is 1.00 in
 * every window of Backend overload at 10 and 30/s (.scratch/diagnosis/retry-probe.ts).
 */
export const RETRY_STORM_AMPLIFICATION = 1.5

/**
 * Retry Amplification at which a retry storm with quick retry Attempts becomes `broken`: each
 * Request sends twice its share. With "Retry at once" the highest window peaks at 2.1x (token
 * bucket) to 2.6x (sliding window counter) in Backend overload at 30/s (seeds 1 to 8,
 * .scratch/diagnosis/retry-probe.ts).
 */
export const RETRY_STORM_BROKEN_AMPLIFICATION = 2

/**
 * The share of retries that must have started within QUICK_RETRY_MS of their failure for
 * amplification to count as a storm. Amplification alone cannot tell a storm from retries that
 * back off: every retrying policy reaches 2.1x to 2.9x in Backend overload at 30/s. Measured in
 * windows at 1.5x or more (seeds 1 to 8, 120 s, default and 3x Demand,
 * .scratch/diagnosis/retry-probe.ts): "Retry at once" is always 100% quick; "Back off" 0%;
 * "Back off with jitter" at most 14%; "Wait for Retry-After" at most 42%, from a token bucket
 * whose Retry-After is the 14 ms to its next token. Retries timed by the Limiter's own advice
 * are what the fix recommends, so 60% sits well clear of them and of 100%.
 */
export const RETRY_STORM_QUICK_SHARE = 0.6

/**
 * How many windows in a row must stay under a threshold before a retry storm leaves that
 * severity: 10. Retries come with the bursts, so the level comes and goes: with "Retry at once"
 * at 20/s in Backend overload it is reached in only 68% to 95% of windows (sliding window
 * counter) and 18% to 50% (token bucket), and without a hold the Finding would start again at
 * every burst (.scratch/evidence/diagnosis-evidence.ts).
 */
export const RETRY_STORM_CLEAR_WINDOWS = 10

/**
 * The share of Attempts the Limiter rejected over the window under which, with the Backend
 * saturated, it counts as letting everything through: limit too loose (spec decision 3). Where
 * saturation fires behind a limit far above the Backend, 0.0% are rejected (the saturation
 * fixture, seeds 1 to 8, .scratch/more-rules/measure.ts); a limit under the Backend's
 * ceiling that still saturates it, 70/s against 80/s at Demand 100, rejects 22% to 36%.
 */
export const LIMIT_TOO_LOOSE_REJECTED_SHARE = 0.01

/**
 * How many of the newest Snapshots limit too tight judges: 10 seconds, twice the usual window,
 * so it can tell a steady excess from bursts: a burst lifts a 5 s mean over the limit while the
 * steady Demand stays under it, and with retries on Offered Load does too (Backend overload at
 * 30/s, with retries on, peaks at 0.95 to 1.44x its limit while Demand stays at 0.52x or under,
 * .scratch/more-rules/measure.ts). It first judges at 15 s.
 */
export const LIMIT_TOO_TIGHT_SECONDS = 10

/**
 * How many of those seconds must have more new Requests (Demand, not Offered Load, which retries
 * inflate) than the Limiter allows a second: 6, more than half, so the steady Demand is over the
 * limit. A burst fills at most 2 of 10 seconds (Backend overload at any Demand and Retry Policy,
 * seeds 1 to 8, .scratch/more-rules/measure.ts); steady Demand over the limit fills all 10 (the
 * fixture at 50/s against 20/s).
 */
export const LIMIT_TOO_TIGHT_OVER_SECONDS = 6

/**
 * The share of Attempts rejected over the 10 s at which limit too tight becomes `warn`
 * (BaseConcept: 30%). A limit just under the steady Demand rejects little and is doing its job;
 * the fixture rejects 54% to 67% (.scratch/more-rules/measure.ts).
 */
export const LIMIT_TOO_TIGHT_WARN_REJECTED = 0.3

/**
 * The rejected share for `broken`: the Limiter turns away most of what arrives. The fixture, a
 * limit of 20/s against 50/s, rejects 54% to 67% over every 10 s (seeds 1 to 8), so it is broken
 * throughout; a limit nearer the Demand, rejecting 30% to 50%, is amber.
 */
export const LIMIT_TOO_TIGHT_BROKEN_REJECTED = 0.5

/**
 * Limit too tight leaves a severity only once the rejected share falls this far below the
 * threshold that entered it (broken under 45%, warn under 25%), so a share near a threshold does
 * not flicker. The fixture's 10 s shares move by up to 13 points (54% to 67%), so 5 keeps one
 * unlucky span from dropping a level.
 */
export const LIMIT_TOO_TIGHT_REJECTED_MARGIN = 0.05

/**
 * The Backend's mean busy share over the 10 s under which it counts as idle enough that the
 * limit, not the Backend, is what turns work away (BaseConcept: 40%). The fixture runs 21% to
 * 28% busy; a greedy Client against 40/s runs 46% to 55% and stays quiet, while against 30/s
 * it straddles 40% (34% to 41%).
 */
export const LIMIT_TOO_TIGHT_IDLE_BUSY = 0.4

/**
 * Once limit too tight is active, how far its two gates may slip before it clears: the Backend
 * may be up to 5 points busier (under 45%), and Demand over the limit in one second fewer (5 of
 * 10), so a span sitting on a gate does not flicker. A burst still fills at most 3 seconds.
 */
export const LIMIT_TOO_TIGHT_GATE_MARGIN = { busy: 0.05, seconds: 1 } as const

/**
 * Goodput over its own running peak, over the 5 s window, under which goodput collapse becomes
 * `warn`: half of what this Variant has shown it can do. A saturated Backend that still serves
 * never drops below 0.75x (the saturation fixture at 100/s, 68 to 89/s against a peak of 85 to
 * 91/s, seeds 1 to 8, .scratch/more-rules/measure.ts); the collapse fixture is at 0.23x to 0.47x
 * five seconds after Demand rises past the Backend and at 0.00x from ten seconds after
 * (.scratch/more-rules/collapse-series.ts).
 */
export const GOODPUT_COLLAPSE_WARN_RATIO = 0.5

/**
 * The ratio for `broken`: under a quarter of the peak. The collapse fixture is at 0.23x to 0.47x
 * five seconds after the rise and at 0.00x from ten seconds after (seeds 1 to 8,
 * .scratch/more-rules/collapse-series.ts), so it goes amber and then red within seconds; a Backend
 * that loses some work but still finishes most of it sits between this and the warn ratio.
 */
export const GOODPUT_COLLAPSE_BROKEN_RATIO = 0.25

/**
 * Goodput collapse leaves a severity only once the ratio rises this far above the threshold that
 * entered it (broken over 0.35, warn over 0.6), so a ratio near a threshold does not flicker.
 */
export const GOODPUT_COLLAPSE_RATIO_MARGIN = 0.1

/**
 * The Backend's mean busy share over the window at or above which a fall in Goodput counts as a
 * collapse: the Backend is still working, so the work is being lost, not missing. Demand falling,
 * or the quiet seconds of bursty traffic, drop Goodput with the Backend idle: the core Scenarios
 * swing to 0.21x their peak between bursts but are never over 28% busy. The collapse fixture is
 * 100% busy throughout.
 */
export const GOODPUT_COLLAPSE_BUSY = 0.8

/**
 * Once goodput collapse is active, how far busy may fall before it clears: to 75%, as saturation
 * leaves 5 points under what entered it, so a Backend sitting near 80% does not flicker.
 */
export const GOODPUT_COLLAPSE_BUSY_MARGIN = 0.05

/**
 * How many of the newest Snapshots noisy neighbor judges, and in how many of them the top Client
 * must have sent more than its fair share of the limit: all 10, so its greed is steady. A Client
 * in a burst goes over its share for a second or two: with no greedy Client, the busiest one in
 * Backend overload is over it in at most 4 of 10 seconds (at 30/s with "Back off" or "Wait for
 * Retry-After"); the greedy fixture's Client is over it in all 10, in every window
 * (.scratch/more-rules/measure.ts).
 */
export const NOISY_NEIGHBOR_SECONDS = 10

/**
 * The top Client's share of allowed Attempts over the 10 s above which it may be a noisy neighbor
 * (BaseConcept: 50%). With no greedy Client the top one has at most 48% (Backend overload at any
 * Demand and Retry Policy, .scratch/more-rules/measure.ts); the steady and crowding conditions
 * keep a Client that crosses it briefly quiet. The greedy fixture's top Client has 81% to 88%.
 */
export const NOISY_NEIGHBOR_TOP_SHARE = 0.5

/**
 * The share of the other Clients' Attempts rejected, while together they send under their fair
 * share, at which noisy neighbor becomes `warn`: they are being turned away for room the greedy
 * Client took. Behind a global key every Client is rejected at the same rate, so comparing
 * allowed with offered shares reads noise (0.63 to 1.36 in the fixture); the others' rejections
 * themselves are what a greedy Client costs. The fixture's others lose 17% to 46%.
 */
export const NOISY_NEIGHBOR_WARN_REJECTED = 0.1

/**
 * The others' rejected share for `broken`: one in five of their Attempts turned away. The greedy
 * fixture's others lose 17% to 46% over 10 s (seeds 1 to 8); with the margin below, a span
 * dipping to 17% stays broken, so it is broken in more than 90% of seconds.
 */
export const NOISY_NEIGHBOR_BROKEN_REJECTED = 0.2

/**
 * Noisy neighbor leaves a severity only once the others' rejected share falls this far under
 * the threshold that entered it (broken under 15%, warn under 5%), so a share near a threshold
 * does not flicker: the fixture's 10 s shares swing by up to 29 points.
 */
export const NOISY_NEIGHBOR_REJECTED_MARGIN = 0.05

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
  /** The Variant's Limiter: its algorithm, key and limit. */
  readonly limiter: LimiterSpec
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

/**
 * A configured rate, such as a limit or what the Backend can serve: whole numbers as they are,
 * with thousands separated ("10,000/s"), others to one decimal.
 */
function rateText(perSecond: number): string {
  const n = Number.isInteger(perSecond) ? perSecond.toLocaleString('en-US') : perSecond.toFixed(1)
  return `${n}/s`
}

/** A measured rate, to one decimal: "46.1/s". */
function perSecondText(perSecond: number): string {
  return `${perSecond.toFixed(1)}/s`
}

/**
 * What the Limiter allows a second over all its keys, as of `snapshot`: its long-run rate, times
 * the Clients seen so far when it counts each Client on its own.
 */
function allowedOverKeys(limiter: LimiterSpec, snapshot: Snapshot | undefined): number {
  const keys =
    limiter.keyBy === 'client' ? Math.max(1, Object.keys(snapshot?.perClient ?? {}).length) : 1
  return allowedPerSecond(limiter) * keys
}

/**
 * Severity with hysteresis for a rule judged by one number against two thresholds: a level is
 * entered past its threshold and left only once the number is `margin` back on the healthy side,
 * so a value near a threshold does not flicker. `worse` says which way is worse. The returned
 * function takes each span's value, or null when the rule's other conditions do not hold, which
 * clears it.
 */
function createLevels(levels: {
  readonly warn: number
  readonly broken: number
  readonly margin: number
  readonly worse: 'above' | 'below'
}) {
  const { warn, broken, margin } = levels
  const sign = levels.worse === 'above' ? 1 : -1
  /** How far `value` is past `threshold` on the worse side; positive is past it. */
  const past = (value: number, threshold: number) => sign * (value - threshold)
  let severity: Severity | null = null
  return (value: number | null): Severity | null => {
    if (value === null) severity = null
    else if (past(value, broken) > 0 || (severity === 'broken' && past(value, broken) > -margin)) {
      severity = 'broken'
    } else if (past(value, warn) > 0 || (severity !== null && past(value, warn) > -margin)) {
      severity = 'warn'
    } else severity = null
    return severity
  }
}

function percent(share: number): string {
  return `${(share * 100).toFixed(1)}%`
}

/** The queue overflow rule: the share of Attempts sent to the Backend that it lost. */
export function queueOverflowRule(backend: BackendSpec): Rule {
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
      text: 'Try a Limiter that lets Attempts through at a steady pace instead of a whole window of them after a quiet spell, such as a token bucket with a small capacity',
    },
    { text: 'Try more Backend slots' },
    { text: 'Try a bigger queue (Attempts wait longer)' },
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
  const fixes: readonly Fix[] = [
    // Ranked by what each did on the saturation fixture at 100/s, 1.25x its ceiling, seeds 1 to
    // 8 (.scratch/apply-fix/patch-probe.ts), against broken 106 to 111 s of 111 at 78 to 81/s
    // as is: twice the slots, never saturated and Goodput 98.6 to 101.2/s; half the service
    // time, the same Goodput with the p99 down to 120 to 129 ms; the same Limiter at 0.75 of
    // the ceiling, never saturated as a token bucket or a sliding window counter, with Goodput
    // held at 60 and 58.3 to 58.6/s. The simulator has no cache, so "cheaper" is a shorter
    // service time.
    { text: 'Try more Backend slots' },
    { text: 'Try making each Attempt cheaper for the Backend, such as with a cache' },
    {
      text: 'Try a limit below what the Backend can serve (it turns more away, but what gets through is quick)',
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
 * The retry storm rule: Offered Load well above Demand over the window because failed
 * Attempts come straight back, measured by how many retries started within QUICK_RETRY_MS of
 * the failure that caused them.
 */
export function retryStormRule(): Rule {
  const fixes: readonly Fix[] = [
    // Ranked by Goodput for the sliding window counter in Backend overload at 30/s with "Retry
    // at once", seeds 1 to 8 (.scratch/apply-fix/patch-probe.ts), against broken 110 to 111 s
    // of 111 and 10.0 to 10.6/s as is: back off with jitter, never a storm and 12.8 to 13.4/s;
    // wait for Retry-After, never a storm and 10.9 to 11.5/s; one Attempt fewer, warn throughout
    // instead of broken and 10.5 to 10.9/s. The same order holds for the token bucket there.
    { text: 'Try backing off with jitter, so each new Attempt waits a random, growing time' },
    {
      text: 'Try waiting for Retry-After, so new Attempts come when the Limiter says there is room',
    },
    { text: 'Try fewer Attempts per Request, so each failure adds less traffic' },
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

/**
 * The limit too loose rule: the Backend saturated (the saturation rule's condition, with its
 * thresholds and hysteresis) behind a Limiter that lets nearly everything through, or whose limit
 * is at or above what the Backend can serve. A limit just over the Backend's ceiling still rejects
 * some: 85/s against 80/s at Demand 100 rejects 7% to 22% with the Backend 97% to 100% busy
 * (.scratch/more-rules/measure.ts), so the rejected share alone would miss it. As a Cause
 * it explains the saturation Finding beside it.
 */
export function limitTooLooseRule(backend: BackendSpec, limiter: LimiterSpec): Rule {
  const saturation = saturationRule(backend)
  const ceiling = backendCeiling(backend)
  const fixes: readonly Fix[] = [
    // As for saturation, measured on the same fixture: the same Limiter at 0.75 of the
    // ceiling is never saturated, with Goodput held at 60/s (.scratch/apply-fix/patch-probe.ts).
    {
      text: 'Try a limit below what the Backend can serve, with room to spare (it turns more away, but what gets through is quick)',
    },
  ]

  return {
    id: 'limit-too-loose',
    judge(window, allowed) {
      // Judged every window, so the saturation rule's hysteresis follows the run.
      const saturated = saturation.judge(window, allowed)
      if (saturated === null) return null
      const sum = (pick: (s: Snapshot) => number) => window.reduce((t, s) => t + pick(s), 0)
      const offered = sum((s) => s.offeredLoad)
      const share = offered === 0 ? 0 : sum((s) => s.rejected) / offered
      const allows = allowedOverKeys(limiter, window.at(-1))
      if (share >= LIMIT_TOO_LOOSE_REJECTED_SHARE && allows < ceiling) return null
      const busy = sum((s) => s.backendUtil) / window.length
      return {
        severity: saturated.severity,
        evidence: [
          { metric: 'Rejected', value: percent(share) },
          { metric: 'Limiter allows', value: rateText(allows) },
          { metric: 'Backend can serve', value: rateText(ceiling) },
          { metric: 'Busy', value: percent(busy) },
        ],
        why:
          `The Limiter allows ${rateText(allows)} and turned away ${percent(share)} of Attempts, ` +
          `but the Backend can serve only ${rateText(ceiling)}, so it was busy ${percent(busy)} of ` +
          'the time.',
        fixes,
      }
    },
  }
}

/**
 * For a rule that judges more than one window: keeps the newest `count` Snapshots across calls.
 * Returns a function taking each window and giving them, oldest first, or null until there are
 * `count`.
 */
function createRecent(count: number) {
  const recent: Snapshot[] = []
  return (window: readonly Snapshot[]): readonly Snapshot[] | null => {
    for (const snapshot of window) {
      if (snapshot.t > (recent.at(-1)?.t ?? -Infinity)) recent.push(snapshot)
    }
    while (recent.length > count) recent.shift()
    return recent.length < count ? null : recent
  }
}

/**
 * The limit too tight rule: over the last LIMIT_TOO_TIGHT_SECONDS, the steady Demand above what
 * the Limiter allows, a large share rejected, and the Backend mostly idle, so the limit turns
 * away work the Backend could have done.
 */
export function limitTooTightRule(limiter: LimiterSpec): Rule {
  const newest = createRecent(LIMIT_TOO_TIGHT_SECONDS)
  const fixes: readonly Fix[] = [
    // On the fixture (Poisson 50/s, a limit of 20/s, a Backend serving 80/s; seeds 1 to 8,
    // .scratch/more-rules/patch-probe.ts), the same Limiter at 0.75 of the Backend's ceiling,
    // 60/s, never fires: Goodput 20.0/s to 48.7 to 50.9/s, token bucket and sliding counter. A
    // bigger burst allowance is not suggested: this rule fires on the steady rate, not bursts.
    { text: 'Try a higher limit, toward what the Backend can serve' },
  ]

  /** Whether it is active after the last span, so its gates hold with a margin. */
  let active = false
  /** The severity after a span that rejected a share, given the one before. */
  const level = createLevels({
    warn: LIMIT_TOO_TIGHT_WARN_REJECTED,
    broken: LIMIT_TOO_TIGHT_BROKEN_REJECTED,
    margin: LIMIT_TOO_TIGHT_REJECTED_MARGIN,
    worse: 'above',
  })

  return {
    id: 'limit-too-tight',
    judge(window) {
      const recent = newest(window)
      if (recent === null) return null
      const allows = allowedOverKeys(limiter, recent.at(-1))
      const sum = (pick: (s: Snapshot) => number) => recent.reduce((t, s) => t + pick(s), 0)
      const overSeconds = recent.filter((s) => s.demand > allows).length
      const offered = sum((s) => s.offeredLoad)
      const share = offered === 0 ? 0 : sum((s) => s.rejected) / offered
      const busy = sum((s) => s.backendUtil) / recent.length
      // Once active, each gate holds with a margin (LIMIT_TOO_TIGHT_GATE_MARGIN).
      const held = active ? LIMIT_TOO_TIGHT_GATE_MARGIN : { busy: 0, seconds: 0 }
      const steady = overSeconds >= LIMIT_TOO_TIGHT_OVER_SECONDS - held.seconds
      const idle = busy < LIMIT_TOO_TIGHT_IDLE_BUSY + held.busy
      const severity = level(steady && idle ? share : null)
      active = severity !== null
      if (severity === null) return null
      const demand = sum((s) => s.demand) / recent.length
      const allowsText = rateText(allows)
      const which =
        overSeconds === LIMIT_TOO_TIGHT_SECONDS
          ? `In each of the last ${LIMIT_TOO_TIGHT_SECONDS} seconds`
          : `In ${overSeconds} of the last ${LIMIT_TOO_TIGHT_SECONDS} seconds`
      return {
        severity,
        evidence: [
          { metric: 'Rejected', value: percent(share) },
          { metric: 'Demand', value: perSecondText(demand) },
          { metric: 'Limiter allows', value: allowsText },
          {
            metric: 'Seconds over the limit',
            value: `${overSeconds} of ${LIMIT_TOO_TIGHT_SECONDS}`,
          },
          { metric: 'Busy', value: percent(busy) },
        ],
        why:
          `${which} more new Requests ` +
          `arrived than the Limiter allows (${perSecondText(demand)} against ${allowsText}), so it ` +
          `turned away ${percent(share)} of Attempts while the Backend was busy only ` +
          `${percent(busy)} of the time.`,
        fixes,
      }
    },
  }
}

/**
 * The goodput collapse rule: Goodput far under the most this Variant has managed, while its
 * Backend stays busy, so the Backend is working on Attempts whose callers have given up (Wasted
 * Work). The peak is the best 5 s window since diagnosis started.
 */
export function goodputCollapseRule({ slots }: BackendSpec): Rule {
  let peak = 0
  const fixes: readonly Fix[] = [
    // Ranked by Goodput on the fixture once Demand passes the Backend (seeds 1 to 8, after 40 s,
    // .scratch/more-rules/patch-probe.ts), against 0.0/s as is: a queue of half the timeout's
    // work (20), never collapsing, 77 to 80/s; the Limiter at 0.75 of the Backend's ceiling,
    // never collapsing, 60/s.
    { text: 'Try a shorter queue, so nothing waits longer than its caller will' },
    { text: 'Try a lower limit, so the Limiter turns away what the Backend cannot finish in time' },
    {
      text: 'Try cancelling work whose caller has given up (not modelled here: the Backend always finishes what it starts)',
    },
  ]

  /** Whether it is active after the last window, so its busy gate holds with a margin. */
  let active = false
  /** The severity after a window at a ratio of the peak, given the one before. */
  const level = createLevels({
    warn: GOODPUT_COLLAPSE_WARN_RATIO,
    broken: GOODPUT_COLLAPSE_BROKEN_RATIO,
    margin: GOODPUT_COLLAPSE_RATIO_MARGIN,
    worse: 'below',
  })

  return {
    id: 'goodput-collapse',
    judge(window) {
      const sum = (pick: (s: Snapshot) => number) => window.reduce((t, s) => t + pick(s), 0)
      const goodput = sum((s) => s.goodput) / window.length
      peak = Math.max(peak, goodput)
      const busy = sum((s) => s.backendUtil) / window.length
      // With no Goodput yet there is nothing to have collapsed from.
      const busyEnough = busy >= GOODPUT_COLLAPSE_BUSY - (active ? GOODPUT_COLLAPSE_BUSY_MARGIN : 0)
      const severity = level(peak > 0 && busyEnough ? goodput / peak : null)
      active = severity !== null
      if (severity === null) return null
      // Wasted Work as a share of busy slot time, both in slot ms; busy is 80% or more here. The
      // Backend books wasted time only on busy slots, over the same spans as busy time, so the
      // share cannot pass 1 but for float rounding in the two differences, which the cap absorbs.
      const busySlotMs = sum((s) => s.backendUtil) * slots * SNAPSHOT_MS
      const wastedShare = Math.min(1, sum((s) => s.wastedWorkMs) / busySlotMs)
      return {
        severity,
        evidence: [
          { metric: 'Goodput', value: perSecondText(goodput) },
          { metric: 'Its peak', value: perSecondText(peak) },
          { metric: 'Busy', value: percent(busy) },
          { metric: 'Wasted Work', value: percent(wastedShare) },
        ],
        why:
          `Goodput fell to ${perSecondText(goodput)} from a peak of ${perSecondText(peak)} while the ` +
          `Backend stayed ${percent(busy)} busy: ${percent(wastedShare)} of its time went on ` +
          'Attempts whose callers had already given up.',
        fixes,
      }
    },
  }
}

/**
 * The noisy neighbor rule, for a Limiter with one global key: over the last
 * NOISY_NEIGHBOR_SECONDS, one Client sends more than its fair share of the limit every second and
 * takes most of what is allowed, while the other Clients, together under their fair share, are
 * turned away. Keyed per Client, each has its own limit and nobody can crowd anyone out.
 */
export function noisyNeighborRule(limiter: LimiterSpec): Rule {
  const newest = createRecent(NOISY_NEIGHBOR_SECONDS)
  const limit = allowedPerSecond(limiter)
  const fixes: readonly Fix[] = [
    // On the fixture (greedy Client a, 60/s, a global limit of 40/s; seeds 1 to 8,
    // .scratch/more-rules/patch-probe.ts), the same limit kept per Client never fires, and
    // Goodput rises from 40/s to 51 to 53/s (token bucket) and from 38/s to 49 to 51/s (sliding
    // window counter). Splitting the 40/s
    // between the Clients (13.3/s each) also clears it, but Goodput falls to 25/s and limit too
    // tight fires, so the limit is kept whole for each.
    { text: 'Try a limit per Client, so one Client using up its limit cannot crowd out the rest' },
    { text: 'Try weighted fair queuing, so each Client gets its turn (not modelled here)' },
  ]

  /** The severity after a span where the others lost a share, given the one before. */
  const level = createLevels({
    warn: NOISY_NEIGHBOR_WARN_REJECTED,
    broken: NOISY_NEIGHBOR_BROKEN_REJECTED,
    margin: NOISY_NEIGHBOR_REJECTED_MARGIN,
    worse: 'above',
  })

  return {
    id: 'noisy-neighbor',
    judge(window) {
      const recent = newest(window)
      if (recent === null) return null
      // Each Client's Attempts over the span, sent and allowed.
      const totals = new Map<ClientId, { offered: number; allowed: number }>()
      for (const snapshot of recent) {
        for (const [id, c] of Object.entries(snapshot.perClient)) {
          const t = totals.get(id) ?? { offered: 0, allowed: 0 }
          totals.set(id, { offered: t.offered + c.offeredLoad, allowed: t.allowed + c.allowed })
        }
      }
      const ranked = [...totals].sort(([, a], [, b]) => b.allowed - a.allowed)
      const [topEntry] = ranked
      const allowedAll = ranked.reduce((t, [, c]) => t + c.allowed, 0)
      if (topEntry === undefined || ranked.length < 2 || allowedAll === 0) {
        level(null)
        return null
      }
      const [top, topTotals] = topEntry
      const clients = ranked.length
      const fairShare = limit / clients
      const topShare = topTotals.allowed / allowedAll
      const steady = recent.every((s) => (s.perClient[top]?.offeredLoad ?? 0) > fairShare)
      const othersOffered = ranked.reduce((t, [, c]) => t + c.offered, 0) - topTotals.offered
      const othersPerSecond = othersOffered / recent.length
      const othersFair = fairShare * (clients - 1)
      const othersRejected =
        othersOffered === 0 ? 0 : 1 - (allowedAll - topTotals.allowed) / othersOffered
      const crowded = topShare > NOISY_NEIGHBOR_TOP_SHARE && steady && othersPerSecond < othersFair
      const severity = level(crowded ? othersRejected : null)
      if (severity === null) return null
      const limitText = rateText(limit)
      return {
        severity,
        evidence: [
          { metric: 'Client', value: top },
          { metric: 'Its share of allowed', value: percent(topShare) },
          {
            metric: 'Others sent',
            value: `${perSecondText(othersPerSecond)} of a fair ${perSecondText(othersFair)}`,
          },
          { metric: 'Others rejected', value: percent(othersRejected) },
        ],
        why:
          `Client ${top} sent more than its fair share of the limit (${perSecondText(fairShare)}, ` +
          `${limitText} shared by ${clients} Clients) in each of the last ` +
          `${NOISY_NEIGHBOR_SECONDS} seconds and got ${percent(topShare)} of what the Limiter ` +
          `allowed, so the other Clients, sending ${perSecondText(othersPerSecond)} between them, ` +
          `had ${percent(othersRejected)} of their Attempts rejected.`,
        fixes,
      }
    },
  }
}

/**
 * The rules every Variant is diagnosed with: noisy neighbor only behind a global key, as a
 * Limiter per Client already gives each Client its own share.
 */
export function defaultRules({ backend, limiter }: DiagnoserOptions): Rule[] {
  return [
    retryStormRule(),
    limitTooLooseRule(backend, limiter),
    limitTooTightRule(limiter),
    ...(limiter.keyBy === 'global' ? [noisyNeighborRule(limiter)] : []),
    saturationRule(backend),
    queueOverflowRule(backend),
    goodputCollapseRule(backend),
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
