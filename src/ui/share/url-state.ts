/**
 * The setup a shared link carries (.scratch/ship/spec.md decisions 2 and 5): the Scenario, its
 * seed, each Variant's Retry Policy and the Demand. Not the run itself: a link opens at T 0, so
 * it is exact in any browser, where a replayed run is not across JavaScript engines.
 *
 * `?s=backend-overload&seed=1&d=10&r=none.immediate`: `s` the Scenario id, `seed`, `d` the
 * Demand in Requests per second, `r` the Retry Policy modes in Variant order, joined by `.`.
 */
import type { Scenario } from '../../runner/scenario.ts'
import {
  RETRY_MODES,
  withRetryMode,
  withVariantRetry,
  type RetryMode,
} from '../controls/retry-options.ts'
import { MAX_DEMAND } from '../controls/demand.ts'
import { parseSeed } from '../controls/seed.ts'

/** Significant figures a Demand keeps in a link: enough for any slider value, none of the noise. */
const DEMAND_DIGITS = 12

/** What a link sets up: the Scenario with its seed and Retry Policies, and the Demand. */
export interface ShareState {
  readonly scenario: Scenario
  readonly demandRps: number
}

/** The link to `scenario` at `demandRps`: `base` with its query replaced. */
export function shareUrl(base: string, scenario: Scenario, demandRps: number): string {
  const url = new URL(base)
  url.search = ''
  url.hash = ''
  // Built by hand, not with URLSearchParams, so the `.` between modes stays readable.
  const params = [
    `s=${encodeURIComponent(scenario.id)}`,
    `seed=${scenario.seed}`,
    `d=${Number(demandRps.toPrecision(DEMAND_DIGITS))}`,
    `r=${scenario.variants.map((variant) => variant.retry.retry).join('.')}`,
  ]
  return `${url.origin}${url.pathname}?${params.join('&')}`
}

/**
 * The setup `search` (as `location.search` gives it) describes, falling back field by field to
 * the Scenario's own values: an unknown Scenario id gives the first of `scenarios`; a seed that
 * is not a whole number from 0 to MAX_SEED, a Demand outside 0 to 1,000, or Retry modes of the
 * wrong count or an unknown name are ignored. Never throws.
 */
export function parseShareState(
  search: string,
  scenarios: readonly [Scenario, ...Scenario[]],
): ShareState {
  const params = new URLSearchParams(search)
  let scenario = scenarios.find((s) => s.id === params.get('s')) ?? scenarios[0]

  const seed = parseSeed(params.get('seed') ?? '')
  if (seed !== null) scenario = { ...scenario, seed }

  const modes = parseModes(params.get('r'), scenario.variants.length)
  if (modes) {
    scenario = modes.reduce((s, mode, i) => {
      const retry = s.variants[i]!.retry
      return mode === retry.retry ? s : withVariantRetry(s, i, withRetryMode(retry, mode))
    }, scenario)
  }

  return { scenario, demandRps: parseDemand(params.get('d')) ?? scenario.traffic.demandRps }
}

/** The Demand in `text`, or null unless it is a plain decimal number from 0 to MAX_DEMAND. */
function parseDemand(text: string | null): number | null {
  if (text === null || !/^\d+(\.\d+)?$/.test(text)) return null
  const demandRps = Number(text)
  return demandRps <= MAX_DEMAND ? demandRps : null
}

/** One known Retry mode per Variant from `text`, or null if any is unknown or the count is wrong. */
function parseModes(text: string | null, variants: number): RetryMode[] | null {
  if (text === null) return null
  const names = text.split('.')
  if (names.length !== variants) return null
  const modes: RetryMode[] = []
  for (const name of names) {
    const known = RETRY_MODES.find((option) => option.mode === name)
    if (!known) return null
    modes.push(known.mode)
  }
  return modes
}
