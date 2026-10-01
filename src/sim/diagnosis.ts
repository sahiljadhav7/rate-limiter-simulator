/**
 * Diagnosis: Findings worked out from a Variant's Snapshots with explicit thresholds, the same
 * for every Scenario (BaseConcept.md "Failure diagnosis"). It reads only Snapshots, so it is
 * as deterministic as the run. The first rule is queue overflow; the others (RS-24, RS-28)
 * add their own state beside it.
 */
import type { Snapshot } from './metrics.ts'

/** A named way the simulated system goes wrong. */
export type FailureMode = 'queue-overflow'

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
  /** A Cause is a design mistake; a Symptom is what it does to the system. */
  readonly kind: 'cause' | 'symptom'
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
  /** With one rule there is one Finding, so it is the Root Cause; ranking comes with RS-24. */
  readonly role: 'root-cause' | 'contributing'
}

/**
 * How many of the newest Snapshots the loss share covers: 5 seconds, the same span as the
 * panel's stats and the latency percentiles, long enough that one unlucky second does not
 * decide it.
 */
export const LOSS_WINDOW_SNAPSHOTS = 5

/**
 * The share of Attempts sent to the Backend that it lost (shed because the queue was full, or
 * timed out) at which queue overflow becomes `warn`. Measured in the Backend overload Scenario:
 * a Limiter that spreads Attempts evenly loses about 0.05%, and fixed window 0.1% at its calm
 * default, so 1% is well clear of normal noise.
 */
export const QUEUE_OVERFLOW_WARN_SHARE = 0.01

/**
 * The loss share at which queue overflow becomes `broken`: one Attempt in twenty lost. Fixed
 * window loses 6.6% at twice the Backend overload Scenario's default Demand and 24% at three
 * times, while sliding window counter and token bucket stay near 0.05%.
 */
export const QUEUE_OVERFLOW_BROKEN_SHARE = 0.05

/**
 * A severity is left only once the share falls below this fraction of the threshold that
 * entered it (broken below 2.5%, warn below 0.5%), so a share hovering at a threshold does not
 * flicker between states.
 */
export const HYSTERESIS_FRACTION = 0.5

/** What a diagnoser needs to know about the Variant beyond its Snapshots. */
export interface DiagnoserOptions {
  /** The Backend's queue limit, named in the Why. */
  readonly queueLimit: number
}

/** Reads a Variant's Snapshots one at a time and keeps its active Findings. */
export interface Diagnoser {
  /** The next Snapshot, in time order. Warm-up Snapshots are ignored. */
  add(snapshot: Snapshot): void
  /** The Findings active after the last Snapshot added. */
  findings(): readonly Finding[]
}

function percent(share: number): string {
  return `${(share * 100).toFixed(1)}%`
}

/** The severity after a Snapshot whose window lost `share`, given the one before. */
function nextSeverity(current: Severity | null, share: number | null): Severity | null {
  if (share === null) return null
  const warn = QUEUE_OVERFLOW_WARN_SHARE
  const broken = QUEUE_OVERFLOW_BROKEN_SHARE
  if (share >= broken) return 'broken'
  if (current === 'broken' && share >= broken * HYSTERESIS_FRACTION) return 'broken'
  if (share >= warn) return 'warn'
  if (current !== null && share >= warn * HYSTERESIS_FRACTION) return 'warn'
  return null
}

export function createDiagnoser({ queueLimit }: DiagnoserOptions): Diagnoser {
  const recent: Snapshot[] = []
  let severity: Severity | null = null
  let startedAt = 0
  let finding: Finding | null = null

  return {
    add(snapshot) {
      if (snapshot.warmUp) return
      recent.push(snapshot)
      if (recent.length > LOSS_WINDOW_SNAPSHOTS) recent.shift()
      const sum = (pick: (s: Snapshot) => number) => recent.reduce((t, s) => t + pick(s), 0)
      // Attempts sent to the Backend: allowed now, or delayed and released later.
      const sent = sum((s) => s.allowed + s.delayed)
      const shed = sum((s) => s.shed)
      const timedOut = sum((s) => s.attemptsTimedOut)
      // With nothing sent for 5 s nothing can be lost, so there is no share and no Finding.
      const share = sent === 0 ? null : (shed + timedOut) / sent
      const next = nextSeverity(severity, share)
      if (next !== null && severity === null) startedAt = snapshot.t
      severity = next
      if (severity === null || share === null) {
        finding = null
        return
      }
      finding = {
        id: 'queue-overflow',
        label: 'Queue overflow',
        kind: 'symptom',
        severity,
        startedAt,
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
          {
            text: 'Try a Limiter that spreads Attempts evenly (sliding window counter or token bucket)',
          },
          { text: 'Try a bigger queue (Attempts wait longer)' },
          { text: 'Try more Backend slots' },
        ],
        role: 'root-cause',
      }
    },
    findings() {
      return finding === null ? [] : [finding]
    },
  }
}
