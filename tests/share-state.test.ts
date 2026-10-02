import { describe, expect, it } from 'vitest'
import type { Scenario } from '../src/runner/scenario.ts'
import {
  RETRY_MODES,
  withRetryMode,
  withVariantRetry,
  type RetryMode,
} from '../src/ui/controls/retry-options.ts'
import { SCENARIOS } from '../src/ui/scenarios/index.ts'
import { parseShareState, shareUrl } from '../src/ui/share/url-state.ts'

const BASE = 'https://ratescale.example/'
const first = SCENARIOS[0]
/**
 * A second Scenario, so picking one by its id is tested though the app ships only one. A
 * different seed and Demand, so taking the first by mistake would show.
 */
const second: Scenario = {
  ...first,
  id: 'second',
  title: 'Second',
  seed: 9,
  traffic: { ...first.traffic, demandRps: 25 },
}
const TWO = [first, second] as const

/** `scenario` with Variant i switched to `modes[i]`, as the dropdown would do it. */
function withModes(scenario: Scenario, modes: readonly RetryMode[]): Scenario {
  return modes.reduce(
    (s, mode, i) => withVariantRetry(s, i, withRetryMode(s.variants[i]!.retry, mode)),
    scenario,
  )
}

/** The query string of `url`, as `location.search` gives it. */
const searchOf = (url: string) => new URL(url).search

describe('shareUrl and parseShareState', () => {
  it.each(
    SCENARIOS.flatMap((scenario) => RETRY_MODES.map(({ mode }) => [scenario, mode] as const)),
  )('round-trips %s with a new seed, Demand and every Variant on %s', (scenario, mode) => {
    const edited = withModes(
      { ...scenario, seed: 987_654 },
      scenario.variants.map(() => mode),
    )
    const url = shareUrl(BASE, edited, 37)
    expect(parseShareState(searchOf(url), SCENARIOS)).toEqual({ scenario: edited, demandRps: 37 })
  })

  it('gives each Variant its own mode, in Variant order', () => {
    const edited = withModes(first, ['immediate', 'backoff-jitter'])
    const url = shareUrl(BASE, edited, 10)
    expect(searchOf(url)).toBe('?s=backend-overload&seed=1&d=10&r=immediate.backoff-jitter')
    expect(parseShareState(searchOf(url), SCENARIOS).scenario).toEqual(edited)
  })

  it('keeps the base, dropping any query it had', () => {
    expect(shareUrl('https://ratescale.example/app/?s=old', first, 10)).toBe(
      'https://ratescale.example/app/?s=backend-overload&seed=1&d=10&r=none.none',
    )
  })

  it.each([
    [0.5, 'd=0.5'],
    [240, 'd=240'],
    [0.1 + 0.2, 'd=0.3'],
    [1000, 'd=1000'],
  ])('writes Demand %s without float noise as %s', (demandRps, expected) => {
    expect(searchOf(shareUrl(BASE, first, demandRps))).toContain(`&${expected}&`)
  })
})

describe('parseShareState falls back field by field', () => {
  it('gives the default Scenario unchanged, at its own Demand, for an empty query', () => {
    expect(parseShareState('', SCENARIOS)).toEqual({
      scenario: first,
      demandRps: first.traffic.demandRps,
    })
  })

  it('gives the default Scenario for an unknown id, keeping the other fields', () => {
    const { scenario, demandRps } = parseShareState('?s=nope&seed=5&d=20', SCENARIOS)
    expect(scenario).toEqual({ ...first, seed: 5 })
    expect(demandRps).toBe(20)
  })

  it('picks the Scenario named by s', () => {
    expect(parseShareState(`?s=${second.id}`, TWO)).toEqual({
      scenario: second,
      demandRps: second.traffic.demandRps,
    })
  })

  it.each(['-1', '1.5', 'abc', '', '4294967296', '1e3'])('ignores the seed %j', (seed) => {
    const { scenario, demandRps } = parseShareState(`?s=${second.id}&seed=${seed}&d=7`, TWO)
    expect(scenario.seed).toBe(second.seed)
    expect(demandRps).toBe(7)
  })

  it.each(['2000', 'NaN', '-1', '', 'abc', 'Infinity', '1e9'])('ignores the Demand %j', (d) => {
    const { scenario, demandRps } = parseShareState(`?seed=9&d=${d}`, SCENARIOS)
    expect(demandRps).toBe(first.traffic.demandRps)
    expect(scenario.seed).toBe(9)
  })

  it.each(['0', '1000', '0.5'])('accepts the Demand %s, inside 0 to 1,000', (d) => {
    expect(parseShareState(`?d=${d}`, SCENARIOS).demandRps).toBe(Number(d))
  })

  it.each(['immediate', 'immediate.none.none', 'immediate.sometimes', '', 'immediate..'])(
    'ignores the Retry modes %j, keeping the seed and Demand',
    (r) => {
      const { scenario, demandRps } = parseShareState(`?seed=3&d=12&r=${r}`, SCENARIOS)
      expect(scenario).toEqual({ ...first, seed: 3 })
      expect(demandRps).toBe(12)
    },
  )

  it('never throws on a garbled query', () => {
    for (const search of [
      '?%%%',
      '?s',
      '?&&&',
      '?r=.',
      '?d=%20',
      '?s=__proto__',
      '?s=constructor',
    ]) {
      const { scenario, demandRps } = parseShareState(search, SCENARIOS)
      expect(SCENARIOS).toContain(SCENARIOS.find((s) => s.id === scenario.id))
      expect(Number.isFinite(demandRps)).toBe(true)
    }
  })
})
