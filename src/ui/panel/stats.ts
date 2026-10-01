/**
 * The numbers a Variant's panel shows in its stat row and pipeline strip, worked out from its
 * Snapshots without React so they are tested on their own (.scratch/panels/spec.md decisions 4
 * to 6). Every one covers the same last 5 seconds, apart from Requests waiting, which is a count
 * at one moment and so is the newest. Each is null when there is nothing to measure, which the
 * panel shows as a dash (CLAUDE.md "The one rule").
 */
import { allowedPerSecond, type LimiterSpec, type Snapshot } from '../../sim/index.ts'

/**
 * How many of the newest Snapshots the rates average over: 5 one-second Snapshots, the same 5
 * seconds the latency percentiles cover, so every number in the row covers the same time.
 */
export const STAT_SNAPSHOTS = 5

/** What a value with nothing to measure shows. */
export const DASH = '–'

/** A Variant's panel numbers. Rates are per second, times in ms, shares and meters 0 to 1. */
export interface PanelStats {
  readonly demand: number | null
  readonly offeredLoad: number | null
  readonly goodput: number | null
  readonly allowed: number | null
  /** Rejected Attempts as a share of Offered Load; null when nothing was offered. */
  readonly rejectedShare: number | null
  /** Attempt p99 from the newest Snapshot, which already covers the last 5 s. */
  readonly p99: number | null
  /** Fraction of Backend slot time that was busy, averaged over the same Snapshots. */
  readonly busy: number | null
  /** Requests waiting for a Backend slot now: at the end of the newest second. */
  readonly waiting: number | null
  /** Allowed per second against what the Limiter allows in the long run, clamped to 0 to 1. */
  readonly limiterMeter: number | null
  /** The Backend's busy fraction, clamped to 0 to 1. */
  readonly backendMeter: number | null
}

/**
 * The Attempts per second a Limiter allows in the long run, over every key: its rate per key,
 * times the Clients when each Client has its own key.
 */
export function limiterCapacity(limiter: LimiterSpec, clients: number): number {
  return allowedPerSecond(limiter) * (limiter.keyBy === 'client' ? clients : 1)
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/**
 * The panel numbers from a Variant's Snapshots (oldest first), its Limiter and how many Clients
 * the Scenario has. Rates average over the last STAT_SNAPSHOTS, or the ones there are.
 */
export function panelStats(
  snapshots: readonly Snapshot[],
  limiter: LimiterSpec,
  clients: number,
): PanelStats {
  const recent = snapshots.slice(-STAT_SNAPSHOTS)
  const newest = recent.at(-1)
  if (newest === undefined) {
    return {
      demand: null,
      offeredLoad: null,
      goodput: null,
      allowed: null,
      rejectedShare: null,
      p99: null,
      busy: null,
      waiting: null,
      limiterMeter: null,
      backendMeter: null,
    }
  }
  const sum = (pick: (s: Snapshot) => number) => recent.reduce((total, s) => total + pick(s), 0)
  const offered = sum((s) => s.offeredLoad)
  const allowed = sum((s) => s.allowed) / recent.length
  const busy = sum((s) => s.backendUtil) / recent.length
  return {
    demand: sum((s) => s.demand) / recent.length,
    offeredLoad: offered / recent.length,
    goodput: sum((s) => s.goodput) / recent.length,
    allowed,
    rejectedShare: offered === 0 ? null : sum((s) => s.rejected) / offered,
    p99: newest.p99,
    busy,
    waiting: newest.queueDepth,
    limiterMeter: clamp01(allowed / limiterCapacity(limiter, clients)),
    backendMeter: clamp01(busy),
  }
}

/**
 * A rate, a time or a count as text: one decimal place under 100 (12.5, 0.4), whole numbers with
 * thousands separators from 100 (151, 1,204), and a dash for null.
 */
export function formatNumber(value: number | null): string {
  if (value === null) return DASH
  const tenths = Math.round(value * 10) / 10
  return tenths < 100 ? String(tenths) : Math.round(value).toLocaleString('en-US')
}

/** A share from 0 to 1 as a percentage without the sign: 0.5 under 10, 58 from 10, or a dash. */
export function formatShare(value: number | null): string {
  if (value === null) return DASH
  const percent = value * 100
  const tenths = Math.round(percent * 10) / 10
  return tenths < 10 ? String(tenths) : String(Math.round(percent))
}
