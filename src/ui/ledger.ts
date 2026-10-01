/** What the ledger says while the run is going slower than the speed asked for. */
export const SLOWER_NOTICE = 'RUNNING SLOWER THAN REQUESTED'

/**
 * How long the notice stays up after the last frame that hit the event budget, in ms of wall
 * time. Under heavy load some frames fit and some do not; without a hold the notice would
 * flicker, and a screen reader would announce it again and again.
 */
export const SLOWER_HOLD_MS = 1000

/** Whether to show SLOWER_NOTICE, from every frame's result; times are wall-clock ms. */
export interface SlowdownHold {
  /** Records the frame at `nowMs`, and whether it hit the event budget. */
  frame(nowMs: number, hitBudget: boolean): void
  /** Whether a frame hit the budget less than SLOWER_HOLD_MS before `nowMs`. */
  showing(nowMs: number): boolean
}

export function createSlowdownHold(): SlowdownHold {
  let lastHitMs: number | null = null
  return {
    frame(nowMs, hitBudget) {
      if (hitBudget) lastHitMs = nowMs
    },
    showing(nowMs) {
      return lastHitMs !== null && nowMs - lastHitMs < SLOWER_HOLD_MS
    },
  }
}

/** What the ledger line is made from. */
export interface LedgerFacts {
  readonly variants: number
  readonly seed: number
  /** Simulated time, in ms. */
  readonly simMs: number
  readonly speed: number
  /** Events handled since 0, summed over every Variant. */
  readonly eventsHandled: number
}

const whole = new Intl.NumberFormat('en-US')
const tenths = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

/**
 * The ledger's line (DESIGN.md "Ledger"): `3 VARIANTS · SEED 42 · T 64.2s · 1× · 18,204 EVENTS`.
 * Upper case is written here rather than by CSS, so the seconds keep their lower-case s.
 */
export function ledgerLine({ variants, seed, simMs, speed, eventsHandled }: LedgerFacts): string {
  return [
    `${variants} ${variants === 1 ? 'VARIANT' : 'VARIANTS'}`,
    `SEED ${seed}`,
    `T ${tenths.format(simMs / 1000)}s`,
    `${speed}×`,
    `${whole.format(eventsHandled)} EVENTS`,
  ].join(' · ')
}
