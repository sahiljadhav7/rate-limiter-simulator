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
import type { LimiterSpec } from './limiter.ts'
import type { Snapshot } from './metrics.ts'

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

/** A suggested configuration change. `patch` (Apply fix, RS-27) comes later. */
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
 * partial window right after the warm-up let one burst second read as the whole window (60%
 * to 74% busy from a single second, .scratch/review/rule-probe.ts).
 */
export const DIAGNOSIS_WINDOW_SNAPSHOTS = 5

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

/** The busy share for `warn`: 85%, where waiting for a slot starts to show in the p99. */
export const SATURATION_WARN_BUSY = 0.85

/** The p99 ratio for `warn`: the slowest Attempts take twice what the work alone takes. */
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
export function queueOverflowRule({ queueLimit }: BackendSpec): Rule {
  let severity: Severity | null = null

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
        fixes: [
          // Ranked by what each did for the sliding window counter in Backend overload at 30/s,
          // seeds 1 to 8 (.scratch/review/fixes.ts): token bucket of 10, 0% lost and Goodput 15.7/s;
          // 8 slots, 0.1% and 14.0/s; a queue of 60, up to 3.5% and 13.7/s; as is, 11.5/s. A lower
          // limit stops the loss but turns so much away that Goodput falls (7.9/s at 40), so it
          // is not suggested.
          {
            text: 'Try a Limiter that lets Attempts through at a steady pace instead of a whole window at once, such as a token bucket with a small capacity',
          },
          { text: 'Try more Backend slots' },
          { text: 'Try a bigger queue (Attempts wait longer)' },
        ],
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
  let severity: Severity | null = null

  /** Whether `busy` and `ratio` reach a severity entered at `minBusy` and `minRatio`. */
  function reaches(
    busy: number,
    ratio: number,
    minBusy: number,
    minRatio: number,
    alreadyIn: boolean,
  ): boolean {
    if (!alreadyIn) return busy >= minBusy && ratio > minRatio
    return busy >= minBusy - SATURATION_BUSY_MARGIN && ratio > minRatio - SATURATION_RATIO_MARGIN
  }

  return {
    id: 'saturation',
    judge(window) {
      const busy = window.reduce((t, s) => t + s.backendUtil, 0) / window.length
      // The newest p99 already covers the last 5 s of completed Attempts.
      const p99 = window.at(-1)?.p99 ?? null
      if (p99 === null) {
        severity = null
        return null
      }
      const ratio = p99 / baseline
      if (
        reaches(busy, ratio, SATURATION_BROKEN_BUSY, SATURATION_BROKEN_RATIO, severity === 'broken')
      ) {
        severity = 'broken'
      } else if (
        reaches(busy, ratio, SATURATION_WARN_BUSY, SATURATION_WARN_RATIO, severity !== null)
      ) {
        severity = 'warn'
      } else {
        severity = null
      }
      if (severity === null) return null
      const ms = (value: number) => `${Math.round(value)} ms`
      return {
        severity,
        evidence: [
          { metric: 'Busy', value: percent(busy) },
          { metric: 'p99 latency', value: ms(p99) },
          { metric: 'Baseline p99', value: ms(baseline) },
          { metric: 'p99 / baseline', value: `${ratio.toFixed(1)}x` },
        ],
        why:
          `The Backend was busy ${percent(busy)} of the time, so Attempts waited for a slot: ` +
          `the slowest 1 in 100 took ${ms(p99)}, ${ratio.toFixed(1)}x the ${ms(baseline)} its ` +
          `work alone takes.`,
        fixes: [
          // Ranked by what each did on the saturation fixture at 100/s, 1.25x its ceiling, seeds
          // 1 to 8 (.scratch/diagnosis/saturation-fixes.ts): 8 slots, never saturated and Goodput
          // 99 to 101/s; half the service time, the same Goodput with p99 down to 122 to 139 ms;
          // a token bucket at 70/s, saturation gone (warn at most 7% of seconds) but Goodput held
          // at 70/s; as is, broken 95% to 100% of seconds at 78 to 81/s. The simulator has no
          // cache, so "cheaper" is measured as a shorter service time.
          { text: 'Try more Backend slots' },
          { text: 'Try making each Attempt cheaper for the Backend, such as with a cache' },
          {
            text: 'Try a limit below what the Backend can serve (it turns more away, but what gets through is quick)',
          },
        ],
      }
    },
  }
}

/** The rules every Variant is diagnosed with. */
export function defaultRules({ backend }: DiagnoserOptions): Rule[] {
  return [saturationRule(backend), queueOverflowRule(backend)]
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
